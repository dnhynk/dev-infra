import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  /** Test seam for a private status owner endpoint; production derives it from the state path. */
  readonly ownerPipePath?: string;
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

const STATUS_OWNER_PROTOCOL_VERSION = 1;
const STATUS_OWNER_MAX_REQUEST_BYTES = 512;
const STATUS_OWNER_MAX_RESPONSE_BYTES = 64 * 1024;
const STATUS_OWNER_MAX_CONNECTIONS = 8;
const STATUS_OWNER_DEFAULT_TIMEOUT_MS = 1_000;
const STATUS_OWNER_DEFAULT_REFRESH_MS = 1_000;
const STATUS_OWNER_MAX_AGE_MS = 5_000;
const STATUS_OWNER_FUTURE_TOLERANCE_MS = 1_000;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const FAILURE_CODE_SET = new Set<string>(OPERATIONAL_FAILURE_CODES);

type OwnerRequest = {
  readonly version: 1;
  readonly nonce: string;
  readonly configFingerprint: string;
  readonly buildFingerprint: string | null;
};

type OwnerCache = {
  readonly capturedAt: string;
  readonly captured: CapturedOperationalStore;
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

function parseOwnerRequest(value: unknown): OwnerRequest | null {
  const record = exactRecord(value, [
    'version', 'nonce', 'configFingerprint', 'buildFingerprint',
  ]);
  if (record === null || record['version'] !== STATUS_OWNER_PROTOCOL_VERSION ||
      typeof record['nonce'] !== 'string' || !NONCE_PATTERN.test(record['nonce']) ||
      typeof record['configFingerprint'] !== 'string' ||
      !FINGERPRINT_PATTERN.test(record['configFingerprint']) ||
      (record['buildFingerprint'] !== null &&
       (typeof record['buildFingerprint'] !== 'string' ||
        !FINGERPRINT_PATTERN.test(record['buildFingerprint'])))) return null;
  return {
    version: 1,
    nonce: record['nonce'],
    configFingerprint: record['configFingerprint'],
    buildFingerprint: record['buildFingerprint'] as string | null,
  };
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
  const canonical = platform === 'win32' ? resolve(statePath).toLowerCase() : resolve(statePath);
  const key = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24);
  if (platform === 'win32') return String.raw`\\.\pipe\orca-slack-bridge-status-v1-${key}`;
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return `\0orca-slack-bridge-status-v1-${user}-${key}`;
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
  readonly clock?: () => Date;
  readonly refreshMilliseconds?: number | null;
  readonly beforeRefresh?: () => void;
  readonly afterDaemonCapture?: () => void;
};

/**
 * The SQLite owner refreshes one private in-memory capture. Requests only compare hashes and
 * serialize the finite projection, so the status process never opens or maps the live DB/WAL/SHM.
 */
export class OperationalStatusOwnerServer implements OperationalStatusOwnerServerLike {
  private readonly pipePath: string;
  private readonly clock: () => Date;
  private readonly refreshMilliseconds: number | null;
  private server: Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cache: OwnerCache | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly options: OperationalStatusOwnerServerOptions) {
    this.pipePath = options.pipePath ?? operationalStatusOwnerPipePath(options.statePath);
    this.clock = options.clock ?? (() => new Date());
    const refreshMilliseconds = options.refreshMilliseconds ?? STATUS_OWNER_DEFAULT_REFRESH_MS;
    if (refreshMilliseconds !== null &&
        (!Number.isSafeInteger(refreshMilliseconds) || refreshMilliseconds < 100 ||
         refreshMilliseconds > STATUS_OWNER_MAX_AGE_MS)) {
      throw new TypeError('status.owner_refresh_invalid');
    }
    this.refreshMilliseconds = refreshMilliseconds;
  }

  refresh(): void {
    try {
      this.options.beforeRefresh?.();
      const captured = captureOperationalStore(this.options.store, this.options.afterDaemonCapture);
      const now = transportNow(this.clock);
      if (now === null) throw new Error('status.snapshot_unavailable');
      this.cache = { capturedAt: now.toISOString(), captured };
    } catch {
      throw new Error('status.snapshot_unavailable');
    }
  }

  async start(): Promise<void> {
    if (this.server !== null) throw new Error('status.owner_start_failed');
    this.refresh();
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolveListen, reject) => {
        const failed = (): void => reject(new Error('status.owner_start_failed'));
        server.once('error', failed);
        server.listen(this.pipePath, () => {
          server.off('error', failed);
          server.on('error', () => undefined);
          resolveListen();
        });
      });
    } catch {
      this.server = null;
      try { server.close(); } catch { /* no owned listener survived */ }
      throw new Error('status.owner_start_failed');
    }
    if (this.refreshMilliseconds !== null) {
      this.timer = setInterval(() => {
        try { this.refresh(); } catch { /* stale cache fails closed at the client */ }
      }, this.refreshMilliseconds);
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise<void>((resolveClose) => {
      try { server.close(() => resolveClose()); } catch { resolveClose(); }
    });
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= STATUS_OWNER_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setTimeout(STATUS_OWNER_DEFAULT_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('close', () => this.sockets.delete(socket));
    let input = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      if (input.length + chunk.length > STATUS_OWNER_MAX_REQUEST_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      input = Buffer.concat([input, chunk]);
      const delimiter = input.indexOf(0x0a);
      if (delimiter < 0) return;
      handled = true;
      if (delimiter !== input.length - 1) {
        socket.destroy();
        return;
      }
      let request: OwnerRequest | null = null;
      try {
        request = parseOwnerRequest(JSON.parse(input.subarray(0, delimiter).toString('utf8')));
      } catch {
        request = null;
      }
      const cached = this.cache;
      if (request === null || cached === null) {
        socket.destroy();
        return;
      }
      const response = Buffer.from(`${JSON.stringify({
        version: STATUS_OWNER_PROTOCOL_VERSION,
        nonce: request.nonce,
        capturedAt: cached.capturedAt,
        schemaVersion: SCHEMA_VERSION,
        snapshot: projectCapturedOperationalStore(cached.captured, {
          configFingerprint: request.configFingerprint,
          buildFingerprint: request.buildFingerprint,
        }),
      })}\n`, 'utf8');
      if (response.length > STATUS_OWNER_MAX_RESPONSE_BYTES) {
        socket.destroy();
        return;
      }
      socket.end(response);
    });
  }
}

function parseOwnerResponse(
  value: unknown,
  nonce: string,
  now: Date,
): OperationalStatusSnapshot | null {
  const response = exactRecord(value, [
    'version', 'nonce', 'capturedAt', 'schemaVersion', 'snapshot',
  ]);
  if (response === null || response['version'] !== STATUS_OWNER_PROTOCOL_VERSION ||
      response['nonce'] !== nonce || response['schemaVersion'] !== SCHEMA_VERSION ||
      !canonicalIso(response['capturedAt'])) return null;
  const age = now.getTime() - Date.parse(response['capturedAt']);
  if (age < -STATUS_OWNER_FUTURE_TOLERANCE_MS || age > STATUS_OWNER_MAX_AGE_MS) return null;
  return parseOperationalStatusSnapshot(response['snapshot']);
}

async function requestOwnedOperationalStatus(
  statePath: string,
  expectations: OperationalStatusExpectations,
  pipePath: string | undefined,
  timeoutMilliseconds: number | undefined,
  clock: () => Date,
): Promise<OperationalStatusSnapshot | null> {
  const timeout = timeoutMilliseconds ?? STATUS_OWNER_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 5_000) return null;
  const nonce = randomBytes(16).toString('hex');
  const request = Buffer.from(`${JSON.stringify({
    version: STATUS_OWNER_PROTOCOL_VERSION,
    nonce,
    configFingerprint: expectations.configFingerprint,
    buildFingerprint: expectations.buildFingerprint,
  })}\n`, 'utf8');
  if (request.length > STATUS_OWNER_MAX_REQUEST_BYTES) return null;

  return await new Promise<OperationalStatusSnapshot | null>((resolveRequest) => {
    const socket = createConnection(pipePath ?? operationalStatusOwnerPipePath(statePath));
    let settled = false;
    let input = Buffer.alloc(0);
    const finish = (value: OperationalStatusSnapshot | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveRequest(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    timer.unref?.();
    socket.on('connect', () => socket.write(request));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    socket.on('data', (chunk: Buffer) => {
      if (input.length + chunk.length > STATUS_OWNER_MAX_RESPONSE_BYTES) {
        finish(null);
        return;
      }
      input = Buffer.concat([input, chunk]);
      const delimiter = input.indexOf(0x0a);
      if (delimiter < 0) return;
      if (delimiter !== input.length - 1) {
        finish(null);
        return;
      }
      try {
        const responseNow = transportNow(clock);
        if (responseNow === null) {
          finish(null);
          return;
        }
        finish(parseOwnerResponse(
          JSON.parse(input.subarray(0, delimiter).toString('utf8')),
          nonce,
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
  ownerTimeoutMilliseconds: number | undefined,
  ownerTransportClock: () => Date,
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
        ownerTimeoutMilliseconds,
        ownerTransportClock,
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
      options.ownerTimeoutMilliseconds,
      options.ownerTransportClock ?? (() => new Date()),
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
