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
  }

  resolveAndProject(gateKey: GateKey): Promise<void> {
    const running = this.active.get(gateKey);
    if (running !== undefined) return running;
    const task = this.runAndProject(gateKey).finally(() => {
      if (this.active.get(gateKey) === task) this.active.delete(gateKey);
    });
    this.active.set(gateKey, task);
    return task;
  }

  /** Startup reconciliation resumes every acknowledged nonterminal intent and pending card. */
  async reconcile(): Promise<void> {
    for (const intent of this.options.store.listNonterminalGateResolutions()) {
      await this.resolveAndProject(intent.gateKey);
    }
    for (const outbox of this.options.store.listPendingGateOutboxes()) {
      await this.project(outbox.gateKey);
    }
  }

  private async runAndProject(gateKey: GateKey): Promise<void> {
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
        await this.options.fault?.('after_ack_before_pre_read', gateKey);
        await this.project(gateKey);
        await this.reconcileIntent(intent, lease);
      } finally {
        clearInterval(renewal);
        // A catchable JS unwind is not a process crash. Always relinquish local ownership here;
        // an actual process death never runs finally and is recovered through authoritative expiry.
        this.options.store.releaseGateResolutionLease(gateKey, this.leaseOwner);
      }
    }
    await this.options.fault?.('after_post_read_before_projection', gateKey);
    await this.project(gateKey);
  }

  private async reconcileIntent(initial: GateResolutionIntent, lease: LeaseState): Promise<void> {
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
    this.options.store.recordGateAttempt(initial.gateKey, 'pre_read', 'started', null, this.at());
    if (!this.renewLease(initial.gateKey, lease)) return;
    let pre: GateSnapshot;
    try {
      pre = await readExactGate(this.options.orca, identity);
    } catch {
      this.uncertain(initial, 'pre_read_failed');
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

    await this.options.fault?.('after_pre_read_before_resolve', initial.gateKey);
    if (!this.renewLease(initial.gateKey, lease)) return;
    let edge: GateSnapshot;
    try {
      edge = await readExactGate(this.options.orca, identity);
    } catch {
      this.uncertain(preReadIntent, 'mutation_edge_read_failed');
      return;
    }
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
    this.options.store.recordGateAttempt(initial.gateKey, 'resolve', 'started', null, this.at());
    let result: GateResolveResult;
    try {
      result = await resolveExactGate(
        this.options.orca,
        identity,
        initial.optionResolution,
        initial.retryRequestId,
      );
    } catch {
      this.options.store.recordGateAttempt(initial.gateKey, 'resolve', 'response_unknown', null, this.at());
      await this.confirmAfterUnknown(resolvingIntent, identity, lease);
      return;
    }
    if (!this.renewLease(initial.gateKey, lease)) return;
    await this.options.fault?.(
      'after_resolve_response_before_result_persist',
      initial.gateKey,
    );
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

    if (!this.renewLease(initial.gateKey, lease)) return;
    let post: GateSnapshot;
    try {
      post = await readExactGate(this.options.orca, identity);
    } catch {
      this.uncertain(resultIntent, 'post_read_failed');
      return;
    }
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
  ): Promise<void> {
    if (!this.renewLease(intent.gateKey, lease)) return;
    let post: GateSnapshot;
    try {
      post = await readExactGate(this.options.orca, identity);
    } catch {
      this.uncertain(intent, 'response_unknown_post_read_failed');
      return;
    }
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

  private async project(gateKey: GateKey): Promise<void> {
    await projectGateResolutionCard(
      this.options.store,
      this.options.slack,
      gateKey,
      this.now,
      undefined,
      this.slackTimeoutMs,
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
