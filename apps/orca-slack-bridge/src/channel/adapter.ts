import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

import {
  CHANNEL_MAX_RECEIPT_ACK_BUDGET_MS,
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
const NS_PER_MS = 1_000_000n;

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
  | 'notification_limit'
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
  readonly deadlineNs: bigint;
};

type ActiveConnection = {
  readonly socket: Socket;
  readonly connectionId: string;
  readonly decoder: ChannelNdjsonDecoder<DaemonToAdapterMessage>;
  readonly acknowledgedGateIds: Set<string>;
  readonly notifiedGateIds: Set<string>;
  readonly pendingReceipts: Map<string, PendingReceipt>;
  readonly notificationWrites: Set<string>;
  readonly notificationQueue: string[];
  readonly queuedAttemptedGateIds: string[];
  epoch: string | null;
  daemonMonotonicSampleNs: bigint | null;
  adapterMonotonicSampleNs: bigint | null;
  probeGateId: string | null;
  writeBlocked: boolean;
  writeTimer: ReturnType<typeof setTimeout> | null;
  readonly queuedReceiptGateIds: Set<string>;
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
  readonly maxGateIdsPerConnection?: number;
  /** Test seam for deterministic backpressure; production always calls `socket.write(frame)`. */
  readonly writeFrame?: (socket: Socket, frame: Buffer) => boolean;
  /** Bounded codes only; never receives frames, claims, paths, argv, environment, or socket errors. */
  readonly onError?: (code: ChannelAdapterErrorCode) => void;
};

function finiteMs(value: number, code: string): number {
  if (!Number.isFinite(value) || value < 1) throw new TypeError(code);
  return Math.trunc(value);
}

function deferredReceipt(timeoutMs: number, onTimeout: () => void): PendingReceipt {
  let resolve!: (result: ReceiptResult) => void;
  let reject!: (error: ChannelAdapterError) => void;
  const promise = new Promise<ReceiptResult>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  const deadlineNs = process.hrtime.bigint() + BigInt(timeoutMs) * NS_PER_MS;
  const timer = setTimeout(() => {
    reject(new ChannelAdapterError('receipt_timeout'));
    onTimeout();
  }, timeoutMs);
  timer.unref?.();
  return { promise, resolve, reject, timer, deadlineNs };
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
  readonly #maxGateIdsPerConnection: number;
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
    const maxGateIds = options.maxGateIdsPerConnection ?? 256;
    if (!Number.isSafeInteger(maxGateIds) || maxGateIds < 1 || maxGateIds > 4_096) {
      throw new TypeError('max_gate_ids_invalid');
    }
    this.#maxGateIdsPerConnection = maxGateIds;
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
      !active.notifiedGateIds.has(gateId) ||
      active.socket.destroyed
    ) {
      return Promise.reject(new ChannelAdapterError('receipt_not_current'));
    }
    if (active.acknowledgedGateIds.has(gateId)) return Promise.resolve('duplicate');
    const existing = active.pendingReceipts.get(gateId);
    if (existing !== undefined) return existing.promise;

    let pending!: PendingReceipt;
    pending = deferredReceipt(this.#receiptAckTimeoutMs, () => {
      // Fence a daemon ACK that could otherwise arrive after this promise timed out and be
      // misclassified as wrong_receipt_ack on an otherwise-current route.
      if (active.pendingReceipts.get(gateId) === pending && !active.socket.destroyed) {
        active.socket.destroy();
      }
    });
    active.pendingReceipts.set(gateId, pending);
    void pending.promise.finally(() => {
      clearTimeout(pending.timer);
      if (active.pendingReceipts.get(gateId) === pending) active.pendingReceipts.delete(gateId);
      if (!active.pendingReceipts.has(gateId)) active.queuedReceiptGateIds.delete(gateId);
    }).catch(() => undefined);
    if (active.writeBlocked) {
      active.queuedReceiptGateIds.add(gateId);
      return pending.promise;
    }
    this.#writeReceipt(active, gateId, pending);
    return pending.promise;
  }

  getResourceSnapshot(): {
    readonly socket: 0 | 1;
    readonly reconnectTimer: 0 | 1;
    readonly receiptTimers: number;
    readonly writeTimer: 0 | 1;
    readonly queuedReceipts: number;
    readonly notificationWrites: number;
    readonly epoch: string | null;
  } {
    return {
      socket: this.#active === null ? 0 : 1,
      reconnectTimer: this.#reconnectTimer === null ? 0 : 1,
      receiptTimers: this.#active?.pendingReceipts.size ?? 0,
      writeTimer: this.#active?.writeTimer === null || this.#active === null ? 0 : 1,
      queuedReceipts: this.#active?.queuedReceiptGateIds.size ?? 0,
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
      notifiedGateIds: new Set(),
      pendingReceipts: new Map(),
      notificationWrites: new Set(),
      notificationQueue: [],
      queuedAttemptedGateIds: [],
      epoch: null,
      daemonMonotonicSampleNs: null,
      adapterMonotonicSampleNs: null,
      probeGateId: null,
      writeBlocked: false,
      writeTimer: null,
      queuedReceiptGateIds: new Set(),
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
      // The daemon sampled its monotonic clock before writing hello_ack. Subtracting our clock at
      // receipt includes daemon→Adapter transit in the conservative direction, so a mapped
      // Adapter deadline is never later than the corresponding daemon-local deadline.
      active.daemonMonotonicSampleNs = BigInt(message.monotonic_ns);
      active.adapterMonotonicSampleNs = process.hrtime.bigint();
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
      // Timer callbacks can be delayed by a busy event loop. The fixed monotonic deadline remains
      // authoritative, so a late ACK cannot revive a timed-out receipt or the old connection.
      if (process.hrtime.bigint() >= pending.deadlineNs) {
        pending.reject(new ChannelAdapterError('receipt_timeout'));
        active.socket.destroy();
        return;
      }
      active.acknowledgedGateIds.add(message.gate_id);
      pending.resolve('accepted');
      return;
    }

    if (active.probeGateId === null) active.probeGateId = message.gate_id;
    if (
      !active.notifiedGateIds.has(message.gate_id) &&
      active.notifiedGateIds.size >= this.#maxGateIdsPerConnection
    ) {
      this.#onError('notification_limit');
      active.socket.destroy();
      return;
    }
    if (
      active.notificationWrites.has(message.gate_id) ||
      active.notificationQueue.includes(message.gate_id)
    ) return;
    // Receipt may race the transport-write completion callback, so membership is recorded before
    // invoking MCP. It is scoped to this exact connection and discarded on reconnect.
    active.notifiedGateIds.add(message.gate_id);
    active.notificationQueue.push(message.gate_id);
    this.#drainNotificationQueue(active);
  }

  #drainNotificationQueue(active: ActiveConnection): void {
    if (
      this.#active !== active ||
      active.socket.destroyed ||
      active.epoch === null ||
      active.writeBlocked ||
      active.queuedAttemptedGateIds.length > 0 ||
      this.#pendingNotifications.size > 0
    ) return;
    const gateId = active.notificationQueue.shift();
    if (gateId === undefined) return;
    active.notificationWrites.add(gateId);
    const epoch = active.epoch;
    const task = this.#notificationWriter.notifyGate(gateId).then(() => {
      if (this.#active !== active || active.epoch !== epoch || active.socket.destroyed) return;
      if (active.writeBlocked) active.queuedAttemptedGateIds.push(gateId);
      else {
        this.#write(active, {
          version: CHANNEL_PROTOCOL_VERSION,
          type: 'attempted',
          connection_epoch: epoch,
          gate_id: gateId,
        });
      }
    }).catch(() => {
      this.#onError('mcp_write_failed');
    }).finally(() => {
      active.notificationWrites.delete(gateId);
      this.#pendingNotifications.delete(task);
      const current = this.#active;
      if (current !== null) this.#drainNotificationQueue(current);
    });
    this.#pendingNotifications.add(task);
  }

  #writeReceipt(active: ActiveConnection, gateId: string, pending: PendingReceipt): boolean {
    if (
      active.epoch === null ||
      active.daemonMonotonicSampleNs === null ||
      active.adapterMonotonicSampleNs === null ||
      active.writeBlocked ||
      active.socket.destroyed
    ) return false;
    // Leave a millisecond for the Adapter timer to retire the socket before any at-budget ACK can
    // be interpreted. The daemon applies the smaller of this remaining budget and its own cap.
    const nowNs = process.hrtime.bigint();
    const remainingNs = pending.deadlineNs - nowNs;
    const remainingMs = Math.min(
      CHANNEL_MAX_RECEIPT_ACK_BUDGET_MS,
      Number(remainingNs / NS_PER_MS) - 1,
    );
    if (remainingMs < 1) {
      pending.reject(new ChannelAdapterError('receipt_timeout'));
      active.socket.destroy();
      return false;
    }
    const daemonDeadlineNs = active.daemonMonotonicSampleNs +
      (pending.deadlineNs - active.adapterMonotonicSampleNs) - 1n;
    if (daemonDeadlineNs < 1n) {
      pending.reject(new ChannelAdapterError('receipt_timeout'));
      active.socket.destroy();
      return false;
    }
    return this.#write(active, {
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: active.epoch,
      gate_id: gateId,
      ack_budget_ms: remainingMs,
      ack_deadline_ns: daemonDeadlineNs.toString(),
    });
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
    if (active.epoch === null) return;
    while (active.queuedAttemptedGateIds.length > 0) {
      const gateId = active.queuedAttemptedGateIds.shift()!;
      this.#write(active, {
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'attempted',
        connection_epoch: active.epoch,
        gate_id: gateId,
      });
      if (active.writeBlocked || active.socket.destroyed) return;
    }
    for (const gateId of [...active.queuedReceiptGateIds]) {
      active.queuedReceiptGateIds.delete(gateId);
      const pending = active.pendingReceipts.get(gateId);
      if (pending === undefined) continue;
      this.#writeReceipt(active, gateId, pending);
      if (active.writeBlocked || active.socket.destroyed) break;
    }
    if (!active.writeBlocked && !active.socket.destroyed) this.#drainNotificationQueue(active);
  }

  #clearWriteState(active: ActiveConnection): void {
    if (active.writeTimer !== null) clearTimeout(active.writeTimer);
    active.writeTimer = null;
    active.writeBlocked = false;
    active.queuedAttemptedGateIds.length = 0;
    active.queuedReceiptGateIds.clear();
    active.notificationQueue.length = 0;
  }

  #rejectReceipts(active: ActiveConnection, code: ChannelAdapterErrorCode): void {
    for (const receipt of active.pendingReceipts.values()) {
      clearTimeout(receipt.timer);
      receipt.reject(new ChannelAdapterError(code));
    }
    active.pendingReceipts.clear();
    active.queuedReceiptGateIds.clear();
  }
}
