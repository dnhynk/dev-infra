import { randomUUID } from 'node:crypto';

import type { GateChannelDelivery, GateChannelDeliveryStore } from '../gate/resolution-types.js';
import { gateKey } from '../identity/keys.js';
import { readExactGate, type OrcaRunner } from '../orca/client.js';
import type { GateStore } from '../store/schema.js';
import type {
  ChannelDeliverySendResult,
  ChannelProductionCommitFence,
  ChannelProductionDeliveryEvent,
} from './pipe-server.js';
import { GateResumeEngine } from './resume.js';

export const DEFAULT_DELIVERY_ATTEMPT_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;
export const DEFAULT_DELIVERY_RECEIPT_BACKOFF_MS = 30_000;
export const DEFAULT_DELIVERY_RECONCILE_DEADLINE_MS = 20_000;
export const DEFAULT_DELIVERY_CONCURRENCY = 8;

export type GateChannelDeliveryTransport = {
  deliverGate(
    runId: string,
    gateId: string,
    signal?: AbortSignal,
  ): Promise<ChannelDeliverySendResult>;
};

export type GateChannelDeliveryErrorCode =
  | 'gate_effect_read_failed'
  | 'gate_effect_mismatch'
  | 'gate_effect_pending'
  | 'channel_send_failed'
  | 'resume_baseline_read_failed'
  | 'delivery_reconcile_deadline'
  | 'delivery_reconcile_failed'
  | `route_${Exclude<ChannelDeliverySendResult['kind'], 'sent'>}_${string}`;

export type GateChannelDeliveryEngineOptions = {
  readonly store: GateStore;
  readonly orca: OrcaRunner;
  readonly transport: GateChannelDeliveryTransport;
  readonly now?: () => Date;
  /** Test seam; production uses the process monotonic clock. */
  readonly monotonicNow?: () => number;
  readonly leaseMs?: number;
  readonly routeRetryMs?: number;
  readonly receiptBackoffMs?: number;
  readonly attemptDelaysMs?: readonly number[];
  readonly batchLimit?: number;
  readonly concurrency?: number;
  readonly reconcileDeadlineMs?: number;
  /** Bounded codes only. No downstream message or payload is exposed. */
  readonly onError?: (code: GateChannelDeliveryErrorCode) => void;
  /** Test seam; production always uses the strict persisted resume engine. */
  readonly resume?: Pick<GateResumeEngine, 'ensureBaseline' | 'reconcile'>;
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
  readonly #monotonicNow: () => number;
  readonly #leaseMs: number;
  readonly #routeRetryMs: number;
  readonly #receiptBackoffMs: number;
  readonly #attemptDelaysMs: readonly number[];
  readonly #batchLimit: number;
  readonly #concurrency: number;
  readonly #reconcileDeadlineMs: number;
  readonly #onError: (code: GateChannelDeliveryErrorCode) => void;
  readonly #resume: Pick<GateResumeEngine, 'ensureBaseline' | 'reconcile'>;
  #singleSlotPrefersSeed = true;

  constructor(options: GateChannelDeliveryEngineOptions) {
    this.#store = options.store;
    this.#orca = options.orca;
    this.#transport = options.transport;
    this.#now = options.now ?? (() => new Date());
    this.#monotonicNow = options.monotonicNow ??
      (() => Number(process.hrtime.bigint()) / 1_000_000);
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
    const concurrency = options.concurrency ?? DEFAULT_DELIVERY_CONCURRENCY;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      throw new TypeError('delivery_concurrency_invalid');
    }
    this.#concurrency = concurrency;
    this.#reconcileDeadlineMs = finiteMs(
      options.reconcileDeadlineMs ?? DEFAULT_DELIVERY_RECONCILE_DEADLINE_MS,
      'delivery_reconcile_deadline_invalid',
    );
    if (this.#reconcileDeadlineMs >= this.#leaseMs) {
      throw new TypeError('delivery_reconcile_deadline_must_precede_lease_expiry');
    }
    this.#onError = options.onError ?? (() => undefined);
    this.#resume = options.resume ?? new GateResumeEngine({
      store: options.store,
      orca: options.orca,
      now: this.#now,
      leaseMs: this.#leaseMs,
      batchLimit: this.#batchLimit,
    });
  }

  /** Lazy seed plus one bounded, concurrent, deadline-limited due batch. */
  async reconcile(): Promise<void> {
    const controller = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = this.#monotonicNow();
    if (!Number.isFinite(startedAt)) throw new TypeError('delivery_monotonic_clock_invalid');
    const deadlineAt = startedAt + this.#reconcileDeadlineMs;
    let resolveDeadline!: () => void;
    const deadline = new Promise<void>((resolve) => { resolveDeadline = resolve; });
    const expire = (): void => {
      if (expired) return;
      expired = true;
      this.#onError('delivery_reconcile_deadline');
      controller.abort();
      resolveDeadline();
    };
    const commitFence = (): boolean => {
      const current = this.#monotonicNow();
      if (!Number.isFinite(current)) return false;
      return !controller.signal.aborted && current < deadlineAt;
    };
    timer = setTimeout(expire, this.#reconcileDeadlineMs);
    timer.unref?.();
    const work = (async (): Promise<void> => {
      const at = this.#now().toISOString();
      let due: readonly GateChannelDelivery[] = [];
      if (this.#batchLimit === 1) {
        if (this.#singleSlotPrefersSeed) {
          const seed = this.#store.seedPendingGateChannelDeliveries(at, 1, commitFence);
          if (seed.kind === 'fenced') {
            expire();
            return;
          }
          if (seed.deliveries.length === 0 && commitFence()) {
            due = this.#store.listDueGateChannelDeliveries(at, 1);
          }
        } else {
          if (commitFence()) due = this.#store.listDueGateChannelDeliveries(at, 1);
          if (due.length === 0 && commitFence()) {
            const seed = this.#store.seedPendingGateChannelDeliveries(at, 1, commitFence);
            if (seed.kind === 'fenced') {
              expire();
              return;
            }
          }
        }
        this.#singleSlotPrefersSeed = !this.#singleSlotPrefersSeed;
      } else {
        const seedQuota = Math.max(1, Math.floor(this.#batchLimit / 2));
        const seed = this.#store.seedPendingGateChannelDeliveries(at, seedQuota, commitFence);
        if (seed.kind === 'fenced') {
          expire();
          return;
        }
        if (!commitFence()) {
          expire();
          return;
        }
        const sendLimit = this.#batchLimit - seed.deliveries.length;
        if (sendLimit > 0) {
          due = this.#store.listDueGateChannelDeliveries(at, sendLimit);
        }
      }
      if (!commitFence()) {
        expire();
        return;
      }
      if (due.length > 0) await this.#runBatch(due, controller.signal);
      if (commitFence()) await this.#resume.reconcile(controller.signal);
    })();
    try {
      await Promise.race([work, deadline]);
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (expired) void work.catch(() => undefined);
    }
  }

  async #runBatch(
    due: readonly GateChannelDelivery[],
    signal: AbortSignal,
  ): Promise<void> {
    let index = 0;
    const workers = Array.from(
      { length: Math.min(this.#concurrency, due.length) },
      async () => {
        while (!signal.aborted) {
          const candidate = due[index];
          index += 1;
          if (candidate === undefined) return;
          await this.#reconcileOne(candidate, signal);
        }
      },
    );
    await Promise.all(workers);
  }

  /**
   * Adapter-confirmed MCP transport write only: no Orca call or receipt authority, and the row
   * retains a finite attempt retry deadline so this historical fact cannot suppress replay.
   */
  recordAttempted(
    event: ChannelProductionDeliveryEvent,
    commitFence?: ChannelProductionCommitFence,
  ): GateChannelDelivery {
    const key = gateKey(event.gateId);
    const current = this.#store.findGateChannelDelivery(key);
    if (current === null) throw new Error('delivery_not_found');
    if (wireId(current.runKey) !== event.runId) throw new Error('delivery_token_mismatch');
    const at = this.#now().toISOString();
    const delay = this.#attemptDelaysMs[Math.min(
      current.attemptCount,
      this.#attemptDelaysMs.length - 1,
    )]!;
    const attempted = this.#store.markGateChannelAttempted(
      key,
      at,
      later(at, delay),
      commitFence,
    );
    if (attempted === null) throw new Error('delivery_not_found');
    return attempted;
  }

  /** Application receipt only. It stays due for an exact Gate effect reread. */
  recordReceipted(
    event: ChannelProductionDeliveryEvent,
    commitFence?: ChannelProductionCommitFence,
  ): GateChannelDelivery {
    const key = gateKey(event.gateId);
    const current = this.#store.findGateChannelDelivery(key);
    if (current === null) throw new Error('delivery_not_found');
    if (wireId(current.runKey) !== event.runId) throw new Error('delivery_token_mismatch');
    const receipted = this.#store.markGateChannelReceipted(
      key,
      this.#now().toISOString(),
      commitFence,
    );
    // The pipe withholds its ACK when this throws, so an unknown production Gate can never be
    // acknowledged without corresponding durable state.
    if (receipted === null) throw new Error('delivery_not_found');
    return receipted;
  }

  async #reconcileOne(
    candidate: GateChannelDelivery,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
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
    const abortLease = (): void => {
      if (released) return;
      try {
        const latest = this.#store.findGateChannelDelivery(current.gateKey);
        if (latest?.leaseOwner === owner) {
          current = latest;
          const deferred = this.#defer(
            latest,
            owner,
            this.#retryDelay(latest),
            'delivery_reconcile_deadline',
          );
          if (!deferred) {
            this.#store.releaseGateChannelDeliveryLease(
              latest.gateKey,
              owner,
              this.#now().toISOString(),
            );
          }
        }
      } catch {
        // The deadline path is best-effort only after strict startup validation succeeded. The
        // active worker will observe the aborted signal and cannot perform a later store write.
      } finally {
        // Late completion of an injected non-abort-aware dependency must never touch a closed DB.
        released = true;
      }
    };
    signal.addEventListener('abort', abortLease, { once: true });
    if (signal.aborted) abortLease();
    try {
      if (signal.aborted) return;
      try {
        const baselined = await this.#resume.ensureBaseline(current, owner, signal);
        if (baselined === null) {
          this.#onError('resume_baseline_read_failed');
          released = this.#defer(
            current,
            owner,
            this.#retryDelay(current),
            'resume_baseline_read_failed',
          );
          return;
        }
        current = baselined;
      } catch {
        if (signal.aborted) return;
        this.#onError('resume_baseline_read_failed');
        released = this.#defer(
          current,
          owner,
          this.#retryDelay(current),
          'resume_baseline_read_failed',
        );
        return;
      }
      if (signal.aborted) return;
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
          }, { signal });
        } catch {
          if (signal.aborted) return;
          this.#onError('gate_effect_read_failed');
          released = this.#defer(
            current,
            owner,
            this.#receiptBackoffMs,
            'gate_effect_read_failed',
          );
          return;
        }
        if (signal.aborted) return;
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
          signal,
        );
      } catch {
        if (signal.aborted) return;
        this.#onError('channel_send_failed');
        released = this.#defer(
          current,
          owner,
          this.#retryDelay(current),
          'channel_send_failed',
        );
        return;
      }
      if (signal.aborted) return;
      const errorCode = result.kind === 'sent'
        ? effectCode
        : (`route_${result.kind}_${result.code}` as const);
      if (errorCode !== null) this.#onError(errorCode);
      released = this.#defer(current, owner, this.#retryDelay(current), errorCode);
    } catch {
      if (signal.aborted) return;
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
      signal.removeEventListener('abort', abortLease);
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
