import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/project/config.js';
import {
  fingerprintOperationalBuild,
  fingerprintOperationalConfig,
  formatOperationalStatus,
  inspectOperationalStatus,
  OPERATIONAL_JOB_NAMES,
  projectOperationalStore,
  type OperationalStatusSnapshot,
} from '../src/operational/status.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import type { DaemonJobName } from '../src/store/operational-types.js';

let dir: string;
let statePath: string;
const AT0 = '2026-08-26T00:00:00.000Z';
const AT1 = '2026-08-26T00:00:01.000Z';
const AT2 = '2026-08-26T00:00:02.000Z';
const NEXT = '2026-08-26T00:15:00.000Z';
const BUILD = 'release-SENTINEL_PRIVATE_BUILD';
const INSTANCE = 'instance-SENTINEL_RAW_ID';
const config = parseConfig({
  slack: null,
  projects: [{ name: 'Project Sentinel', repositories: ['private-owner/private-repository'] }],
});
const disabledConfig = parseConfig({
  slack: null,
  projects: [{ name: 'Project Sentinel', repositories: ['private-owner/private-repository'] }],
  automation: { enabled: false },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-operational-status-'));
  statePath = join(dir, 'state.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function completeJobs(
  store: SqliteDigestStore,
  failure: DaemonJobName | null = null,
  backoff = false,
  jobs: readonly DaemonJobName[] = OPERATIONAL_JOB_NAMES,
): void {
  for (const job of jobs) {
    const claim = store.startDaemonJob(job, AT0);
    if (claim === null) throw new Error('expected job claim');
    if (job === failure) {
      const failed = store.completeDaemonJobFailure({
        claim, at: AT1, durationMs: 1, errorCode: 'github.unavailable',
      });
      if (failed === null) throw new Error('expected failed outcome');
      if (backoff) store.scheduleDaemonJobBackoff(job, failed.revision, NEXT, AT2);
    } else {
      store.completeDaemonJobSuccess({ claim, at: AT1, durationMs: 1, nextRunAt: NEXT });
    }
  }
}

function healthyStore(options: {
  readonly configFingerprint?: string;
  readonly buildFingerprint?: string;
  readonly failure?: DaemonJobName | null;
  readonly backoff?: boolean;
  readonly jobs?: boolean;
  readonly jobNames?: readonly DaemonJobName[];
  readonly config?: typeof config;
} = {}): SqliteDigestStore {
  const store = new SqliteDigestStore(statePath);
  store.recordDaemonStart({
    instanceId: INSTANCE,
    buildFingerprint: options.buildFingerprint ?? fingerprintOperationalBuild(BUILD),
    configFingerprint: options.configFingerprint ?? fingerprintOperationalConfig(options.config ?? config),
    at: AT0,
  });
  if (options.jobs !== false) {
    completeJobs(store, options.failure ?? null, options.backoff ?? false, options.jobNames);
  }
  return store;
}

function inspect(overrides: Parameters<typeof inspectOperationalStatus>[0] = {}) {
  return inspectOperationalStatus({
    config,
    statePath,
    logDir: dir,
    expectedBuildIdentity: BUILD,
    clock: () => new Date('2026-08-26T00:00:30.000Z'),
    ...overrides,
  });
}

function snapshotAndClose(store: SqliteDigestStore): OperationalStatusSnapshot {
  try {
    return projectOperationalStore(store);
  } finally {
    store.close();
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function projectedSnapshot(
  pending: {
    readonly gateCards: number;
    readonly channelDeliveries: number;
    readonly resumeBaselines: number;
    readonly legacyNotifications: number;
    readonly slackRootIntents: number;
  },
  uncertain = 0,
  dead = 0,
): OperationalStatusSnapshot {
  return projectOperationalStore({
    readDaemonHealth: () => ({
      revision: 0,
      instanceId: INSTANCE,
      buildFingerprint: fingerprintOperationalBuild(BUILD),
      configFingerprint: fingerprintOperationalConfig(config),
      desiredState: 'running',
      state: 'running',
      startedAt: AT0,
      heartbeatAt: AT0,
      cleanStoppedAt: null,
      lastErrorCode: null,
      updatedAt: AT0,
    }),
    findDaemonJobOutcome: (jobName) => ({
      jobName,
      revision: 1,
      state: 'succeeded',
      attempt: 1,
      consecutiveFailures: 0,
      startedAt: AT0,
      completedAt: AT1,
      lastSuccessAt: AT1,
      lastFailureAt: null,
      durationMs: 1,
      nextRunAt: NEXT,
      errorCode: null,
      processedCount: 0,
      deferredCount: 0,
      checkpoint: 0,
      updatedAt: AT1,
    }),
    readEffectiveDiscoverySnapshot: () => ({ repositories: [], bindings: [], issues: [] }),
    readOperationalAggregateCounts: () => ({
      pending: { ...pending, total: pending.gateCards + pending.channelDeliveries +
        pending.resumeBaselines + pending.legacyNotifications + pending.slackRootIntents },
      uncertain: { slackRootIntents: uncertain, total: uncertain },
      dead: { unavailableResumeBaselines: dead, total: dead },
    }),
  });
}

describe('read-only operational status classification', () => {
  it('reports a fully matched daemon as healthy with static aggregate-only output', async () => {
    healthyStore().close();
    const report = await inspect();
    expect(report).toMatchObject({
      overall: 'healthy', exitCode: 0, codes: ['status.healthy'],
      schema: { state: 'matched', expectedVersion: 13, foundVersion: 13 },
      config: { state: 'matched' }, build: { state: 'matched' },
      daemon: { state: 'running', desiredState: 'running', heartbeatAgeSeconds: 30 },
      registry: { active: 0, pending: 0, rejected: 0, deferred: 0 },
      work: { pending: { actionableTotal: 0, legacyNotifications: 0 } },
    });
    expect(report.jobs.every((job) => job.state === 'succeeded')).toBe(true);
    const rendered = `${formatOperationalStatus(report)}\n${JSON.stringify(report)}`;
    for (const privateValue of [INSTANCE, 'Project Sentinel', 'private-owner', statePath, dir, BUILD]) {
      expect(rendered).not.toContain(privateValue);
    }
  });

  it('reads the live WAL snapshot while the daemon-owned store remains open', async () => {
    const store = healthyStore();
    try {
      const sourceFiles = [`${statePath}`, `${statePath}-wal`];
      const before = sourceFiles.map((path) => ({ path, hash: sha256(path) }));
      const beforeFiles = readdirSync(dir).sort();
      const report = await inspect();
      expect(report).toMatchObject({ exitCode: 0, schema: { state: 'matched' } });
      expect(store.readDaemonHealth()).toMatchObject({ state: 'running' });
      for (const source of before) expect(sha256(source.path)).toBe(source.hash);
      expect(readdirSync(dir).sort()).toEqual(beforeFiles);
    } finally {
      store.close();
    }
  });

  it('uses one SQLite backup epoch across an exact commit/checkpoint interleaving', async () => {
    const store = healthyStore();
    const checkpoint = new DatabaseSync(statePath);
    const scratchParent = join(dir, 'snapshot-scratch');
    mkdirSync(scratchParent);
    const freshHeartbeat = '2026-08-26T00:02:00.000Z';
    let checkpointed = false;
    let checkpointResult: { readonly busy: number; readonly log: number; readonly checkpointed: number } | null = null;
    try {
      expect(store.recordDaemonHeartbeat(INSTANCE, freshHeartbeat)).not.toBeNull();
      const report = await inspect({
        clock: () => new Date('2026-08-26T00:02:30.000Z'),
        temporaryDirectory: scratchParent,
        afterSqliteBackupStep: () => {
          if (checkpointed) return;
          checkpointed = true;
          checkpointResult = checkpoint.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
            readonly busy: number; readonly log: number; readonly checkpointed: number;
          };
        },
      });
      expect(checkpointed).toBe(true);
      expect(checkpointResult).toEqual({ busy: 0, log: 0, checkpointed: 0 });
      expect(report).toMatchObject({
        exitCode: 0,
        daemon: { heartbeatAgeSeconds: 30 },
        codes: ['status.healthy'],
      });
      expect(store.readDaemonHealth()?.heartbeatAt).toBe(freshHeartbeat);
      expect(readdirSync(scratchParent)).toEqual([]);
    } finally {
      checkpoint.close();
      store.close();
    }
  });

  it('uses the injected clock for fresh/stale and clock-drift classifications', async () => {
    const snapshot = snapshotAndClose(healthyStore());
    expect((await inspect({ snapshot, clock: () => new Date('2026-08-26T00:01:30.000Z') })).exitCode).toBe(0);
    const stale = await inspect({ snapshot, clock: () => new Date('2026-08-26T00:01:31.000Z') });
    expect(stale.exitCode).toBe(1);
    expect(stale.codes).toContain('daemon.stale');
    const future = await inspect({ snapshot, clock: () => new Date('2026-08-25T23:59:00.000Z') });
    expect(future.exitCode).toBe(1);
    expect(future.codes).toContain('daemon.clock_drift');
    const broken = await inspect({ snapshot, clock: () => { throw new Error('SENTINEL_CLOCK_DETAIL'); } });
    expect(broken).toMatchObject({ exitCode: 1, codes: expect.arrayContaining(['daemon.clock_drift']) });
    expect(JSON.stringify(broken)).not.toContain('SENTINEL');
  });

  it('maps stopped/config/schema absence to exit 2 and build/job degradation to exit 1', async () => {
    let store = healthyStore();
    store.recordDaemonCleanStop(INSTANCE, AT2);
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['daemon.stopped']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore();
    store.setDaemonDesiredState('stopped', AT2);
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['daemon.stopped']),
    });

    rmSync(statePath, { force: true });
    expect(await inspect({ snapshot: snapshotAndClose(new SqliteDigestStore(statePath)) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['daemon.absent']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore({ configFingerprint: 'different-config' });
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['config.drift']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore({ buildFingerprint: 'different-build' });
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 1, codes: expect.arrayContaining(['build.drift']),
    });

    rmSync(statePath, { force: true });
    expect(await inspect({
      snapshot: snapshotAndClose(healthyStore()), expectedBuildIdentity: null, env: {},
    })).toMatchObject({
      exitCode: 1, codes: expect.arrayContaining(['build.unverified']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore({ failure: 'repository-discovery' });
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 1, codes: expect.arrayContaining(['job.failed']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore({ failure: 'repository-discovery', backoff: true });
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 1, codes: expect.arrayContaining(['job.backoff']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore({ jobs: false });
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 1, codes: expect.arrayContaining(['job.absent']),
    });
  });

  it('ignores disabled observer rows while Gate and Channel jobs remain required', async () => {
    const requiredJobs = ['gate-reconcile', 'channel-delivery'] as const;
    let store = healthyStore({ config: disabledConfig, jobNames: requiredJobs });
    let report = await inspect({ config: disabledConfig, snapshot: snapshotAndClose(store) });
    expect(report).toMatchObject({ exitCode: 0, codes: ['status.healthy'] });
    expect(report.jobs.filter((job) => job.state === 'absent').map((job) => job.job)).toEqual([
      'repository-discovery', 'run-observer', 'pr-digest',
    ]);

    rmSync(statePath, { force: true });
    store = healthyStore({ config: disabledConfig, jobNames: requiredJobs });
    for (const job of ['repository-discovery', 'run-observer', 'pr-digest'] as const) {
      const claim = store.startDaemonJob(job, AT0);
      if (claim === null) throw new Error('expected disabled observer claim');
      const failed = store.completeDaemonJobFailure({
        claim, at: AT1, durationMs: 1, errorCode: 'github.unavailable',
      });
      if (failed === null) throw new Error('expected disabled observer failure');
      if (job === 'run-observer') store.scheduleDaemonJobBackoff(job, failed.revision, AT2, AT2);
    }
    report = await inspect({ config: disabledConfig, snapshot: snapshotAndClose(store) });
    expect(report).toMatchObject({ exitCode: 0, codes: ['status.healthy'] });
    expect(report.jobs.find((job) => job.job === 'repository-discovery')?.state).toBe('failed');
    expect(report.jobs.find((job) => job.job === 'run-observer')?.state).toBe('backoff');

    rmSync(statePath, { force: true });
    store = healthyStore({
      config: disabledConfig,
      jobNames: requiredJobs,
      failure: 'gate-reconcile',
    });
    report = await inspect({ config: disabledConfig, snapshot: snapshotAndClose(store) });
    expect(report).toMatchObject({ exitCode: 1, codes: expect.arrayContaining(['job.failed']) });

    rmSync(statePath, { force: true });
    store = healthyStore({ config: disabledConfig, jobNames: ['gate-reconcile'] });
    report = await inspect({ config: disabledConfig, snapshot: snapshotAndClose(store) });
    expect(report).toMatchObject({ exitCode: 1, codes: expect.arrayContaining(['job.absent']) });
  });

  it('accepts an injected O1-6 task facet without inspecting or mutating Task Scheduler', async () => {
    const snapshot = snapshotAndClose(healthyStore());
    expect(await inspect({ snapshot, taskFacet: () => ({ ownership: 'absent', state: 'stopped' }) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['task.absent', 'task.stopped']),
    });
    expect(await inspect({ snapshot, taskFacet: () => ({ ownership: 'drifted', state: 'running' }) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['task.drift']),
    });
    expect(await inspect({ snapshot, taskFacet: () => ({ ownership: 'matched', state: 'running' }) })).toMatchObject({
      exitCode: 0,
    });
  });

  it('does not create an absent source database or a temporary snapshot', async () => {
    expect(existsSync(statePath)).toBe(false);
    expect((await inspect()).codes).toContain('schema.absent');
    expect(existsSync(statePath)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([12, 14] as const)('does not migrate or alter a schema-v%s source database', async (version) => {
    healthyStore().close();
    const raw = new DatabaseSync(statePath);
    raw.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(version);
    raw.close();
    const beforeHash = sha256(statePath);
    const beforeFiles = readdirSync(dir).sort();
    const report = await inspect();
    expect(report).toMatchObject({ exitCode: 2, schema: { state: 'mismatched', foundVersion: version } });
    expect(sha256(statePath)).toBe(beforeHash);
    expect(readdirSync(dir).sort()).toEqual(beforeFiles);
  }, 15_000);

  it('does not alter or echo a corrupt source database', async () => {
    writeFileSync(statePath, 'SENTINEL_CORRUPT_DATABASE');
    const beforeHash = sha256(statePath);
    const beforeFiles = readdirSync(dir).sort();
    const report = await inspect();
    expect(report).toMatchObject({ exitCode: 2, schema: { state: 'corrupt' } });
    expect(JSON.stringify(report)).not.toContain('SENTINEL');
    expect(sha256(statePath)).toBe(beforeHash);
    expect(readdirSync(dir).sort()).toEqual(beforeFiles);
  });

  it('turns config/path failures into static exit-2 codes without leaking private paths', async () => {
    const privatePath = join(dir, 'SENTINEL-private-config.json');
    const invalidConfig = await inspectOperationalStatus({
      configPath: privatePath, statePath, logDir: dir,
    });
    expect(invalidConfig).toMatchObject({ exitCode: 2, codes: ['config.invalid'] });
    expect(JSON.stringify(invalidConfig)).not.toContain('SENTINEL');

    const pathFailure = await inspectOperationalStatus({
      config,
      env: {},
      platform: 'win32',
      expectedBuildIdentity: BUILD,
    });
    expect(pathFailure).toMatchObject({ exitCode: 2, codes: ['state.path_unavailable'] });
  });
});

describe('registry and exact D2/D3 aggregates', () => {
  it('separates active/pending/rejected/deferred registry aggregates without returning identities', async () => {
    const store = healthyStore();
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [{
        canonicalKey: 'github.com/private-owner/private-repository',
        nameWithOwner: 'private-owner/private-repository',
        githubRepositoryId: 123,
        projectKey: 'Project Sentinel',
        projectOrigin: 'explicit',
        evidence: 'verified',
      }],
      bindings: [],
      issues: [
        { issueHash: 'a'.repeat(64), category: 'github_identity_unverified' },
        { issueHash: 'b'.repeat(64), category: 'capacity_deferred' },
        { issueHash: 'c'.repeat(64), category: 'no_remote' },
      ],
      at: AT0,
    });
    store.close();
    const report = await inspect();
    expect(report).toMatchObject({
      exitCode: 1,
      registry: { active: 1, pending: 1, rejected: 1, deferred: 1 },
      codes: expect.arrayContaining(['registry.pending', 'registry.rejected', 'registry.deferred']),
    });
    expect(JSON.stringify(report)).not.toContain('private-owner');
    expect(JSON.stringify(report)).not.toContain('Project Sentinel');
  });

  it('keeps legacy notification_state diagnostic but not actionable', async () => {
    const snapshot = projectedSnapshot({
      gateCards: 0, channelDeliveries: 0, resumeBaselines: 0,
      legacyNotifications: 1, slackRootIntents: 0,
    });
    const report = await inspect({ snapshot });
    expect(report.work.pending).toMatchObject({ legacyNotifications: 1, actionableTotal: 0 });
    expect(report.codes).not.toContain('work.pending');
    expect(report.exitCode).toBe(0);
    expect(JSON.stringify(report)).not.toContain('gate:legacy-private-id');
  });

  it('projects gate card, delivery, required resume, Slack pending/uncertain, and unavailable-resume dead exactly', async () => {
    const snapshot = projectedSnapshot({
      gateCards: 1, channelDeliveries: 1, resumeBaselines: 1,
      legacyNotifications: 0, slackRootIntents: 1,
    }, 1, 1);
    const report = await inspect({ snapshot });
    expect(report.work).toEqual({
      pending: {
        gateCards: 1, channelDeliveries: 1, resumeBaselines: 1, slackRootIntents: 1,
        legacyNotifications: 0, actionableTotal: 4,
      },
      uncertain: { slackRootIntents: 1, total: 1 },
      dead: { unavailableResumeBaselines: 1, total: 1 },
    });
    expect(report).toMatchObject({
      exitCode: 1,
      codes: expect.arrayContaining(['work.pending', 'work.uncertain', 'work.dead']),
    });
    const json = JSON.stringify(report);
    for (const sentinel of ['private-id', 'C_PRIVATE', 'dispatch-private-id']) expect(json).not.toContain(sentinel);
  });
});
