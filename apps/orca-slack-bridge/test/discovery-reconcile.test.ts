import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bridgeConfigFingerprint,
  buildEffectiveBridgeConfig,
} from '../src/discovery/effective-config.js';
import { runRepositoryDiscoveryPass } from '../src/discovery/reconcile.js';
import type { RepositoryIdentityConfirmer } from '../src/github/repository.js';
import { repositoryIdentity } from '../src/identity/repository.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { parseConfig, type ParsedBridgeConfig } from '../src/project/config.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

type RepoRow = ReturnType<typeof repoRow>;
type Confirmation = { readonly id: number; readonly nameWithOwner: string } | Error;

const T0 = '2026-08-26T00:00:00.000Z';
const T1 = '2026-08-26T01:00:00.000Z';
const T2 = '2026-08-27T01:00:01.000Z';

function repoRow(
  id: string,
  nameWithOwner: string | null,
  options: { readonly url?: string; readonly canonicalKey?: string } = {},
) {
  const url = options.url ?? (nameWithOwner === null ? '' : `https://github.com/${nameWithOwner}.git`);
  const canonicalKey = options.canonicalKey ??
    (nameWithOwner === null ? '' : `github.com/${nameWithOwner.toLowerCase()}`);
  return {
    addedAt: 1,
    badgeColor: '#123456',
    displayName: 'synthetic-repository',
    externalWorktreeVisibility: 'visible',
    externalWorktreeVisibilityLegacy: false,
    gitRemoteIdentity: nameWithOwner === null ? null : {
      canonicalKey,
      remoteName: 'origin',
      remoteUrl: url,
    },
    gitUsername: 'synthetic-user',
    hookSettings: {},
    id,
    kind: 'git',
    path: 'X:/synthetic/repository',
    projectHostSetupMethod: 'synthetic',
    repoIcon: null,
    upstream: null,
  };
}

function envelope(rows: readonly RepoRow[]): unknown {
  return { _meta: { runtimeId: 'synthetic-runtime' }, id: 'synthetic-call', ok: true, result: { repos: rows } };
}

class FakeOrca implements OrcaRunner {
  readonly calls: readonly string[][] = [] as string[][];
  constructor(readonly response: unknown | Error) {}
  async run(args: readonly string[]): Promise<string> {
    (this.calls as string[][]).push([...args]);
    if (this.response instanceof Error) throw this.response;
    return typeof this.response === 'string' ? this.response : JSON.stringify(this.response);
  }
}

class FakeGithub implements RepositoryIdentityConfirmer {
  readonly calls: string[] = [];
  constructor(
    private readonly response: (nameWithOwner: string) => Confirmation,
  ) {}
  async confirm(nameWithOwner: string) {
    this.calls.push(nameWithOwner);
    const response = this.response(nameWithOwner);
    if (response instanceof Error) throw response;
    return repositoryIdentity(response.id, response.nameWithOwner);
  }
}

function config(
  projects: readonly {
    readonly name: string;
    readonly repositories: readonly string[];
    readonly orcaRepositoryIds?: readonly string[];
  }[] = [],
  capacity: Partial<{
    readonly repositories: number;
    readonly runsPerPass: number;
    readonly orcaIdsPerCanonicalRepository: number;
  }> = {},
): ParsedBridgeConfig {
  return parseConfig({
    slack: null,
    projects,
    automation: { capacity },
  });
}

describe('O1-3 repository discovery reconciliation', () => {
  let directory: string;
  let store: SqliteDigestStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'bridge-o1-3-'));
    store = new SqliteDigestStore(join(directory, 'state.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const pass = async (
    rows: readonly RepoRow[],
    bridgeConfig: ParsedBridgeConfig,
    github: FakeGithub,
    at = T0,
    extra: { readonly lastKnownGoodConfigFingerprint?: string } = {},
  ) => {
    const orca = new FakeOrca(envelope(rows));
    const result = await runRepositoryDiscoveryPass({
      orca, github, store, config: bridgeConfig, now: () => new Date(at), ...extra,
    });
    expect(orca.calls).toEqual([['repo', 'list', '--json']]);
    return result;
  };

  it('GitHub-confirmed auto discovery creates one stable singleton Project', async () => {
    const github = new FakeGithub(() => ({ id: 101, nameWithOwner: 'acme/widget' }));
    const result = await pass([repoRow('orca-a', 'acme/widget')], config(), github);

    expect(result.status).toBe('succeeded');
    expect(github.calls).toEqual(['acme/widget']);
    expect(result.snapshot.repositories).toMatchObject([{
      canonicalKey: 'github.com/acme/widget', githubRepositoryId: 101,
      projectKey: 'auto:github.com/acme/widget', projectOrigin: 'auto', active: true,
    }]);
    expect(result.effectiveConfig.projects).toMatchObject([{
      key: 'auto:github.com/acme/widget', origin: 'auto', orcaRepositoryIds: ['orca-a'],
    }]);
  });

  it('coalesces duplicate rows and multiple exact Orca IDs for one canonical repository', async () => {
    const github = new FakeGithub(() => ({ id: 102, nameWithOwner: 'acme/widget' }));
    const result = await pass([
      repoRow('orca-b', 'acme/widget'),
      repoRow('orca-a', 'acme/widget'),
      repoRow('orca-a', 'acme/widget'),
    ], config(), github);

    expect(github.calls).toEqual(['acme/widget']);
    expect(result.snapshot.repositories).toHaveLength(1);
    expect(result.snapshot.bindings.map((row) => row.orcaRepositoryId)).toEqual(['orca-a', 'orca-b']);
    expect(result.effectiveConfig.projects[0]?.orcaRepositoryIds).toEqual(['orca-a', 'orca-b']);
    expect(result.effectiveConfig.diagnostics).toContainEqual(expect.objectContaining({
      code: 'duplicate_orca_id', effect: 'coalesced',
    }));
  });

  it('quarantines one Orca ID observed with two canonical remotes', async () => {
    const github = new FakeGithub(() => ({ id: 1, nameWithOwner: 'unused/value' }));
    const result = await pass([
      repoRow('orca-conflict', 'acme/one'),
      repoRow('orca-conflict', 'acme/two'),
    ], config(), github);

    expect(github.calls).toEqual([]);
    expect(result.snapshot.repositories).toEqual([]);
    expect(result.effectiveConfig.bindings).toMatchObject([{
      status: 'blocked', reason: 'duplicate_orca_id', orcaRepositoryIds: ['orca-conflict'],
    }]);
  });

  it('keeps an unrelated verified group routable beside a row-local failure', async () => {
    const result = await pass([
      repoRow('orca-good', 'acme/good'),
      repoRow('orca-bad', 'acme/bad', { url: 'https://example.test/acme/bad' }),
    ], config(), new FakeGithub(() => ({ id: 126, nameWithOwner: 'acme/good' })));

    expect(result.snapshot.repositories).toMatchObject([{
      canonicalKey: 'github.com/acme/good', githubRepositoryId: 126,
    }]);
    expect(result.effectiveConfig.routing).toMatchObject({
      status: 'partially_blocked', blockedBindingCount: 1,
    });
    expect(result.effectiveConfig.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'bound', orcaRepositoryIds: ['orca-good'] }),
      expect.objectContaining({
        status: 'blocked', reason: 'unsupported_remote', orcaRepositoryIds: ['orca-bad'],
      }),
    ]));
  });

  it('applies explicit membership and rejects a contradictory live remote', async () => {
    const bridgeConfig = config([
      { name: 'alpha', repositories: ['acme/one'], orcaRepositoryIds: ['orca-explicit'] },
      { name: 'beta', repositories: ['acme/two'] },
    ]);
    const compatible = await pass(
      [repoRow('orca-explicit', 'acme/one')], bridgeConfig,
      new FakeGithub(() => ({ id: 103, nameWithOwner: 'acme/one' })),
    );
    expect(compatible.snapshot.bindings[0]).toMatchObject({ projectKey: 'alpha' });

    const conflicting = await pass(
      [repoRow('orca-explicit', 'acme/two')], bridgeConfig,
      new FakeGithub(() => ({ id: 104, nameWithOwner: 'acme/two' })), T1,
    );
    expect(conflicting.effectiveConfig.bindings.find((row) =>
      row.orcaRepositoryIds.includes('orca-explicit'))).toMatchObject({
        status: 'blocked', reason: 'manual_remote_conflict',
      });
  });

  it.each([
    ['absent', repoRow('orca-manual', null), true],
    ['unsupported', repoRow('orca-manual', 'acme/widget', { url: 'https://example.test/acme/widget' }), true],
    ['malformed', repoRow('orca-manual', 'acme/widget', { url: 'https://github.com/acme/widget?private=1' }), false],
  ] as const)('manual fallback for %s remote is explicitly fenced', async (_name, row, routable) => {
    const bridgeConfig = config([
      { name: 'manual', repositories: ['acme/widget'], orcaRepositoryIds: ['orca-manual'] },
    ]);
    const result = await pass([row], bridgeConfig, new FakeGithub(() => new Error('not called')));
    const binding = result.effectiveConfig.bindings.find((item) =>
      item.orcaRepositoryIds.includes('orca-manual'));
    if (routable) {
      expect(binding).toMatchObject({
        status: 'bound', projectKey: 'manual', verification: 'remote_unverified', identity: null,
      });
      expect(result.effectiveConfig.diagnostics).toContainEqual(expect.objectContaining({
        code: 'remote_unverified', effect: 'remote_unverified',
      }));
    } else {
      expect(binding).toMatchObject({ status: 'blocked', reason: 'invalid_remote' });
    }
  });

  it('marks a missing live remote without overwriting an already verified numeric LKG', async () => {
    const bridgeConfig = config([{
      name: 'manual', repositories: ['acme/widget'], orcaRepositoryIds: ['orca-manual'],
    }]);
    await pass(
      [repoRow('orca-manual', 'acme/widget')], bridgeConfig,
      new FakeGithub(() => ({ id: 123, nameWithOwner: 'acme/widget' })),
    );
    const result = await pass(
      [repoRow('orca-manual', null)], bridgeConfig,
      new FakeGithub(() => new Error('not called')), T1,
    );

    expect(result.snapshot.repositories[0]).toMatchObject({
      githubRepositoryId: 123, lastGoodAt: T0,
    });
    expect(result.snapshot.bindings[0]).toMatchObject({
      canonicalKey: 'github.com/acme/widget', lastGoodAt: T0,
    });
    expect(result.effectiveConfig.bindings[0]).toMatchObject({
      status: 'bound', verification: 'remote_unverified', githubRepositoryId: 123,
    });
  });

  it('uses numeric identity to converge a GitHub rename without losing the binding', async () => {
    const bridgeConfig = config([{ name: 'project', repositories: ['acme/old'] }]);
    await pass(
      [repoRow('orca-rename', 'acme/old')], bridgeConfig,
      new FakeGithub(() => ({ id: 105, nameWithOwner: 'acme/old' })),
    );
    const renamed = await pass(
      [repoRow('orca-rename', 'acme/old')], bridgeConfig,
      new FakeGithub(() => ({ id: 105, nameWithOwner: 'acme/new' })), T1,
    );

    expect(renamed.snapshot.repositories).toMatchObject([{
      canonicalKey: 'github.com/acme/new', githubRepositoryId: 105, projectKey: 'project',
    }]);
    expect(renamed.snapshot.bindings).toMatchObject([{
      orcaRepositoryId: 'orca-rename', canonicalKey: 'github.com/acme/new', projectKey: 'project',
    }]);

    const outage = await pass(
      [repoRow('orca-rename', 'acme/old')], bridgeConfig,
      new FakeGithub(() => new Error('private outage')), T2,
    );
    expect(outage.snapshot.repositories).toMatchObject([{
      canonicalKey: 'github.com/acme/new', githubRepositoryId: 105, lastGoodAt: T1,
    }]);
    expect(outage.effectiveConfig.projects[0]?.orcaRepositoryIds).toEqual(['orca-rename']);
    expect(outage.effectiveConfig.diagnostics).toContainEqual(expect.objectContaining({
      code: 'github_identity_unverified', effect: 'lkg_carried',
    }));
  });

  it('quarantines two canonicals that GitHub maps to contradictory facts for one numeric ID', async () => {
    const github = new FakeGithub((name) => ({ id: 106, nameWithOwner: name }));
    const result = await pass([
      repoRow('orca-one', 'acme/one'), repoRow('orca-two', 'acme/two'),
    ], config(), github);

    expect(result.snapshot.repositories).toEqual([]);
    expect(result.effectiveConfig.bindings).toMatchObject([{
      status: 'blocked', reason: 'canonical_conflict',
      orcaRepositoryIds: ['orca-one', 'orca-two'],
    }]);
  });

  it.each(['confirmed-different', 'github-outage'] as const)(
    'does not repoint an existing exact Orca ID to a contradictory live remote: %s',
    async (mode) => {
      const bridgeConfig = config();
      await pass(
        [repoRow('orca-stable-id', 'acme/one')], bridgeConfig,
        new FakeGithub(() => ({ id: 124, nameWithOwner: 'acme/one' })),
      );
      const result = await pass(
        [repoRow('orca-stable-id', 'acme/two')], bridgeConfig,
        new FakeGithub(() => mode === 'confirmed-different'
          ? { id: 125, nameWithOwner: 'acme/two' }
          : new Error('private outage')), T1,
      );

      expect(result.snapshot.repositories).toMatchObject([{
        canonicalKey: 'github.com/acme/one', githubRepositoryId: 124,
      }]);
      expect(result.snapshot.bindings).toMatchObject([{
        orcaRepositoryId: 'orca-stable-id', canonicalKey: 'github.com/acme/one',
      }]);
      expect(result.effectiveConfig.bindings).toMatchObject([{
        status: 'blocked', reason: 'canonical_conflict',
        orcaRepositoryIds: ['orca-stable-id'],
      }]);
    },
  );

  it('keeps verified LKG through GitHub outage while a new repository remains pending', async () => {
    const bridgeConfig = config();
    await pass(
      [repoRow('orca-known', 'acme/known')], bridgeConfig,
      new FakeGithub(() => ({ id: 107, nameWithOwner: 'acme/known' })),
    );
    const outage = new FakeGithub(() => new Error('private outage detail'));
    const result = await pass([
      repoRow('orca-known', 'acme/known'),
      repoRow('orca-known-second', 'acme/known'),
      repoRow('orca-new', 'acme/new'),
    ], bridgeConfig, outage, T1);

    expect(result.snapshot.repositories).toMatchObject([{
      canonicalKey: 'github.com/acme/known', githubRepositoryId: 107,
      lastGoodAt: T0,
    }]);
    expect(result.snapshot.bindings.map((row) => row.orcaRepositoryId)).toEqual([
      'orca-known', 'orca-known-second',
    ]);
    expect(result.effectiveConfig.bindings.find((row) =>
      row.orcaRepositoryIds.includes('orca-new'))).toMatchObject({
        status: 'blocked', reason: 'github_identity_unverified',
      });
  });

  it.each([
    { id: 0, nameWithOwner: 'acme/new' },
    { id: 120, nameWithOwner: 'acme/new/extra' },
  ])('does not publish a partial malformed GitHub identity %#', async (confirmation) => {
    const result = await pass(
      [repoRow('orca-new', 'acme/new')], config(),
      new FakeGithub(() => confirmation),
    );
    expect(result.snapshot.repositories).toEqual([]);
    expect(result.snapshot.bindings).toEqual([]);
    expect(result.effectiveConfig.bindings).toMatchObject([{
      status: 'blocked', reason: 'github_identity_unverified',
    }]);
  });

  it('does not consume a mismatched-config LKG when the whole repository query fails', async () => {
    const bridgeConfig = config();
    await pass(
      [repoRow('orca-known', 'acme/known')], bridgeConfig,
      new FakeGithub(() => ({ id: 108, nameWithOwner: 'acme/known' })),
    );
    const result = await runRepositoryDiscoveryPass({
      orca: new FakeOrca(new Error('private query failure')),
      github: new FakeGithub(() => new Error('not called')),
      store,
      config: bridgeConfig,
      lastKnownGoodConfigFingerprint: 'different-config-fingerprint',
      now: () => new Date(T1),
    });

    expect(result).toMatchObject({ status: 'failed', failure: 'config_drift' });
    expect(result.snapshot.repositories).toHaveLength(1);
    expect(result.effectiveConfig.projects).toEqual([]);
    expect(result.effectiveConfig.routing).toEqual({ status: 'blocked', reason: 'config_drift' });
  });

  it('uses only current verified facts after a successful pass with an incompatible LKG fingerprint', async () => {
    const bridgeConfig = config();
    await pass(
      [repoRow('orca-old', 'acme/old')], bridgeConfig,
      new FakeGithub(() => ({ id: 121, nameWithOwner: 'acme/old' })),
    );
    const result = await pass(
      [repoRow('orca-new', 'acme/new')], bridgeConfig,
      new FakeGithub(() => ({ id: 122, nameWithOwner: 'acme/new' })), T1,
      { lastKnownGoodConfigFingerprint: 'different-config-fingerprint' },
    );

    expect(result.snapshot.repositories.map((row) => row.canonicalKey)).toEqual([
      'github.com/acme/new', 'github.com/acme/old',
    ]);
    expect(result.effectiveConfig.projects.map((row) => row.key)).toEqual([
      'auto:github.com/acme/new',
    ]);
  });

  it('preserves the prior routing revision when strict parser shape fails', async () => {
    const bridgeConfig = config();
    const first = await pass(
      [repoRow('orca-known', 'acme/known')], bridgeConfig,
      new FakeGithub(() => ({ id: 109, nameWithOwner: 'acme/known' })),
    );
    const malformed = envelope([repoRow('orca-known', 'acme/known')]) as Record<string, unknown>;
    malformed['unexpected'] = true;
    const failed = await runRepositoryDiscoveryPass({
      orca: new FakeOrca(malformed),
      github: new FakeGithub(() => new Error('not called')),
      store, config: bridgeConfig, now: () => new Date(T1),
    });

    expect(failed).toMatchObject({ status: 'failed', failure: 'schema_drift' });
    expect(failed.snapshot.repositories[0]).toMatchObject({ githubRepositoryId: 109, lastGoodAt: T0 });
    expect(failed.effectiveConfig.revision).toBe(first.effectiveConfig.revision);
  });

  it('uses two successful omissions plus 24 hours before inactivation', async () => {
    const bridgeConfig = config();
    await pass(
      [repoRow('orca-aging', 'acme/aging')], bridgeConfig,
      new FakeGithub(() => ({ id: 110, nameWithOwner: 'acme/aging' })),
    );
    const once = await pass([], bridgeConfig, new FakeGithub(() => new Error('not called')), T1);
    expect(once.snapshot.repositories[0]).toMatchObject({ active: true, consecutiveMissingPasses: 1 });
    const twice = await pass([], bridgeConfig, new FakeGithub(() => new Error('not called')), T2);
    expect(twice.snapshot.repositories).toEqual([]);
    expect(twice.snapshot.bindings).toEqual([]);
  });

  it('returns the old effective registry when the atomic store transaction rolls back', async () => {
    const bridgeConfig = config();
    await pass(
      [repoRow('orca-stable', 'acme/stable')], bridgeConfig,
      new FakeGithub(() => ({ id: 111, nameWithOwner: 'acme/stable' })),
    );
    const databasePath = join(directory, 'state.db');
    store.close();
    store = new SqliteDigestStore(databasePath, {
      operationalFault: (point) => {
        if (point === 'after_discovery_registry') throw new Error('private injected failure');
      },
    });
    const failed = await pass(
      [repoRow('orca-next', 'acme/next')], bridgeConfig,
      new FakeGithub(() => ({ id: 112, nameWithOwner: 'acme/next' })), T1,
    );

    expect(failed).toMatchObject({ status: 'failed', failure: 'store_failed' });
    expect(failed.snapshot.repositories).toMatchObject([{
      canonicalKey: 'github.com/acme/stable', githubRepositoryId: 111,
    }]);
  });

  it.each([15, 16, 17])('repository capacity at %i is deterministic and never silently truncates', async (count) => {
    const rows = Array.from({ length: count }, (_, index) =>
      repoRow(`orca-${String(index).padStart(2, '0')}`, `acme/repo-${String(index).padStart(2, '0')}`));
    const github = new FakeGithub((name) => ({
      id: 1_000 + Number(name.slice(-2)), nameWithOwner: name,
    }));
    const result = await pass(rows, config(), github);

    expect(result.snapshot.repositories).toHaveLength(Math.min(count, 16));
    expect(github.calls).toHaveLength(Math.min(count, 16));
    expect(result.counts.deferredRepositories).toBe(count > 16 ? 1 : 0);
    if (count > 16) {
      expect(result.effectiveConfig.bindings.some((row) =>
        row.status === 'blocked' && row.reason === 'capacity_deferred')).toBe(true);
    }
  });

  it('fails before mutation when explicit membership alone exceeds effective repository capacity', async () => {
    const repositories = Array.from({ length: 17 }, (_, index) =>
      `acme/configured-${String(index).padStart(2, '0')}`);
    const bridgeConfig = config([
      { name: 'first', repositories: repositories.slice(0, 9) },
      { name: 'second', repositories: repositories.slice(9) },
    ]);
    const result = await pass([], bridgeConfig, new FakeGithub(() => new Error('not called')));

    expect(result).toMatchObject({ status: 'failed', failure: 'capacity_conflict' });
    expect(result.snapshot.repositories).toEqual([]);
    expect(result.effectiveConfig.routing).toEqual({
      status: 'blocked', reason: 'capacity_conflict',
    });
  });

  it.each([15, 16, 17])('Orca-ID-per-canonical capacity at %i blocks the entire overflowing group', async (count) => {
    const bridgeConfig = config();
    const github = new FakeGithub(() => ({ id: 113, nameWithOwner: 'acme/group' }));
    const rows = Array.from({ length: count }, (_, index) => repoRow(`orca-${index}`, 'acme/group'));
    const result = await pass(rows, bridgeConfig, github);

    if (count <= 16) {
      expect(result.snapshot.bindings).toHaveLength(count);
      expect(result.effectiveConfig.projects[0]?.orcaRepositoryIds).toHaveLength(count);
    } else {
      expect(github.calls).toEqual([]);
      expect(result.snapshot.repositories).toEqual([]);
      expect(result.effectiveConfig.bindings).toMatchObject([{
        status: 'blocked', reason: 'capacity_conflict',
      }]);
    }
  });

  it('preserves every configured repository and coalesces discovered IDs into one Project', async () => {
    const bridgeConfig = config([{
      name: 'suite', repositories: ['acme/one', 'acme/two'],
    }]);
    const result = await pass([
      repoRow('orca-one', 'acme/one'), repoRow('orca-two', 'acme/two'),
    ], bridgeConfig, new FakeGithub((name) => ({
      id: name.endsWith('/one') ? 114 : 115, nameWithOwner: name,
    })));

    expect(result.effectiveConfig.projects).toMatchObject([{
      key: 'suite',
      repositories: [
        { canonicalKey: 'github.com/acme/one' },
        { canonicalKey: 'github.com/acme/two' },
      ],
      orcaRepositoryIds: ['orca-one', 'orca-two'],
    }]);
  });

  it('builds a stable frozen content revision and changes it only with routing content', () => {
    const bridgeConfig = config([{
      name: 'manual', repositories: ['acme/manual'], orcaRepositoryIds: ['orca-manual'],
    }]);
    const first = buildEffectiveBridgeConfig(bridgeConfig, {
      repositories: [], bindings: [], issues: [],
    });
    const second = buildEffectiveBridgeConfig(bridgeConfig, {
      repositories: [], bindings: [], issues: [],
    });

    expect(first.configFingerprint).toBe(bridgeConfigFingerprint(bridgeConfig));
    expect(first.revision).toBe(second.revision);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.projects)).toBe(true);
    expect(Object.isFrozen(first.projects[0])).toBe(true);
  });
});
