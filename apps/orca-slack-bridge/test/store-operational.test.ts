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
import type { OperationalFailureCode, SlackRootClaim } from '../src/store/operational-types.js';
import { pullRequestKey, runKey, type PullRequestKey, type RunKey } from '../src/identity/keys.js';
import {
  downgradeGateMetadataToV13,
  dropTerminalPromptTables,
} from './fixtures/schema-downgrade.js';

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
  dropTerminalPromptTables(db);
  downgradeGateMetadataToV13(db);
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
  evidence: 'verified' as const,
};

const binding = {
  orcaRepositoryId: 'orca-repository-key',
  canonicalKey: repository.canonicalKey,
  projectKey: repository.projectKey,
  origin: 'discovered' as const,
  evidence: 'verified' as const,
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
    const prKey = pullRequestKey(101, 7);
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

    expect(SCHEMA_VERSION).toBe(16);
    expect(objectMap(migrated)).toEqual(objectMap(path));
    const structural = new DatabaseSync(migrated, { readOnly: true });
    expect(structural.prepare('PRAGMA foreign_key_list(orca_repository_binding)').all())
      .toEqual(expect.arrayContaining([expect.objectContaining({
        table: 'repository_registry', from: 'canonical_key', to: 'canonical_key', on_update: 'CASCADE',
      })]));
    structural.close();
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
    future.prepare('UPDATE schema_version SET version = 17 WHERE id = 1').run();
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
        passOutcome: 'succeeded',
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

  it('rejects noncanonical repository, PR, and Run identities without exposing rejected values', () => {
    const invalidCanonicalKey = 'github.com/acme/private-sentinel.git';
    const invalidPrKeys = [
      'pr:github.com/acme/private-sentinel#7',
      'pr:0#7',
      'pr:101#0',
      'pr:-1#7',
      'pr:101#-7',
      'pr:01#7',
      'pr:101#07',
      'pr:101#7.0',
      'pr:101',
      'pr:101#7#8',
      'pr:9007199254740992#7',
      'pr:101#9007199254740992',
    ] as const;
    const inputStore = new SqliteDigestStore(path);
    for (const key of invalidPrKeys) {
      try {
        inputStore.prepareSlackRootIntent({
          kind: 'pr', key: key as PullRequestKey, channelId: 'C1',
          renderFingerprint: 'render.1', at: AT0,
        });
        throw new Error('expected invalid PR identity to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(OperationalStoreError);
        expect((error as Error).message).toBe('Operational store input is invalid');
        expect((error as Error).message).not.toContain(key);
      }
    }
    const invalidRunKeys = [
      'run:', 'run: ', 'run:\t', 'run: private', 'run:private ',
      'run:\nprivate', 'run:private\n', 'private-run-key',
    ] as const;
    for (const key of invalidRunKeys) {
      try {
        inputStore.prepareSlackRootIntent({
          kind: 'run', key: key as RunKey, channelId: 'C1',
          renderFingerprint: 'render.1', at: AT0,
        });
        throw new Error('expected invalid Run identity to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(OperationalStoreError);
        expect((error as Error).message).toBe('Operational store input is invalid');
        expect((error as Error).message).not.toContain('private');
      }
    }
    const validInternalRun = runKey('internal run/key');
    expect(inputStore.prepareSlackRootIntent({
      kind: 'run', key: validInternalRun, channelId: 'C1',
      renderFingerprint: 'render.1', at: AT0,
    })).toMatchObject({ key: validInternalRun, state: 'pending' });
    try {
      inputStore.replaceDiscoverySnapshot({
        passOutcome: 'succeeded',
        repositories: [{
          ...repository,
          canonicalKey: invalidCanonicalKey as `github.com/${string}/${string}`,
          nameWithOwner: 'acme/private-sentinel.git',
        }],
        bindings: [], issues: [], at: AT0,
      });
      throw new Error('expected noncanonical repository identity to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationalStoreError);
      expect((error as Error).message).toBe('Operational store input is invalid');
      expect((error as Error).message).not.toContain('private-sentinel');
    }
    inputStore.close();

    const corruptRepositories = join(dir, 'corrupt-canonical.db');
    const repositoryStore = new SqliteDigestStore(corruptRepositories);
    repositoryStore.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [repository], bindings: [binding], issues: [], at: AT0,
    });
    repositoryStore.close();
    const repositoryDb = new DatabaseSync(corruptRepositories);
    repositoryDb.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON');
    repositoryDb.prepare(`UPDATE repository_registry
      SET canonical_key = ?, name_with_owner = ?`).run(
      invalidCanonicalKey, 'acme/private-sentinel.git',
    );
    repositoryDb.close();
    try {
      new SqliteDigestStore(corruptRepositories);
      throw new Error('expected corrupt repository identity to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationalStoreError);
      expect((error as Error).message).toBe('Operational store state is malformed or corrupt');
      expect((error as Error).message).not.toContain('private-sentinel');
    }

    const corruptIntentPath = join(dir, 'corrupt-pr-identity.db');
    const intentStore = new SqliteDigestStore(corruptIntentPath);
    intentStore.prepareSlackRootIntent({
      kind: 'pr', key: pullRequestKey(101, 7), channelId: 'C1',
      renderFingerprint: 'render.1', at: AT0,
    });
    intentStore.close();
    const intentDb = new DatabaseSync(corruptIntentPath);
    intentDb.exec('PRAGMA ignore_check_constraints = ON');
    const invalidCorruptPrKey = 'pr:9007199254740992#7';
    intentDb.prepare('UPDATE slack_root_intent SET entity_key = ?').run(invalidCorruptPrKey);
    intentDb.close();
    try {
      new SqliteDigestStore(corruptIntentPath);
      throw new Error('expected corrupt PR identity to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationalStoreError);
      expect((error as Error).message).toBe('Operational store state is malformed or corrupt');
      expect((error as Error).message).not.toContain(invalidCorruptPrKey);
    }

    const corruptRunPath = join(dir, 'corrupt-run-identity.db');
    const runStore = new SqliteDigestStore(corruptRunPath);
    runStore.prepareSlackRootIntent({
      kind: 'run', key: runKey('valid-run'), channelId: 'C1',
      renderFingerprint: 'render.1', at: AT0,
    });
    runStore.close();
    const runDb = new DatabaseSync(corruptRunPath);
    runDb.exec('PRAGMA ignore_check_constraints = ON');
    runDb.prepare(`UPDATE slack_root_intent SET entity_key = 'run: private-sentinel'`).run();
    runDb.close();
    try {
      new SqliteDigestStore(corruptRunPath);
      throw new Error('expected corrupt Run identity to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationalStoreError);
      expect((error as Error).message).toBe('Operational store state is malformed or corrupt');
      expect((error as Error).message).not.toContain('private-sentinel');
    }
  });
});

describe('discovery registry transactions', () => {
  it('replaces one effective snapshot, aggregates issues, and preserves LKG across rollback', () => {
    const store = new SqliteDigestStore(path);
    expect(store.hasDiscoveryRoutingRows()).toBe(false);
    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [repository], bindings: [binding], issues: [issue], at: AT0,
    })).toMatchObject({
      repositories: [{ canonicalKey: repository.canonicalKey, active: true }],
      bindings: [{ orcaRepositoryId: binding.orcaRepositoryId, active: true }],
      issues: [{ issueHash: issue.issueHash, occurrenceCount: 1, active: true }],
    });
    expect(store.hasDiscoveryRoutingRows()).toBe(true);
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [repository],
      bindings: [binding, {
        orcaRepositoryId: 'manual-no-remote', canonicalKey: null,
        projectKey: 'project-one', origin: 'manual', evidence: 'verified',
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
      passOutcome: 'succeeded',
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

  it('atomically replaces an incompatible routing generation while preserving issue history', () => {
    let store = new SqliteDigestStore(path);
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', routingMode: 'reconcile',
      repositories: [repository], bindings: [binding], issues: [issue], at: AT0,
    });
    store.close();

    const replacement = {
      ...repository,
      canonicalKey: 'github.com/acme/replacement' as const,
      nameWithOwner: 'acme/replacement' as const,
      githubRepositoryId: 202,
      projectKey: 'project-two',
    };
    const replacementBinding = {
      ...binding,
      orcaRepositoryId: 'replacement-orca-id',
      canonicalKey: replacement.canonicalKey,
      projectKey: replacement.projectKey,
    };
    const faulty = new SqliteDigestStore(path, {
      operationalFault: (point) => {
        if (point === 'after_discovery_registry') throw new Error('injected');
      },
    });
    expect(() => faulty.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', routingMode: 'replace',
      repositories: [replacement], bindings: [replacementBinding], issues: [], at: AT1,
    })).toThrow(OperationalStoreError);
    expect(faulty.readEffectiveDiscoverySnapshot()).toMatchObject({
      repositories: [{ canonicalKey: repository.canonicalKey }],
      bindings: [{ orcaRepositoryId: binding.orcaRepositoryId }],
      issues: [{ issueHash: issue.issueHash, active: true }],
    });
    faulty.close();

    store = new SqliteDigestStore(path);
    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', routingMode: 'replace',
      repositories: [replacement], bindings: [replacementBinding], issues: [], at: AT1,
    })).toMatchObject({
      repositories: [{ canonicalKey: replacement.canonicalKey, firstSeenAt: AT1 }],
      bindings: [{ orcaRepositoryId: replacementBinding.orcaRepositoryId, firstSeenAt: AT1 }],
      issues: [],
    });
    store.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM repository_registry').get())
      .toEqual({ count: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM orca_repository_binding').get())
      .toEqual({ count: 1 });
    expect(raw.prepare(`SELECT active, resolved_at IS NOT NULL AS resolved
                          FROM repository_discovery_issue WHERE issue_hash = ?`)
      .get(issue.issueHash)).toEqual({ active: 0, resolved: 1 });
    raw.close();

    store = new SqliteDigestStore(path);
    expect(() => store.replaceDiscoverySnapshot({
      passOutcome: 'failed', routingMode: 'replace',
      repositories: [], bindings: [], issues: [], at: AT2,
    })).toThrowError(new OperationalStoreError('OPERATIONAL_INPUT_INVALID'));
    expect(store.readEffectiveDiscoverySnapshot().repositories).toMatchObject([{
      canonicalKey: replacement.canonicalKey,
    }]);
    store.close();
  });

  it('rejects duplicate identities, project mismatch, and non-manual null bindings', () => {
    const store = new SqliteDigestStore(path);
    for (const input of [
      { passOutcome: 'succeeded' as const, repositories: [repository, repository], bindings: [], issues: [], at: AT0 },
      { passOutcome: 'succeeded' as const, repositories: [repository], bindings: [{ ...binding, projectKey: 'wrong' }], issues: [], at: AT0 },
      { passOutcome: 'succeeded' as const, repositories: [repository], bindings: [{ ...binding, canonicalKey: null }], issues: [], at: AT0 },
    ]) {
      expect(() => store.replaceDiscoverySnapshot(input)).toThrow(OperationalStoreError);
    }
    store.close();
  });

  it('reserves auto Project keys for one numeric identity across inactive rows', () => {
    const autoOriginal = {
      ...repository,
      canonicalKey: 'github.com/acme/new' as const,
      nameWithOwner: 'acme/new' as const,
      projectKey: 'auto:github.com/acme/old',
      projectOrigin: 'auto' as const,
    };
    const originalBinding = {
      ...binding,
      canonicalKey: autoOriginal.canonicalKey,
      projectKey: autoOriginal.projectKey,
    };
    const store = new SqliteDigestStore(path);
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', repositories: [autoOriginal], bindings: [originalBinding],
      issues: [], at: AT0,
    });
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', repositories: [], bindings: [], issues: [],
      at: '2026-08-26T01:00:00.000Z',
    });
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', repositories: [], bindings: [], issues: [],
      at: '2026-08-27T01:00:01.000Z',
    });
    expect(store.readEffectiveDiscoverySnapshot()).toEqual({
      repositories: [], bindings: [], issues: [],
    });
    expect(store.hasDiscoveryRoutingRows()).toBe(true);

    const reused = {
      ...autoOriginal,
      canonicalKey: 'github.com/acme/old' as const,
      nameWithOwner: 'acme/old' as const,
      githubRepositoryId: 202,
    };
    const reusedBinding = {
      ...originalBinding,
      orcaRepositoryId: 'orca-reused',
      canonicalKey: reused.canonicalKey,
    };
    expect(() => store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', routingMode: 'reconcile',
      repositories: [reused], bindings: [reusedBinding], issues: [],
      at: '2026-08-27T02:00:00.000Z',
    })).toThrowError(new OperationalStoreError('OPERATIONAL_CONFLICT'));
    expect(store.readEffectiveDiscoverySnapshot()).toEqual({
      repositories: [], bindings: [], issues: [],
    });

    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', routingMode: 'replace',
      repositories: [reused], bindings: [reusedBinding], issues: [],
      at: '2026-08-27T02:00:00.000Z',
    })).toMatchObject({
      repositories: [{ githubRepositoryId: 202, projectKey: autoOriginal.projectKey }],
      bindings: [{ orcaRepositoryId: 'orca-reused' }],
    });
    store.close();
  });

  it('renames by numeric identity through the FK and applies consecutive-pass plus 24h grace', () => {
    let store = new SqliteDigestStore(path);
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [repository], bindings: [binding], issues: [], at: AT0,
    });
    const renamed = {
      ...repository,
      canonicalKey: 'github.com/acme/widget-renamed' as const,
      nameWithOwner: 'acme/widget-renamed' as const,
    };
    const renamedBinding = { ...binding, canonicalKey: renamed.canonicalKey };
    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [renamed], bindings: [renamedBinding], issues: [], at: AT1,
    })).toMatchObject({
      repositories: [{
        canonicalKey: renamed.canonicalKey, githubRepositoryId: repository.githubRepositoryId,
        firstSeenAt: AT0, lastSeenAt: AT1, consecutiveMissingPasses: 0,
      }],
      bindings: [{
        canonicalKey: renamed.canonicalKey, firstSeenAt: AT0, lastSeenAt: AT1,
        consecutiveMissingPasses: 0,
      }],
    });

    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [], bindings: [], issues: [], at: AT2,
    })).toMatchObject({
      repositories: [{
        canonicalKey: renamed.canonicalKey, firstSeenAt: AT0, lastSeenAt: AT1,
        active: true, consecutiveMissingPasses: 1,
      }],
      bindings: [{
        canonicalKey: renamed.canonicalKey, firstSeenAt: AT0, lastSeenAt: AT1,
        active: true, consecutiveMissingPasses: 1,
      }],
    });
    store.close();
    store = new SqliteDigestStore(path);
    // Reappearance resets only the miss counter; durable first-seen identity is retained.
    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [renamed], bindings: [renamedBinding], issues: [], at: AT3,
    }).repositories[0]).toMatchObject({
      firstSeenAt: AT0, lastSeenAt: AT3, consecutiveMissingPasses: 0,
    });
    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [], bindings: [], issues: [], at: AT4,
    }).repositories[0]).toMatchObject({
      firstSeenAt: AT0, lastSeenAt: AT3, active: true, consecutiveMissingPasses: 1,
    });
    const afterGrace = '2026-08-27T00:00:04.000Z';
    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [], bindings: [], issues: [], at: afterGrace,
    })).toEqual({ repositories: [], bindings: [], issues: [] });
    store.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare(`SELECT canonical_key, first_seen_at, last_seen_at, active,
                               consecutive_missing_passes
                          FROM repository_registry`).get()).toEqual({
      canonical_key: renamed.canonicalKey, first_seen_at: AT0, last_seen_at: AT3,
      active: 0, consecutive_missing_passes: 2,
    });
    expect(raw.prepare(`SELECT canonical_key, first_seen_at, last_seen_at, active,
                               consecutive_missing_passes
                          FROM orca_repository_binding`).get()).toEqual({
      canonical_key: renamed.canonicalKey, first_seen_at: AT0, last_seen_at: AT3,
      active: 0, consecutive_missing_passes: 2,
    });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM repository_registry').get())
      .toEqual({ count: 1 });
    raw.close();
    const reopened = new SqliteDigestStore(path);
    expect(reopened.hasDiscoveryRoutingRows()).toBe(true);
    expect(reopened.readEffectiveDiscoverySnapshot()).toEqual({
      repositories: [], bindings: [], issues: [],
    });
    reopened.close();
  });

  it('propagates a changed parent project to grace-retained bindings without refreshing evidence', () => {
    let store = new SqliteDigestStore(path);
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', repositories: [repository], bindings: [binding], issues: [], at: AT0,
    });
    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [{ ...repository, projectKey: 'project-two' }],
      bindings: [], issues: [], at: AT1,
    })).toMatchObject({
      repositories: [{ projectKey: 'project-two', lastSeenAt: AT1, lastGoodAt: AT1 }],
      bindings: [{
        projectKey: 'project-two', lastSeenAt: AT0, lastGoodAt: AT0,
        consecutiveMissingPasses: 1, active: true,
      }],
    });
    store.close();
    store = new SqliteDigestStore(path);
    expect(store.readEffectiveDiscoverySnapshot().bindings[0]).toMatchObject({
      projectKey: 'project-two', lastSeenAt: AT0, lastGoodAt: AT0,
      consecutiveMissingPasses: 1,
    });
    store.close();
  });

  it('absorbs a tentative rename target into the verified numeric identity and retains both bindings', () => {
    let store = new SqliteDigestStore(path);
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', repositories: [repository], bindings: [binding], issues: [], at: AT0,
    });
    const target = {
      ...repository,
      canonicalKey: 'github.com/acme/widget-next' as const,
      nameWithOwner: 'acme/widget-next' as const,
      githubRepositoryId: null,
    };
    const targetBinding = {
      ...binding, orcaRepositoryId: 'tentative-orca-key', canonicalKey: target.canonicalKey,
    };
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', repositories: [target], bindings: [targetBinding], issues: [], at: AT1,
    });
    const converged = { ...target, githubRepositoryId: repository.githubRepositoryId };
    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', repositories: [converged],
      bindings: [{ ...binding, canonicalKey: target.canonicalKey }], issues: [], at: AT2,
    })).toMatchObject({
      repositories: [{
        canonicalKey: target.canonicalKey, githubRepositoryId: repository.githubRepositoryId,
        firstSeenAt: AT0, lastSeenAt: AT2,
      }],
      bindings: expect.arrayContaining([
        expect.objectContaining({
          orcaRepositoryId: binding.orcaRepositoryId, canonicalKey: target.canonicalKey,
        }),
        expect.objectContaining({
          orcaRepositoryId: targetBinding.orcaRepositoryId, canonicalKey: target.canonicalKey,
        }),
      ]),
    });
    store.close();
    store = new SqliteDigestStore(path);
    const reopened = store.readEffectiveDiscoverySnapshot();
    expect(reopened.repositories).toHaveLength(1);
    expect(reopened.bindings).toHaveLength(2);
    expect(reopened.bindings.every((row) => row.canonicalKey === target.canonicalKey)).toBe(true);
    store.close();
  });

  it('fails closed when a tentative rename target has a conflicting project or numeric identity', () => {
    for (const conflict of ['project', 'numeric'] as const) {
      const candidate = join(dir, `identity-${conflict}.db`);
      const store = new SqliteDigestStore(candidate);
      const target = {
        ...repository,
        canonicalKey: `github.com/acme/widget-${conflict}` as const,
        nameWithOwner: `acme/widget-${conflict}` as const,
        githubRepositoryId: conflict === 'numeric' ? 202 : null,
        projectKey: conflict === 'project' ? 'project-two' : repository.projectKey,
      };
      store.replaceDiscoverySnapshot({
        passOutcome: 'succeeded', repositories: [repository, target], bindings: [], issues: [], at: AT0,
      });
      expect(() => store.replaceDiscoverySnapshot({
        passOutcome: 'succeeded',
        repositories: [{ ...target, githubRepositoryId: repository.githubRepositoryId }],
        bindings: [], issues: [], at: AT1,
      })).toThrowError(new OperationalStoreError('OPERATIONAL_CONFLICT'));
      const unchanged = store.readEffectiveDiscoverySnapshot();
      expect(unchanged.repositories).toHaveLength(2);
      expect(unchanged.repositories.find((row) => row.canonicalKey === repository.canonicalKey))
        .toMatchObject({ githubRepositoryId: repository.githubRepositoryId, projectKey: 'project-one' });
      store.close();
    }
  });

  it('preserves numeric LKG and grace evidence through failed and carried-forward observations', () => {
    let store = new SqliteDigestStore(path);
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded', repositories: [repository], bindings: [binding], issues: [], at: AT0,
    });
    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'failed', repositories: [{
        canonicalKey: 'github.com/acme/unverified' as const,
        nameWithOwner: 'acme/unverified' as const,
        githubRepositoryId: null,
        projectKey: 'project-one',
        projectOrigin: 'auto',
        evidence: 'carried_forward',
      }], bindings: [],
      issues: [{ issueHash: 'b'.repeat(64), category: 'query_failed' }], at: AT1,
    })).toMatchObject({
      repositories: [{
        canonicalKey: repository.canonicalKey, githubRepositoryId: repository.githubRepositoryId,
        lastSeenAt: AT0, lastGoodAt: AT0, consecutiveMissingPasses: 0,
      }],
      bindings: [{ lastSeenAt: AT0, lastGoodAt: AT0, consecutiveMissingPasses: 0 }],
      issues: [{ category: 'query_failed', occurrenceCount: 1, active: true }],
    });
    expect(store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [{ ...repository, githubRepositoryId: null, evidence: 'carried_forward' }],
      bindings: [{ ...binding, evidence: 'carried_forward' }], issues: [], at: AT2,
    })).toMatchObject({
      repositories: [{
        githubRepositoryId: repository.githubRepositoryId, lastSeenAt: AT0,
        lastGoodAt: AT0, consecutiveMissingPasses: 0,
      }],
      bindings: [{ lastSeenAt: AT0, lastGoodAt: AT0, consecutiveMissingPasses: 0 }],
    });
    store.close();
    store = new SqliteDigestStore(path);
    expect(store.readEffectiveDiscoverySnapshot().repositories[0]).toMatchObject({
      githubRepositoryId: repository.githubRepositoryId, lastSeenAt: AT0, lastGoodAt: AT0,
    });
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
    expect(store.advanceDaemonJobCheckpoint(first, 0, 5, AT0)).toMatchObject({
      revision: first.revision, state: 'running', checkpoint: 5,
    });
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
    expect(() => store.advanceDaemonJobCheckpoint(first, 5, 4, AT2))
      .toThrow(OperationalStoreError);
    const second = store.startDaemonJob('repository-discovery', AT2)!;
    expect(store.advanceDaemonJobCheckpoint(first, 5, 6, AT2)).toBeNull();
    expect(store.advanceDaemonJobCheckpoint(second, 5, 6, AT2)).toMatchObject({
      revision: second.revision, state: 'running', checkpoint: 6,
    });
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

  it('atomically takes over a future schedule for a mandated startup pass', () => {
    const store = new SqliteDigestStore(path);
    const first = store.startDaemonJob('pr-digest', AT0)!;
    expect(store.completeDaemonJobSuccess({
      claim: first,
      at: AT1,
      nextRunAt: '2026-08-26T00:10:00.000Z',
      durationMs: 1_000,
      checkpoint: 7,
    })).toMatchObject({ state: 'succeeded', attempt: 1, checkpoint: 7 });
    expect(store.startDaemonJob('pr-digest', AT2)).toBeNull();

    const startup = store.startDaemonJob('pr-digest', AT2, { startupTakeover: true });
    expect(startup).not.toBeNull();
    expect(store.findDaemonJobOutcome('pr-digest')).toMatchObject({
      state: 'running', attempt: 2, checkpoint: 7, nextRunAt: null,
    });
    expect(store.completeDaemonJobSuccess({
      claim: startup!,
      at: AT3,
      nextRunAt: '2026-08-26T00:20:00.000Z',
      durationMs: 1_000,
      checkpoint: 8,
    })).toMatchObject({ state: 'succeeded', attempt: 2, checkpoint: 8 });
    store.close();
  });

  it('죽은 instance가 남긴 running 행을 기동 회수로만 되찾는다', () => {
    /*
     * daemon이 job 도중 비정상 종료하면 그 행은 `running`으로 남는다. 이 회수 경로가 없었을 때
     * 이후 뜨는 daemon은 그 job을 claim하지 못했고, claim 거부는 fatal이라 스스로 종료했다 —
     * 회수 수단이 없는 무한 크래시 루프였다.
     *
     * 회수는 기동 pass에만 허용된다. 평시 claim은 여전히 거절이어야 한다. 그렇지 않으면 한
     * lane에서 도는 job을 다른 호출이 가로챌 수 있다.
     */
    const store = new SqliteDigestStore(path);
    const abandoned = store.startDaemonJob('gate-reconcile', AT0);
    expect(abandoned).not.toBeNull();
    expect(store.findDaemonJobOutcome('gate-reconcile')).toMatchObject({ state: 'running' });

    // 평시 claim은 살아 있는 job을 가로채지 않는다.
    expect(store.startDaemonJob('gate-reconcile', AT2)).toBeNull();

    const reclaimed = store.startDaemonJob('gate-reconcile', AT2, { startupTakeover: true });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.revision).toBeGreaterThan(abandoned!.revision);
    expect(store.findDaemonJobOutcome('gate-reconcile')).toMatchObject({
      state: 'running', attempt: 2,
    });

    // 죽은 instance의 claim으로는 더 이상 완료를 쓸 수 없다.
    expect(store.completeDaemonJobSuccess({
      claim: abandoned!,
      at: AT3,
      nextRunAt: '2026-08-26T00:30:00.000Z',
      durationMs: 1_000,
      checkpoint: 0,
    })).toBeNull();
    expect(store.completeDaemonJobSuccess({
      claim: reclaimed!,
      at: AT3,
      nextRunAt: '2026-08-26T00:30:00.000Z',
      durationMs: 1_000,
      checkpoint: 0,
    })).toMatchObject({ state: 'succeeded', attempt: 2 });
    store.close();
  });

  it('accepts only the finite redacted failure-code catalog in every operational writer and row', () => {
    const store = new SqliteDigestStore(path);
    const job = store.startDaemonJob('repository-discovery', AT0)!;
    const root = { kind: 'run', key: runKey('error-catalog') } as const;
    store.prepareSlackRootIntent({ ...root, channelId: 'C1', renderFingerprint: 'r.1', at: AT0 });
    const claim = expectClaim(store.claimSlackRootIntent(root, 'instance-a', AT1));
    const arbitrary = 'private.token-123' as OperationalFailureCode;
    for (const write of [
      () => store.completeDaemonJobFailure({
        claim: job, at: AT2, durationMs: 1, errorCode: arbitrary,
      }),
      () => store.markSlackRootIntentSafeRetry(claim, arbitrary, AT2),
      () => store.markSlackRootIntentUncertain(claim, arbitrary, AT2),
    ]) {
      try {
        write();
        throw new Error('expected arbitrary operational error code to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(OperationalStoreError);
        expect((error as Error).message).toBe('Operational store input is invalid');
        expect((error as Error).message).not.toContain('private');
      }
    }
    store.close();

    for (const table of ['daemon_health', 'daemon_job_outcome', 'slack_root_intent'] as const) {
      const candidate = join(dir, `error-code-${table}.db`);
      const candidateStore = new SqliteDigestStore(candidate);
      if (table === 'daemon_health') {
        candidateStore.recordDaemonStart({
          instanceId: 'instance-a', buildFingerprint: 'b.1', configFingerprint: 'c.1', at: AT0,
        });
      } else if (table === 'daemon_job_outcome') {
        const candidateJob = candidateStore.startDaemonJob('repository-discovery', AT0)!;
        candidateStore.completeDaemonJobFailure({
          claim: candidateJob, at: AT1, durationMs: 1, errorCode: 'github.unavailable',
        });
      } else {
        const candidateRoot = { kind: 'run', key: runKey('corrupt-error-code') } as const;
        candidateStore.prepareSlackRootIntent({
          ...candidateRoot, channelId: 'C1', renderFingerprint: 'r.1', at: AT0,
        });
        const candidateClaim = expectClaim(
          candidateStore.claimSlackRootIntent(candidateRoot, 'instance-a', AT1),
        );
        candidateStore.markSlackRootIntentUncertain(
          candidateClaim, 'transport.unknown', AT2,
        );
      }
      candidateStore.close();
      const raw = new DatabaseSync(candidate);
      raw.exec('PRAGMA ignore_check_constraints = ON');
      const column = table === 'daemon_job_outcome' ? 'error_code' : 'last_error_code';
      raw.prepare(`UPDATE ${table} SET ${column} = ?`).run('private.token-123');
      raw.close();
      try {
        new SqliteDigestStore(candidate);
        throw new Error('expected arbitrary stored operational error code to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(OperationalStoreError);
        expect((error as Error).message).toBe('Operational store state is malformed or corrupt');
        expect((error as Error).message).not.toContain('private');
      }
    }
  });

  it('redacts raw SQLite causes from every operational read surface', () => {
    const cases = [
      {
        name: 'discovery', drop: 'repository_registry',
        read: (store: SqliteDigestStore) => store.readEffectiveDiscoverySnapshot(),
      },
      {
        name: 'health', drop: 'daemon_health',
        read: (store: SqliteDigestStore) => store.readDaemonHealth(),
      },
      {
        name: 'job', drop: 'daemon_job_outcome',
        read: (store: SqliteDigestStore) => store.findDaemonJobOutcome('repository-discovery'),
      },
      {
        name: 'aggregate', drop: 'gate_resolution_outbox',
        read: (store: SqliteDigestStore) => store.readOperationalAggregateCounts(),
      },
      {
        name: 'root', drop: 'slack_root_intent',
        read: (store: SqliteDigestStore) => store.findSlackRootIntent({
          kind: 'run', key: runKey('redacted-read'),
        }),
      },
    ] as const;
    for (const candidate of cases) {
      const candidatePath = join(dir, `redacted-${candidate.name}.db`);
      const store = new SqliteDigestStore(candidatePath);
      const raw = new DatabaseSync(candidatePath);
      raw.exec(`DROP TABLE ${candidate.drop}`);
      raw.close();
      try {
        candidate.read(store);
        throw new Error('expected missing operational table to fail closed');
      } catch (error) {
        expect(error).toBeInstanceOf(OperationalStoreError);
        expect((error as Error).message).toBe('Operational store state is malformed or corrupt');
        expect((error as Error).message).not.toContain(candidate.drop);
        expect((error as Error).message).not.toContain('no such table');
      }
      store.close();
    }
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

    const retry = { kind: 'run', key: 'run:safe-retry' } as const;
    first.prepareSlackRootIntent({ ...retry, channelId: 'C1', renderFingerprint: 'retry.1', at: AT0 });
    const retryClaim = expectClaim(first.claimSlackRootIntent(retry, 'instance-a', AT1));
    expect(first.markSlackRootIntentSafeRetry(retryClaim, 'validation.failed', AT2))
      .toMatchObject({ state: 'pending', renderFingerprint: 'retry.1' });
    expect(first.prepareSlackRootIntent({
      ...retry, channelId: 'C1', renderFingerprint: 'retry.2', at: AT3,
    })).toMatchObject({ state: 'pending', renderFingerprint: 'retry.2', attemptCount: 1 });
    const retriedClaim = expectClaim(first.claimSlackRootIntent(retry, 'instance-a', AT4));
    expect(first.markSlackRootIntentUncertain(retriedClaim, 'transport.unknown', AT5)?.state)
      .toBe('uncertain');

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
    const entity = { kind: 'pr', key: pullRequestKey(101, 8) } as const;
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
    posted.updateObservation(entity.key, {
      renderFingerprint: 'render.updated', factsFingerprint: 'facts.updated', summaryJson: null,
    }, AT3);
    expect(posted.findPrMessage(entity.key)).toMatchObject({
      channelId: 'C1', messageTs: '100.2', renderFingerprint: 'render.updated',
    });
    posted.close();
    const reopened = new SqliteDigestStore(postedPath);
    expect(reopened.findSlackRootIntent(entity)).toMatchObject({
      state: 'posted', messageTs: '100.2', renderFingerprint: 'render.1',
    });
    expect(reopened.findPrMessage(entity.key)).toMatchObject({
      messageTs: '100.2', renderFingerprint: 'render.updated',
    });
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
