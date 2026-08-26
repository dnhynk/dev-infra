import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/store/schema.js';
import {
  OperationalStoreError,
  SchemaVersionError,
  SqliteDigestStore,
} from '../src/store/sqlite.js';
import type { SlackRootClaim } from '../src/store/operational-types.js';
import type { PullRequestKey } from '../src/identity/keys.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-operational-v13-'));
  path = join(dir, 'state.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const AT0 = '2026-08-26T00:00:00.000Z';
const AT1 = '2026-08-26T00:00:01.000Z';
const AT2 = '2026-08-26T00:00:02.000Z';
const AT3 = '2026-08-26T00:00:03.000Z';
const AT4 = '2026-08-26T00:00:04.000Z';
const AT5 = '2026-08-26T00:00:05.000Z';
const AT6 = '2026-08-26T00:00:06.000Z';
const AT7 = '2026-08-26T00:00:07.000Z';

function downgradeToV12(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    DROP TABLE slack_root_intent;
    DROP TABLE daemon_job_outcome;
    DROP TABLE daemon_health;
    DROP TABLE repository_discovery_issue;
    DROP TABLE orca_repository_binding;
    DROP TABLE repository_registry;
  `);
  db.prepare('UPDATE schema_version SET version = 12 WHERE id = 1').run();
  db.close();
}

function objectMap(dbPath: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const objects = (db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as {
      readonly type: string; readonly name: string; readonly tbl_name: string; readonly sql: string;
    }[]).map((object) => ({
      ...object,
      columns: object.type === 'table' ? db.prepare(`PRAGMA table_xinfo(${object.name})`).all() : [],
      indexes: object.type === 'table' ? db.prepare(`PRAGMA index_list(${object.name})`).all() : [],
      indexColumns: object.type === 'index' ? db.prepare(`PRAGMA index_xinfo(${object.name})`).all() : [],
      foreignKeys: object.type === 'table'
        ? db.prepare(`PRAGMA foreign_key_list(${object.name})`).all()
        : [],
    }));
  db.close();
  return objects;
}

const repository = {
  canonicalKey: 'github.com/acme/widget' as const,
  nameWithOwner: 'acme/widget' as const,
  githubRepositoryId: 101,
  projectKey: 'project-one',
  projectOrigin: 'explicit' as const,
};

const binding = {
  orcaRepositoryId: 'orca-repository-key',
  canonicalKey: repository.canonicalKey,
  projectKey: repository.projectKey,
  origin: 'discovered' as const,
};

const issue = { issueHash: 'a'.repeat(64), category: 'no_remote' as const };

function expectClaim(result: ReturnType<SqliteDigestStore['claimSlackRootIntent']>): SlackRootClaim {
  expect(result?.kind).toBe('claimed');
  if (result?.kind !== 'claimed') throw new Error('test expected an exact root claim');
  return result.claim;
}

describe('additive v13 operational schema', () => {
  it('makes fresh v13 structurally identical to v12→v13 and preserves existing mapping rows', () => {
    const migrated = join(dir, 'migrated.db');
    const before = new SqliteDigestStore(migrated);
    const prKey = 'pr:github.com/acme/widget#7' as PullRequestKey;
    before.insertPrMessage({
      prKey, channelId: 'C1', messageTs: '100.1', renderFingerprint: 'render.old',
      factsFingerprint: 'facts.old', summaryJson: null, at: AT0,
    });
    before.insertRunMessage({
      runKey: 'run:existing', channelId: 'C2', messageTs: '100.2',
      renderFingerprint: 'run.old', at: AT0,
    });
    before.insertRunCollectionMessage({
      channelId: 'C3', messageTs: '100.3', renderFingerprint: 'collection.old', at: AT0,
    });
    before.close();
    downgradeToV12(migrated);

    new SqliteDigestStore(migrated).close();
    new SqliteDigestStore(path).close();

    expect(SCHEMA_VERSION).toBe(13);
    expect(objectMap(migrated)).toEqual(objectMap(path));
    const reopened = new SqliteDigestStore(migrated);
    expect(reopened.findPrMessage(prKey)).toMatchObject({ channelId: 'C1', messageTs: '100.1' });
    expect(reopened.findRunMessage('run:existing')).toMatchObject({ channelId: 'C2', messageTs: '100.2' });
    expect(reopened.findRunCollectionMessage()).toMatchObject({ channelId: 'C3', messageTs: '100.3' });
    reopened.close();
  });

  it('rolls every v12→v13 DDL fault back to a clean v12 file', () => {
    expect(MIGRATIONS[11]).toHaveLength(13);
    for (const statementIndex of MIGRATIONS[11]!.keys()) {
      const candidate = join(dir, `fault-${statementIndex}.db`);
      new SqliteDigestStore(candidate).close();
      downgradeToV12(candidate);
      expect(() => new SqliteDigestStore(candidate, {
        migrationFault: (version, index) => {
          if (version === 12 && index === statementIndex) throw new Error('injected');
        },
      })).toThrow('injected');
      const raw = new DatabaseSync(candidate, { readOnly: true });
      expect(raw.prepare('SELECT version FROM schema_version WHERE id = 1').get())
        .toEqual({ version: 12 });
      expect(raw.prepare(`SELECT name FROM sqlite_master
        WHERE name IN ('repository_registry','orca_repository_binding','repository_discovery_issue',
                       'daemon_health','daemon_job_outcome','slack_root_intent')`).all()).toEqual([]);
      raw.close();
    }
  });

  it('rejects future schemas and malformed operational rows with static errors', () => {
    new SqliteDigestStore(path).close();
    const future = new DatabaseSync(path);
    future.prepare('UPDATE schema_version SET version = 14 WHERE id = 1').run();
    future.close();
    expect(() => new SqliteDigestStore(path)).toThrow(SchemaVersionError);

    const corruptPath = join(dir, 'corrupt.db');
    const store = new SqliteDigestStore(corruptPath);
    const entity = { kind: 'run', key: 'run:corrupt-check' } as const;
    store.prepareSlackRootIntent({ ...entity, channelId: 'C1', renderFingerprint: 'render.1', at: AT0 });
    store.close();
    const corrupt = new DatabaseSync(corruptPath);
    corrupt.exec('PRAGMA ignore_check_constraints = ON');
    corrupt.prepare(`UPDATE slack_root_intent SET entity_key = 'raw-private-key'`).run();
    corrupt.close();
    try {
      new SqliteDigestStore(corruptPath);
      throw new Error('expected strict operational validation');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationalStoreError);
      expect((error as Error).message).toBe('Operational store state is malformed or corrupt');
      expect((error as Error).message).not.toContain('raw-private-key');
    }
  });

  it('fails closed with one redacted error for corrupt rows in all six operational tables', () => {
    const corruptions = [
      `UPDATE repository_registry SET canonical_key = 'private-raw-key'`,
      `UPDATE orca_repository_binding SET canonical_key = NULL, origin = 'discovered'`,
      `UPDATE repository_discovery_issue SET occurrence_count = 0`,
      `UPDATE daemon_health SET clean_stopped_at = '${AT1}' WHERE state = 'running'`,
      `UPDATE daemon_job_outcome SET attempt = 0`,
      `UPDATE slack_root_intent SET entity_key = 'private-raw-key'`,
    ];
    for (const [index, sql] of corruptions.entries()) {
      const candidate = join(dir, `corrupt-${index}.db`);
      const store = new SqliteDigestStore(candidate);
      store.replaceDiscoverySnapshot({
        repositories: [repository], bindings: [binding], issues: [issue], at: AT0,
      });
      store.recordDaemonStart({
        instanceId: 'instance-a', buildFingerprint: 'build.1', configFingerprint: 'config.1', at: AT0,
      });
      store.startDaemonJob('repository-discovery', AT0);
      store.prepareSlackRootIntent({
        kind: 'run', key: 'run:corrupt', channelId: 'C1', renderFingerprint: 'render.1', at: AT0,
      });
      store.close();
      const raw = new DatabaseSync(candidate);
      raw.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON');
      raw.exec(sql);
      raw.close();
      expect(() => new SqliteDigestStore(candidate)).toThrowError(
        new OperationalStoreError('OPERATIONAL_STORE_CORRUPT'),
      );
    }
  });
});

describe('discovery registry transactions', () => {
  it('replaces one effective snapshot, aggregates issues, and preserves LKG across rollback', () => {
    const store = new SqliteDigestStore(path);
    expect(store.replaceDiscoverySnapshot({
      repositories: [repository], bindings: [binding], issues: [issue], at: AT0,
    })).toMatchObject({
      repositories: [{ canonicalKey: repository.canonicalKey, active: true }],
      bindings: [{ orcaRepositoryId: binding.orcaRepositoryId, active: true }],
      issues: [{ issueHash: issue.issueHash, occurrenceCount: 1, active: true }],
    });
    store.replaceDiscoverySnapshot({
      repositories: [repository],
      bindings: [binding, {
        orcaRepositoryId: 'manual-no-remote', canonicalKey: null,
        projectKey: 'project-one', origin: 'manual',
      }],
      issues: [issue], at: AT1,
    });
    expect(store.readEffectiveDiscoverySnapshot().issues[0]?.occurrenceCount).toBe(2);
    store.close();

    const faulty = new SqliteDigestStore(path, {
      operationalFault: (point) => {
        if (point === 'after_discovery_registry') throw new Error('injected');
      },
    });
    expect(() => faulty.replaceDiscoverySnapshot({
      repositories: [{ ...repository, projectKey: 'changed' }],
      bindings: [{ ...binding, projectKey: 'changed' }], issues: [], at: AT2,
    })).toThrow(OperationalStoreError);
    expect(faulty.readEffectiveDiscoverySnapshot()).toMatchObject({
      repositories: [{ projectKey: 'project-one', active: true }],
      bindings: [
        { orcaRepositoryId: 'manual-no-remote', canonicalKey: null, active: true },
        { orcaRepositoryId: binding.orcaRepositoryId, projectKey: 'project-one', active: true },
      ],
      issues: [{ occurrenceCount: 2, active: true }],
    });
    faulty.close();
  });

  it('rejects duplicate identities, project mismatch, and non-manual null bindings', () => {
    const store = new SqliteDigestStore(path);
    for (const input of [
      { repositories: [repository, repository], bindings: [], issues: [], at: AT0 },
      { repositories: [repository], bindings: [{ ...binding, projectKey: 'wrong' }], issues: [], at: AT0 },
      { repositories: [repository], bindings: [{ ...binding, canonicalKey: null }], issues: [], at: AT0 },
    ]) {
      expect(() => store.replaceDiscoverySnapshot(input)).toThrow(OperationalStoreError);
    }
    store.close();
  });
});

describe('daemon health and monotonic job outcomes', () => {
  it('records desired/start/heartbeat/clean-stop facts used to derive staleness', () => {
    const store = new SqliteDigestStore(path);
    expect(store.recordDaemonStart({
      instanceId: 'instance-a', buildFingerprint: 'build.1', configFingerprint: 'config.1', at: AT0,
    })).toMatchObject({ state: 'running', desiredState: 'running', heartbeatAt: AT0 });
    expect(store.recordDaemonHeartbeat('wrong-instance', AT1)).toBeNull();
    expect(store.recordDaemonHeartbeat('instance-a', AT1)).toMatchObject({ heartbeatAt: AT1 });
    expect(store.setDaemonDesiredState('stopped', AT2)).toMatchObject({ desiredState: 'stopped' });
    expect(store.recordDaemonStart({
      instanceId: 'instance-b', buildFingerprint: 'build.1', configFingerprint: 'config.1', at: AT3,
    })).toMatchObject({ state: 'running', desiredState: 'stopped', instanceId: 'instance-b' });
    expect(store.recordDaemonCleanStop('instance-b', AT4)).toMatchObject({
      state: 'stopped', desiredState: 'stopped', cleanStoppedAt: AT4,
    });
    expect(store.recordDaemonHeartbeat('instance-b', AT4)).toBeNull();
    expect(store.setDaemonDesiredState('running', AT5)).toMatchObject({ desiredState: 'running' });
    expect(store.recordDaemonStart({
      instanceId: 'instance-c', buildFingerprint: 'build.1', configFingerprint: 'config.1', at: AT6,
    })).toMatchObject({ state: 'running', desiredState: 'running' });
    expect(store.recordDaemonCleanStop('instance-c', AT7)).toMatchObject({
      state: 'stopped', desiredState: 'running', cleanStoppedAt: AT7,
    });
    store.close();
  });

  it('fences concurrent job starts and advances success/failure/backoff/checkpoint monotonically', () => {
    const store = new SqliteDigestStore(path);
    const first = store.startDaemonJob('repository-discovery', AT0)!;
    expect(store.startDaemonJob('repository-discovery', AT0)).toBeNull();
    expect(() => store.completeDaemonJobSuccess({
      claim: first, at: AT1, nextRunAt: AT0, durationMs: 1000,
    })).toThrow(OperationalStoreError);
    expect(store.completeDaemonJobSuccess({
      claim: first, at: AT1, nextRunAt: AT2, durationMs: 1000,
      processedCount: 4, deferredCount: 1, checkpoint: 5,
    })).toMatchObject({
      state: 'succeeded', checkpoint: 5, consecutiveFailures: 0, nextRunAt: AT2,
    });
    expect(store.startDaemonJob('repository-discovery', AT1)).toBeNull();
    expect(() => store.advanceDaemonJobCheckpoint('repository-discovery', 5, 4, AT2))
      .toThrow(OperationalStoreError);
    const second = store.startDaemonJob('repository-discovery', AT2)!;
    const failed = store.completeDaemonJobFailure({
      claim: second, at: AT3, durationMs: 1000, errorCode: 'github.unavailable', checkpoint: 6,
    });
    expect(failed).toMatchObject({ state: 'failed', checkpoint: 6, consecutiveFailures: 1 });
    expect(store.scheduleDaemonJobBackoff(
      'repository-discovery', failed!.revision, '2026-08-26T00:01:00.000Z', AT3,
    )).toMatchObject({ state: 'backoff', nextRunAt: '2026-08-26T00:01:00.000Z' });
    expect(store.startDaemonJob('repository-discovery', AT3)).toBeNull();
    store.close();
  });
});

describe('at-most-once Slack root intents', () => {
  it('lets only one connection claim, never retries uncertain, and recovers prior senders as uncertain', () => {
    const first = new SqliteDigestStore(path);
    const second = new SqliteDigestStore(path);
    const entity = { kind: 'run', key: 'run:one' } as const;
    first.prepareSlackRootIntent({ ...entity, channelId: 'C1', renderFingerprint: 'render.1', at: AT0 });
    const claim = expectClaim(first.claimSlackRootIntent(entity, 'instance-a', AT1));
    expect(second.claimSlackRootIntent(entity, 'instance-b', AT1)?.kind).toBe('not_claimed');
    expect(first.markSlackRootIntentUncertain(claim, 'transport.unknown', AT2))
      .toMatchObject({ state: 'uncertain' });
    expect(second.claimSlackRootIntent(entity, 'instance-b', AT3)?.kind).toBe('not_claimed');

    const recover = { kind: 'run', key: 'run:recover' } as const;
    first.prepareSlackRootIntent({ ...recover, channelId: 'C1', renderFingerprint: 'render.2', at: AT0 });
    expectClaim(first.claimSlackRootIntent(recover, 'old-instance', AT1));
    expect(second.recoverSlackRootIntents('new-instance', AT2)).toBe(1);
    expect(second.findSlackRootIntent(recover)).toMatchObject({
      state: 'uncertain', lastErrorCode: 'startup_recovery',
    });
    first.close();
    second.close();
  });

  it('commits mapping+posted atomically and leaves a rolled-back possible effect unauthorized', () => {
    const entity = { kind: 'pr', key: 'pr:github.com/acme/widget#8' as PullRequestKey } as const;
    const faulty = new SqliteDigestStore(path, {
      operationalFault: (point) => {
        if (point === 'after_root_mapping') throw new Error('injected');
      },
    });
    faulty.prepareSlackRootIntent({ ...entity, channelId: 'C1', renderFingerprint: 'render.1', at: AT0 });
    const claim = expectClaim(faulty.claimSlackRootIntent(entity, 'instance-a', AT1));
    expect(() => faulty.markSlackRootIntentPosted({
      claim, messageTs: '100.2', mapping: {
        kind: 'pr', factsFingerprint: 'facts.1', summaryJson: null,
      }, at: AT2,
    })).toThrow(OperationalStoreError);
    expect(faulty.findPrMessage(entity.key)).toBeNull();
    expect(faulty.findSlackRootIntent(entity)?.state).toBe('sending');
    expect(faulty.markSlackRootIntentUncertain(claim, 'commit.unknown', AT3)?.state).toBe('uncertain');
    faulty.close();

    const postedPath = join(dir, 'posted.db');
    const posted = new SqliteDigestStore(postedPath);
    posted.prepareSlackRootIntent({ ...entity, channelId: 'C1', renderFingerprint: 'render.1', at: AT0 });
    const postedClaim = expectClaim(posted.claimSlackRootIntent(entity, 'instance-a', AT1));
    expect(posted.markSlackRootIntentPosted({
      claim: postedClaim, messageTs: '100.2', mapping: {
        kind: 'pr', factsFingerprint: 'facts.1', summaryJson: null,
      }, at: AT2,
    })).toMatchObject({ state: 'posted', messageTs: '100.2' });
    expect(posted.findPrMessage(entity.key)).toMatchObject({ channelId: 'C1', messageTs: '100.2' });
    posted.close();
    const reopened = new SqliteDigestStore(postedPath);
    expect(reopened.findSlackRootIntent(entity)?.state).toBe('posted');
    reopened.close();
  });
});

describe('exact operational pending categories', () => {
  it('separates D2/D3 sidecars, consumed/recorded/required, card pending, and legacy state', () => {
    const store = new SqliteDigestStore(path);
    const pendingRoot = { kind: 'run', key: 'run:pending' } as const;
    store.prepareSlackRootIntent({ ...pendingRoot, channelId: 'C1', renderFingerprint: 'r.1', at: AT0 });
    const uncertainRoot = { kind: 'run', key: 'run:uncertain' } as const;
    store.prepareSlackRootIntent({ ...uncertainRoot, channelId: 'C1', renderFingerprint: 'r.2', at: AT0 });
    const uncertainClaim = expectClaim(store.claimSlackRootIntent(uncertainRoot, 'instance-a', AT1));
    store.markSlackRootIntentUncertain(uncertainClaim, 'transport.unknown', AT2);

    const raw = new DatabaseSync(path);
    const insertOutbox = raw.prepare(`INSERT INTO gate_resolution_outbox
      (gate_key, revision, card_state, card_pending, notification_state, projected_at,
       projection_owner, projection_expires_at, last_error_code, created_at, updated_at)
      VALUES (?, 0, 'resolved', ?, 'pending', ?, NULL, NULL, NULL, ?, ?)`);
    const insertDelivery = raw.prepare(`INSERT INTO gate_channel_delivery
      (gate_key, run_key, task_key, source_dispatch_id, revision, deferred_outbox_revision,
       state, attempt_count, last_attempt_at, next_attempt_at, receipted_at, consumed_at,
       lease_owner, lease_expires_at, last_error_code, created_at, updated_at, resume_baseline_state)
      VALUES (?, 'run:r', 'task:t', 'dispatch-id', 0, 0, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`);
    insertOutbox.run('gate:card', 1, null, AT0, AT0);
    insertOutbox.run('gate:legacy', 0, AT0, AT0, AT0);
    // The sidecar owns this key: neither card_pending nor legacy notification may shadow it.
    insertOutbox.run('gate:required', 1, null, AT0, AT0);
    insertDelivery.run('gate:required', 'pending', 0, null, AT1, null, null, AT0, AT0, 'required');
    insertOutbox.run('gate:recorded', 0, AT0, AT0, AT0);
    insertDelivery.run('gate:recorded', 'receipted', 1, AT1, AT2, AT2, null, AT0, AT2, 'recorded');
    insertOutbox.run('gate:consumed', 0, AT0, AT0, AT0);
    insertDelivery.run('gate:consumed', 'consumed', 1, AT1, null, AT2, AT2, AT0, AT2, 'recorded');
    insertOutbox.run('gate:dead', 0, AT0, AT0, AT0);
    insertDelivery.run('gate:dead', 'pending', 0, null, AT1, null, null, AT0, AT0, 'unavailable');
    raw.close();

    expect(store.readOperationalAggregateCounts()).toEqual({
      pending: {
        gateCards: 1, channelDeliveries: 1, resumeBaselines: 1,
        legacyNotifications: 1, slackRootIntents: 1, total: 5,
      },
      uncertain: { slackRootIntents: 1, total: 1 },
      dead: { unavailableResumeBaselines: 1, total: 1 },
    });
    store.close();
  });
});
