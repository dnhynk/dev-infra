import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import { listRuns, type OrcaRun, type OrcaRunner } from '../orca/client.js';
import {
  CHANNEL_PROTOCOL_VERSION,
  ChannelNdjsonDecoder,
  ChannelProtocolError,
  decodeAdapterMessage,
  encodeChannelFrame,
  type AdapterHello,
  type AdapterToDaemonMessage,
  type ChannelProtocolErrorCode,
} from './protocol.js';

export const CHANNEL_PIPE_PATH = String.raw`\\.\pipe\orca-slack-bridge-channel-v1`;
export const DEFAULT_PROBE_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;

export type ChannelPipeErrorCode =
  | ChannelProtocolErrorCode
  | 'pipe_in_use'
  | 'pipe_listen_failed'
  | 'pipe_runtime_error'
  | 'socket_error'
  | 'socket_write_failed'
  | 'write_timeout'
  | 'connection_limit'
  | 'hello_timeout'
  | 'duplicate_hello'
  | 'message_before_hello'
  | 'unexpected_message'
  | 'stale_epoch'
  | 'wrong_attempt'
  | 'wrong_receipt'
  | 'run_read_failed'
  | 'shutdown_timeout';

export class ChannelPipeError extends Error {
  readonly code: ChannelPipeErrorCode;

  constructor(code: ChannelPipeErrorCode) {
    super(code);
    this.name = 'ChannelPipeError';
    this.code = code;
  }
}

export type ChannelConnectionSnapshot = {
  readonly epoch: string;
  readonly sessionId: string;
  readonly terminalHandle: string;
  readonly paneKey: string;
  readonly instanceId: string;
  readonly connectionId: string;
  readonly probeGateId: string;
  readonly probeWrites: number;
  readonly attemptedWrites: number;
  readonly verified: boolean;
};

export type ChannelRouteDecision =
  | { readonly kind: 'pending'; readonly code: 'run_missing' | 'run_unreadable' | 'no_candidate' | 'unverified' | 'stale_generation' | 'run_read_failed' }
  | { readonly kind: 'ambiguous'; readonly code: 'duplicate_run' | 'same_binding' }
  | {
      readonly kind: 'eligible_but_disabled';
      readonly epoch: string;
      readonly generation: number;
      /** D3-1 has no production Gate writer or durable delivery state. */
      readonly productionDeliveryEnabled: false;
    };

type ConnectionState = {
  readonly socket: Socket;
  readonly decoder: ChannelNdjsonDecoder<AdapterToDaemonMessage>;
  bindingIndex: Promise<BindingGenerationIndex | null> | null;
  hello: AdapterHello | null;
  epoch: string | null;
  probeGateId: string | null;
  probeWrites: number;
  attemptedWrites: number;
  verified: boolean;
  probeDelayIndex: number;
  writeBlocked: boolean;
  pendingReceiptAck: string | null;
  timer: ReturnType<typeof setTimeout> | null;
};

type BindingGenerationIndex = ReadonlyMap<string, ReadonlyMap<string, number>>;

export type ChannelPipeServerOptions = {
  readonly orca: OrcaRunner;
  readonly pipePath?: string;
  readonly probeDelaysMs?: readonly number[];
  readonly helloTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxConnections?: number;
  readonly maxConnectionsPerBinding?: number;
  /** Test seam for deterministic backpressure; production always calls `socket.write(frame)`. */
  readonly writeFrame?: (socket: Socket, frame: Buffer) => boolean;
  /** Receives bounded codes only. Raw frames, claims, paths, and socket errors are never passed. */
  readonly onError?: (code: ChannelPipeErrorCode) => void;
};

function finiteMs(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1) throw new TypeError(`${name}_invalid`);
  return Math.trunc(value);
}

function listenErrorCode(error: unknown): ChannelPipeErrorCode {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'EADDRINUSE'
  )
    ? 'pipe_in_use'
    : 'pipe_listen_failed';
}

function bindingKey(terminalHandle: string, paneKey: string): string {
  return `${terminalHandle}\u0000${paneKey}`;
}

function indexBindingGenerations(runs: readonly OrcaRun[]): BindingGenerationIndex {
  const mutable = new Map<string, Map<string, number>>();
  for (const run of runs) {
    if (
      run.coordinatorHandle === null ||
      run.coordinatorPaneKey === null ||
      run.consumerGeneration.kind !== 'value'
    ) continue;
    const key = bindingKey(run.coordinatorHandle, run.coordinatorPaneKey);
    let generations = mutable.get(key);
    if (generations === undefined) {
      generations = new Map();
      mutable.set(key, generations);
    }
    generations.set(run.id, run.consumerGeneration.value);
  }
  return mutable;
}

async function abortableListRuns(
  runner: OrcaRunner,
  signal: AbortSignal,
): Promise<OrcaRun[]> {
  if (signal.aborted) throw new Error('orca_read_aborted');
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(new Error('orca_read_aborted'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    // The race retires server-owned work even for an injected runner that ignores AbortSignal.
    // Production OrcaCli also consumes the signal and terminates its child process.
    return await Promise.race([listRuns(runner, { signal }), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Daemon-owned local Channel endpoint.
 *
 * D3-1 intentionally has no method that writes a production Gate. It exercises the real pipe,
 * Adapter, MCP notification, and receipt probe while routing evaluation remains read-only.
 */
export class ChannelPipeServer {
  readonly #orca: OrcaRunner;
  readonly #pipePath: string;
  readonly #probeDelaysMs: readonly number[];
  readonly #helloTimeoutMs: number;
  readonly #writeTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #maxConnections: number;
  readonly #maxConnectionsPerBinding: number;
  readonly #writeFrame: (socket: Socket, frame: Buffer) => boolean;
  readonly #onError: (code: ChannelPipeErrorCode) => void;
  readonly #connections = new Set<ConnectionState>();
  #server: Server | null = null;
  #bindingAbort: AbortController | null = null;
  #bindingRead: Promise<BindingGenerationIndex | null> | null = null;
  #stopping = false;
  #productionRouteEvaluations = 0;

  constructor(options: ChannelPipeServerOptions) {
    this.#orca = options.orca;
    this.#pipePath = options.pipePath ?? CHANNEL_PIPE_PATH;
    const delays = options.probeDelaysMs ?? DEFAULT_PROBE_DELAYS_MS;
    if (delays.length === 0) throw new TypeError('probe_delays_empty');
    this.#probeDelaysMs = delays.map((value) => finiteMs(value, 'probe_delay'));
    this.#helloTimeoutMs = finiteMs(options.helloTimeoutMs ?? 5_000, 'hello_timeout');
    this.#writeTimeoutMs = finiteMs(options.writeTimeoutMs ?? 5_000, 'write_timeout');
    this.#shutdownTimeoutMs = finiteMs(options.shutdownTimeoutMs ?? 2_000, 'shutdown_timeout');
    const maxConnections = options.maxConnections ?? 64;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 1_024) {
      throw new TypeError('max_connections_invalid');
    }
    this.#maxConnections = maxConnections;
    const maxConnectionsPerBinding = options.maxConnectionsPerBinding ?? 2;
    if (
      !Number.isSafeInteger(maxConnectionsPerBinding) ||
      maxConnectionsPerBinding < 1 ||
      maxConnectionsPerBinding > maxConnections
    ) {
      throw new TypeError('max_connections_per_binding_invalid');
    }
    this.#maxConnectionsPerBinding = maxConnectionsPerBinding;
    this.#writeFrame = options.writeFrame ?? ((socket, frame) => socket.write(frame));
    this.#onError = options.onError ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.#server !== null) throw new ChannelPipeError('pipe_in_use');
    this.#stopping = false;
    const bindingAbort = new AbortController();
    this.#bindingAbort = bindingAbort;
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: unknown): void => {
          server.off('listening', listening);
          reject(new ChannelPipeError(listenErrorCode(error)));
        };
        const listening = (): void => {
          server.off('error', failed);
          resolve();
        };
        server.once('error', failed);
        server.once('listening', listening);
        server.listen(this.#pipePath);
      });
    } catch (error) {
      if (this.#server === server) this.#server = null;
      bindingAbort.abort();
      if (this.#bindingAbort === bindingAbort) this.#bindingAbort = null;
      server.removeAllListeners();
      throw error;
    }

    server.on('error', () => this.#onError('pipe_runtime_error'));
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const bindingAbort = this.#bindingAbort;
    this.#bindingAbort = null;
    bindingAbort?.abort();
    const bindingRead = this.#bindingRead;
    for (const connection of this.#connections) {
      this.#clearTimer(connection);
      connection.socket.destroy();
    }

    const server = this.#server;
    this.#server = null;
    if (server !== null || bindingRead !== null) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const closing: Promise<unknown>[] = [];
      if (server !== null) {
        closing.push(new Promise<void>((resolve) => {
          server.close(() => resolve());
        }));
      }
      if (bindingRead !== null) closing.push(bindingRead);
      const closed = Promise.allSettled(closing).then(() => 'closed' as const);
      const timedOut = new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), this.#shutdownTimeoutMs);
        timeout.unref?.();
      });
      const result = await Promise.race([closed, timedOut]);
      if (timeout !== null) clearTimeout(timeout);
      if (result === 'timeout') {
        this.#onError('shutdown_timeout');
      }
      server?.removeAllListeners();
    }
    if (this.#bindingRead === bindingRead) this.#bindingRead = null;
    this.#connections.clear();
  }

  getResourceSnapshot(): {
    readonly listening: boolean;
    readonly sockets: number;
    readonly timers: number;
    readonly bindingReads: 0 | 1;
    readonly queuedReceiptAcks: number;
    readonly productionRouteEvaluations: number;
    readonly productionGateWrites: 0;
  } {
    return {
      listening: this.#server?.listening ?? false,
      sockets: this.#connections.size,
      timers: [...this.#connections].filter((connection) => connection.timer !== null).length,
      bindingReads: this.#bindingRead === null ? 0 : 1,
      queuedReceiptAcks: [...this.#connections].filter(
        (connection) => connection.pendingReceiptAck !== null,
      ).length,
      productionRouteEvaluations: this.#productionRouteEvaluations,
      productionGateWrites: 0,
    };
  }

  listConnections(): readonly ChannelConnectionSnapshot[] {
    const snapshots: ChannelConnectionSnapshot[] = [];
    for (const connection of this.#connections) {
      const hello = connection.hello;
      const epoch = connection.epoch;
      const probeGateId = connection.probeGateId;
      if (hello === null || epoch === null || probeGateId === null) continue;
      snapshots.push({
        epoch,
        sessionId: hello.session_id,
        terminalHandle: hello.terminal_handle,
        paneKey: hello.pane_key,
        instanceId: hello.instance_id,
        connectionId: hello.connection_id,
        probeGateId,
        probeWrites: connection.probeWrites,
        attemptedWrites: connection.attemptedWrites,
        verified: connection.verified,
      });
    }
    return snapshots;
  }

  /** Read-only D3-1 router shell. It never broadcasts and cannot flush a production Gate. */
  async evaluateProductionRoute(runId: string): Promise<ChannelRouteDecision> {
    this.#productionRouteEvaluations += 1;
    const connectionSnapshot = [...this.#connections];
    const bindings = new Map<ConnectionState, BindingGenerationIndex | null>();
    await Promise.all(connectionSnapshot.map(async (connection) => {
      if (connection.bindingIndex !== null) {
        bindings.set(connection, await connection.bindingIndex);
      }
    }));
    let runs;
    try {
      runs = (await listRuns(this.#orca)).filter((run) => run.id === runId);
    } catch {
      this.#onError('run_read_failed');
      return { kind: 'pending', code: 'run_read_failed' };
    }
    if (runs.length === 0) return { kind: 'pending', code: 'run_missing' };
    if (runs.length > 1) return { kind: 'ambiguous', code: 'duplicate_run' };
    const run = runs[0]!;
    if (
      run.coordinatorHandle === null ||
      run.coordinatorPaneKey === null ||
      run.consumerGeneration.kind !== 'value'
    ) {
      return { kind: 'pending', code: 'run_unreadable' };
    }

    const candidates = connectionSnapshot.filter((connection) =>
      this.#connections.has(connection) &&
      bindings.has(connection) &&
      connection.hello !== null &&
      connection.epoch !== null &&
      connection.hello.terminal_handle === run.coordinatorHandle &&
      connection.hello.pane_key === run.coordinatorPaneKey,
    );
    if (candidates.length === 0) return { kind: 'pending', code: 'no_candidate' };
    if (candidates.length > 1) return { kind: 'ambiguous', code: 'same_binding' };
    const candidate = candidates[0]!;
    if (!candidate.verified) return { kind: 'pending', code: 'unverified' };

    const currentGeneration = run.consumerGeneration.value;
    const boundGenerations = bindings.get(candidate);
    if (boundGenerations === null) {
      candidate.socket.destroy();
      return { kind: 'pending', code: 'run_read_failed' };
    }
    const boundGeneration = boundGenerations
      ?.get(bindingKey(run.coordinatorHandle, run.coordinatorPaneKey))
      ?.get(run.id);
    if (boundGeneration === undefined || boundGeneration !== currentGeneration) {
      // A fresh connection must capture the new generation at hello; an existing claim can never
      // lazily adopt a Run that appeared later or a generation created by coordinator takeover.
      candidate.socket.destroy();
      return { kind: 'pending', code: 'stale_generation' };
    }
    return {
      kind: 'eligible_but_disabled',
      epoch: candidate.epoch!,
      generation: currentGeneration,
      productionDeliveryEnabled: false,
    };
  }

  #accept(socket: Socket): void {
    if (this.#stopping) {
      socket.destroy();
      return;
    }
    if (this.#connections.size >= this.#maxConnections) {
      this.#onError('connection_limit');
      socket.destroy();
      return;
    }
    const connection: ConnectionState = {
      socket,
      decoder: new ChannelNdjsonDecoder(decodeAdapterMessage),
      bindingIndex: null,
      hello: null,
      epoch: null,
      probeGateId: null,
      probeWrites: 0,
      attemptedWrites: 0,
      verified: false,
      probeDelayIndex: 0,
      writeBlocked: false,
      pendingReceiptAck: null,
      timer: null,
    };
    this.#connections.add(connection);
    connection.timer = setTimeout(() => {
      this.#onError('hello_timeout');
      socket.destroy();
    }, this.#helloTimeoutMs);
    connection.timer.unref?.();

    socket.on('data', (chunk: Buffer) => {
      try {
        const messages = connection.decoder.push(chunk);
        for (const message of messages) {
          this.#handleMessage(connection, message);
          if (socket.destroyed) break;
        }
      } catch (error) {
        this.#onError(error instanceof ChannelProtocolError ? error.code : 'unexpected_message');
        socket.destroy();
      }
    });
    socket.on('error', () => this.#onError('socket_error'));
    socket.on('drain', () => this.#handleDrain(connection));
    socket.on('close', () => {
      try {
        connection.decoder.finish();
      } catch (error) {
        this.#onError(error instanceof ChannelProtocolError ? error.code : 'unexpected_message');
      }
      this.#clearTimer(connection);
      this.#connections.delete(connection);
    });
  }

  #handleMessage(connection: ConnectionState, message: AdapterToDaemonMessage): void {
    if (message.type === 'hello') {
      if (connection.hello !== null) {
        this.#rejectConnection(connection, 'duplicate_hello');
        return;
      }
      const sameBinding = [...this.#connections].filter((candidate) =>
        candidate !== connection &&
        candidate.hello !== null &&
        candidate.hello.terminal_handle === message.terminal_handle &&
        candidate.hello.pane_key === message.pane_key,
      ).length;
      if (sameBinding >= this.#maxConnectionsPerBinding) {
        this.#rejectConnection(connection, 'connection_limit');
        return;
      }
      this.#clearTimer(connection);
      connection.hello = message;
      connection.bindingIndex = this.#readBindingIndex();
      connection.epoch = `epoch_${randomUUID()}`;
      connection.probeGateId = `gate_${randomBytes(6).toString('hex')}`;
      this.#write(connection, {
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'hello_ack',
        connection_epoch: connection.epoch,
      });
      this.#writeProbe(connection);
      return;
    }

    if (connection.hello === null || connection.epoch === null || connection.probeGateId === null) {
      this.#rejectConnection(connection, 'message_before_hello');
      return;
    }
    if (message.connection_epoch !== connection.epoch) {
      this.#rejectConnection(connection, 'stale_epoch');
      return;
    }
    if (message.type === 'attempted') {
      if (message.gate_id !== connection.probeGateId) {
        this.#rejectConnection(connection, 'wrong_attempt');
        return;
      }
      connection.attemptedWrites += 1;
      return;
    }
    if (message.type === 'receipt') {
      if (message.gate_id !== connection.probeGateId) {
        this.#rejectConnection(connection, 'wrong_receipt');
        return;
      }
      if (!connection.verified) {
        connection.verified = true;
        if (!connection.writeBlocked) this.#clearTimer(connection);
      }
      if (connection.writeBlocked) {
        connection.pendingReceiptAck = message.gate_id;
        return;
      }
      // Duplicate receipt calls are idempotent: acknowledge the already-verified same epoch/ID.
      this.#write(connection, {
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'receipt_ack',
        connection_epoch: connection.epoch,
        gate_id: message.gate_id,
      });
    }
  }

  #writeProbe(connection: ConnectionState): void {
    if (
      connection.verified ||
      connection.writeBlocked ||
      connection.epoch === null ||
      connection.probeGateId === null ||
      connection.socket.destroyed
    ) return;
    connection.probeWrites += 1;
    const accepted = this.#write(connection, {
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'notify',
      connection_epoch: connection.epoch,
      gate_id: connection.probeGateId,
    });
    if (accepted) this.#scheduleProbe(connection);
  }

  #readBindingIndex(): Promise<BindingGenerationIndex | null> {
    if (this.#bindingRead !== null) return this.#bindingRead;
    const abort = this.#bindingAbort;
    if (abort === null || abort.signal.aborted) return Promise.resolve(null);
    let tracked!: Promise<BindingGenerationIndex | null>;
    tracked = abortableListRuns(this.#orca, abort.signal).then(indexBindingGenerations).catch(() => {
      if (!abort.signal.aborted) this.#onError('run_read_failed');
      return null;
    }).then((index) => {
      if (index === null && !abort.signal.aborted) {
        // A failed authoritative read cannot stay cached on healthy-looking connections forever.
        // Disconnecting makes each Adapter retry and capture a fresh generation snapshot.
        for (const connection of this.#connections) {
          if (connection.bindingIndex === tracked) connection.socket.destroy();
        }
      }
      return index;
    }).finally(() => {
      if (this.#bindingRead === tracked) this.#bindingRead = null;
    });
    this.#bindingRead = tracked;
    return tracked;
  }

  #scheduleProbe(connection: ConnectionState): void {
    if (connection.verified || connection.writeBlocked || connection.socket.destroyed) return;
    const delay = this.#probeDelaysMs[Math.min(
      connection.probeDelayIndex,
      this.#probeDelaysMs.length - 1,
    )]!;
    connection.probeDelayIndex += 1;
    connection.timer = setTimeout(() => {
      connection.timer = null;
      this.#writeProbe(connection);
    }, delay);
    connection.timer.unref?.();
  }

  #handleDrain(connection: ConnectionState): void {
    if (!this.#connections.has(connection) || !connection.writeBlocked) return;
    this.#clearTimer(connection);
    connection.writeBlocked = false;
    const pendingReceiptAck = connection.pendingReceiptAck;
    connection.pendingReceiptAck = null;
    if (pendingReceiptAck !== null && connection.epoch !== null) {
      this.#write(connection, {
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'receipt_ack',
        connection_epoch: connection.epoch,
        gate_id: pendingReceiptAck,
      });
      return;
    }
    if (connection.verified || connection.socket.destroyed) return;
    if (connection.probeWrites === 0) this.#writeProbe(connection);
    else this.#scheduleProbe(connection);
  }

  #write(connection: ConnectionState, message: Parameters<typeof encodeChannelFrame>[0]): boolean {
    if (connection.writeBlocked || connection.socket.destroyed) return false;
    try {
      const accepted = this.#writeFrame(connection.socket, encodeChannelFrame(message));
      if (!accepted) {
        connection.writeBlocked = true;
        this.#clearTimer(connection);
        connection.timer = setTimeout(() => {
          connection.timer = null;
          this.#rejectConnection(connection, 'write_timeout');
        }, this.#writeTimeoutMs);
        connection.timer.unref?.();
      }
      return accepted;
    } catch {
      this.#onError('socket_write_failed');
      connection.socket.destroy();
      return false;
    }
  }

  #rejectConnection(connection: ConnectionState, code: ChannelPipeErrorCode): void {
    this.#onError(code);
    connection.socket.destroy();
  }

  #clearTimer(connection: ConnectionState): void {
    if (connection.timer !== null) clearTimeout(connection.timer);
    connection.timer = null;
  }
}
