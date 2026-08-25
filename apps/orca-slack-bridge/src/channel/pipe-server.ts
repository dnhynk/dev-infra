import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

import { listRuns, type OrcaRun, type OrcaRunner } from '../orca/client.js';
import {
  CHANNEL_PROTOCOL_VERSION,
  ChannelNdjsonDecoder,
  ChannelProtocolError,
  decodeAdapterMessage,
  encodeChannelFrame,
  isGateId,
  type AdapterHello,
  type AdapterToDaemonMessage,
  type ChannelProtocolErrorCode,
} from './protocol.js';

export const CHANNEL_PIPE_PATH = String.raw`\\.\pipe\orca-slack-bridge-channel-v1`;
export const DEFAULT_PROBE_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;
const PRODUCTION_RECEIPT_ACK_SAFETY_MS = 50;
const PRODUCTION_ROUTE_FRESHNESS_MS = 25;

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
  | 'stale_delivery'
  | 'delivery_event_failed'
  | 'delivery_event_expired'
  | 'production_delivery_limit'
  | 'inbound_message_limit'
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
  | { readonly kind: 'pending'; readonly code: 'run_missing' | 'run_unreadable' | 'no_candidate' | 'unverified' | 'stale_generation' | 'run_read_failed' | 'backpressure' | 'connection_capacity' | 'write_failed' }
  | { readonly kind: 'ambiguous'; readonly code: 'duplicate_run' | 'same_binding' }
  | {
      readonly kind: 'eligible';
      readonly epoch: string;
      readonly generation: number;
    };

export type ChannelDeliverySendResult =
  | Exclude<ChannelRouteDecision, { readonly kind: 'eligible' }>
  | { readonly kind: 'sent'; readonly epoch: string; readonly generation: number };

export type ChannelProductionDeliveryEvent = {
  readonly gateId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly connectionEpoch: string;
};

export type ChannelProductionDeliveryHandlers = {
  /** Synchronous so a receipt ACK can never cross the pipe before its durable commit. */
  readonly attempted: (event: ChannelProductionDeliveryEvent) => void;
  readonly receipted: (event: ChannelProductionDeliveryEvent) => void;
};

type ProductionAdapterMessage = Extract<
  AdapterToDaemonMessage,
  { readonly type: 'attempted' | 'receipt' }
>;

type QueuedProductionEvent = {
  readonly message: ProductionAdapterMessage;
  readonly deadlineAt: number;
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
  readonly pendingReceiptAcks: Set<string>;
  readonly productionDeliveries: Map<string, ChannelProductionDeliveryEvent>;
  readonly productionEventQueue: QueuedProductionEvent[];
  productionEventsActive: number;
  productionCommit: Promise<void>;
  inbound: Promise<void>;
  pendingInboundMessages: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type BindingGenerationIndex = ReadonlyMap<string, ReadonlyMap<string, number>>;

type ChannelRouteSelection =
  | {
      readonly decision: Extract<ChannelRouteDecision, { readonly kind: 'eligible' }>;
      readonly connection: ConnectionState;
    }
  | {
      readonly decision: Exclude<ChannelRouteDecision, { readonly kind: 'eligible' }>;
      readonly connection: null;
    };

export type ChannelPipeServerOptions = {
  readonly orca: OrcaRunner;
  readonly pipePath?: string;
  readonly probeDelaysMs?: readonly number[];
  readonly helloTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxConnections?: number;
  readonly maxConnectionsPerBinding?: number;
  readonly maxProductionGateIdsPerConnection?: number;
  readonly eventValidationTimeoutMs?: number;
  /** Bounds fresh route reads without serially consuming the Adapter's 5 second ACK window. */
  readonly maxConcurrentProductionEvents?: number;
  /** Absolute daemon-side callback/ACK budget; production defaults below the Adapter timeout. */
  readonly productionEventDeadlineMs?: number;
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

function combinedSignal(...signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

async function abortablePromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) throw new Error('orca_read_aborted');
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(new Error('orca_read_aborted'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Daemon-owned local Channel endpoint.
 *
 * The dead-window-safe probe remains the only verification signal. D3 production Gate writes use
 * the same exact-generation route only after verification and report Adapter events through a
 * synchronous durable handler installed before startup.
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
  readonly #maxProductionGateIdsPerConnection: number;
  readonly #eventValidationTimeoutMs: number;
  readonly #maxConcurrentProductionEvents: number;
  readonly #productionEventDeadlineMs: number;
  readonly #writeFrame: (socket: Socket, frame: Buffer) => boolean;
  readonly #onError: (code: ChannelPipeErrorCode) => void;
  readonly #connections = new Set<ConnectionState>();
  #server: Server | null = null;
  #bindingAbort: AbortController | null = null;
  #bindingRead: Promise<BindingGenerationIndex | null> | null = null;
  #productionHandlers: ChannelProductionDeliveryHandlers | null = null;
  #stopping = false;
  #productionRouteEvaluations = 0;
  #productionGateWrites = 0;

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
    const maxProductionGateIds = options.maxProductionGateIdsPerConnection ?? 256;
    if (
      !Number.isSafeInteger(maxProductionGateIds) ||
      maxProductionGateIds < 1 ||
      maxProductionGateIds > 4_096
    ) {
      throw new TypeError('max_production_gate_ids_invalid');
    }
    this.#maxProductionGateIdsPerConnection = maxProductionGateIds;
    this.#eventValidationTimeoutMs = finiteMs(
      options.eventValidationTimeoutMs ?? 2_000,
      'event_validation_timeout',
    );
    const maxConcurrentProductionEvents = options.maxConcurrentProductionEvents ?? 8;
    if (
      !Number.isSafeInteger(maxConcurrentProductionEvents) ||
      maxConcurrentProductionEvents < 1 ||
      maxConcurrentProductionEvents > 64
    ) {
      throw new TypeError('max_concurrent_production_events_invalid');
    }
    this.#maxConcurrentProductionEvents = maxConcurrentProductionEvents;
    this.#productionEventDeadlineMs = finiteMs(
      options.productionEventDeadlineMs ?? 4_500,
      'production_event_deadline',
    );
    if (this.#productionEventDeadlineMs >= 5_000) {
      throw new TypeError('production_event_deadline_exceeds_adapter_timeout');
    }
    this.#writeFrame = options.writeFrame ?? ((socket, frame) => socket.write(frame));
    this.#onError = options.onError ?? (() => undefined);
  }

  setProductionDeliveryHandlers(handlers: ChannelProductionDeliveryHandlers): void {
    if (this.#server !== null) throw new ChannelPipeError('pipe_in_use');
    this.#productionHandlers = handlers;
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
    readonly productionGateWrites: number;
  } {
    return {
      listening: this.#server?.listening ?? false,
      sockets: this.#connections.size,
      timers: [...this.#connections].filter((connection) => connection.timer !== null).length,
      bindingReads: this.#bindingRead === null ? 0 : 1,
      queuedReceiptAcks: [...this.#connections].reduce(
        (count, connection) => count + connection.pendingReceiptAcks.size,
        0,
      ),
      productionRouteEvaluations: this.#productionRouteEvaluations,
      productionGateWrites: this.#productionGateWrites,
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

  /** Read-only route inspection; delivery uses the same selector and then performs one exact write. */
  async evaluateProductionRoute(runId: string): Promise<ChannelRouteDecision> {
    return (await this.#selectProductionRoute(runId)).decision;
  }

  /** Write only after the current Run/generation has exactly one verified Adapter candidate. */
  async deliverGate(
    runId: string,
    gateId: string,
    signal?: AbortSignal,
  ): Promise<ChannelDeliverySendResult> {
    if (!isGateId(gateId)) throw new ChannelPipeError('invalid_gate_id');
    if (this.#productionHandlers === null) throw new ChannelPipeError('delivery_event_failed');
    const selected = await this.#selectProductionRoute(runId, signal);
    if (selected.connection === null) return selected.decision;
    const connection = selected.connection;
    if (connection.writeBlocked) return { kind: 'pending', code: 'backpressure' };
    if (
      !connection.productionDeliveries.has(gateId) &&
      connection.productionDeliveries.size >= this.#maxProductionGateIdsPerConnection
    ) {
      this.#onError('production_delivery_limit');
      connection.socket.destroy();
      return { kind: 'pending', code: 'connection_capacity' };
    }
    const token: ChannelProductionDeliveryEvent = {
      gateId,
      runId,
      consumerGeneration: selected.decision.generation,
      connectionEpoch: selected.decision.epoch,
    };
    const existingToken = connection.productionDeliveries.get(gateId);
    if (
      existingToken !== undefined &&
      (
        existingToken.runId !== token.runId ||
        existingToken.consumerGeneration !== token.consumerGeneration ||
        existingToken.connectionEpoch !== token.connectionEpoch
      )
    ) {
      this.#onError('stale_delivery');
      connection.socket.destroy();
      return { kind: 'pending', code: 'stale_generation' };
    }
    connection.productionDeliveries.set(gateId, token);
    const wrote = this.#write(connection, {
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'notify',
      connection_epoch: selected.decision.epoch,
      gate_id: gateId,
    });
    if (!wrote && !connection.writeBlocked) {
      connection.productionDeliveries.delete(gateId);
      return { kind: 'pending', code: 'write_failed' };
    }
    // `socket.write() === false` still means the frame was accepted into Node's bounded queue.
    this.#productionGateWrites += 1;
    return {
      kind: 'sent',
      epoch: selected.decision.epoch,
      generation: selected.decision.generation,
    };
  }

  async #selectProductionRoute(
    runId: string,
    externalSignal?: AbortSignal,
  ): Promise<ChannelRouteSelection> {
    this.#productionRouteEvaluations += 1;
    const signal = combinedSignal(externalSignal, this.#bindingAbort?.signal);
    const connectionSnapshot = [...this.#connections];
    const bindings = new Map<ConnectionState, BindingGenerationIndex | null>();
    let runs;
    try {
      await abortablePromise(Promise.all(connectionSnapshot.map(async (connection) => {
        if (connection.bindingIndex !== null) {
          bindings.set(connection, await connection.bindingIndex);
        }
      })), signal);
      runs = (await abortablePromise(listRuns(
        this.#orca,
        signal === undefined ? undefined : { signal },
      ), signal)).filter((run) => run.id === runId);
    } catch {
      this.#onError('run_read_failed');
      return { decision: { kind: 'pending', code: 'run_read_failed' }, connection: null };
    }
    if (runs.length === 0) {
      return { decision: { kind: 'pending', code: 'run_missing' }, connection: null };
    }
    if (runs.length > 1) {
      return { decision: { kind: 'ambiguous', code: 'duplicate_run' }, connection: null };
    }
    const run = runs[0]!;
    if (
      run.coordinatorHandle === null ||
      run.coordinatorPaneKey === null ||
      run.consumerGeneration.kind !== 'value'
    ) {
      return { decision: { kind: 'pending', code: 'run_unreadable' }, connection: null };
    }

    const candidates = connectionSnapshot.filter((connection) =>
      this.#connections.has(connection) &&
      bindings.has(connection) &&
      connection.hello !== null &&
      connection.epoch !== null &&
      connection.hello.terminal_handle === run.coordinatorHandle &&
      connection.hello.pane_key === run.coordinatorPaneKey,
    );
    if (candidates.length === 0) {
      return { decision: { kind: 'pending', code: 'no_candidate' }, connection: null };
    }

    const currentGeneration = run.consumerGeneration.value;
    const key = bindingKey(run.coordinatorHandle, run.coordinatorPaneKey);
    const currentCandidates: ConnectionState[] = [];
    let retiredFailedRead = false;
    let retiredStaleGeneration = false;
    for (const candidate of candidates) {
      const boundGenerations = bindings.get(candidate);
      if (boundGenerations === null) {
        candidate.socket.destroy();
        retiredFailedRead = true;
        continue;
      }
      const boundGeneration = boundGenerations?.get(key)?.get(run.id);
      if (boundGeneration === undefined || boundGeneration !== currentGeneration) {
        // A fresh connection must capture the new generation at hello; an existing claim can never
        // lazily adopt a Run that appeared later or a generation created by coordinator takeover.
        candidate.socket.destroy();
        retiredStaleGeneration = true;
        continue;
      }
      currentCandidates.push(candidate);
    }
    if (currentCandidates.length === 0) {
      if (retiredFailedRead) {
        return { decision: { kind: 'pending', code: 'run_read_failed' }, connection: null };
      }
      if (retiredStaleGeneration) {
        return { decision: { kind: 'pending', code: 'stale_generation' }, connection: null };
      }
      return { decision: { kind: 'pending', code: 'no_candidate' }, connection: null };
    }
    if (currentCandidates.length > 1) {
      return { decision: { kind: 'ambiguous', code: 'same_binding' }, connection: null };
    }
    const candidate = currentCandidates[0]!;
    if (!candidate.verified) {
      return { decision: { kind: 'pending', code: 'unverified' }, connection: null };
    }

    return {
      decision: {
        kind: 'eligible',
        epoch: candidate.epoch!,
        generation: currentGeneration,
      },
      connection: candidate,
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
      pendingReceiptAcks: new Set(),
      productionDeliveries: new Map(),
      productionEventQueue: [],
      productionEventsActive: 0,
      productionCommit: Promise.resolve(),
      inbound: Promise.resolve(),
      pendingInboundMessages: 0,
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
          if (connection.pendingInboundMessages >= 256) {
            this.#rejectConnection(connection, 'inbound_message_limit');
            break;
          }
          connection.pendingInboundMessages += 1;
          const receivedAt = performance.now();
          const handled = connection.inbound.then(async () => {
            if (socket.destroyed) return;
            await this.#handleMessage(connection, message, receivedAt);
          });
          connection.inbound = handled
            .catch(() => {
              this.#onError('unexpected_message');
              socket.destroy();
            })
            .finally(() => { connection.pendingInboundMessages -= 1; });
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
      connection.productionEventQueue.length = 0;
      this.#connections.delete(connection);
    });
  }

  async #handleMessage(
    connection: ConnectionState,
    message: AdapterToDaemonMessage,
    receivedAt: number,
  ): Promise<void> {
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
      if (
        message.gate_id !== connection.probeGateId &&
        !connection.productionDeliveries.has(message.gate_id)
      ) {
        this.#rejectConnection(connection, 'wrong_attempt');
        return;
      }
      connection.attemptedWrites += 1;
      if (message.gate_id !== connection.probeGateId) {
        this.#enqueueProductionEvent(connection, message, receivedAt);
      }
      return;
    }
    if (message.type === 'receipt') {
      const probeReceipt = message.gate_id === connection.probeGateId;
      if (!probeReceipt && !connection.productionDeliveries.has(message.gate_id)) {
        this.#rejectConnection(connection, 'wrong_receipt');
        return;
      }
      if (probeReceipt && !connection.verified) {
        connection.verified = true;
        if (!connection.writeBlocked) this.#clearTimer(connection);
      }
      if (!probeReceipt) {
        this.#enqueueProductionEvent(connection, message, receivedAt);
        return;
      }
      this.#ackReceipt(connection, message.gate_id);
    }
  }

  #enqueueProductionEvent(
    connection: ConnectionState,
    message: ProductionAdapterMessage,
    receivedAt: number,
  ): void {
    if (
      connection.productionEventsActive + connection.productionEventQueue.length >= 256
    ) {
      this.#rejectConnection(connection, 'inbound_message_limit');
      return;
    }
    connection.productionEventQueue.push({
      message,
      deadlineAt: receivedAt + (
        message.type === 'receipt'
          ? Math.min(
              this.#productionEventDeadlineMs,
              Math.max(0, message.ack_budget_ms - PRODUCTION_RECEIPT_ACK_SAFETY_MS),
            )
          : this.#productionEventDeadlineMs
      ),
    });
    this.#drainProductionEvents(connection);
  }

  #drainProductionEvents(connection: ConnectionState): void {
    while (
      connection.productionEventsActive < this.#maxConcurrentProductionEvents &&
      connection.productionEventQueue.length > 0 &&
      this.#connections.has(connection) &&
      !connection.socket.destroyed &&
      !this.#stopping
    ) {
      const event = connection.productionEventQueue.shift()!;
      if (performance.now() >= event.deadlineAt) {
        this.#expireProductionEvent(connection);
        return;
      }
      connection.productionEventsActive += 1;
      void this.#processProductionEvent(connection, event)
        .catch(() => {
          this.#onError('delivery_event_failed');
        })
        .finally(() => {
          connection.productionEventsActive -= 1;
          this.#drainProductionEvents(connection);
        });
    }
  }

  async #processProductionEvent(
    connection: ConnectionState,
    event: QueuedProductionEvent,
  ): Promise<void> {
    const remainingMs = event.deadlineAt - performance.now();
    if (remainingMs < 1) {
      this.#expireProductionEvent(connection);
      return;
    }
    // Start the expensive fresh Run read in parallel, but append its durable callback and ACK to
    // one arrival-ordered commit chain. This keeps callback serialization without summing route
    // latency across a burst and consuming the Adapter's aggregate receipt timeout.
    const validation = this.#validateProductionEvent(
      connection,
      event.message.gate_id,
      Math.min(this.#eventValidationTimeoutMs, remainingMs),
    ).then((token) => ({ token, validatedAt: performance.now() }));
    const committed = connection.productionCommit.then(async () => {
      let { token, validatedAt } = await validation;
      if (token === null || connection.socket.destroyed || this.#stopping) return;
      const waitedForWritable = event.message.type === 'receipt' && connection.writeBlocked;
      if (
        event.message.type === 'receipt' &&
        !await this.#waitForWritable(connection, event.deadlineAt)
      ) {
        this.#expireProductionEvent(connection);
        return;
      }
      if (
        waitedForWritable ||
        performance.now() - validatedAt > PRODUCTION_ROUTE_FRESHNESS_MS
      ) {
        const refreshBudgetMs = event.deadlineAt - performance.now();
        if (refreshBudgetMs < 1) {
          this.#expireProductionEvent(connection);
          return;
        }
        token = await this.#validateProductionEvent(
          connection,
          event.message.gate_id,
          Math.min(this.#eventValidationTimeoutMs, refreshBudgetMs),
        );
        if (token === null || connection.socket.destroyed || this.#stopping) return;
      }
      if (performance.now() >= event.deadlineAt) {
        this.#expireProductionEvent(connection);
        return;
      }
      try {
        if (event.message.type === 'attempted') this.#productionHandlers?.attempted(token);
        else this.#productionHandlers?.receipted(token);
      } catch {
        // No receipt ACK: the Adapter's receipt tool remains retryable and cannot outrun durable state.
        this.#onError('delivery_event_failed');
        return;
      }
      if (event.message.type === 'receipt') {
        const ackBudgetMs = Math.floor(event.deadlineAt - performance.now());
        if (ackBudgetMs < 1 || connection.writeBlocked) {
          this.#expireProductionEvent(connection);
          return;
        }
        this.#ackReceipt(connection, event.message.gate_id, ackBudgetMs);
      }
    });
    connection.productionCommit = committed.catch(() => undefined);
    await committed;
  }

  #expireProductionEvent(connection: ConnectionState): void {
    if (connection.socket.destroyed) return;
    connection.productionEventQueue.length = 0;
    this.#onError('delivery_event_expired');
    connection.socket.destroy();
  }

  async #waitForWritable(connection: ConnectionState, deadlineAt: number): Promise<boolean> {
    if (!connection.writeBlocked) return !connection.socket.destroyed;
    const remainingMs = Math.floor(deadlineAt - performance.now());
    if (remainingMs < 1 || connection.socket.destroyed || this.#stopping) return false;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (writable: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connection.socket.off('drain', drained);
        connection.socket.off('close', closed);
        resolve(writable);
      };
      const drained = (): void => finish(
        !connection.socket.destroyed &&
        !this.#stopping &&
        !connection.writeBlocked &&
        performance.now() < deadlineAt,
      );
      const closed = (): void => finish(false);
      const timer = setTimeout(() => finish(false), remainingMs);
      timer.unref?.();
      connection.socket.once('drain', drained);
      connection.socket.once('close', closed);
    });
  }

  async #validateProductionEvent(
    connection: ConnectionState,
    gateId: string,
    timeoutMs: number,
  ): Promise<ChannelProductionDeliveryEvent | null> {
    const token = connection.productionDeliveries.get(gateId);
    if (
      token === undefined ||
      connection.epoch !== token.connectionEpoch ||
      this.#stopping ||
      connection.socket.destroyed
    ) return null;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    timer.unref?.();
    let selected: ChannelRouteSelection;
    try {
      selected = await this.#selectProductionRoute(token.runId, deadline.signal);
    } finally {
      clearTimeout(timer);
    }
    if (this.#stopping) return null;
    if (
      selected.connection === connection &&
      selected.decision.kind === 'eligible' &&
      selected.decision.epoch === token.connectionEpoch &&
      selected.decision.generation === token.consumerGeneration
    ) return token;
    if (selected.decision.kind === 'pending' && selected.decision.code === 'run_read_failed') {
      return null;
    }
    this.#onError('stale_delivery');
    if (!connection.socket.destroyed) connection.socket.destroy();
    return null;
  }

  #ackReceipt(connection: ConnectionState, gateId: string, ackBudgetMs?: number): void {
    if (connection.writeBlocked) {
      if (ackBudgetMs !== undefined) {
        this.#expireProductionEvent(connection);
        return;
      }
      connection.pendingReceiptAcks.add(gateId);
      return;
    }
    // Duplicate receipt calls are idempotent for every Gate sent in this exact epoch.
    this.#write(connection, {
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt_ack',
      connection_epoch: connection.epoch!,
      gate_id: gateId,
    }, ackBudgetMs);
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
    if (connection.pendingReceiptAcks.size > 0 && connection.epoch !== null) {
      for (const gateId of [...connection.pendingReceiptAcks]) {
        connection.pendingReceiptAcks.delete(gateId);
        this.#write(connection, {
          version: CHANNEL_PROTOCOL_VERSION,
          type: 'receipt_ack',
          connection_epoch: connection.epoch,
          gate_id: gateId,
        });
        if (connection.writeBlocked || connection.socket.destroyed) break;
      }
      return;
    }
    if (connection.verified || connection.socket.destroyed) return;
    if (connection.probeWrites === 0) this.#writeProbe(connection);
    else this.#scheduleProbe(connection);
  }

  #write(
    connection: ConnectionState,
    message: Parameters<typeof encodeChannelFrame>[0],
    blockTimeoutMs?: number,
  ): boolean {
    if (connection.writeBlocked || connection.socket.destroyed) return false;
    try {
      const accepted = this.#writeFrame(connection.socket, encodeChannelFrame(message));
      if (!accepted) {
        connection.writeBlocked = true;
        this.#clearTimer(connection);
        const timeoutMs = blockTimeoutMs === undefined
          ? this.#writeTimeoutMs
          : Math.max(1, Math.min(this.#writeTimeoutMs, Math.floor(blockTimeoutMs)));
        connection.timer = setTimeout(() => {
          connection.timer = null;
          this.#rejectConnection(connection, 'write_timeout');
        }, timeoutMs);
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
