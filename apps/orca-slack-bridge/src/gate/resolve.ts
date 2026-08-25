import { randomUUID } from 'node:crypto';
import type { GateKey } from '../identity/keys.js';
import {
  readExactGate,
  resolveExactGate,
  type ExactGateIdentity,
  type OrcaRunner,
} from '../orca/client.js';
import { DEFAULT_SLACK_UPDATE_TIMEOUT_MS, type SlackPoster } from '../slack/post.js';
import type { GateStore } from '../store/schema.js';
import { projectGateResolutionCard } from './resolution-project.js';
import type { GateResolutionIntent, GateResolveResult, GateSnapshot } from './resolution-types.js';

export type GateResolutionFault =
  | 'after_ack_before_pre_read'
  | 'after_pre_read_before_resolve'
  | 'after_resolve_response_before_result_persist'
  | 'after_resolve_before_post_read'
  | 'after_post_read_before_projection';

export type GateResolutionEngineOptions = {
  readonly store: GateStore;
  readonly orca: OrcaRunner;
  readonly slack: SlackPoster;
  readonly now?: () => Date;
  readonly leaseNow?: () => Date;
  readonly leaseOwner?: string;
  readonly leaseDurationMs?: number;
  readonly slackTimeoutMs?: number;
  readonly reconcileBatchLimit?: number;
  readonly reconcileDeadlineMs?: number;
  readonly fault?: (point: GateResolutionFault, gateKey: GateKey) => void | Promise<void>;
};

function identityFor(
  intent: GateResolutionIntent,
  runId: string,
  labels: readonly string[],
): ExactGateIdentity {
  return {
    gateId: intent.gateKey.slice('gate:'.length),
    runId,
    taskId: intent.taskId,
    options: labels,
  };
}

function expected(snapshot: GateSnapshot, intent: GateResolutionIntent): boolean {
  return snapshot.status === 'resolved' && snapshot.resolution === intent.optionResolution;
}

function confirmedExpected(snapshot: GateSnapshot, intent: GateResolutionIntent): boolean {
  return (
    intent.resolveResult !== null &&
    expected(snapshot, intent) &&
    snapshot.resolvedAt === intent.resolveResult.gate.resolvedAt
  );
}

function mutationOwnershipMayBeAmbiguous(intent: GateResolutionIntent): boolean {
  return intent.mutationOwnership === 'unknown';
}

type LeaseState = { lost: boolean };

function boundedDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < minimum) {
    throw new TypeError(`${label} must be a finite number >= ${minimum}`);
  }
  return Math.trunc(candidate);
}

/**
 * Durable D2 worker. It never sends the D3 coordinator notification; that outbox remains pending.
 * The revision CAS elects one local lifecycle advance across daemon processes. Orca itself has no
 * CAS, so the final local fence narrows but cannot remove the external read→mutation TOCTOU window.
 */
export class GateResolutionEngine {
  private readonly active = new Map<GateKey, Promise<void>>();
  private readonly now: () => Date;
  private readonly leaseNow: () => Date;
  private readonly leaseOwner: string;
  private readonly leaseDurationMs: number;
  private readonly slackTimeoutMs: number;
  private readonly reconcileBatchLimit: number;
  private readonly reconcileDeadlineMs: number;
  private reconcileOffset = 0;

  constructor(private readonly options: GateResolutionEngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.leaseNow = options.leaseNow ?? (() => new Date());
    this.leaseOwner = options.leaseOwner ?? `p${process.pid}.${randomUUID()}`;
    this.leaseDurationMs = boundedDuration(
      options.leaseDurationMs,
      30_000,
      100,
      'leaseDurationMs',
    );
    this.slackTimeoutMs = boundedDuration(
      options.slackTimeoutMs,
      DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
      10,
      'slackTimeoutMs',
    );
    if (this.slackTimeoutMs > DEFAULT_SLACK_UPDATE_TIMEOUT_MS) {
      throw new TypeError(
        `slackTimeoutMs must be <= ${DEFAULT_SLACK_UPDATE_TIMEOUT_MS} so the durable projection lease stays live`,
      );
    }
    const reconcileBatchLimit = options.reconcileBatchLimit ?? 64;
    if (
      !Number.isSafeInteger(reconcileBatchLimit)
      || reconcileBatchLimit < 1
      || reconcileBatchLimit > 1_000
    ) throw new TypeError('reconcileBatchLimit must be an integer between 1 and 1000');
    this.reconcileBatchLimit = reconcileBatchLimit;
    this.reconcileDeadlineMs = boundedDuration(
      options.reconcileDeadlineMs,
      20_000,
      10,
      'reconcileDeadlineMs',
    );
  }

  resolveAndProject(gateKey: GateKey, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    const running = this.active.get(gateKey);
    if (running !== undefined) return running;
    const task = this.runAndProject(gateKey, signal).finally(() => {
      if (this.active.get(gateKey) === task) this.active.delete(gateKey);
    });
    this.active.set(gateKey, task);
    return task;
  }

  /** Startup reconciliation resumes work and also checks completed cards for renderer drift. */
  async reconcile(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const deadline = new AbortController();
    const combined = signal === undefined
      ? deadline.signal
      : AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), this.reconcileDeadlineMs);
    timer.unref?.();
    try {
      const work = [
        ...this.options.store.listNonterminalGateResolutions().map((intent) => ({
          kind: 'resolve' as const,
          gateKey: intent.gateKey,
        })),
        ...this.options.store.listAcknowledgedGateOutboxes().map((outbox) => ({
          kind: 'project' as const,
          gateKey: outbox.gateKey,
        })),
      ];
      if (work.length === 0) return;
      const start = this.reconcileOffset % work.length;
      const count = Math.min(this.reconcileBatchLimit, work.length);
      for (let index = 0; index < count; index += 1) {
        if (combined.aborted) return;
        const operation = work[(start + index) % work.length]!;
        if (operation.kind === 'resolve') {
          await this.resolveAndProject(operation.gateKey, combined);
        } else {
          await this.project(operation.gateKey, combined);
        }
        this.reconcileOffset = (start + index + 1) % work.length;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async runAndProject(gateKey: GateKey, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    let intent = this.options.store.findGateResolution(gateKey);
    if (intent === null || intent.ackState !== 'acked') return;
    if (!['resolved', 'conflict', 'degraded'].includes(intent.lifecycle)) {
      const leased = await this.acquireLease(gateKey);
      if (leased === null) return;
      intent = leased;
      const lease: LeaseState = { lost: false };
      const renewal = setInterval(() => {
        this.renewLease(gateKey, lease);
      }, Math.max(10, Math.trunc(this.leaseDurationMs / 3)));
      renewal.unref?.();
      try {
        if (signal?.aborted) return;
        await this.options.fault?.('after_ack_before_pre_read', gateKey);
        if (signal?.aborted) return;
        await this.project(gateKey, signal);
        await this.reconcileIntent(intent, lease, signal);
      } finally {
        clearInterval(renewal);
        // A catchable JS unwind is not a process crash. Always relinquish local ownership here;
        // an actual process death never runs finally and is recovered through authoritative expiry.
        this.options.store.releaseGateResolutionLease(gateKey, this.leaseOwner);
      }
    }
    if (signal?.aborted) return;
    await this.options.fault?.('after_post_read_before_projection', gateKey);
    if (signal?.aborted) return;
    await this.project(gateKey, signal);
  }

  private async reconcileIntent(
    initial: GateResolutionIntent,
    lease: LeaseState,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    const metadata = this.options.store.findGateMetadata(initial.gateKey);
    if (metadata === null) {
      this.finish(initial, 'degraded', null, 'sidecar_missing');
      return;
    }
    const identity = identityFor(
      initial,
      metadata.runKey.slice('run:'.length),
      metadata.options.map((option) => option.label),
    );
    const hasStructuredMutationResult = initial.resolveResult !== null;
    const recoveringPersistedMutation =
      hasStructuredMutationResult && initial.preRead?.status === 'pending';
    const readPhase = recoveringPersistedMutation ? 'post_read' : 'pre_read';
    this.options.store.recordGateAttempt(initial.gateKey, readPhase, 'started', null, this.at());
    if (!this.renewLease(initial.gateKey, lease)) return;
    let pre: GateSnapshot;
    try {
      pre = await readExactGate(
        this.options.orca,
        identity,
        signal === undefined ? undefined : { signal },
      );
    } catch {
      if (signal?.aborted) return;
      this.uncertain(
        initial,
        recoveringPersistedMutation ? 'post_read_failed' : 'pre_read_failed',
      );
      return;
    }
    if (signal?.aborted) return;
    if (recoveringPersistedMutation) {
      // A structured resolve response proves that the mutation edge was already crossed. On
      // restart this read is the missing post-read, not a new baseline: overwriting the durable
      // pending preRead with the current resolved snapshot would destroy the D2 pending→resolved
      // evidence required by the additive D3 seed.
      this.options.store.recordGateAttempt(
        initial.gateKey,
        'post_read',
        'succeeded',
        null,
        this.at(),
      );
      const confirmed = confirmedExpected(pre, initial);
      this.finish(
        initial,
        confirmed ? 'resolved' : 'conflict',
        pre,
        confirmed
          ? null
          : pre.status === 'resolved'
            ? 'external_resolution'
            : 'post_mutation_state_changed',
      );
      return;
    }
    const preReadIntent = this.options.store.updateGateResolution(initial.gateKey, initial.revision, this.leaseOwner, {
      lifecycle: 'pre_read',
      preRead: pre,
      errorCode: null,
      errorDetail: null,
      at: this.at(),
    });
    if (preReadIntent === null) return;
    this.options.store.recordGateAttempt(initial.gateKey, 'pre_read', 'succeeded', null, this.at());
    if (pre.status === 'resolved') {
      const confirmed = hasStructuredMutationResult && confirmedExpected(pre, initial);
      const ownershipAmbiguous =
        !confirmed && mutationOwnershipMayBeAmbiguous(initial) && expected(pre, initial);
      this.finish(
        preReadIntent,
        confirmed ? 'resolved' : ownershipAmbiguous ? 'degraded' : 'conflict',
        pre,
        confirmed ? null : ownershipAmbiguous ? 'mutation_ownership_ambiguous' : 'external_resolution',
      );
      return;
    }
    if (preReadIntent.resolveResult !== null) {
      this.finish(preReadIntent, 'conflict', pre, 'post_mutation_state_changed');
      return;
    }

    if (signal?.aborted) return;
    await this.options.fault?.('after_pre_read_before_resolve', initial.gateKey);
    if (signal?.aborted) return;
    if (!this.renewLease(initial.gateKey, lease)) return;
    let edge: GateSnapshot;
    try {
      edge = await readExactGate(
        this.options.orca,
        identity,
        signal === undefined ? undefined : { signal },
      );
    } catch {
      if (signal?.aborted) return;
      this.uncertain(preReadIntent, 'mutation_edge_read_failed');
      return;
    }
    if (signal?.aborted) return;
    if (edge.status === 'resolved') {
      const ownershipAmbiguous =
        mutationOwnershipMayBeAmbiguous(preReadIntent) && expected(edge, preReadIntent);
      this.finish(
        preReadIntent,
        ownershipAmbiguous ? 'degraded' : 'conflict',
        edge,
        ownershipAmbiguous ? 'mutation_ownership_ambiguous' : 'external_resolution',
      );
      return;
    }

    const resolvingIntent = this.options.store.updateGateResolution(
      initial.gateKey,
      preReadIntent.revision,
      this.leaseOwner,
      {
        lifecycle: 'resolving',
        errorCode: null,
        errorDetail: null,
        at: this.at(),
      },
    );
    if (resolvingIntent === null) return;
    // Final durable local fence. A concurrently persisted conflict/terminal result wins. The
    // remaining interval between this read and Orca is the disclosed external-resolver residual.
    const fenced = this.options.store.findGateResolution(initial.gateKey);
    if (
      fenced === null ||
      fenced.revision !== resolvingIntent.revision ||
      fenced.lifecycle !== 'resolving' ||
      fenced.leaseOwner !== this.leaseOwner
    ) {
      return;
    }
    // Renewal is an expiry-authoritative mutation fence: a delayed timer or failed renewal marks
    // ownership lost, and this worker never starts Orca after that point. The timer keeps a normal
    // in-flight call covered; every physical retry still uses the one durable logical request ID.
    if (!this.renewLease(initial.gateKey, lease)) return;
    if (signal?.aborted) return;
    this.options.store.recordGateAttempt(initial.gateKey, 'resolve', 'started', null, this.at());
    let result: GateResolveResult;
    try {
      result = await resolveExactGate(
        this.options.orca,
        identity,
        initial.optionResolution,
        initial.retryRequestId,
        signal === undefined ? undefined : { signal },
      );
    } catch {
      if (signal?.aborted) return;
      this.options.store.recordGateAttempt(initial.gateKey, 'resolve', 'response_unknown', null, this.at());
      await this.confirmAfterUnknown(resolvingIntent, identity, lease, signal);
      return;
    }
    if (signal?.aborted) return;
    if (!this.renewLease(initial.gateKey, lease)) return;
    await this.options.fault?.(
      'after_resolve_response_before_result_persist',
      initial.gateKey,
    );
    if (signal?.aborted) return;
    const stored = this.options.store.updateGateResolution(
      initial.gateKey,
      resolvingIntent.revision,
      this.leaseOwner,
      {
        lifecycle: 'post_read',
        resolveResult: result,
        errorCode: null,
        errorDetail: null,
        at: this.at(),
      },
    );
    if (stored === null) return;
    const resultIntent = stored;
    this.options.store.recordGateAttempt(
      initial.gateKey,
      'resolve',
      result.mutation.replayed ? 'replayed' : 'succeeded',
      null,
      this.at(),
    );
    await this.options.fault?.('after_resolve_before_post_read', initial.gateKey);

    if (signal?.aborted) return;
    if (!this.renewLease(initial.gateKey, lease)) return;
    let post: GateSnapshot;
    try {
      post = await readExactGate(
        this.options.orca,
        identity,
        signal === undefined ? undefined : { signal },
      );
    } catch {
      if (signal?.aborted) return;
      this.uncertain(resultIntent, 'post_read_failed');
      return;
    }
    if (signal?.aborted) return;
    this.options.store.recordGateAttempt(initial.gateKey, 'post_read', 'succeeded', null, this.at());
    const confirmed = confirmedExpected(post, resultIntent);
    this.finish(
      resultIntent,
      confirmed ? 'resolved' : 'conflict',
      post,
      confirmed ? null : 'final_state_mismatch',
    );
  }

  private async confirmAfterUnknown(
    intent: GateResolutionIntent,
    identity: ExactGateIdentity,
    lease: LeaseState,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    if (!this.renewLease(intent.gateKey, lease)) return;
    let post: GateSnapshot;
    try {
      post = await readExactGate(
        this.options.orca,
        identity,
        signal === undefined ? undefined : { signal },
      );
    } catch {
      if (signal?.aborted) return;
      this.uncertain(intent, 'response_unknown_post_read_failed');
      return;
    }
    if (signal?.aborted) return;
    if (expected(post, intent)) {
      // The mutation response was lost, so equal final text cannot distinguish our request from
      // an external resolver that selected the same option in the response-loss window.
      this.finish(intent, 'degraded', post, 'mutation_ownership_ambiguous');
    } else if (post.status === 'resolved') {
      this.finish(intent, 'conflict', post, 'external_resolution');
    } else {
      this.uncertain(intent, 'response_unknown_pending');
    }
  }

  private uncertain(intent: GateResolutionIntent, code: string): void {
    this.options.store.updateGateResolution(intent.gateKey, intent.revision, this.leaseOwner, {
      lifecycle: 'uncertain',
      errorCode: code,
      errorDetail: null,
      cardState: 'degraded',
      at: this.at(),
    });
  }

  private finish(
    intent: GateResolutionIntent,
    lifecycle: 'resolved' | 'conflict' | 'degraded',
    postRead: GateSnapshot | null,
    errorCode: string | null,
  ): void {
    this.options.store.updateGateResolution(intent.gateKey, intent.revision, this.leaseOwner, {
      lifecycle,
      postRead,
      errorCode,
      errorDetail: null,
      at: this.at(),
    });
  }

  private async project(gateKey: GateKey, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await projectGateResolutionCard(
      this.options.store,
      this.options.slack,
      gateKey,
      this.now,
      undefined,
      this.slackTimeoutMs,
      signal,
    );
  }

  private async acquireLease(gateKey: GateKey): Promise<GateResolutionIntent | null> {
    const at = this.leaseInstant();
    const result = this.options.store.acquireGateResolutionLease(
      gateKey,
      this.leaseOwner,
      at.toISOString(),
      this.leaseExpiry(at),
    );
    // Reconciliation is a nonblocking pass across every Gate. A live renewable owner is retried
    // by the next periodic pass; waiting here would starve later Gates and hang daemon shutdown.
    return result.kind === 'acquired' ? result.intent : null;
  }

  private renewLease(gateKey: GateKey, lease: LeaseState): boolean {
    if (lease.lost) return false;
    try {
      const at = this.leaseInstant();
      const renewed = this.options.store.renewGateResolutionLease(
        gateKey,
        this.leaseOwner,
        at.toISOString(),
        this.leaseExpiry(at),
      );
      if (!renewed) lease.lost = true;
      return renewed;
    } catch {
      lease.lost = true;
      return false;
    }
  }

  private leaseInstant(): Date {
    const at = this.leaseNow();
    if (!(at instanceof Date) || !Number.isFinite(at.valueOf())) {
      throw new TypeError('lease clock returned an invalid Date');
    }
    return at;
  }

  private leaseExpiry(at: Date): string {
    return new Date(at.valueOf() + this.leaseDurationMs).toISOString();
  }

  private at(): string {
    return this.now().toISOString();
  }
}
