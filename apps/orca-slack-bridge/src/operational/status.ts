import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    readonly state: 'matched' | 'absent' | 'mismatched' | 'corrupt';
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
  /** Safe projected test/adapter seam; the production CLI always reads the copied O1-2 store. */
  readonly snapshot?: OperationalStatusSnapshot;
};

export type OperationalStatusSnapshot = {
  readonly daemon: DaemonHealthRecord | null;
  readonly jobs: readonly OperationalStatusJob[];
  readonly registry: OperationalStatusReport['registry'];
  readonly work: OperationalStatusReport['work'];
};

type SnapshotResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'schema_absent' }
  | { readonly kind: 'schema_mismatch'; readonly version: number }
  | { readonly kind: 'corrupt' }
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

/** Projects only aggregate/static operational facts from the O1-2 read API. */
export function projectOperationalStore(
  store: Pick<
    OperationalStore,
    'readDaemonHealth' | 'findDaemonJobOutcome' |
    'readEffectiveDiscoverySnapshot' | 'readOperationalAggregateCounts'
  >,
): OperationalStatusSnapshot {
  const daemon = store.readDaemonHealth();
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

function readStoredStatus(path: string): SnapshotResult {
  try {
    if (!pathExists(path)) return { kind: 'absent' };
  } catch {
    return { kind: 'corrupt' };
  }

  let scratch: string | null = null;
  let raw: DatabaseSync | null = null;
  let store: SqliteDigestStore | null = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'orca-slack-bridge-status-'));
    const copy = join(scratch, 'state.db');
    copyFileSync(path, copy);
    if (pathExists(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);

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
    return { kind: 'ready', value: projectOperationalStore(store) };
  } catch {
    return { kind: 'corrupt' };
  } finally {
    try { raw?.close(); } catch { /* source remains untouched */ }
    try { store?.close(); } catch { /* scratch cleanup still runs */ }
    if (scratch !== null) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* bounded temp leak only */ }
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

  const snapshot: SnapshotResult = options.snapshot === undefined
    ? readStoredStatus(statePath)
    : { kind: 'ready', value: options.snapshot };
  const logState = readLogState(logDir);
  if (snapshot.kind !== 'ready') {
    const base = baseReport(staleAfterSeconds);
    const schema = snapshot.kind === 'schema_mismatch'
      ? { state: 'mismatched' as const, expectedVersion: SCHEMA_VERSION, foundVersion: snapshot.version }
      : snapshot.kind === 'corrupt'
        ? { state: 'corrupt' as const, expectedVersion: SCHEMA_VERSION, foundVersion: null }
        : { state: 'absent' as const, expectedVersion: SCHEMA_VERSION, foundVersion: null };
    const code: StatusCode = snapshot.kind === 'schema_mismatch'
      ? 'schema.drift'
      : snapshot.kind === 'corrupt'
        ? 'schema.corrupt'
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
  const expectedConfig = fingerprintOperationalConfig(config);
  const rawExpectedBuild = options.expectedBuildIdentity ?? env['ORCA_SLACK_BRIDGE_BUILD'] ?? null;
  const expectedBuild = rawExpectedBuild === null || rawExpectedBuild.trim() === ''
    ? null
    : fingerprintOperationalBuild(rawExpectedBuild);
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
    configState = daemon.configFingerprint === expectedConfig ? 'matched' : 'mismatched';
    if (configState === 'mismatched') add('config.drift', 2);
    if (expectedBuild === null) {
      add('build.unverified', 1);
    } else {
      buildState = daemon.buildFingerprint === expectedBuild ? 'matched' : 'mismatched';
      if (buildState === 'mismatched') add('build.drift', 1);
    }
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

  for (const job of snapshot.value.jobs) {
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
