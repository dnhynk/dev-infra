import { randomUUID } from 'node:crypto';

import type { GateChannelDelivery, GateChannelDeliveryStore } from '../gate/resolution-types.js';
import { gateKey } from '../identity/keys.js';
import { readExactGate, type OrcaRunner } from '../orca/client.js';
import type { GateStore } from '../store/schema.js';
import type { ChannelDeliverySendResult } from './pipe-server.js';

export const DEFAULT_DELIVERY_ATTEMPT_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;
export const DEFAULT_DELIVERY_RECEIPT_BACKOFF_MS = 30_000;

export type GateChannelDeliveryTransport = {
  deliverGate(runId: string, gateId: string): Promise<ChannelDeliverySendResult>;
};

export type GateChannelDeliveryErrorCode =
  | 'gate_effect_read_failed'
  | 'gate_effect_mismatch'
  | 'gate_effect_pending'
  | 'channel_send_failed'
  | 'delivery_reconcile_failed'
  | `route_${Exclude<ChannelDeliverySendResult['kind'], 'sent'>}_${string}`;

export type GateChannelDeliveryEngineOptions = {
  readonly store: GateStore;
  readonly orca: OrcaRunner;
  readonly transport: GateChannelDeliveryTransport;
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly routeRetryMs?: number;
  readonly receiptBackoffMs?: number;
  readonly attemptDelaysMs?: readonly number[];
  readonly batchLimit?: number;
  /** Bounded codes only. No downstream message or payload is exposed. */
  readonly onError?: (code: GateChannelDeliveryErrorCode) => void;
};

function finiteMs(value: number, code: string): number {
  if (!Number.isFinite(value) || value < 1) throw new TypeError(code);
  return Math.trunc(value);
}

function later(at: string, delayMs: number): string {
  return new Date(new Date(at).valueOf() + delayMs).toISOString();
}

function wireId(key: `gate:${string}` | `run:${string}` | `task:${string}`): string {
  return key.slice(key.indexOf(':') + 1);
}

/**
 * Durable D3 scheduler. Pipe writes are merely scheduling attempts; Adapter `attempted` and
 * application `receipted` callbacks advance the store independently, and only a fresh exact Orca
 * reread can commit `consumed`.
 */
export class GateChannelDeliveryEngine {
  readonly #store: GateChannelDeliveryStore & Pick<GateStore, 'findGateResolution'>;
  readonly #orca: OrcaRunner;
  readonly #transport: GateChannelDeliveryTransport;
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #routeRetryMs: number;
  readonly #receiptBackoffMs: number;
  readonly #attemptDelaysMs: readonly number[];
  readonly #batchLimit: number;
  readonly #onError: (code: GateChannelDeliveryErrorCode) => void;

  constructor(options: GateChannelDeliveryEngineOptions) {
    this.#store = options.store;
    this.#orca = options.orca;
    this.#transport = options.transport;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = finiteMs(options.leaseMs ?? 30_000, 'delivery_lease_invalid');
    this.#routeRetryMs = finiteMs(options.routeRetryMs ?? 5_000, 'delivery_route_retry_invalid');
    this.#receiptBackoffMs = finiteMs(
      options.receiptBackoffMs ?? DEFAULT_DELIVERY_RECEIPT_BACKOFF_MS,
      'delivery_receipt_backoff_invalid',
    );
    const attemptDelays = options.attemptDelaysMs ?? DEFAULT_DELIVERY_ATTEMPT_DELAYS_MS;
    if (attemptDelays.length === 0) throw new TypeError('delivery_attempt_delays_empty');
    this.#attemptDelaysMs = attemptDelays.map((delay) =>
      finiteMs(delay, 'delivery_attempt_delay_invalid'));
    const batchLimit = options.batchLimit ?? 64;
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 1_000) {
      throw new TypeError('delivery_batch_limit_invalid');
    }
    this.#batchLimit = batchLimit;
    this.#onError = options.onError ?? (() => undefined);
  }

  /** Lazy seed plus one bounded due batch. Overlap is fenced in SQLite, not process memory. */
  async reconcile(): Promise<void> {
    const at = this.#now().toISOString();
    this.#store.seedPendingGateChannelDeliveries(at);
    const due = this.#store.listDueGateChannelDeliveries(at, this.#batchLimit);
    for (const delivery of due) await this.#reconcileOne(delivery);
  }

  /** Adapter-confirmed MCP transport write; never promoted to receipt or effect. */
  recordAttempted(gateId: string): GateChannelDelivery {
    const key = gateKey(gateId);
    const current = this.#store.findGateChannelDelivery(key);
    if (current === null) throw new Error('delivery_not_found');
    const at = this.#now().toISOString();
    const delay = this.#attemptDelaysMs[Math.min(
      current.attemptCount,
      this.#attemptDelaysMs.length - 1,
    )]!;
    const attempted = this.#store.markGateChannelAttempted(key, at, later(at, delay));
    if (attempted === null) throw new Error('delivery_not_found');
    return attempted;
  }

  /** Application receipt only. It stays due for an exact Gate effect reread. */
  recordReceipted(gateId: string): GateChannelDelivery {
    const receipted = this.#store.markGateChannelReceipted(
      gateKey(gateId),
      this.#now().toISOString(),
    );
    // The pipe withholds its ACK when this throws, so an unknown production Gate can never be
    // acknowledged without corresponding durable state.
    if (receipted === null) throw new Error('delivery_not_found');
    return receipted;
  }

  async #reconcileOne(candidate: GateChannelDelivery): Promise<void> {
    // Acquisition-specific ownership prevents a late completion from one overlapping reconcile
    // from releasing or consuming a newer lease held by this same daemon process.
    const owner = `p${process.pid}.${randomUUID()}`;
    const acquiredAt = this.#now().toISOString();
    const lease = this.#store.acquireGateChannelDeliveryLease(
      candidate.gateKey,
      owner,
      acquiredAt,
      later(acquiredAt, this.#leaseMs),
    );
    if (lease.kind !== 'acquired') return;
    let current = lease.delivery;
    let released = false;
    let effectCode: GateChannelDeliveryErrorCode | null = null;
    try {
      if (current.state === 'receipted') {
        let fresh;
        try {
          const intent = this.#store.findGateResolution(current.gateKey);
          if (
            intent === null ||
            intent.preRead === null ||
            intent.postRead === null
          ) throw new Error('missing_d2_evidence');
          fresh = await readExactGate(this.#orca, {
            gateId: wireId(current.gateKey),
            runId: wireId(current.runKey),
            taskId: wireId(current.taskKey),
            options: intent.preRead.options,
          });
        } catch {
          this.#onError('gate_effect_read_failed');
          released = this.#defer(
            current,
            owner,
            this.#receiptBackoffMs,
            'gate_effect_read_failed',
          );
          return;
        }
        if (fresh.status === 'resolved') {
          const consume = this.#store.consumeGateChannelDelivery(
            current.gateKey,
            current.revision,
            owner,
            fresh,
            this.#now().toISOString(),
          );
          if (consume.kind === 'consumed' || consume.kind === 'duplicate') {
            released = true;
            return;
          }
          if (consume.kind === 'mismatch') {
            this.#onError('gate_effect_mismatch');
            released = this.#defer(
              current,
              owner,
              this.#receiptBackoffMs,
              'gate_effect_mismatch',
            );
            return;
          }
          return;
        }
        // A current exact pending Gate means the coordinator effect has not happened yet. The
        // receipt slows duplicate delivery but does not suppress it (OD-066).
        effectCode = 'gate_effect_pending';
      }

      let result: ChannelDeliverySendResult;
      try {
        result = await this.#transport.deliverGate(
          wireId(current.runKey),
          wireId(current.gateKey),
        );
      } catch {
        this.#onError('channel_send_failed');
        released = this.#defer(
          current,
          owner,
          this.#retryDelay(current),
          'channel_send_failed',
        );
        return;
      }
      const errorCode = result.kind === 'sent'
        ? effectCode
        : (`route_${result.kind}_${result.code}` as const);
      if (errorCode !== null) this.#onError(errorCode);
      released = this.#defer(current, owner, this.#retryDelay(current), errorCode);
    } catch {
      this.#onError('delivery_reconcile_failed');
      const latest = this.#store.findGateChannelDelivery(current.gateKey);
      if (latest?.leaseOwner === owner) {
        current = latest;
        released = this.#defer(
          current,
          owner,
          this.#retryDelay(current),
          'delivery_reconcile_failed',
        );
      }
    } finally {
      if (!released) {
        this.#store.releaseGateChannelDeliveryLease(
          current.gateKey,
          owner,
          this.#now().toISOString(),
        );
      }
    }
  }

  #retryDelay(delivery: GateChannelDelivery): number {
    return delivery.state === 'receipted' ? this.#receiptBackoffMs : this.#routeRetryMs;
  }

  #defer(
    delivery: GateChannelDelivery,
    owner: string,
    delayMs: number,
    errorCode: GateChannelDeliveryErrorCode | null,
  ): boolean {
    const at = this.#now().toISOString();
    return this.#store.deferGateChannelDelivery(
      delivery.gateKey,
      delivery.revision,
      owner,
      at,
      later(at, delayMs),
      errorCode,
    ) !== null;
  }
}
