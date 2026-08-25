import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

import {
  CHANNEL_PROTOCOL_VERSION,
  ChannelNdjsonDecoder,
  ChannelProtocolError,
  decodeDaemonMessage,
  encodeChannelFrame,
  isGateId,
  validateAdapterClaims,
  type ChannelProtocolErrorCode,
  type DaemonToAdapterMessage,
} from './protocol.js';
import { CHANNEL_PIPE_PATH } from './pipe-server.js';

export const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export type ChannelAdapterErrorCode =
  | ChannelProtocolErrorCode
  | 'invalid_identity'
  | 'daemon_unavailable'
  | 'socket_error'
  | 'socket_write_failed'
  | 'write_timeout'
  | 'duplicate_hello_ack'
  | 'message_before_hello_ack'
  | 'stale_epoch'
  | 'unexpected_message'
  | 'mcp_write_failed'
  | 'invalid_gate_id'
  | 'receipt_not_current'
  | 'receipt_timeout'
  | 'receipt_disconnected'
  | 'wrong_receipt_ack'
  | 'shutdown_timeout';

export class ChannelAdapterError extends Error {
  readonly code: ChannelAdapterErrorCode;

  constructor(code: ChannelAdapterErrorCode) {
    super(code);
    this.name = 'ChannelAdapterError';
    this.code = code;
  }
}

export type ChannelAdapterIdentity = {
  readonly sessionId: string;
  readonly terminalHandle: string;
  readonly paneKey: string;
};

export function channelAdapterIdentityFromEnv(env: NodeJS.ProcessEnv): ChannelAdapterIdentity {
  const identity = {
    sessionId: env['CLAUDE_CODE_SESSION_ID'],
    terminalHandle: env['ORCA_TERMINAL_HANDLE'],
    paneKey: env['ORCA_PANE_KEY'],
    instanceId: `adapter_${randomUUID()}`,
    connectionId: `connection_${randomUUID()}`,
  };
  try {
    validateAdapterClaims(identity);
  } catch {
    throw new ChannelAdapterError('invalid_identity');
  }
  return {
    sessionId: identity.sessionId,
    terminalHandle: identity.terminalHandle,
    paneKey: identity.paneKey,
  };
}

type ReceiptResult = 'accepted' | 'duplicate';

type PendingReceipt = {
  readonly promise: Promise<ReceiptResult>;
  readonly resolve: (result: ReceiptResult) => void;
  readonly reject: (error: ChannelAdapterError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type ActiveConnection = {
  readonly socket: Socket;
  readonly connectionId: string;
  readonly decoder: ChannelNdjsonDecoder<DaemonToAdapterMessage>;
  readonly acknowledgedGateIds: Set<string>;
  readonly pendingReceipts: Map<string, PendingReceipt>;
  readonly notificationWrites: Set<string>;
  epoch: string | null;
  probeGateId: string | null;
  writeBlocked: boolean;
  writeTimer: ReturnType<typeof setTimeout> | null;
  queuedReceiptGateId: string | null;
};

export type ChannelNotificationWriter = {
  /** Resolves only after the MCP transport write completes. It is not an application receipt. */
  notifyGate(gateId: string): Promise<void>;
};

export type ChannelAdapterClientOptions = {
  readonly identity: ChannelAdapterIdentity;
  readonly notificationWriter: ChannelNotificationWriter;
  readonly pipePath?: string;
  readonly reconnectDelaysMs?: readonly number[];
  readonly receiptAckTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  /** Test seam for deterministic backpressure; production always calls `socket.write(frame)`. */
  readonly writeFrame?: (socket: Socket, frame: Buffer) => boolean;
  /** Bounded codes only; never receives frames, claims, paths, argv, environment, or socket errors. */
  readonly onError?: (code: ChannelAdapterErrorCode) => void;
};

function finiteMs(value: number, code: string): number {
  if (!Number.isFinite(value) || value < 1) throw new TypeError(code);
  return Math.trunc(value);
}

function deferredReceipt(timeoutMs: number): PendingReceipt {
  let resolve!: (result: ReceiptResult) => void;
  let reject!: (error: ChannelAdapterError) => void;
  const promise = new Promise<ReceiptResult>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  const timer = setTimeout(() => reject(new ChannelAdapterError('receipt_timeout')), timeoutMs);
  timer.unref?.();
  return { promise, resolve, reject, timer };
}

/** Reconnecting session-scoped Adapter client. */
export class ChannelAdapterClient {
  readonly #identity: ChannelAdapterIdentity;
  readonly #instanceId = `adapter_${randomUUID()}`;
  readonly #notificationWriter: ChannelNotificationWriter;
  readonly #pipePath: string;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #receiptAckTimeoutMs: number;
  readonly #writeTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #writeFrame: (socket: Socket, frame: Buffer) => boolean;
  readonly #onError: (code: ChannelAdapterErrorCode) => void;
  readonly #pendingNotifications = new Set<Promise<void>>();
  #active: ActiveConnection | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectDelayIndex = 0;
  #started = false;
  #stopped = false;

  constructor(options: ChannelAdapterClientOptions) {
    const claims = {
      sessionId: options.identity.sessionId,
      terminalHandle: options.identity.terminalHandle,
      paneKey: options.identity.paneKey,
      instanceId: this.#instanceId,
      connectionId: `connection_${randomUUID()}`,
    };
    try {
      validateAdapterClaims(claims);
    } catch {
      throw new ChannelAdapterError('invalid_identity');
    }
    this.#identity = options.identity;
    this.#notificationWriter = options.notificationWriter;
    this.#pipePath = options.pipePath ?? CHANNEL_PIPE_PATH;
    const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    if (delays.length === 0) throw new TypeError('reconnect_delays_empty');
    this.#reconnectDelaysMs = delays.map((delay) => finiteMs(delay, 'reconnect_delay_invalid'));
    this.#receiptAckTimeoutMs = finiteMs(
      options.receiptAckTimeoutMs ?? 5_000,
      'receipt_timeout_invalid',
    );
    this.#writeTimeoutMs = finiteMs(options.writeTimeoutMs ?? 5_000, 'write_timeout_invalid');
    this.#shutdownTimeoutMs = finiteMs(
      options.shutdownTimeoutMs ?? 2_000,
      'shutdown_timeout_invalid',
    );
    this.#writeFrame = options.writeFrame ?? ((socket, frame) => socket.write(frame));
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const active = this.#active;
    this.#active = null;
    if (active !== null) {
      this.#clearWriteState(active);
      this.#rejectReceipts(active, 'receipt_disconnected');
      active.socket.removeAllListeners();
      active.socket.destroy();
    }

    if (this.#pendingNotifications.size > 0) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const settled = Promise.allSettled([...this.#pendingNotifications]).then(() => 'settled' as const);
      const timedOut = new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), this.#shutdownTimeoutMs);
        timeout.unref?.();
      });
      const result = await Promise.race([settled, timedOut]);
      if (timeout !== null) clearTimeout(timeout);
      if (result === 'timeout') {
        // The external MCP writer is not cancellable, but it must not remain owned or re-awaited by
        // this stopped Adapter. Its eventual finally is idempotent against the cleared set.
        this.#pendingNotifications.clear();
        this.#onError('shutdown_timeout');
      }
    }
  }

  reportReceipt(gateId: string): Promise<ReceiptResult> {
    if (!isGateId(gateId)) return Promise.reject(new ChannelAdapterError('invalid_gate_id'));
    const active = this.#active;
    if (
      active === null ||
      active.epoch === null ||
      active.probeGateId !== gateId ||
      active.socket.destroyed
    ) {
      return Promise.reject(new ChannelAdapterError('receipt_not_current'));
    }
    if (active.acknowledgedGateIds.has(gateId)) return Promise.resolve('duplicate');
    const existing = active.pendingReceipts.get(gateId);
    if (existing !== undefined) return existing.promise;

    const pending = deferredReceipt(this.#receiptAckTimeoutMs);
    active.pendingReceipts.set(gateId, pending);
    void pending.promise.finally(() => {
      clearTimeout(pending.timer);
      if (active.pendingReceipts.get(gateId) === pending) active.pendingReceipts.delete(gateId);
      if (active.queuedReceiptGateId === gateId && !active.pendingReceipts.has(gateId)) {
        active.queuedReceiptGateId = null;
      }
    }).catch(() => undefined);
    if (active.writeBlocked) {
      active.queuedReceiptGateId = gateId;
      return pending.promise;
    }
    this.#write(active, {
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: active.epoch,
      gate_id: gateId,
    });
    return pending.promise;
  }

  getResourceSnapshot(): {
    readonly socket: 0 | 1;
    readonly reconnectTimer: 0 | 1;
    readonly receiptTimers: number;
    readonly writeTimer: 0 | 1;
    readonly queuedReceipts: 0 | 1;
    readonly notificationWrites: number;
    readonly epoch: string | null;
  } {
    return {
      socket: this.#active === null ? 0 : 1,
      reconnectTimer: this.#reconnectTimer === null ? 0 : 1,
      receiptTimers: this.#active?.pendingReceipts.size ?? 0,
      writeTimer: this.#active?.writeTimer === null || this.#active === null ? 0 : 1,
      queuedReceipts: this.#active?.queuedReceiptGateId === null || this.#active === null ? 0 : 1,
      notificationWrites: this.#pendingNotifications.size,
      epoch: this.#active?.epoch ?? null,
    };
  }

  #connect(): void {
    if (this.#stopped || this.#active !== null) return;
    const socket = createConnection(this.#pipePath);
    const active: ActiveConnection = {
      socket,
      connectionId: `connection_${randomUUID()}`,
      decoder: new ChannelNdjsonDecoder(decodeDaemonMessage),
      acknowledgedGateIds: new Set(),
      pendingReceipts: new Map(),
      notificationWrites: new Set(),
      epoch: null,
      probeGateId: null,
      writeBlocked: false,
      writeTimer: null,
      queuedReceiptGateId: null,
    };
    this.#active = active;

    socket.on('connect', () => {
      this.#write(active, {
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'hello',
        session_id: this.#identity.sessionId,
        terminal_handle: this.#identity.terminalHandle,
        pane_key: this.#identity.paneKey,
        instance_id: this.#instanceId,
        connection_id: active.connectionId,
      });
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        const messages = active.decoder.push(chunk);
        for (const message of messages) {
          this.#handleMessage(active, message);
          if (socket.destroyed) break;
        }
      } catch (error) {
        this.#onError(error instanceof ChannelProtocolError ? error.code : 'unexpected_message');
        socket.destroy();
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      this.#onError(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? 'daemon_unavailable'
        : 'socket_error');
    });
    socket.on('drain', () => this.#handleDrain(active));
    socket.on('close', () => {
      try {
        active.decoder.finish();
      } catch (error) {
        this.#onError(error instanceof ChannelProtocolError ? error.code : 'unexpected_message');
      }
      this.#clearWriteState(active);
      this.#rejectReceipts(active, 'receipt_disconnected');
      if (this.#active === active) this.#active = null;
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== null) return;
    const delay = this.#reconnectDelaysMs[Math.min(
      this.#reconnectDelayIndex,
      this.#reconnectDelaysMs.length - 1,
    )]!;
    this.#reconnectDelayIndex += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #handleMessage(active: ActiveConnection, message: DaemonToAdapterMessage): void {
    if (this.#active !== active) return;
    if (message.type === 'hello_ack') {
      if (active.epoch !== null) {
        this.#onError('duplicate_hello_ack');
        active.socket.destroy();
        return;
      }
      active.epoch = message.connection_epoch;
      this.#reconnectDelayIndex = 0;
      return;
    }
    if (active.epoch === null) {
      this.#onError('message_before_hello_ack');
      active.socket.destroy();
      return;
    }
    if (message.connection_epoch !== active.epoch) {
      this.#onError('stale_epoch');
      active.socket.destroy();
      return;
    }
    if (message.type === 'receipt_ack') {
      const pending = active.pendingReceipts.get(message.gate_id);
      if (pending === undefined) {
        if (!active.acknowledgedGateIds.has(message.gate_id)) {
          this.#onError('wrong_receipt_ack');
          active.socket.destroy();
        }
        return;
      }
      active.acknowledgedGateIds.add(message.gate_id);
      pending.resolve('accepted');
      return;
    }

    if (active.probeGateId === null) active.probeGateId = message.gate_id;
    else if (active.probeGateId !== message.gate_id) {
      this.#onError('unexpected_message');
      active.socket.destroy();
      return;
    }
    if (active.notificationWrites.has(message.gate_id)) return;
    // Stdio is one process-wide transport. A write that ignores disconnect must not let every new
    // pipe epoch retain another ActiveConnection closure; one unresolved MCP write is the hard cap.
    if (this.#pendingNotifications.size > 0) return;
    active.notificationWrites.add(message.gate_id);
    const epoch = active.epoch;
    const task = this.#notificationWriter.notifyGate(message.gate_id).then(() => {
      if (this.#active !== active || active.epoch !== epoch || active.socket.destroyed) return;
      this.#write(active, {
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'attempted',
        connection_epoch: epoch,
        gate_id: message.gate_id,
      });
    }).catch(() => {
      this.#onError('mcp_write_failed');
    }).finally(() => {
      active.notificationWrites.delete(message.gate_id);
      this.#pendingNotifications.delete(task);
    });
    this.#pendingNotifications.add(task);
  }

  #write(active: ActiveConnection, message: Parameters<typeof encodeChannelFrame>[0]): boolean {
    if (this.#active !== active || active.socket.destroyed || active.writeBlocked) return false;
    try {
      const accepted = this.#writeFrame(active.socket, encodeChannelFrame(message));
      if (!accepted) {
        active.writeBlocked = true;
        active.writeTimer = setTimeout(() => {
          active.writeTimer = null;
          if (this.#active !== active || active.socket.destroyed || !active.writeBlocked) return;
          this.#onError('write_timeout');
          active.socket.destroy();
        }, this.#writeTimeoutMs);
        active.writeTimer.unref?.();
      }
      return true;
    } catch {
      this.#onError('socket_write_failed');
      active.socket.destroy();
      return false;
    }
  }

  #handleDrain(active: ActiveConnection): void {
    if (this.#active !== active || active.socket.destroyed || !active.writeBlocked) return;
    if (active.writeTimer !== null) clearTimeout(active.writeTimer);
    active.writeTimer = null;
    active.writeBlocked = false;
    const gateId = active.queuedReceiptGateId;
    active.queuedReceiptGateId = null;
    if (gateId === null || active.epoch === null || !active.pendingReceipts.has(gateId)) return;
    this.#write(active, {
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: active.epoch,
      gate_id: gateId,
    });
  }

  #clearWriteState(active: ActiveConnection): void {
    if (active.writeTimer !== null) clearTimeout(active.writeTimer);
    active.writeTimer = null;
    active.writeBlocked = false;
    active.queuedReceiptGateId = null;
  }

  #rejectReceipts(active: ActiveConnection, code: ChannelAdapterErrorCode): void {
    for (const receipt of active.pendingReceipts.values()) {
      clearTimeout(receipt.timer);
      receipt.reject(new ChannelAdapterError(code));
    }
    active.pendingReceipts.clear();
  }
}
