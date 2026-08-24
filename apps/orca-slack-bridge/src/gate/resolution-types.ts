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

export type GateProjectionLeaseResult = 'acquired' | 'recovered' | 'busy' | 'superseded';

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
  ): GateProjectionLeaseResult;
  /** A completed card whose deterministic renderer changed must become a new pending generation. */
  rearmGateOutboxProjection(gateKey: GateKey, expectedRevision: number, at: string): boolean;
  markGateOutboxProjected(
    gateKey: GateKey,
    expectedRevision: number,
    renderFingerprint: string,
    owner: string,
    at: string,
  ): boolean;
  /** Release an ordinary completion and force the latest generation pending after ambiguity/failure. */
  releaseGateOutboxProjection(gateKey: GateKey, owner: string, at: string): boolean;
  recordGateAudit(gateKey: GateKey | null, event: string, reason: string, at: string): void;
  recordGateAttempt(gateKey: GateKey, phase: string, outcome: string, detail: string | null, at: string): void;
}
