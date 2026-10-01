import type { GateMetadata } from './types.js';
import type { GateKey, RunKey, TaskKey } from '../identity/keys.js';

export const GATE_ACTION_PREFIX = 'orca_gate_resolve_v1';
export const GATE_BLOCK_PREFIX = 'orca_gate_fixed_options_v1';
export const GATE_FACT_CAP = 500;
export const GATE_AUDIT_LIMIT = 128;

export type GateObservedStatus = 'pending' | 'resolved';

/**
 * The producer records unsupported or internally inconsistent Orca states explicitly so an older
 * actionable `pending` observation can never survive a newer fail-closed observation.
 */
export type GateLocalStatus = GateObservedStatus | 'unsupported';

/** Last exact Orca Gate observation made by the production Run observer. */
export type GateLocalObservation = {
  readonly gateKey: GateKey;
  readonly runKey: RunKey;
  readonly taskKey: TaskKey;
  readonly status: GateLocalStatus;
  readonly resolution: string | null;
  readonly resolvedAt: string | null;
  readonly metadataState: 'matched' | 'missing' | 'mismatched';
  /** `write_pending` is a durable pre-Slack fence for an ordinary card update. */
  readonly mappingState: 'matched' | 'missing' | 'mismatched' | 'write_pending';
  readonly observedAt: string;
};

/**
 * Logical write candidate returned by the durable pre-Slack observation transaction. Its matched
 * correlation is revalidated by `beginGateObservationWrite`; the stored row may deliberately stay
 * `write_pending` or fail-closed until that atomic owner transition.
 */
export type GateObservationSaveResult = {
  readonly observation: GateLocalObservation;
  readonly revision: number;
  /** False means a newer/terminal snapshot won, so this caller may not render to Slack. */
  readonly current: boolean;
};

export type GateResolutionLifecycle =
  | 'claimed'
  | 'pre_read'
  | 'resolving'
  | 'uncertain'
  | 'post_read'
  | 'resolved'
  | 'conflict'
  | 'degraded';

export type GateSnapshot = {
  readonly gateId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly options: readonly string[];
  readonly status: GateObservedStatus;
  readonly resolution: string | null;
  readonly resolvedAt: string | null;
};

export type GateResolveResult = {
  readonly gate: GateSnapshot;
  readonly mutation: {
    readonly requestId: string;
    readonly replayed: boolean;
  };
};

/** Immutable winner facts plus the durable lifecycle of its one logical Orca mutation. */
export type GateResolutionIntent = {
  readonly gateKey: GateKey;
  /** Monotonic durable CAS generation for lifecycle ownership across daemon processes. */
  readonly revision: number;
  /** Only `acked` intents may cross either remote boundary. */
  readonly ackState: 'pending' | 'acked' | 'failed';
  /** Short renewable cross-process lease held while this daemon may call Orca. */
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly retryRequestId: string;
  readonly optionId: string;
  readonly optionResolution: string;
  readonly askMessageId: string;
  readonly questionThreadId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly apiAppId: string | null;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly blockId: string;
  readonly actionId: string;
  readonly actionValue: string;
  readonly lifecycle: GateResolutionLifecycle;
  /** Sticky provenance: unknown survives retries until structured same-request output is stored. */
  readonly mutationOwnership: 'not_started' | 'unknown' | 'structured';
  readonly preRead: GateSnapshot | null;
  readonly resolveResult: GateResolveResult | null;
  readonly postRead: GateSnapshot | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorDetail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type GateCardState = 'resolving' | 'resolved' | 'conflict' | 'degraded';

/** D2 owns the pending notification projection, but never sends the D3 notification. */
export type GateResolutionOutbox = {
  readonly gateKey: GateKey;
  /** Monotonic projection generation; a stale Slack completion may not clear a newer card. */
  readonly revision: number;
  readonly cardState: GateCardState;
  readonly cardPending: boolean;
  readonly notificationState: 'pending';
  readonly projectedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type GateClaimInput = {
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly apiAppId: string | null;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly blockId: string;
  readonly actionId: string;
  readonly actionValue: string;
  /** Generated before BEGIN and persisted only if this call wins the Gate-local CAS. */
  readonly retryRequestId: string;
  readonly at: string;
};

export type GateClaimResult =
  | { readonly kind: 'claimed'; readonly intent: GateResolutionIntent; readonly metadata: GateMetadata }
  | { readonly kind: 'duplicate'; readonly intent: GateResolutionIntent; readonly metadata: GateMetadata }
  | { readonly kind: 'lost'; readonly intent: GateResolutionIntent }
  | { readonly kind: 'rejected'; readonly reason: string };

export type GateLeaseResult =
  | { readonly kind: 'acquired'; readonly intent: GateResolutionIntent }
  | { readonly kind: 'busy'; readonly expiresAt: string }
  | { readonly kind: 'unavailable' };

export type GateProjectionLeaseResult =
  | 'acquired'
  | 'recovered'
  | 'busy'
  | 'superseded'
  | 'deferred';

/** Exact D3-3 opt-in for the one Channel-originated card generation it is authorized to render. */
export type GateChannelProjectionClaim = {
  readonly expectedDeliveryRevision: number;
  readonly expectedOutboxRevision: number;
};

/** Checked inside the SQLite transaction immediately before its durable commit. */
export type GateChannelDeliveryCommitFence = () => boolean;

export type GateChannelSeedResult =
  | { readonly kind: 'committed'; readonly deliveries: readonly GateChannelDelivery[] }
  | { readonly kind: 'fenced' };

export type GateChannelDeliveryState = 'pending' | 'attempted' | 'receipted' | 'consumed';

/**
 * v11 rows are `unavailable`: they may already have crossed the pipe before this code existed, so
 * a later snapshot can never be called pre-send. Only v12-created rows start `required` and may
 * advance to immutable `recorded` evidence before their first transport call.
 */
export type GateResumeBaselineState = 'unavailable' | 'required' | 'recorded';

/**
 * Additive D3 delivery state. The v10 Gate outbox remains the immutable D2 source row; this row is
 * a lazy materialization that can be retried without changing `notification_state='pending'`.
 */
export type GateChannelDelivery = {
  readonly gateKey: GateKey;
  readonly runKey: RunKey;
  readonly taskKey: TaskKey;
  readonly sourceDispatchId: string;
  /** Monotonic CAS/fencing generation for delivery state and lease ownership. */
  readonly revision: number;
  /** Exact D2 card-outbox generation re-armed by the latest D3 transition and deferred to D3-3. */
  readonly deferredOutboxRevision: number;
  readonly resumeBaselineState: GateResumeBaselineState;
  readonly state: GateChannelDeliveryState;
  /** Number of Adapter-confirmed MCP transport writes, not daemon pipe writes. */
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  /** Retry/requery eligibility. `consumed` is the only state with no next attempt. */
  readonly nextAttemptAt: string | null;
  readonly receiptedAt: string | null;
  readonly consumedAt: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  /** Bounded code only. Raw transport, Orca, Slack, or credential material is never persisted. */
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Normalized Orca facts only. Task result, worker resource, terminal text, and payloads are absent. */
export type GateResumeDispatchFact = {
  readonly dispatchId: string;
  readonly status: string;
};

export type GateResumeTaskFact = {
  readonly taskId: string;
  readonly status: string;
  readonly currentDispatchId: string | null;
  readonly dispatches: readonly GateResumeDispatchFact[];
};

/** Source identity plus the deterministic dependency-descendant closure at one strict reread. */
export type GateResumeSnapshot = {
  readonly schemaVersion: 1;
  readonly sourceTaskId: string;
  readonly sourceDispatchId: string;
  readonly candidates: readonly GateResumeTaskFact[];
};

export type GateResumeEvidence = {
  readonly kind: 'new_dispatch' | 'status_transition';
  readonly taskId: string;
  readonly dispatchId: string;
  readonly fromStatus: string | null;
  readonly toStatus: 'dispatched' | 'completed';
};

export type GateResumeObservation = {
  readonly gateKey: GateKey;
  readonly revision: number;
  readonly baseline: GateResumeSnapshot;
  readonly latest: GateResumeSnapshot | null;
  /** First positive evidence is latched and can never be downgraded by a later read failure. */
  readonly evidence: GateResumeEvidence | null;
  readonly nextObservationAt: string | null;
  readonly observedAt: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  /** Bounded code only. Raw Orca output is never persisted. */
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type GateResumeLeaseResult =
  | { readonly kind: 'acquired'; readonly observation: GateResumeObservation }
  | { readonly kind: 'busy'; readonly expiresAt: string }
  | { readonly kind: 'unavailable' };

export type GateChannelDeliveryLeaseResult =
  | { readonly kind: 'acquired'; readonly delivery: GateChannelDelivery }
  | { readonly kind: 'busy'; readonly expiresAt: string }
  | { readonly kind: 'unavailable' };

export type GateChannelConsumeResult =
  | { readonly kind: 'consumed'; readonly delivery: GateChannelDelivery }
  | { readonly kind: 'duplicate'; readonly delivery: GateChannelDelivery }
  | { readonly kind: 'mismatch' | 'superseded' };

/** Durable D3 API. Every remote side effect is outside SQLite and therefore fenced by this CAS. */
export interface GateChannelDeliveryStore {
  /** Idempotently materialize one bounded page of eligible terminal D2 pending notifications. */
  seedPendingGateChannelDeliveries(
    at: string,
    limit: number,
    commitFence: GateChannelDeliveryCommitFence,
  ): GateChannelSeedResult;
  findGateChannelDelivery(gateKey: GateKey): GateChannelDelivery | null;
  listDueGateChannelDeliveries(at: string, limit?: number): readonly GateChannelDelivery[];
  acquireGateChannelDeliveryLease(
    gateKey: GateKey,
    owner: string,
    at: string,
    expiresAt: string,
  ): GateChannelDeliveryLeaseResult;
  releaseGateChannelDeliveryLease(gateKey: GateKey, owner: string, at: string): boolean;
  /** Persist retry pacing/error and release the exact current lease without changing lifecycle. */
  deferGateChannelDelivery(
    gateKey: GateKey,
    expectedRevision: number,
    owner: string,
    at: string,
    nextAttemptAt: string,
    errorCode: string | null,
  ): GateChannelDelivery | null;
  /** Adapter-reported MCP transport write. A late report cannot regress receipt/consumption. */
  markGateChannelAttempted(
    gateKey: GateKey,
    at: string,
    nextAttemptAt: string,
    commitFence?: GateChannelDeliveryCommitFence,
  ): GateChannelDelivery | null;
  /** Application receipt only; it deliberately does not consume the event. */
  markGateChannelReceipted(
    gateKey: GateKey,
    at: string,
    commitFence?: GateChannelDeliveryCommitFence,
  ): GateChannelDelivery | null;
  /**
   * Commit `consumed` only when the fresh exact Gate matches the stored D2 pending→resolved
   * evidence. The state transition and D2 card-outbox re-arm are one SQLite transaction.
   */
  consumeGateChannelDelivery(
    gateKey: GateKey,
    expectedRevision: number,
    owner: string,
    freshGate: GateSnapshot,
    at: string,
  ): GateChannelConsumeResult;

  /** Persist the immutable strict pre-send baseline while retaining the exact delivery lease. */
  recordGateResumeBaseline(
    gateKey: GateKey,
    expectedDeliveryRevision: number,
    owner: string,
    baseline: GateResumeSnapshot,
    at: string,
  ): GateChannelDelivery | null;
  /**
   * 끝내 읽지 못한 baseline을 `unavailable`로 넘겨 delivery가 영원히 재시도하지 않게 한다.
   * 전달 liveness는 유지하고 재개 증거만 포기한다 — v11 legacy delivery와 같은 의미다.
   */
  markGateResumeBaselineUnavailable(
    gateKey: GateKey,
    expectedDeliveryRevision: number,
    owner: string,
    at: string,
  ): GateChannelDelivery | null;
  findGateResumeObservation(gateKey: GateKey): GateResumeObservation | null;
  listDueGateResumeObservations(at: string, limit?: number): readonly GateResumeObservation[];
  acquireGateResumeLease(
    gateKey: GateKey,
    expectedRevision: number,
    owner: string,
    at: string,
    expiresAt: string,
  ): GateResumeLeaseResult;
  /**
   * Commit one normalized reread. Positive evidence atomically re-arms the exact existing-card
   * generation; a stale resume owner advances neither fact nor projection.
   */
  recordGateResumeObservation(
    gateKey: GateKey,
    expectedRevision: number,
    owner: string,
    latest: GateResumeSnapshot | null,
    evidence: GateResumeEvidence | null,
    at: string,
    nextObservationAt: string,
    errorCode: string | null,
  ): GateResumeObservation | null;
  releaseGateResumeLease(gateKey: GateKey, owner: string, at: string): boolean;
}

export type GateProgressUpdate = {
  readonly lifecycle: GateResolutionLifecycle;
  readonly preRead?: GateSnapshot | null;
  readonly resolveResult?: GateResolveResult | null;
  readonly postRead?: GateSnapshot | null;
  readonly errorCode?: string | null;
  readonly errorDetail?: string | null;
  readonly cardState?: GateCardState;
  readonly at: string;
};

export interface GateResolutionStore {
  /**
   * Persist an observer snapshot. A first-publisher snapshot may require the Gate message to
   * remain absent so a stale pre-post read cannot downgrade a concurrently established mapping.
   */
  saveGateLocalObservation(
    observation: GateLocalObservation,
    expectedFirstMessage?: {
      readonly channelId: string;
      readonly threadTs: string | null;
    },
    /**
     * When present, confirm an earlier reservation without allocating a second generation. A
     * different current revision makes this caller stale; only a newly discovered fail-closed
     * correlation may still be persisted.
     */
    expectedRevision?: number,
  ): GateObservationSaveResult;
  findGateLocalObservation(gateKey: GateKey): GateLocalObservation | null;
  claimGateResolution(input: GateClaimInput): GateClaimResult;
  findGateResolution(gateKey: GateKey): GateResolutionIntent | null;
  listNonterminalGateResolutions(): readonly GateResolutionIntent[];
  acquireGateResolutionLease(
    gateKey: GateKey,
    owner: string,
    at: string,
    expiresAt: string,
  ): GateLeaseResult;
  renewGateResolutionLease(
    gateKey: GateKey,
    owner: string,
    at: string,
    expiresAt: string,
  ): boolean;
  releaseGateResolutionLease(gateKey: GateKey, owner: string): void;
  markGateResolutionAck(
    gateKey: GateKey,
    expectedRevision: number,
    ackState: 'acked' | 'failed',
    at: string,
  ): GateResolutionIntent | null;
  updateGateResolution(
    gateKey: GateKey,
    expectedRevision: number,
    leaseOwner: string,
    update: GateProgressUpdate,
  ): GateResolutionIntent | null;
  findGateResolutionOutbox(gateKey: GateKey): GateResolutionOutbox | null;
  listPendingGateOutboxes(): readonly GateResolutionOutbox[];
  /** Includes completed terminal cards so deterministic renderer drift is checked on reconcile. */
  listAcknowledgedGateOutboxes(): readonly GateResolutionOutbox[];
  /** Persisted before an ordinary Slack update so crash recovery cannot trust an older D2 fingerprint. */
  beginGateObservationWrite(
    gateKey: GateKey,
    at: string,
    expectedObservation: GateLocalObservation,
    expectedRevision: number,
    expectedMessageIdentity?: {
      readonly channelId: string;
      readonly threadTs: string | null;
    },
  ): boolean;
  /** A catchable local unwind ended; keep the durable fence but permit this owner to retry. */
  abandonGateObservationWrite(gateKey: GateKey): void;
  /** Serialize the remote Slack update for one outbox generation across daemon processes. */
  acquireGateOutboxProjection(
    gateKey: GateKey,
    expectedRevision: number,
    owner: string,
    at: string,
    channelClaim?: GateChannelProjectionClaim,
  ): GateProjectionLeaseResult;
  /** A completed card whose deterministic renderer changed must become a new pending generation. */
  rearmGateOutboxProjection(gateKey: GateKey, expectedRevision: number, at: string): boolean;
  markGateOutboxProjected(
    gateKey: GateKey,
    expectedRevision: number,
    renderFingerprint: string,
    owner: string,
    at: string,
    channelClaim?: GateChannelProjectionClaim,
  ): boolean;
  /** Release an ordinary completion and force the latest generation pending after ambiguity/failure. */
  releaseGateOutboxProjection(
    gateKey: GateKey,
    owner: string,
    at: string,
    channelClaim?: GateChannelProjectionClaim,
  ): boolean;
  recordGateAudit(gateKey: GateKey | null, event: string, reason: string, at: string): void;
  recordGateAttempt(gateKey: GateKey, phase: string, outcome: string, detail: string | null, at: string): void;
}
