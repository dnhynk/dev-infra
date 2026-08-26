import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  defaultConfigPath,
  loadConfig,
  type ParsedBridgeConfig,
} from '../project/config.js';
import { SCHEMA_VERSION } from '../store/schema.js';
import { resolveStatePath, SqliteDigestStore } from '../store/sqlite.js';
import type {
  DaemonHealthRecord,
  DaemonJobName,
  DaemonJobOutcomeRecord,
  OperationalAggregateCounts,
  OperationalStore,
} from '../store/operational-types.js';
import { OPERATIONAL_FAILURE_CODES } from '../store/operational-types.js';
import {
  OPERATIONAL_JOB_NAMES,
  operationalLogPath,
  resolveOperationalLogDir,
} from './logger.js';
import {
  activeOperationalStatusCapability,
  CurrentUserOperationalStatusCapabilityStore,
  operationalStatusCapabilityIsFresh,
  operationalStatusCapabilityPath,
  operationalStatusStateIdentity,
  retiredOperationalStatusCapability,
  STATUS_OWNER_CAPABILITY_FUTURE_TOLERANCE_MS,
  STATUS_OWNER_CAPABILITY_MAX_AGE_MS,
  STATUS_OWNER_CAPABILITY_ROTATE_AFTER_MS,
  type ActiveOperationalStatusCapability,
  type OperationalStatusCapabilityStore,
  type OperationalStatusOwnerClaim,
  type OperationalStatusTransportEndpoint,
  type RetiredOperationalStatusCapability,
} from './status-capability.js';
export { OPERATIONAL_JOB_NAMES } from './logger.js';

export const STATUS_CODES = [
  'status.healthy',
  'config.invalid',
  'config.drift',
  'state.path_unavailable',
  'state.snapshot_unavailable',
  'schema.absent',
  'schema.drift',
  'schema.corrupt',
  'daemon.absent',
  'daemon.stopped',
  'daemon.stale',
  'daemon.clock_drift',
  'daemon.degraded',
  'build.unverified',
  'build.drift',
  'job.absent',
  'job.failed',
  'job.backoff',
  'registry.pending',
  'registry.rejected',
  'registry.deferred',
  'work.pending',
  'work.uncertain',
  'work.dead',
  'task.absent',
  'task.stopped',
  'task.drift',
] as const;

export type StatusCode = typeof STATUS_CODES[number];
export type StatusExitCode = 0 | 1 | 2;
export type TaskStatusFacet = {
  readonly ownership: 'unavailable' | 'absent' | 'matched' | 'drifted';
  readonly state: 'unavailable' | 'running' | 'stopped';
};

export type OperationalStatusReport = {
  readonly overall: 'healthy' | 'degraded' | 'unavailable';
  readonly exitCode: StatusExitCode;
  readonly codes: readonly StatusCode[];
  readonly schema: {
    readonly state: 'matched' | 'absent' | 'mismatched' | 'corrupt' | 'unavailable';
    readonly expectedVersion: number;
    readonly foundVersion: number | null;
  };
  readonly config: { readonly state: 'readable' | 'matched' | 'mismatched' | 'invalid' };
  readonly build: { readonly state: 'matched' | 'mismatched' | 'unverified' };
  readonly daemon: {
    readonly desiredState: 'running' | 'stopped' | 'absent';
    readonly state: 'running' | 'stopped' | 'absent';
    readonly heartbeatAgeSeconds: number | null;
    readonly staleAfterSeconds: number;
    readonly lastErrorCode: DaemonHealthRecord['lastErrorCode'];
  };
  readonly task: TaskStatusFacet;
  readonly logs: { readonly state: 'present' | 'absent' | 'unreadable' };
  readonly registry: {
    readonly active: number;
    readonly pending: number;
    readonly rejected: number;
    readonly deferred: number;
  };
  readonly work: {
    readonly pending: {
      readonly gateCards: number;
      readonly channelDeliveries: number;
      readonly resumeBaselines: number;
      readonly slackRootIntents: number;
      /** Legacy notification_state remains diagnostic and is never actionable. */
      readonly legacyNotifications: number;
      readonly actionableTotal: number;
    };
    readonly uncertain: OperationalAggregateCounts['uncertain'];
    readonly dead: OperationalAggregateCounts['dead'];
  };
  readonly jobs: readonly OperationalStatusJob[];
};

export type OperationalStatusJob = {
  readonly job: DaemonJobName;
  readonly state: DaemonJobOutcomeRecord['state'] | 'absent';
  readonly attempt: number;
  readonly consecutiveFailures: number;
  readonly durationMs: number | null;
  readonly nextRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly processedCount: number;
  readonly deferredCount: number;
  readonly errorCode: DaemonJobOutcomeRecord['errorCode'];
};

export type InspectOperationalStatusOptions = {
  readonly configPath?: string;
  readonly statePath?: string | null;
  readonly logDir?: string | null;
  readonly config?: ParsedBridgeConfig;
  /** Raw release identity. It is hashed before comparison and is never returned. */
  readonly expectedBuildIdentity?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly clock?: () => Date;
  readonly taskFacet?: () => TaskStatusFacet | Promise<TaskStatusFacet>;
  /** Safe projected test/adapter seam; production validates the same aggregate-only shape. */
  readonly snapshot?: OperationalStatusSnapshot;
  /** Deterministic test seam; production never exposes the read-only source connection. */
  readonly afterSqliteBackupStep?: () => void;
  /** Test-only parent for proving that the online snapshot leaves no temporary file. */
  readonly temporaryDirectory?: string;
  /** POSIX test seam; Windows endpoints come only from the protected owner capability. */
  readonly ownerPipePath?: string;
  /** Test seam for the protected capability artifact; production uses a per-user runtime path. */
  readonly ownerCapabilityPath?: string;
  /** Safe platform abstraction for synthetic permission/rotation races. */
  readonly ownerCapabilityStore?: OperationalStatusCapabilityStore;
  /** Bounded local owner request timeout. */
  readonly ownerTimeoutMilliseconds?: number;
  /** Transport freshness clock, deliberately separate from heartbeat classification time. */
  readonly ownerTransportClock?: () => Date;
};

export type OperationalStatusSnapshot = {
  readonly daemon: {
    readonly desiredState: DaemonHealthRecord['desiredState'];
    readonly state: DaemonHealthRecord['state'];
    readonly heartbeatAt: string;
    readonly lastErrorCode: DaemonHealthRecord['lastErrorCode'];
    readonly configState: 'matched' | 'mismatched';
    readonly buildState: 'matched' | 'mismatched' | 'unverified';
  } | null;
  readonly jobs: readonly OperationalStatusJob[];
  readonly registry: OperationalStatusReport['registry'];
  readonly work: OperationalStatusReport['work'];
};

export type OperationalStatusExpectations = {
  readonly configFingerprint: string;
  readonly buildFingerprint: string | null;
};

type CapturedOperationalStore = Omit<OperationalStatusSnapshot, 'daemon'> & {
  readonly daemon: DaemonHealthRecord | null;
};

type SnapshotResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'schema_absent' }
  | { readonly kind: 'schema_mismatch'; readonly version: number }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'owner_unavailable' }
  | { readonly kind: 'ready'; readonly value: OperationalStatusSnapshot };

const EMPTY_TASK: TaskStatusFacet = { ownership: 'unavailable', state: 'unavailable' };
const EMPTY_WORK: OperationalStatusReport['work'] = {
  pending: {
    gateCards: 0, channelDeliveries: 0, resumeBaselines: 0, slackRootIntents: 0,
    legacyNotifications: 0, actionableTotal: 0,
  },
  uncertain: { slackRootIntents: 0, total: 0 },
  dead: { unavailableResumeBaselines: 0, total: 0 },
};

function emptyJobs(): readonly OperationalStatusJob[] {
  return OPERATIONAL_JOB_NAMES.map((job) => ({
    job, state: 'absent', attempt: 0, consecutiveFailures: 0, durationMs: null,
    nextRunAt: null, lastSuccessAt: null, lastFailureAt: null,
    processedCount: 0, deferredCount: 0, errorCode: null,
  }));
}

function baseReport(staleAfterSeconds: number): OperationalStatusReport {
  return {
    overall: 'unavailable',
    exitCode: 2,
    codes: [],
    schema: { state: 'absent', expectedVersion: SCHEMA_VERSION, foundVersion: null },
    config: { state: 'invalid' },
    build: { state: 'unverified' },
    daemon: {
      desiredState: 'absent', state: 'absent', heartbeatAgeSeconds: null,
      staleAfterSeconds, lastErrorCode: null,
    },
    task: EMPTY_TASK,
    logs: { state: 'absent' },
    registry: { active: 0, pending: 0, rejected: 0, deferred: 0 },
    work: EMPTY_WORK,
    jobs: emptyJobs(),
  };
}

function withOutcome(
  report: Omit<OperationalStatusReport, 'overall' | 'exitCode' | 'codes'>,
  codes: ReadonlySet<StatusCode>,
  exitCode: StatusExitCode,
): OperationalStatusReport {
  const ordered = STATUS_CODES.filter((code) => codes.has(code));
  const finalCodes = ordered.length === 0 ? ['status.healthy' as const] : ordered;
  return {
    ...report,
    overall: exitCode === 0 ? 'healthy' : exitCode === 1 ? 'degraded' : 'unavailable',
    exitCode,
    codes: finalCodes,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Shared with O1-5 so the daemon and read-only status projection compare identical bytes. */
export function fingerprintOperationalConfig(config: ParsedBridgeConfig): string {
  return createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
}

/** Shared with O1-5; the raw build/release identity never enters status output. */
export function fingerprintOperationalBuild(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function schemaVersion(db: DatabaseSync): { readonly kind: 'absent' } | { readonly kind: 'version'; readonly value: number } | { readonly kind: 'corrupt' } {
  try {
    const table = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
    ).get();
    if (table === undefined) return { kind: 'absent' };
    const rows = db.prepare('SELECT id, version FROM schema_version').all() as readonly Record<string, unknown>[];
    if (rows.length !== 1 || rows[0]?.['id'] !== 1 || !Number.isSafeInteger(rows[0]?.['version'])) {
      return { kind: 'corrupt' };
    }
    return { kind: 'version', value: rows[0]['version'] as number };
  } catch {
    return { kind: 'corrupt' };
  }
}

function toJob(job: DaemonJobName, record: DaemonJobOutcomeRecord | null): OperationalStatusJob {
  return record === null ? {
    job, state: 'absent', attempt: 0, consecutiveFailures: 0, durationMs: null,
    nextRunAt: null, lastSuccessAt: null, lastFailureAt: null,
    processedCount: 0, deferredCount: 0, errorCode: null,
  } : {
    job, state: record.state, attempt: record.attempt,
    consecutiveFailures: record.consecutiveFailures, durationMs: record.durationMs,
    nextRunAt: record.nextRunAt, lastSuccessAt: record.lastSuccessAt,
    lastFailureAt: record.lastFailureAt, processedCount: record.processedCount,
    deferredCount: record.deferredCount, errorCode: record.errorCode,
  };
}

function captureOperationalStore(
  store: Pick<
    OperationalStore,
    'readDaemonHealth' | 'findDaemonJobOutcome' |
    'readEffectiveDiscoverySnapshot' | 'readOperationalAggregateCounts'
  >,
  afterDaemonCapture?: () => void,
): CapturedOperationalStore {
  const daemon = store.readDaemonHealth();
  afterDaemonCapture?.();
  const jobs = OPERATIONAL_JOB_NAMES.map((job) => toJob(job, store.findDaemonJobOutcome(job)));
  const discovery = store.readEffectiveDiscoverySnapshot();
  const counts = store.readOperationalAggregateCounts();
  const registry = {
    active: discovery.repositories.filter((repository) => repository.active).length,
    pending: discovery.issues.filter((issue) =>
      issue.active && issue.category === 'github_identity_unverified').length,
    deferred: discovery.issues.filter((issue) =>
      issue.active && issue.category === 'capacity_deferred').length,
    rejected: discovery.issues.filter((issue) => issue.active &&
      issue.category !== 'github_identity_unverified' && issue.category !== 'capacity_deferred').length,
  };
  // O1-2 preserves the legacy bucket in its diagnostic total. It is deliberately excluded here:
  // notification_state no longer owns an actionable D2/D3 unit once the sidecars exist.
  const actionableTotal = counts.pending.gateCards + counts.pending.channelDeliveries +
    counts.pending.resumeBaselines + counts.pending.slackRootIntents;
  return {
    daemon,
    jobs,
    registry,
    work: {
      pending: {
        gateCards: counts.pending.gateCards,
        channelDeliveries: counts.pending.channelDeliveries,
        resumeBaselines: counts.pending.resumeBaselines,
        slackRootIntents: counts.pending.slackRootIntents,
        legacyNotifications: counts.pending.legacyNotifications,
        actionableTotal,
      },
      uncertain: counts.uncertain,
      dead: counts.dead,
    },
  };
}

function projectCapturedOperationalStore(
  captured: CapturedOperationalStore,
  expectations: OperationalStatusExpectations,
): OperationalStatusSnapshot {
  const daemon = captured.daemon === null ? null : {
    desiredState: captured.daemon.desiredState,
    state: captured.daemon.state,
    heartbeatAt: captured.daemon.heartbeatAt,
    lastErrorCode: captured.daemon.lastErrorCode,
    configState: captured.daemon.configFingerprint === expectations.configFingerprint
      ? 'matched' as const
      : 'mismatched' as const,
    buildState: expectations.buildFingerprint === null
      ? 'unverified' as const
      : captured.daemon.buildFingerprint === expectations.buildFingerprint
        ? 'matched' as const
        : 'mismatched' as const,
  };
  return { ...captured, daemon };
}

/** Projects only aggregate/static facts; raw daemon identity and fingerprints never escape. */
export function projectOperationalStore(
  store: Pick<
    OperationalStore,
    'readDaemonHealth' | 'findDaemonJobOutcome' |
    'readEffectiveDiscoverySnapshot' | 'readOperationalAggregateCounts'
  >,
  expectations: OperationalStatusExpectations,
): OperationalStatusSnapshot {
  return projectCapturedOperationalStore(captureOperationalStore(store), expectations);
}

const STATUS_OWNER_PROTOCOL_VERSION = 2;
const STATUS_OWNER_MAX_REQUEST_BYTES = 1_024;
const STATUS_OWNER_MAX_RESPONSE_BYTES = 64 * 1024;
const STATUS_OWNER_MAX_CONNECTIONS = 8;
const STATUS_OWNER_DEFAULT_TIMEOUT_MS = 1_000;
const STATUS_OWNER_DEFAULT_ABSOLUTE_REQUEST_DEADLINE_MS = 2_000;
const STATUS_OWNER_DEFAULT_REFRESH_MS = 1_000;
const STATUS_OWNER_MESSAGE_MAX_AGE_MS = 5_000;
const STATUS_OWNER_MAX_ACCEPTED_NONCES = 2_048;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const FAILURE_CODE_SET = new Set<string>(OPERATIONAL_FAILURE_CODES);

type OwnerRequest = {
  readonly version: 2;
  readonly stateIdentity: string;
  readonly capabilityId: string;
  readonly transport: OperationalStatusTransportEndpoint;
  readonly nonce: string;
  readonly sentAt: string;
  readonly configFingerprint: string;
  readonly buildFingerprint: string | null;
  readonly authenticator: string;
};

type UnsignedOwnerRequest = Omit<OwnerRequest, 'authenticator'>;

type OwnerGeneration = {
  readonly capturedAt: string;
  readonly captured: CapturedOperationalStore;
  readonly capability: ActiveOperationalStatusCapability;
};

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return null;
  return record;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function boundedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000_000;
}

function nullableIso(value: unknown): value is string | null {
  return value === null || canonicalIso(value);
}

function ownerAuthenticator(secret: string, domain: 'request' | 'response', value: unknown): string {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`orca-slack-bridge-status-owner-v2:${domain}\0`, 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function sameAuthenticator(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || !FINGERPRINT_PATTERN.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function encodeOwnerFrame(value: unknown, maximumBytes: number): Buffer | null {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length === 0 || payload.length > maximumBytes - 4) return null;
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function declaredOwnerFrameLength(input: Buffer, maximumBytes: number): number | null {
  if (input.length < 4) return null;
  const declared = input.readUInt32BE(0);
  return declared > 0 && declared <= maximumBytes - 4 ? declared : -1;
}

function parseExactOwnerFrame(input: Buffer, maximumBytes: number): unknown | null {
  const declared = declaredOwnerFrameLength(input, maximumBytes);
  if (declared === null || declared < 0 || input.length !== declared + 4) return null;
  try {
    return JSON.parse(input.subarray(4).toString('utf8'));
  } catch {
    return null;
  }
}

function parseOwnerRequest(
  value: unknown,
  generation: OwnerGeneration,
  now: Date,
): OwnerRequest | null {
  const record = exactRecord(value, [
    'version', 'stateIdentity', 'capabilityId', 'nonce', 'sentAt',
    'transport', 'configFingerprint', 'buildFingerprint', 'authenticator',
  ]);
  if (record === null || record['version'] !== STATUS_OWNER_PROTOCOL_VERSION ||
      record['stateIdentity'] !== generation.capability.stateIdentity ||
      record['capabilityId'] !== generation.capability.capabilityId ||
      !sameCanonical(record['transport'], generation.capability.transport) ||
      typeof record['nonce'] !== 'string' || !NONCE_PATTERN.test(record['nonce']) ||
      !canonicalIso(record['sentAt']) ||
      typeof record['configFingerprint'] !== 'string' ||
      !FINGERPRINT_PATTERN.test(record['configFingerprint']) ||
      (record['buildFingerprint'] !== null &&
       (typeof record['buildFingerprint'] !== 'string' ||
        !FINGERPRINT_PATTERN.test(record['buildFingerprint'])))) return null;
  const age = now.getTime() - Date.parse(record['sentAt']);
  if (age < -STATUS_OWNER_CAPABILITY_FUTURE_TOLERANCE_MS ||
      age > STATUS_OWNER_MESSAGE_MAX_AGE_MS) return null;
  const unsigned: UnsignedOwnerRequest = {
    version: 2,
    stateIdentity: record['stateIdentity'] as string,
    capabilityId: record['capabilityId'] as string,
    transport: generation.capability.transport,
    nonce: record['nonce'],
    sentAt: record['sentAt'],
    configFingerprint: record['configFingerprint'],
    buildFingerprint: record['buildFingerprint'] as string | null,
  };
  if (!sameAuthenticator(
    ownerAuthenticator(generation.capability.secret, 'request', unsigned),
    record['authenticator'],
  )) return null;
  return { ...unsigned, authenticator: record['authenticator'] as string };
}

function parseStatusJob(value: unknown): OperationalStatusJob | null {
  const record = exactRecord(value, [
    'job', 'state', 'attempt', 'consecutiveFailures', 'durationMs', 'nextRunAt',
    'lastSuccessAt', 'lastFailureAt', 'processedCount', 'deferredCount', 'errorCode',
  ]);
  if (record === null || typeof record['job'] !== 'string' ||
      !(OPERATIONAL_JOB_NAMES as readonly string[]).includes(record['job']) ||
      typeof record['state'] !== 'string' ||
      !['absent', 'running', 'succeeded', 'failed', 'backoff'].includes(record['state']) ||
      !boundedInteger(record['attempt']) || !boundedInteger(record['consecutiveFailures']) ||
      (record['durationMs'] !== null && !boundedInteger(record['durationMs'])) ||
      !nullableIso(record['nextRunAt']) || !nullableIso(record['lastSuccessAt']) ||
      !nullableIso(record['lastFailureAt']) || !boundedInteger(record['processedCount']) ||
      !boundedInteger(record['deferredCount']) ||
      (record['errorCode'] !== null &&
       (typeof record['errorCode'] !== 'string' || !FAILURE_CODE_SET.has(record['errorCode'])))) {
    return null;
  }
  return record as unknown as OperationalStatusJob;
}

function parseOperationalStatusSnapshot(value: unknown): OperationalStatusSnapshot | null {
  try {
    const snapshot = exactRecord(value, ['daemon', 'jobs', 'registry', 'work']);
    if (snapshot === null || !Array.isArray(snapshot['jobs']) ||
        snapshot['jobs'].length !== OPERATIONAL_JOB_NAMES.length) return null;
    const jobs = snapshot['jobs'].map(parseStatusJob);
    if (jobs.some((job) => job === null)) return null;
    const jobNames = jobs.map((job) => job!.job);
    if (new Set(jobNames).size !== OPERATIONAL_JOB_NAMES.length ||
        OPERATIONAL_JOB_NAMES.some((job, index) => jobNames[index] !== job)) return null;

    let daemon: OperationalStatusSnapshot['daemon'] = null;
    if (snapshot['daemon'] !== null) {
      const input = exactRecord(snapshot['daemon'], [
        'desiredState', 'state', 'heartbeatAt', 'lastErrorCode', 'configState', 'buildState',
      ]);
      if (input === null || !['running', 'stopped'].includes(input['desiredState'] as string) ||
          !['running', 'stopped'].includes(input['state'] as string) ||
          !canonicalIso(input['heartbeatAt']) ||
          (input['lastErrorCode'] !== null &&
           (typeof input['lastErrorCode'] !== 'string' || !FAILURE_CODE_SET.has(input['lastErrorCode']))) ||
          !['matched', 'mismatched'].includes(input['configState'] as string) ||
          !['matched', 'mismatched', 'unverified'].includes(input['buildState'] as string)) return null;
      daemon = input as unknown as NonNullable<OperationalStatusSnapshot['daemon']>;
    }

    const registry = exactRecord(snapshot['registry'], ['active', 'pending', 'rejected', 'deferred']);
    if (registry === null || Object.values(registry).some((count) => !boundedInteger(count))) return null;
    const work = exactRecord(snapshot['work'], ['pending', 'uncertain', 'dead']);
    const pending = exactRecord(work?.['pending'], [
      'gateCards', 'channelDeliveries', 'resumeBaselines', 'slackRootIntents',
      'legacyNotifications', 'actionableTotal',
    ]);
    const uncertain = exactRecord(work?.['uncertain'], ['slackRootIntents', 'total']);
    const dead = exactRecord(work?.['dead'], ['unavailableResumeBaselines', 'total']);
    if (work === null || pending === null || uncertain === null || dead === null ||
        [...Object.values(pending), ...Object.values(uncertain), ...Object.values(dead)]
          .some((count) => !boundedInteger(count))) return null;
    if (pending['actionableTotal'] !==
        Number(pending['gateCards']) + Number(pending['channelDeliveries']) +
        Number(pending['resumeBaselines']) + Number(pending['slackRootIntents']) ||
        uncertain['total'] !== uncertain['slackRootIntents'] ||
        dead['total'] !== dead['unavailableResumeBaselines']) return null;

    return {
      daemon,
      jobs: jobs as readonly OperationalStatusJob[],
      registry: registry as unknown as OperationalStatusSnapshot['registry'],
      work: work as unknown as OperationalStatusSnapshot['work'],
    };
  } catch {
    return null;
  }
}

function transportNow(clock: () => Date): Date | null {
  try {
    const value = clock();
    return Number.isFinite(value.getTime()) ? value : null;
  } catch {
    return null;
  }
}

export function operationalStatusOwnerPipePath(
  statePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') throw new TypeError('status.owner_transport_invalid');
  const key = operationalStatusStateIdentity(statePath, platform).slice(0, 24);
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return `\0orca-slack-bridge-status-v2-${user}-${key}`;
}

function expectedOwnerTransport(
  value: unknown,
  statePath: string,
  pipePath: string | undefined,
  platform: NodeJS.Platform,
): value is OperationalStatusTransportEndpoint {
  if (platform === 'win32') {
    const record = exactRecord(value, ['kind', 'host', 'port']);
    return pipePath === undefined && record !== null && record['kind'] === 'tcp' &&
      record['host'] === '127.0.0.1' && Number.isSafeInteger(record['port']) &&
      Number(record['port']) >= 1 && Number(record['port']) <= 65_535;
  }
  const record = exactRecord(value, ['kind', 'path']);
  return record !== null && record['kind'] === 'pipe' &&
    record['path'] === (pipePath ?? operationalStatusOwnerPipePath(statePath, platform));
}

export type OperationalStatusOwnerServerLike = {
  start(): Promise<void>;
  refresh(): void;
  stop(): Promise<void>;
};

export type OperationalStatusOwnerServerOptions = {
  readonly statePath: string;
  readonly store: Pick<
    OperationalStore,
    'readDaemonHealth' | 'findDaemonJobOutcome' |
    'readEffectiveDiscoverySnapshot' | 'readOperationalAggregateCounts'
  >;
  readonly pipePath?: string;
  readonly capabilityPath?: string;
  readonly capabilityStore?: OperationalStatusCapabilityStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly clock?: () => Date;
  readonly refreshMilliseconds?: number | null;
  /** Test seam for the refreshing inactivity timeout. */
  readonly requestIdleTimeoutMilliseconds?: number;
  /** Test seam for the non-refreshing wall-clock request deadline. */
  readonly requestAbsoluteDeadlineMilliseconds?: number;
  readonly beforeRefresh?: () => void;
  readonly afterDaemonCapture?: () => void;
};

/**
 * The SQLite owner refreshes one private in-memory capture. Requests only compare hashes and
 * serialize the finite projection, so the status process never opens or maps the live DB/WAL/SHM.
 */
export class OperationalStatusOwnerServer implements OperationalStatusOwnerServerLike {
  private readonly platform: NodeJS.Platform;
  private readonly pipePath: string | null;
  private readonly stateIdentity: string;
  private readonly capabilityPath: string;
  private readonly capabilityStore: OperationalStatusCapabilityStore;
  private readonly clock: () => Date;
  private readonly refreshMilliseconds: number | null;
  private readonly requestIdleTimeoutMilliseconds: number;
  private readonly requestAbsoluteDeadlineMilliseconds: number;
  private server: Server | null = null;
  private ownerClaim: OperationalStatusOwnerClaim | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation: OwnerGeneration | null = null;
  private readonly sockets = new Set<Socket>();
  private acceptedNonceCapabilityId: string | null = null;
  private readonly acceptedNonces = new Map<string, number>();

  constructor(private readonly options: OperationalStatusOwnerServerOptions) {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    if (platform === 'win32' && options.pipePath !== undefined) {
      throw new TypeError('status.owner_transport_invalid');
    }
    this.platform = platform;
    this.pipePath = platform === 'win32'
      ? null
      : options.pipePath ?? operationalStatusOwnerPipePath(options.statePath, platform);
    this.stateIdentity = operationalStatusStateIdentity(options.statePath, platform);
    this.capabilityPath = options.capabilityPath ??
      operationalStatusCapabilityPath(options.statePath, env, platform);
    this.capabilityStore = options.capabilityStore ??
      new CurrentUserOperationalStatusCapabilityStore(platform, env);
    this.clock = options.clock ?? (() => new Date());
    const refreshMilliseconds = options.refreshMilliseconds ?? STATUS_OWNER_DEFAULT_REFRESH_MS;
    if (refreshMilliseconds !== null &&
        (!Number.isSafeInteger(refreshMilliseconds) || refreshMilliseconds < 100 ||
         refreshMilliseconds > STATUS_OWNER_CAPABILITY_MAX_AGE_MS)) {
      throw new TypeError('status.owner_refresh_invalid');
    }
    this.refreshMilliseconds = refreshMilliseconds;
    const idleTimeout = options.requestIdleTimeoutMilliseconds ?? STATUS_OWNER_DEFAULT_TIMEOUT_MS;
    const absoluteDeadline = options.requestAbsoluteDeadlineMilliseconds ??
      STATUS_OWNER_DEFAULT_ABSOLUTE_REQUEST_DEADLINE_MS;
    if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 10 || idleTimeout > 5_000 ||
        !Number.isSafeInteger(absoluteDeadline) || absoluteDeadline < 20 ||
        absoluteDeadline > 10_000 || absoluteDeadline <= idleTimeout) {
      throw new TypeError('status.owner_timeout_invalid');
    }
    this.requestIdleTimeoutMilliseconds = idleTimeout;
    this.requestAbsoluteDeadlineMilliseconds = absoluteDeadline;
  }

  refresh(): void {
    try {
      const previous = this.generation;
      const claim = this.ownerClaim;
      if (this.server === null || previous === null || claim === null) {
        throw new Error('status.snapshot_unavailable');
      }
      claim.assertHeld();
      this.options.beforeRefresh?.();
      const captured = captureOperationalStore(this.options.store, this.options.afterDaemonCapture);
      const now = transportNow(this.clock);
      if (now === null) throw new Error('status.snapshot_unavailable');
      const previousAge = now.getTime() - Date.parse(previous.capability.publishedAt);
      const capability = previousAge < 0 ||
          previousAge >= STATUS_OWNER_CAPABILITY_ROTATE_AFTER_MS
        ? activeOperationalStatusCapability(
          this.stateIdentity,
          previous.capability.transport,
          now.toISOString(),
        )
        : previous.capability;
      const generation: OwnerGeneration = {
        capturedAt: now.toISOString(),
        captured,
        capability,
      };
      if (capability !== previous.capability) {
        this.capabilityStore.publish(
          this.capabilityPath,
          generation.capability,
          previous.capability,
          claim,
        );
        const confirmed = this.capabilityStore.read(this.capabilityPath);
        if (confirmed.kind !== 'ready' || confirmed.value.status !== 'active' ||
            !sameCanonical(confirmed.value, generation.capability)) {
          throw new Error('status.snapshot_unavailable');
        }
        this.acceptedNonces.clear();
        this.acceptedNonceCapabilityId = capability.capabilityId;
      }
      this.generation = generation;
    } catch {
      throw new Error('status.snapshot_unavailable');
    }
  }

  async start(): Promise<void> {
    if (this.server !== null || this.ownerClaim !== null) {
      throw new Error('status.owner_start_failed');
    }
    let claim: OperationalStatusOwnerClaim;
    try {
      claim = await this.capabilityStore.acquireOwnerClaim(this.capabilityPath, this.stateIdentity);
      claim.assertHeld();
    } catch {
      throw new Error('status.owner_start_failed');
    }
    this.ownerClaim = claim;
    const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.server = server;
    let published: ActiveOperationalStatusCapability | null = null;
    try {
      await new Promise<void>((resolveListen, reject) => {
        const failed = (): void => reject(new Error('status.owner_start_failed'));
        server.once('error', failed);
        const ready = (): void => {
          server.off('error', failed);
          server.on('error', () => undefined);
          resolveListen();
        };
        if (this.platform === 'win32') {
          // libuv named pipes cannot preserve the readable half after client EOF on Windows.
          // Loopback TCP supplies the exact request-EOF/response-EOF boundary on one connection.
          server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, ready);
        } else {
          server.listen(this.pipePath!, ready);
        }
      });
      const transport = this.boundTransport(server);
      if (transport === null) throw new Error('status.owner_start_failed');
      this.options.beforeRefresh?.();
      const captured = captureOperationalStore(this.options.store, this.options.afterDaemonCapture);
      const now = transportNow(this.clock);
      if (now === null) throw new Error('status.owner_start_failed');
      const generation: OwnerGeneration = {
        capturedAt: now.toISOString(),
        captured,
        capability: activeOperationalStatusCapability(
          this.stateIdentity,
          transport,
          now.toISOString(),
        ),
      };
      const existing = this.capabilityStore.read(this.capabilityPath);
      if (existing.kind === 'invalid' ||
          (existing.kind === 'ready' && existing.value.stateIdentity !== this.stateIdentity) ||
          (existing.kind === 'ready' && existing.value.status === 'active' &&
           operationalStatusCapabilityIsFresh(existing.value, now))) {
        throw new Error('status.owner_start_failed');
      }
      published = generation.capability;
      this.capabilityStore.publish(
        this.capabilityPath,
        generation.capability,
        existing.kind === 'ready' ? existing.value : null,
        claim,
      );
      const confirmed = this.capabilityStore.read(this.capabilityPath);
      if (confirmed.kind !== 'ready' || confirmed.value.status !== 'active' ||
          !sameCanonical(confirmed.value, generation.capability)) {
        throw new Error('status.owner_start_failed');
      }
      this.generation = generation;
      this.acceptedNonces.clear();
      this.acceptedNonceCapabilityId = generation.capability.capabilityId;
    } catch {
      this.server = null;
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await new Promise<void>((resolveClose) => {
        try { server.close(() => resolveClose()); } catch { resolveClose(); }
      });
      if (published !== null) {
        try {
          const now = transportNow(this.clock);
          const current = this.capabilityStore.read(this.capabilityPath);
          if (now !== null && current.kind === 'ready' && current.value.status === 'active' &&
            sameCanonical(current.value, published)) {
            const retired = retiredOperationalStatusCapability(published, now.toISOString());
            this.capabilityStore.publish(this.capabilityPath, retired, published, claim);
            this.capabilityStore.remove(this.capabilityPath, retired, claim);
          }
        } catch { /* stale protected metadata fails closed */ }
      }
      this.generation = null;
      this.acceptedNonces.clear();
      this.acceptedNonceCapabilityId = null;
      this.ownerClaim = null;
      try { await claim.release(); } catch { /* claim loss remains a failed start */ }
      throw new Error('status.owner_start_failed');
    }
    if (this.refreshMilliseconds !== null) {
      this.timer = setInterval(() => {
        try { this.refresh(); } catch { /* stale cache fails closed at the client */ }
      }, this.refreshMilliseconds);
      this.timer.unref?.();
    }
  }

  private boundTransport(server: Server): OperationalStatusTransportEndpoint | null {
    if (this.platform !== 'win32') {
      return this.pipePath === null ? null : { kind: 'pipe', path: this.pipePath };
    }
    const address = server.address();
    return address !== null && typeof address !== 'string' && address.family === 'IPv4' &&
        address.address === '127.0.0.1' && Number.isSafeInteger(address.port) &&
        address.port >= 1 && address.port <= 65_535
      ? { kind: 'tcp', host: '127.0.0.1', port: address.port }
      : null;
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const server = this.server;
    this.server = null;
    const claim = this.ownerClaim;
    this.ownerClaim = null;
    const active = this.generation?.capability ?? null;
    this.generation = null;
    this.acceptedNonces.clear();
    this.acceptedNonceCapabilityId = null;
    let retired: RetiredOperationalStatusCapability | null = null;
    let failed = false;
    if (active !== null) {
      try {
        if (claim === null) throw new Error('status.owner_stop_failed');
        claim.assertHeld();
        const now = transportNow(this.clock);
        const current = this.capabilityStore.read(this.capabilityPath);
        if (now === null || current.kind !== 'ready' || current.value.status !== 'active' ||
            !sameCanonical(current.value, active)) {
          throw new Error('status.owner_stop_failed');
        }
        retired = retiredOperationalStatusCapability(active, now.toISOString());
        this.capabilityStore.publish(this.capabilityPath, retired, active, claim);
      } catch {
        failed = true;
      }
    }
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server !== null) {
      await new Promise<void>((resolveClose) => {
        try { server.close(() => resolveClose()); } catch { resolveClose(); }
      });
    }
    if (retired !== null) {
      try {
        if (claim === null) throw new Error('status.owner_stop_failed');
        this.capabilityStore.remove(this.capabilityPath, retired, claim);
      } catch { failed = true; }
    }
    if (claim !== null) {
      try { await claim.release(); } catch { failed = true; }
    }
    if (failed) throw new Error('status.owner_stop_failed');
  }

  private accept(socket: Socket): void {
    if ((this.platform === 'win32' && socket.remoteAddress !== '127.0.0.1') ||
        this.sockets.size >= STATUS_OWNER_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const acceptedAt = process.hrtime.bigint();
    const absoluteDeadlineNanoseconds =
      BigInt(this.requestAbsoluteDeadlineMilliseconds) * 1_000_000n;
    const absoluteDeadlinePassed = (): boolean =>
      process.hrtime.bigint() - acceptedAt >= absoluteDeadlineNanoseconds;
    const absoluteTimer = setTimeout(
      () => socket.destroy(),
      this.requestAbsoluteDeadlineMilliseconds,
    );
    absoluteTimer.unref?.();
    socket.setTimeout(this.requestIdleTimeoutMilliseconds, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(absoluteTimer);
      this.sockets.delete(socket);
    });
    let input = Buffer.alloc(0);
    let rejected = false;
    socket.on('data', (chunk: Buffer) => {
      if (rejected) return;
      if (input.length + chunk.length > STATUS_OWNER_MAX_REQUEST_BYTES) {
        rejected = true;
        socket.destroy();
        return;
      }
      input = Buffer.concat([input, chunk]);
      const declared = declaredOwnerFrameLength(input, STATUS_OWNER_MAX_REQUEST_BYTES);
      if (declared !== null && (declared < 0 || input.length > declared + 4)) {
        rejected = true;
        socket.destroy();
      }
    });
    socket.on('end', () => {
      if (rejected || absoluteDeadlinePassed()) {
        socket.destroy();
        return;
      }
      const generation = this.generation;
      const now = transportNow(this.clock);
      const persisted = this.capabilityStore.read(this.capabilityPath);
      if (absoluteDeadlinePassed() || generation === null || now === null ||
          !operationalStatusCapabilityIsFresh(generation.capability, now) ||
          persisted.kind !== 'ready' || persisted.value.status !== 'active' ||
          !sameCanonical(persisted.value, generation.capability)) {
        socket.destroy();
        return;
      }
      const request = parseOwnerRequest(
        parseExactOwnerFrame(input, STATUS_OWNER_MAX_REQUEST_BYTES),
        generation,
        now,
      );
      if (request === null) {
        socket.destroy();
        return;
      }
      if (!this.reserveAcceptedNonce(request.capabilityId, request.nonce, now)) {
        socket.destroy();
        return;
      }
      const unsignedRequest: UnsignedOwnerRequest = {
        version: request.version,
        stateIdentity: request.stateIdentity,
        capabilityId: request.capabilityId,
        transport: request.transport,
        nonce: request.nonce,
        sentAt: request.sentAt,
        configFingerprint: request.configFingerprint,
        buildFingerprint: request.buildFingerprint,
      };
      const unsignedResponse = {
        version: STATUS_OWNER_PROTOCOL_VERSION,
        stateIdentity: request.stateIdentity,
        capabilityId: request.capabilityId,
        transport: request.transport,
        nonce: request.nonce,
        capturedAt: generation.capturedAt,
        schemaVersion: SCHEMA_VERSION,
        snapshot: projectCapturedOperationalStore(generation.captured, {
          configFingerprint: request.configFingerprint,
          buildFingerprint: request.buildFingerprint,
        }),
      };
      const response = encodeOwnerFrame({
        ...unsignedResponse,
        authenticator: ownerAuthenticator(generation.capability.secret, 'response', {
          request: unsignedRequest,
          response: unsignedResponse,
        }),
      }, STATUS_OWNER_MAX_RESPONSE_BYTES);
      if (response === null || absoluteDeadlinePassed()) {
        socket.destroy();
        return;
      }
      socket.end(response);
    });
  }

  private reserveAcceptedNonce(capabilityId: string, nonce: string, now: Date): boolean {
    if (this.acceptedNonceCapabilityId !== capabilityId) return false;
    const expiresBefore = now.getTime() - STATUS_OWNER_MESSAGE_MAX_AGE_MS;
    for (const [acceptedNonce, acceptedAt] of this.acceptedNonces) {
      if (acceptedAt <= expiresBefore) this.acceptedNonces.delete(acceptedNonce);
    }
    if (this.acceptedNonces.has(nonce) ||
        this.acceptedNonces.size >= STATUS_OWNER_MAX_ACCEPTED_NONCES) return false;
    this.acceptedNonces.set(nonce, now.getTime());
    return true;
  }
}

function parseOwnerResponse(
  value: unknown,
  request: UnsignedOwnerRequest,
  capability: ActiveOperationalStatusCapability,
  now: Date,
): OperationalStatusSnapshot | null {
  const response = exactRecord(value, [
    'version', 'stateIdentity', 'capabilityId', 'transport', 'nonce', 'capturedAt',
    'schemaVersion', 'snapshot', 'authenticator',
  ]);
  if (response === null || response['version'] !== STATUS_OWNER_PROTOCOL_VERSION ||
      response['stateIdentity'] !== request.stateIdentity ||
      response['capabilityId'] !== request.capabilityId ||
      !sameCanonical(response['transport'], request.transport) ||
      response['nonce'] !== request.nonce || response['schemaVersion'] !== SCHEMA_VERSION ||
      !canonicalIso(response['capturedAt'])) return null;
  const age = now.getTime() - Date.parse(response['capturedAt']);
  if (age < -STATUS_OWNER_CAPABILITY_FUTURE_TOLERANCE_MS ||
      age > STATUS_OWNER_MESSAGE_MAX_AGE_MS) return null;
  const unsignedResponse = {
    version: response['version'],
    stateIdentity: response['stateIdentity'],
    capabilityId: response['capabilityId'],
    transport: response['transport'],
    nonce: response['nonce'],
    capturedAt: response['capturedAt'],
    schemaVersion: response['schemaVersion'],
    snapshot: response['snapshot'],
  };
  if (!sameAuthenticator(
    ownerAuthenticator(capability.secret, 'response', {
      request,
      response: unsignedResponse,
    }),
    response['authenticator'],
  )) return null;
  return parseOperationalStatusSnapshot(response['snapshot']);
}

async function requestOwnedOperationalStatus(
  statePath: string,
  expectations: OperationalStatusExpectations,
  pipePath: string | undefined,
  capabilityPath: string | undefined,
  capabilityStore: OperationalStatusCapabilityStore | undefined,
  timeoutMilliseconds: number | undefined,
  clock: () => Date,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<OperationalStatusSnapshot | null> {
  const timeout = timeoutMilliseconds ?? STATUS_OWNER_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 5_000) return null;
  const now = transportNow(clock);
  if (now === null) return null;
  const stateIdentity = operationalStatusStateIdentity(statePath, platform);
  let resolvedCapabilityPath: string;
  try {
    resolvedCapabilityPath = capabilityPath ?? operationalStatusCapabilityPath(statePath, env, platform);
  } catch {
    return null;
  }
  const store = capabilityStore ?? new CurrentUserOperationalStatusCapabilityStore(platform, env);
  const observed = store.read(resolvedCapabilityPath);
  if (observed.kind !== 'ready' || observed.value.status !== 'active' ||
      observed.value.stateIdentity !== stateIdentity ||
      !expectedOwnerTransport(observed.value.transport, statePath, pipePath, platform) ||
      !operationalStatusCapabilityIsFresh(observed.value, now)) return null;
  const capability = observed.value;
  const nonce = randomBytes(16).toString('hex');
  const unsignedRequest: UnsignedOwnerRequest = {
    version: STATUS_OWNER_PROTOCOL_VERSION,
    stateIdentity,
    capabilityId: capability.capabilityId,
    transport: capability.transport,
    nonce,
    sentAt: now.toISOString(),
    configFingerprint: expectations.configFingerprint,
    buildFingerprint: expectations.buildFingerprint,
  };
  const request = encodeOwnerFrame({
    ...unsignedRequest,
    authenticator: ownerAuthenticator(capability.secret, 'request', unsignedRequest),
  }, STATUS_OWNER_MAX_REQUEST_BYTES);
  if (request === null) return null;

  return await new Promise<OperationalStatusSnapshot | null>((resolveRequest) => {
    const socket = capability.transport.kind === 'tcp'
      ? createConnection({
        host: capability.transport.host,
        port: capability.transport.port,
        allowHalfOpen: true,
      })
      : createConnection({ path: capability.transport.path, allowHalfOpen: true });
    let settled = false;
    let input = Buffer.alloc(0);
    let receivedEnd = false;
    const finish = (value: OperationalStatusSnapshot | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveRequest(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    timer.unref?.();
    socket.on('connect', () => socket.end(request));
    socket.on('error', () => finish(null));
    socket.on('close', () => {
      if (!receivedEnd) finish(null);
    });
    socket.on('data', (chunk: Buffer) => {
      if (input.length + chunk.length > STATUS_OWNER_MAX_RESPONSE_BYTES) {
        finish(null);
        return;
      }
      input = Buffer.concat([input, chunk]);
      const declared = declaredOwnerFrameLength(input, STATUS_OWNER_MAX_RESPONSE_BYTES);
      if (declared !== null && (declared < 0 || input.length > declared + 4)) {
        finish(null);
      }
    });
    socket.on('end', () => {
      receivedEnd = true;
      try {
        const responseNow = transportNow(clock);
        if (responseNow === null) {
          finish(null);
          return;
        }
        finish(parseOwnerResponse(
          parseExactOwnerFrame(input, STATUS_OWNER_MAX_RESPONSE_BYTES),
          unsignedRequest,
          capability,
          responseNow,
        ));
      } catch {
        finish(null);
      }
    });
  });
}

function immutableDatabaseUrl(path: string): URL {
  const url = pathToFileURL(path);
  url.searchParams.set('immutable', '1');
  url.searchParams.set('mode', 'ro');
  return url;
}

async function readStoredStatus(
  path: string,
  expectations: OperationalStatusExpectations,
  afterSqliteBackupStep: (() => void) | undefined,
  temporaryDirectory: string,
  ownerPipePath: string | undefined,
  ownerCapabilityPath: string | undefined,
  ownerCapabilityStore: OperationalStatusCapabilityStore | undefined,
  ownerTimeoutMilliseconds: number | undefined,
  ownerTransportClock: () => Date,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<SnapshotResult> {
  try {
    if (!pathExists(path)) return { kind: 'absent' };
  } catch {
    return { kind: 'corrupt' };
  }

  let scratch: string | null = null;
  let source: DatabaseSync | null = null;
  let raw: DatabaseSync | null = null;
  let store: SqliteDigestStore | null = null;
  try {
    const walPresent = pathExists(`${path}-wal`);
    if (walPresent) {
      // Every ordinary mutable WAL reader may update read marks in the source SHM, even when the
      // SQLite connection is logically read-only. The daemon/store owner instead serves a strict
      // aggregate-only cached projection over its local private pipe; this process opens no source
      // DB/WAL/SHM handle at all.
      if (!pathExists(`${path}-shm`)) return { kind: 'owner_unavailable' };
      const owned = await requestOwnedOperationalStatus(
        path,
        expectations,
        ownerPipePath,
        ownerCapabilityPath,
        ownerCapabilityStore,
        ownerTimeoutMilliseconds,
        ownerTransportClock,
        env,
        platform,
      );
      return owned === null
        ? { kind: 'owner_unavailable' }
        : { kind: 'ready', value: owned };
    }
    source = new DatabaseSync(immutableDatabaseUrl(path), { readOnly: true, timeout: 5_000 });
    scratch = mkdtempSync(join(temporaryDirectory, 'orca-slack-bridge-status-'));
    const copy = join(scratch, 'state.db');
    // sqlite3_backup_* takes one transactionally consistent image. If a writer commits or
    // checkpoints concurrently, SQLite restarts the backup rather than combining file epochs.
    if (afterSqliteBackupStep === undefined) await backup(source, copy);
    else await backup(source, copy, { rate: 1, progress: afterSqliteBackupStep });
    source.close();
    source = null;

    raw = new DatabaseSync(copy);
    const version = schemaVersion(raw);
    raw.close();
    raw = null;
    if (version.kind === 'absent') return { kind: 'schema_absent' };
    if (version.kind === 'corrupt') return { kind: 'corrupt' };
    if (version.value !== SCHEMA_VERSION) return { kind: 'schema_mismatch', version: version.value };

    // The version gate above prevents SqliteDigestStore from migrating even its scratch copy.
    // Its strict O1-2 decoder remains the authority for all operational row invariants.
    store = new SqliteDigestStore(copy);
    return { kind: 'ready', value: projectOperationalStore(store, expectations) };
  } catch {
    return { kind: 'corrupt' };
  } finally {
    try { source?.close(); } catch { /* read-only source remains unmodified */ }
    try { raw?.close(); } catch { /* source remains untouched */ }
    try { store?.close(); } catch { /* scratch cleanup still runs */ }
    if (scratch !== null) {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
      } catch {
        // Cleanup remains bounded and never renders the private temp path or triggering error.
      }
    }
  }
}

function readLogState(logDir: string): OperationalStatusReport['logs']['state'] {
  try {
    statSync(operationalLogPath(logDir));
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

function validTaskFacet(value: TaskStatusFacet): boolean {
  return ['unavailable', 'absent', 'matched', 'drifted'].includes(value.ownership) &&
    ['unavailable', 'running', 'stopped'].includes(value.state);
}

export async function inspectOperationalStatus(
  options: InspectOperationalStatusOptions = {},
): Promise<OperationalStatusReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let config: ParsedBridgeConfig;
  try {
    config = options.config ?? await loadConfig(options.configPath ?? defaultConfigPath(env));
  } catch {
    const base = baseReport(90);
    return withOutcome({ ...base, config: { state: 'invalid' } }, new Set(['config.invalid']), 2);
  }

  const staleAfterSeconds = config.automation.health.staleAfterSeconds;
  let task = EMPTY_TASK;
  if (options.taskFacet !== undefined) {
    try {
      const observed = await options.taskFacet();
      task = validTaskFacet(observed) ? observed : { ownership: 'drifted', state: 'stopped' };
    } catch {
      task = { ownership: 'drifted', state: 'stopped' };
    }
  }

  let statePath: string;
  let logDir: string;
  try {
    statePath = resolveStatePath(options.statePath ?? null, env, platform);
    logDir = resolveOperationalLogDir(options.logDir ?? null, env, platform);
  } catch {
    const base = baseReport(staleAfterSeconds);
    return withOutcome(
      { ...base, config: { state: 'readable' }, task },
      new Set(['state.path_unavailable']),
      2,
    );
  }

  const expectations: OperationalStatusExpectations = {
    configFingerprint: fingerprintOperationalConfig(config),
    buildFingerprint: (() => {
      const raw = options.expectedBuildIdentity ?? env['ORCA_SLACK_BRIDGE_BUILD'] ?? null;
      return raw === null || raw.trim() === '' ? null : fingerprintOperationalBuild(raw);
    })(),
  };
  const injectedSnapshot = options.snapshot === undefined
    ? null
    : parseOperationalStatusSnapshot(options.snapshot);
  const snapshot: SnapshotResult = options.snapshot === undefined
    ? await readStoredStatus(
      statePath,
      expectations,
      options.afterSqliteBackupStep,
      options.temporaryDirectory ?? tmpdir(),
      options.ownerPipePath,
      options.ownerCapabilityPath,
      options.ownerCapabilityStore,
      options.ownerTimeoutMilliseconds,
      options.ownerTransportClock ?? (() => new Date()),
      env,
      platform,
    )
    : injectedSnapshot === null
      ? { kind: 'owner_unavailable' }
      : { kind: 'ready', value: injectedSnapshot };
  const logState = readLogState(logDir);
  if (snapshot.kind !== 'ready') {
    const base = baseReport(staleAfterSeconds);
    const schema = snapshot.kind === 'schema_mismatch'
      ? { state: 'mismatched' as const, expectedVersion: SCHEMA_VERSION, foundVersion: snapshot.version }
      : snapshot.kind === 'corrupt'
        ? { state: 'corrupt' as const, expectedVersion: SCHEMA_VERSION, foundVersion: null }
        : snapshot.kind === 'owner_unavailable'
          ? { state: 'unavailable' as const, expectedVersion: SCHEMA_VERSION, foundVersion: null }
        : { state: 'absent' as const, expectedVersion: SCHEMA_VERSION, foundVersion: null };
    const code: StatusCode = snapshot.kind === 'schema_mismatch'
      ? 'schema.drift'
      : snapshot.kind === 'corrupt'
        ? 'schema.corrupt'
        : snapshot.kind === 'owner_unavailable'
          ? 'state.snapshot_unavailable'
        : 'schema.absent';
    return withOutcome(
      { ...base, schema, config: { state: 'readable' }, task, logs: { state: logState } },
      new Set([code]),
      2,
    );
  }

  let clockInvalid = false;
  let now: Date;
  try {
    now = options.clock?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('clock.invalid');
  } catch {
    now = new Date(0);
    clockInvalid = true;
  }
  const daemon = snapshot.value.daemon;
  const codes = new Set<StatusCode>();
  let exitCode: StatusExitCode = 0;
  const add = (code: StatusCode, severity: 1 | 2): void => {
    codes.add(code);
    exitCode = Math.max(exitCode, severity) as StatusExitCode;
  };

  let configState: OperationalStatusReport['config']['state'] = 'readable';
  let buildState: OperationalStatusReport['build']['state'] = 'unverified';
  let daemonProjection: OperationalStatusReport['daemon'] = {
    desiredState: 'absent', state: 'absent', heartbeatAgeSeconds: null,
    staleAfterSeconds, lastErrorCode: null,
  };
  if (daemon === null) {
    add('daemon.absent', 2);
  } else {
    configState = daemon.configState;
    if (configState === 'mismatched') add('config.drift', 2);
    buildState = daemon.buildState;
    if (buildState === 'unverified') {
      add('build.unverified', 1);
    } else if (buildState === 'mismatched') add('build.drift', 1);
    const nowMs = now.getTime();
    const heartbeatMs = Date.parse(daemon.heartbeatAt);
    const age = Math.max(0, Math.floor((nowMs - heartbeatMs) / 1_000));
    daemonProjection = {
      desiredState: daemon.desiredState,
      state: daemon.state,
      heartbeatAgeSeconds: age,
      staleAfterSeconds,
      lastErrorCode: daemon.lastErrorCode,
    };
    if (daemon.desiredState === 'stopped' || daemon.state === 'stopped') add('daemon.stopped', 2);
    if (clockInvalid || heartbeatMs > nowMs + 1_000) add('daemon.clock_drift', 1);
    else if (age > staleAfterSeconds) add('daemon.stale', 1);
    if (daemon.lastErrorCode !== null) add('daemon.degraded', 1);
  }

  const disabledObserverJobs = config.automation.enabled
    ? new Set<DaemonJobName>()
    : new Set<DaemonJobName>(['repository-discovery', 'run-observer', 'pr-digest']);
  for (const job of snapshot.value.jobs) {
    if (disabledObserverJobs.has(job.job)) continue;
    if (job.state === 'absent') add('job.absent', 1);
    else if (job.state === 'failed') add('job.failed', 1);
    else if (job.state === 'backoff') add('job.backoff', 1);
  }
  if (snapshot.value.registry.pending > 0) add('registry.pending', 1);
  if (snapshot.value.registry.rejected > 0) add('registry.rejected', 1);
  if (snapshot.value.registry.deferred > 0) add('registry.deferred', 1);
  if (snapshot.value.work.pending.actionableTotal > 0) add('work.pending', 1);
  if (snapshot.value.work.uncertain.total > 0) add('work.uncertain', 1);
  if (snapshot.value.work.dead.total > 0) add('work.dead', 1);
  if (task.ownership === 'absent') add('task.absent', 2);
  else if (task.ownership === 'drifted') add('task.drift', 2);
  if (task.state === 'stopped') add('task.stopped', 2);

  return withOutcome({
    schema: { state: 'matched', expectedVersion: SCHEMA_VERSION, foundVersion: SCHEMA_VERSION },
    config: { state: configState },
    build: { state: buildState },
    daemon: daemonProjection,
    task,
    logs: { state: logState },
    registry: snapshot.value.registry,
    work: snapshot.value.work,
    jobs: snapshot.value.jobs,
  }, codes, exitCode);
}

export function formatOperationalStatus(report: OperationalStatusReport): string {
  const lines = [
    `overall=${report.overall}`,
    `codes=${report.codes.join(',')}`,
    `schema=${report.schema.state} expected=${report.schema.expectedVersion} found=${report.schema.foundVersion ?? 'none'}`,
    `config=${report.config.state} build=${report.build.state}`,
    `daemon=${report.daemon.state} desired=${report.daemon.desiredState} heartbeatAgeSeconds=${report.daemon.heartbeatAgeSeconds ?? 'none'}`,
    `task=${report.task.ownership}/${report.task.state} logs=${report.logs.state}`,
    `registry active=${report.registry.active} pending=${report.registry.pending} rejected=${report.registry.rejected} deferred=${report.registry.deferred}`,
    `work pending=${report.work.pending.actionableTotal} legacy=${report.work.pending.legacyNotifications} uncertain=${report.work.uncertain.total} dead=${report.work.dead.total}`,
  ];
  for (const job of report.jobs) {
    lines.push(
      `job=${job.job} state=${job.state} attempt=${job.attempt} failures=${job.consecutiveFailures} nextRunAt=${job.nextRunAt ?? 'none'} errorCode=${job.errorCode ?? 'none'}`,
    );
  }
  return lines.join('\n');
}
