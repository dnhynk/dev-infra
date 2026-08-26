import type { CanonicalGithubRepository, EffectiveProjectOrigin } from '../discovery/types.js';
import type { PullRequestKey, RunKey } from '../identity/keys.js';

export type RepositoryRegistryInput = CanonicalGithubRepository & {
  readonly githubRepositoryId: number | null;
  readonly projectKey: string;
  readonly projectOrigin: EffectiveProjectOrigin;
  /** Only verified observations may replace last-known-good identity facts. */
  readonly evidence: DiscoveryObservationEvidence;
};

export type OrcaRepositoryBindingInput = {
  readonly orcaRepositoryId: string;
  readonly canonicalKey: CanonicalGithubRepository['canonicalKey'] | null;
  readonly projectKey: string;
  /** A null canonical key is valid only for the explicit manual-ID fallback. */
  readonly origin: 'manual' | 'discovered';
  /** Carried-forward rows retain their durable evidence timestamps unchanged. */
  readonly evidence: DiscoveryObservationEvidence;
};

export type DiscoveryPassOutcome = 'succeeded' | 'failed';
export type DiscoveryObservationEvidence = 'verified' | 'carried_forward';
export type DiscoveryRoutingSnapshotMode = 'reconcile' | 'replace';

export type RepositoryDiscoveryIssueCategory =
  | 'no_remote'
  | 'unsupported_remote'
  | 'invalid_remote'
  | 'canonical_conflict'
  | 'duplicate_orca_id'
  | 'manual_remote_conflict'
  | 'capacity_conflict'
  | 'schema_drift'
  | 'project_conflict'
  | 'query_failed'
  | 'github_identity_unverified'
  | 'capacity_deferred';

export type RepositoryDiscoveryIssueInput = {
  /** SHA-256 hex of the private issue identity; no raw ID, URL, path, or payload is stored. */
  readonly issueHash: string;
  readonly category: RepositoryDiscoveryIssueCategory;
};

export type ReplaceDiscoverySnapshotInput = {
  /** Failed whole passes record diagnostics but never consume grace or replace LKG. */
  readonly passOutcome: DiscoveryPassOutcome;
  /**
   * `replace` atomically discards the prior routing generation before writing current facts.
   * Non-routing discovery issue history is preserved. It is valid only for a successful pass.
   */
  readonly routingMode?: DiscoveryRoutingSnapshotMode;
  readonly repositories: readonly RepositoryRegistryInput[];
  readonly bindings: readonly OrcaRepositoryBindingInput[];
  readonly issues: readonly RepositoryDiscoveryIssueInput[];
  readonly at: string;
};

export type RepositoryRegistryRecord = Omit<RepositoryRegistryInput, 'evidence'> & {
  readonly active: boolean;
  /** Consecutive successful discovery passes in which this identity was absent. */
  readonly consecutiveMissingPasses: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastGoodAt: string;
  readonly updatedAt: string;
};

export type OrcaRepositoryBindingRecord = Omit<OrcaRepositoryBindingInput, 'evidence'> & {
  readonly active: boolean;
  /** Consecutive successful discovery passes in which this exact Orca ID was absent. */
  readonly consecutiveMissingPasses: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastGoodAt: string;
  readonly updatedAt: string;
};

export type RepositoryDiscoveryIssueRecord = RepositoryDiscoveryIssueInput & {
  readonly active: boolean;
  readonly occurrenceCount: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly resolvedAt: string | null;
  readonly updatedAt: string;
};

export type EffectiveDiscoverySnapshot = {
  readonly repositories: readonly RepositoryRegistryRecord[];
  readonly bindings: readonly OrcaRepositoryBindingRecord[];
  readonly issues: readonly RepositoryDiscoveryIssueRecord[];
};

export type DaemonDesiredState = 'running' | 'stopped';
export type DaemonRuntimeState = 'running' | 'stopped';

/** Finite redacted catalog. Operational tables never accept free-form errors. */
export const OPERATIONAL_FAILURE_CODES = [
  'startup_recovery',
  'validation.failed',
  'transport.unknown',
  'commit.unknown',
  'github.unavailable',
  'config.invalid',
  'config.drift',
  'schema.drift',
  'daemon.startup_failed',
  'daemon.heartbeat_failed',
  'logger.write_failed',
  'discovery.no_remote',
  'discovery.unsupported_remote',
  'discovery.invalid_remote',
  'discovery.canonical_conflict',
  'discovery.duplicate_orca_id',
  'discovery.manual_remote_conflict',
  'discovery.capacity_conflict',
  'discovery.schema_drift',
  'discovery.project_conflict',
  'discovery.query_failed',
  'discovery.github_unavailable',
  'discovery.github_identity_unverified',
  'discovery.capacity_deferred',
  'run.query_failed',
  'run.schema_drift',
  'run.timeout',
  'run.capacity_deferred',
  'digest.query_failed',
  'digest.github_unavailable',
  'digest.timeout',
  'digest.capacity_deferred',
  'gate.reconcile_failed',
  'channel.delivery_failed',
  'scheduler.timeout',
  'scheduler.aborted',
  'slack.validation_failed',
  'slack.transport_unknown',
  'slack.commit_unknown',
] as const;

export type OperationalFailureCode = typeof OPERATIONAL_FAILURE_CODES[number];

export type DaemonHealthRecord = {
  readonly revision: number;
  readonly instanceId: string;
  readonly buildFingerprint: string;
  readonly configFingerprint: string;
  readonly desiredState: DaemonDesiredState;
  readonly state: DaemonRuntimeState;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly cleanStoppedAt: string | null;
  readonly lastErrorCode: OperationalFailureCode | null;
  readonly updatedAt: string;
};

export type DaemonStartInput = {
  readonly instanceId: string;
  readonly buildFingerprint: string;
  readonly configFingerprint: string;
  readonly at: string;
};

export type DaemonJobName =
  | 'repository-discovery'
  | 'run-observer'
  | 'pr-digest'
  | 'gate-reconcile'
  | 'channel-delivery';

export type DaemonJobState = 'running' | 'succeeded' | 'failed' | 'backoff';

export type DaemonJobOutcomeRecord = {
  readonly jobName: DaemonJobName;
  readonly revision: number;
  readonly state: DaemonJobState;
  readonly attempt: number;
  readonly consecutiveFailures: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly durationMs: number | null;
  readonly nextRunAt: string | null;
  readonly errorCode: OperationalFailureCode | null;
  readonly processedCount: number;
  readonly deferredCount: number;
  readonly checkpoint: number;
  readonly updatedAt: string;
};

export type DaemonJobClaim = {
  readonly jobName: DaemonJobName;
  readonly revision: number;
  readonly startedAt: string;
};

export type DaemonJobCompletion = {
  readonly claim: DaemonJobClaim;
  readonly at: string;
  readonly durationMs: number;
  readonly processedCount?: number;
  readonly deferredCount?: number;
  /** Checkpoints may advance on success but can never move backwards. */
  readonly checkpoint?: number;
};

export type DaemonJobSuccessCompletion = DaemonJobCompletion & {
  /** Completion-based regular schedule; the next run cannot precede this success. */
  readonly nextRunAt: string;
};

export type OperationalAggregateCounts = {
  readonly pending: {
    readonly gateCards: number;
    readonly channelDeliveries: number;
    readonly resumeBaselines: number;
    readonly legacyNotifications: number;
    readonly slackRootIntents: number;
    readonly total: number;
  };
  readonly uncertain: {
    readonly slackRootIntents: number;
    readonly total: number;
  };
  readonly dead: {
    /** Pre-v12 deliveries whose resume baseline can no longer be proven. */
    readonly unavailableResumeBaselines: number;
    readonly total: number;
  };
};

export type SlackRootEntity =
  | { readonly kind: 'pr'; readonly key: PullRequestKey }
  | { readonly kind: 'run'; readonly key: RunKey }
  | { readonly kind: 'run_collection'; readonly key: 'run_collection' };

export type SlackRootIntentState = 'pending' | 'sending' | 'posted' | 'uncertain';

export type SlackRootIntentRecord = SlackRootEntity & {
  readonly revision: number;
  readonly channelId: string;
  readonly renderFingerprint: string;
  readonly state: SlackRootIntentState;
  readonly attemptCount: number;
  readonly sendingInstanceId: string | null;
  readonly messageTs: string | null;
  readonly preparedAt: string;
  readonly lastAttemptAt: string | null;
  readonly postedAt: string | null;
  readonly uncertainAt: string | null;
  readonly lastErrorCode: OperationalFailureCode | null;
  readonly updatedAt: string;
};

export type PrepareSlackRootIntentInput = SlackRootEntity & {
  readonly channelId: string;
  readonly renderFingerprint: string;
  readonly at: string;
};

export type SlackRootClaim = SlackRootEntity & {
  readonly revision: number;
  readonly instanceId: string;
  readonly claimedAt: string;
};

export type SlackRootClaimResult =
  | { readonly kind: 'claimed'; readonly claim: SlackRootClaim; readonly intent: SlackRootIntentRecord }
  | { readonly kind: 'not_claimed'; readonly intent: SlackRootIntentRecord };

export type SlackRootPostedMapping =
  | {
      readonly kind: 'pr';
      readonly factsFingerprint: string;
      readonly summaryJson: string | null;
    }
  | { readonly kind: 'run' }
  | { readonly kind: 'run_collection' };

export type SlackRootPostedInput = {
  readonly claim: SlackRootClaim;
  readonly messageTs: string;
  readonly mapping: SlackRootPostedMapping;
  readonly at: string;
};

export interface OperationalStore {
  replaceDiscoverySnapshot(input: ReplaceDiscoverySnapshotInput): EffectiveDiscoverySnapshot;
  /** Includes inactive rows so config-generation decisions cannot be made from the active view. */
  hasDiscoveryRoutingRows(): boolean;
  readEffectiveDiscoverySnapshot(): EffectiveDiscoverySnapshot;

  recordDaemonStart(input: DaemonStartInput): DaemonHealthRecord;
  recordDaemonHeartbeat(instanceId: string, at: string): DaemonHealthRecord | null;
  recordDaemonCleanStop(instanceId: string, at: string): DaemonHealthRecord | null;
  setDaemonDesiredState(state: DaemonDesiredState, at: string): DaemonHealthRecord | null;
  readDaemonHealth(): DaemonHealthRecord | null;

  startDaemonJob(jobName: DaemonJobName, at: string): DaemonJobClaim | null;
  completeDaemonJobSuccess(input: DaemonJobSuccessCompletion): DaemonJobOutcomeRecord | null;
  completeDaemonJobFailure(input: DaemonJobCompletion & { readonly errorCode: OperationalFailureCode }): DaemonJobOutcomeRecord | null;
  scheduleDaemonJobBackoff(jobName: DaemonJobName, expectedRevision: number, nextRunAt: string, at: string): DaemonJobOutcomeRecord | null;
  advanceDaemonJobCheckpoint(claim: DaemonJobClaim, expectedCheckpoint: number, checkpoint: number, at: string): DaemonJobOutcomeRecord | null;
  findDaemonJobOutcome(jobName: DaemonJobName): DaemonJobOutcomeRecord | null;

  readOperationalAggregateCounts(): OperationalAggregateCounts;

  prepareSlackRootIntent(input: PrepareSlackRootIntentInput): SlackRootIntentRecord;
  claimSlackRootIntent(entity: SlackRootEntity, instanceId: string, at: string): SlackRootClaimResult | null;
  markSlackRootIntentSafeRetry(claim: SlackRootClaim, errorCode: OperationalFailureCode, at: string): SlackRootIntentRecord | null;
  markSlackRootIntentUncertain(claim: SlackRootClaim, errorCode: OperationalFailureCode, at: string): SlackRootIntentRecord | null;
  markSlackRootIntentPosted(input: SlackRootPostedInput): SlackRootIntentRecord | null;
  recoverSlackRootIntents(instanceId: string, at: string): number;
  findSlackRootIntent(entity: SlackRootEntity): SlackRootIntentRecord | null;
}
