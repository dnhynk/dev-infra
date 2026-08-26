import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  bridgeConfigFingerprint,
  buildEffectiveBridgeConfig,
} from '../src/discovery/effective-config.js';
import {
  runRepositoryDiscoveryPass,
  type RepositoryDiscoveryPassOptions,
} from '../src/discovery/reconcile.js';
import type {
  RepositoryIdentityConfirmer,
  RepositoryIdentityConfirmationOptions,
} from '../src/github/repository.js';
import { repositoryIdentity } from '../src/identity/repository.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { parseConfig, type ParsedBridgeConfig } from '../src/project/config.js';
import type { OperationalStore } from '../src/store/operational-types.js';
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

class NeverGithub implements RepositoryIdentityConfirmer {
  readonly calls: string[] = [];
  signal: AbortSignal | null = null;

  confirm(nameWithOwner: string, options: RepositoryIdentityConfirmationOptions) {
    this.calls.push(nameWithOwner);
    this.signal = options.signal;
    return new Promise<ReturnType<typeof repositoryIdentity>>(() => undefined);
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
    github: RepositoryIdentityConfirmer,
    at = T0,
    extra: {
      readonly lastKnownGoodConfigFingerprint?: string | null;
      readonly deadlineAt?: number;
      readonly signal?: AbortSignal;
    } = {},
  ) => {
    const orca = new FakeOrca(envelope(rows));
    const result = await runRepositoryDiscoveryPass({
      orca, github, store, config: bridgeConfig, now: () => new Date(at),
      lastKnownGoodConfigFingerprint: bridgeConfigFingerprint(bridgeConfig),
      ...extra,
    });
    expect(orca.calls).toEqual([['repo', 'list', '--json']]);
    return result;
  };

  const storeBytes = (): readonly (string | null)[] => [
    join(directory, 'state.db'),
    join(directory, 'state.db-wal'),
  ].map((path) => existsSync(path) ? readFileSync(path).toString('base64') : null);

  const countingStore = (onWrite: () => void): OperationalStore => new Proxy(store, {
    get(target, property) {
      if (property === 'replaceDiscoverySnapshot') {
        return (...args: Parameters<OperationalStore['replaceDiscoverySnapshot']>) => {
          onWrite();
          return target.replaceDiscoverySnapshot(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as OperationalStore;

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

  it.each(['deadline', 'external-abort'] as const)(
    'bounds a never-settling confirmer with %s and performs zero store writes',
    async (mode) => {
      const github = new NeverGithub();
      const bridgeConfig = config();
      const before = store.readEffectiveDiscoverySnapshot();
      const bytes = storeBytes();
      const controller = new AbortController();
      const abortTimer = mode === 'external-abort'
        ? setTimeout(() => controller.abort(), 20)
        : undefined;
      const startedAt = Date.now();
      const result = await pass(
        [repoRow('private-id-that-must-not-persist', 'acme/widget')],
        bridgeConfig,
        github,
        T0,
        {
          deadlineAt: Date.now() + (mode === 'deadline' ? 20 : 1_000),
          ...(mode === 'external-abort' ? { signal: controller.signal } : {}),
        },
      );
      if (abortTimer !== undefined) clearTimeout(abortTimer);

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(result).toMatchObject({ status: 'failed', failure: 'github_unavailable' });
      expect(result.snapshot).toEqual(before);
      expect(store.readEffectiveDiscoverySnapshot()).toEqual(before);
      expect(storeBytes()).toEqual(bytes);
      expect(result.effectiveConfig.bindings).toContainEqual(expect.objectContaining({
        status: 'blocked', reason: 'github_identity_unverified',
      }));
      if (mode === 'deadline') {
        expect(github.calls).toEqual(['acme/widget']);
        expect(github.signal?.aborted).toBe(true);
      }
    },
  );

  it('discards an already-confirmed prefix when a later GitHub candidate reaches the deadline', async () => {
    const bridgeConfig = config();
    const calls: string[] = [];
    const github: RepositoryIdentityConfirmer = {
      confirm(nameWithOwner) {
        calls.push(nameWithOwner);
        if (nameWithOwner === 'acme/fast') {
          return Promise.resolve(repositoryIdentity(139, 'acme/fast'));
        }
        return new Promise(() => undefined);
      },
    };
    const before = store.readEffectiveDiscoverySnapshot();
    const result = await pass(
      [repoRow('orca-fast', 'acme/fast'), repoRow('orca-hung', 'acme/hung')],
      bridgeConfig,
      github,
      T0,
      { deadlineAt: Date.now() + 20 },
    );

    expect(calls).toEqual(['acme/fast', 'acme/hung']);
    expect(result).toMatchObject({ status: 'failed', failure: 'github_unavailable' });
    expect(result.snapshot).toEqual(before);
    expect(store.readEffectiveDiscoverySnapshot()).toEqual(before);
    expect(result.effectiveConfig.projects).toEqual([]);
    expect(result.effectiveConfig.bindings.filter((binding) =>
      binding.status === 'blocked')).toHaveLength(2);
  });

  it.each(['schema', 'query'] as const)(
    'leaves the exact durable snapshot and bytes untouched on whole-pass %s failure',
    async (mode) => {
      const bridgeConfig = config();
      const seed = await pass(
        [repoRow('orca-known', 'acme/known')], bridgeConfig,
        new FakeGithub(() => ({ id: 130, nameWithOwner: 'acme/known' })),
      );
      const before = store.readEffectiveDiscoverySnapshot();
      const bytes = storeBytes();
      let writes = 0;
      const malformed = envelope([repoRow('orca-known', 'acme/known')]) as Record<string, unknown>;
      malformed['unexpected'] = true;
      const result = await runRepositoryDiscoveryPass({
        orca: new FakeOrca(mode === 'schema' ? malformed : new Error('private query marker')),
        github: new FakeGithub(() => new Error('not called')),
        store: countingStore(() => { writes += 1; }),
        config: bridgeConfig,
        lastKnownGoodConfigFingerprint: bridgeConfigFingerprint(bridgeConfig),
        now: () => new Date(T1),
      });

      expect(result.failure).toBe(mode === 'schema' ? 'schema_drift' : 'query_failed');
      expect(writes).toBe(0);
      expect(result.snapshot).toEqual(before);
      expect(store.readEffectiveDiscoverySnapshot()).toEqual(before);
      expect(storeBytes()).toEqual(bytes);
      expect(result.effectiveConfig.revision).toBe(seed.effectiveConfig.revision);
      expect(result.snapshot.issues).toEqual(before.issues);
    },
  );

  it('quarantines every current and durable alias for a same-numeric cross-Project identity', async () => {
    const bridgeConfig = config([
      { name: 'alpha', repositories: ['acme/old'] },
      { name: 'beta', repositories: ['acme/new'] },
    ]);
    await pass(
      [repoRow('orca-old', 'acme/old')], bridgeConfig,
      new FakeGithub(() => ({ id: 131, nameWithOwner: 'acme/old' })),
    );
    const result = await pass(
      [repoRow('orca-old', 'acme/old'), repoRow('orca-new', 'acme/new')],
      bridgeConfig,
      new FakeGithub(() => ({ id: 131, nameWithOwner: 'acme/current' })),
      T1,
    );

    const affected = result.effectiveConfig.bindings.filter((binding) =>
      binding.orcaRepositoryIds.some((id) => id === 'orca-old' || id === 'orca-new'));
    expect(affected).toHaveLength(1);
    expect(affected[0]).toMatchObject({
      status: 'blocked', reason: 'project_conflict',
      orcaRepositoryIds: ['orca-new', 'orca-old'],
    });
    expect(result.effectiveConfig.bindings.some((binding) =>
      binding.status === 'bound' && binding.orcaRepositoryIds.includes('orca-old'))).toBe(false);
  });

  it.each([16, 17, 18])(
    'enforces the post-convergence Orca-ID bound at %i fresh aliases',
    async (count) => {
      const first = Math.floor(count / 2);
      const rows = [
        ...Array.from({ length: first }, (_, index) => repoRow(`orca-a-${index}`, 'acme/alias-a')),
        ...Array.from({ length: count - first }, (_, index) =>
          repoRow(`orca-b-${index}`, 'acme/alias-b')),
      ];
      const result = await pass(
        rows,
        config(),
        new FakeGithub(() => ({ id: 132, nameWithOwner: 'acme/current' })),
      );

      if (count === 16) {
        expect(result.snapshot.bindings).toHaveLength(16);
        expect(result.effectiveConfig.bindings).toContainEqual(expect.objectContaining({
          status: 'bound', orcaRepositoryIds: expect.arrayContaining(['orca-a-0', 'orca-b-0']),
        }));
      } else {
        expect(result.snapshot.repositories).toEqual([]);
        expect(result.snapshot.bindings).toEqual([]);
        expect(result.effectiveConfig.bindings).toContainEqual(expect.objectContaining({
          status: 'blocked', reason: 'capacity_conflict',
        }));
        expect(result.counts.blockedBindings).toBe(count);
      }
    },
  );

  it.each([
    { seed: 15, added: 1, total: 16 },
    { seed: 16, added: 1, total: 17 },
    { seed: 16, added: 2, total: 18 },
  ])('counts grace-retained aliases before accepting $total IDs', async ({ seed, added, total }) => {
    const bridgeConfig = config();
    await pass(
      Array.from({ length: seed }, (_, index) => repoRow(`orca-old-${index}`, 'acme/group')),
      bridgeConfig,
      new FakeGithub(() => ({ id: 133, nameWithOwner: 'acme/group' })),
    );
    const result = await pass(
      Array.from({ length: added }, (_, index) => repoRow(`orca-new-${index}`, 'acme/group')),
      bridgeConfig,
      new FakeGithub(() => ({ id: 133, nameWithOwner: 'acme/group' })),
      T1,
    );

    if (total === 16) {
      expect(result.snapshot.bindings).toHaveLength(16);
      expect(result.effectiveConfig.bindings).toContainEqual(expect.objectContaining({
        status: 'bound', orcaRepositoryIds: expect.arrayContaining(['orca-new-0', 'orca-old-0']),
      }));
    } else {
      expect(result.snapshot.bindings).toHaveLength(16);
      expect(result.snapshot.bindings.some((binding) =>
        binding.orcaRepositoryId.startsWith('orca-new-'))).toBe(false);
      expect(result.effectiveConfig.bindings).toContainEqual(expect.objectContaining({
        status: 'blocked', reason: 'capacity_conflict',
      }));
      expect(result.counts.blockedBindings).toBe(total);
    }
  });

  it('confirms a new-ID/new-alias rename at full capacity and defers a true seventeenth numeric group', async () => {
    const bridgeConfig = config();
    const rows = Array.from({ length: 16 }, (_, index) =>
      repoRow(`orca-${index}`, `acme/repo-${index}`));
    await pass(rows, bridgeConfig, new FakeGithub((name) => ({
      id: 200 + Number(name.slice('acme/repo-'.length)), nameWithOwner: name,
    })));

    const renameGithub = new FakeGithub(() => ({ id: 200, nameWithOwner: 'acme/renamed' }));
    const renamed = await pass(
      [repoRow('orca-renamed-alias', 'acme/fresh-alias')], bridgeConfig, renameGithub, T1,
    );
    expect(renameGithub.calls).toEqual(['acme/fresh-alias']);
    expect(renamed.snapshot.repositories).toHaveLength(16);
    expect(renamed.snapshot.bindings.find((binding) =>
      binding.orcaRepositoryId === 'orca-0')?.canonicalKey).toBe('github.com/acme/renamed');
    expect(renamed.snapshot.bindings.find((binding) =>
      binding.orcaRepositoryId === 'orca-renamed-alias')?.canonicalKey)
      .toBe('github.com/acme/renamed');
    expect(renamed.counts.deferredRepositories).toBe(0);

    const newGithub = new FakeGithub(() => ({ id: 999, nameWithOwner: 'acme/seventeenth' }));
    const deferred = await pass(
      [repoRow('orca-seventeen', 'acme/seventeenth')], bridgeConfig, newGithub,
      '2026-08-26T02:00:00.000Z',
    );
    expect(newGithub.calls).toEqual(['acme/seventeenth']);
    expect(deferred.snapshot.repositories).toHaveLength(16);
    expect(deferred.counts.deferredRepositories).toBe(1);
    expect(deferred.effectiveConfig.bindings).toContainEqual(expect.objectContaining({
      status: 'blocked', reason: 'capacity_deferred',
      orcaRepositoryIds: ['orca-seventeen'],
    }));
  });

  it('charges one slot to a complete same-numeric alias group and binds every alias atomically', async () => {
    const bridgeConfig = config();
    const rows = Array.from({ length: 15 }, (_, index) =>
      repoRow(`orca-seed-${index}`, `acme/seed-${index}`));
    await pass(rows, bridgeConfig, new FakeGithub((name) => ({
      id: 300 + Number(name.slice('acme/seed-'.length)), nameWithOwner: name,
    })));

    const github = new FakeGithub(() => ({ id: 999, nameWithOwner: 'acme/converged' }));
    const converged = await pass([
      repoRow('orca-alias-b', 'acme/fresh-b'),
      repoRow('orca-alias-a', 'acme/fresh-a'),
    ], bridgeConfig, github, T1);

    expect(github.calls).toEqual(['acme/fresh-a', 'acme/fresh-b']);
    expect(converged.snapshot.repositories).toHaveLength(16);
    expect(converged.snapshot.bindings.filter((binding) =>
      binding.canonicalKey === 'github.com/acme/converged').map((binding) =>
      binding.orcaRepositoryId)).toEqual(['orca-alias-a', 'orca-alias-b']);
    expect(converged.counts.deferredRepositories).toBe(0);
    expect(converged.effectiveConfig.bindings.some((binding) =>
      binding.status === 'blocked' && binding.orcaRepositoryIds.some((id) =>
        id.startsWith('orca-alias-')))).toBe(false);
  });

  it.each([
    ['forward', ['orca-high', 'orca-low']],
    ['reverse', ['orca-low', 'orca-high']],
  ])('selects complete numeric groups deterministically under capacity: %s', async (_name, ids) => {
    const rowsById = new Map([
      ['orca-high', repoRow('orca-high', 'acme/a-high')],
      ['orca-low', repoRow('orca-low', 'acme/z-low')],
    ]);
    const github = new FakeGithub((name) => name === 'acme/a-high'
      ? { id: 900, nameWithOwner: name }
      : { id: 100, nameWithOwner: name });
    const result = await pass(
      ids.map((id) => rowsById.get(id)!),
      config([], { repositories: 1 }),
      github,
    );

    expect(github.calls).toEqual(['acme/a-high', 'acme/z-low']);
    expect(result.snapshot.repositories).toMatchObject([{
      canonicalKey: 'github.com/acme/z-low', githubRepositoryId: 100,
    }]);
    expect(result.effectiveConfig.bindings).toContainEqual(expect.objectContaining({
      status: 'blocked', reason: 'capacity_deferred', orcaRepositoryIds: ['orca-high'],
    }));
  });

  it('preserves current live conflict blocks when the atomic store rolls back', async () => {
    const bridgeConfig = config();
    await pass(
      [repoRow('orca-stable', 'acme/stable')], bridgeConfig,
      new FakeGithub(() => ({ id: 134, nameWithOwner: 'acme/stable' })),
    );
    const databasePath = join(directory, 'state.db');
    store.close();
    store = new SqliteDigestStore(databasePath, {
      operationalFault: (point) => {
        if (point === 'after_discovery_registry') throw new Error('private rollback marker');
      },
    });
    const failed = await pass(
      [repoRow('orca-stable', 'acme/other')], bridgeConfig,
      new FakeGithub(() => ({ id: 135, nameWithOwner: 'acme/other' })),
      T1,
    );

    expect(failed).toMatchObject({ status: 'failed', failure: 'store_failed' });
    expect(failed.snapshot.repositories[0]).toMatchObject({ githubRepositoryId: 134 });
    expect(failed.effectiveConfig.bindings.find((binding) =>
      binding.orcaRepositoryIds.includes('orca-stable'))).toMatchObject({
        status: 'blocked', reason: 'canonical_conflict',
      });
    expect(failed.effectiveConfig.bindings.some((binding) =>
      binding.status === 'bound' && binding.orcaRepositoryIds.includes('orca-stable'))).toBe(false);
  });

  it('carries a GitHub-proven auto rename through a later outage on its old alias', async () => {
    const bridgeConfig = config();
    await pass(
      [repoRow('orca-auto', 'acme/old')], bridgeConfig,
      new FakeGithub(() => ({ id: 136, nameWithOwner: 'acme/old' })),
    );
    const renamed = await pass(
      [repoRow('orca-auto', 'acme/old')], bridgeConfig,
      new FakeGithub(() => ({ id: 136, nameWithOwner: 'acme/new' })),
      T1,
    );
    expect(renamed.snapshot.repositories[0]).toMatchObject({
      canonicalKey: 'github.com/acme/new', projectKey: 'auto:github.com/acme/old',
    });

    const outage = await pass(
      [repoRow('orca-auto', 'acme/old')], bridgeConfig,
      new FakeGithub(() => new Error('private outage marker')),
      T2,
    );
    expect(outage.effectiveConfig.bindings.find((binding) =>
      binding.orcaRepositoryIds.includes('orca-auto'))).toMatchObject({
        status: 'bound', githubRepositoryId: 136,
      });
    expect(outage.effectiveConfig.diagnostics).toContainEqual(expect.objectContaining({
      code: 'github_identity_unverified', effect: 'lkg_carried',
    }));
    expect(outage.effectiveConfig.bindings.some((binding) =>
      binding.status === 'blocked' && binding.reason === 'canonical_conflict')).toBe(false);
  });

  it.each([
    ['forward', ['orca-original', 'orca-reused']],
    ['reverse', ['orca-reused', 'orca-original']],
  ] as const)(
    'keeps a renamed auto Project singleton when its old canonical name is reused: %s',
    async (_order, ids) => {
      const bridgeConfig = config();
      await pass(
        [repoRow('orca-original', 'acme/old')], bridgeConfig,
        new FakeGithub(() => ({ id: 1, nameWithOwner: 'acme/old' })),
      );
      const renamed = await pass(
        [repoRow('orca-original', 'acme/old')], bridgeConfig,
        new FakeGithub(() => ({ id: 1, nameWithOwner: 'acme/new' })),
        T1,
      );
      expect(renamed.snapshot.repositories).toMatchObject([{
        canonicalKey: 'github.com/acme/new', githubRepositoryId: 1,
        projectKey: 'auto:github.com/acme/old',
      }]);

      const rows = new Map([
        ['orca-original', repoRow('orca-original', 'acme/new')],
        ['orca-reused', repoRow('orca-reused', 'acme/old')],
      ]);
      const github = new FakeGithub((name) => name === 'acme/new'
        ? { id: 1, nameWithOwner: 'acme/new' }
        : { id: 2, nameWithOwner: 'acme/old' });
      const reused = await pass(ids.map((id) => rows.get(id)!), bridgeConfig, github, T2);

      expect(reused.status).toBe('succeeded');
      expect(github.calls).toEqual(['acme/new', 'acme/old']);
      expect(reused.effectiveConfig.projects).toHaveLength(2);
      expect(reused.effectiveConfig.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: 'auto:github.com/acme/old', origin: 'auto',
          repositories: [expect.objectContaining({ canonicalKey: 'github.com/acme/new' })],
          orcaRepositoryIds: ['orca-original'],
        }),
        expect.objectContaining({
          key: 'auto:github-id:2', origin: 'auto',
          repositories: [expect.objectContaining({ canonicalKey: 'github.com/acme/old' })],
          orcaRepositoryIds: ['orca-reused'],
        }),
      ]));
      expect(new Set(reused.effectiveConfig.projects.map((project) => project.key)).size).toBe(2);
      expect(reused.effectiveConfig.projects.every((project) =>
        project.repositories.length === 1 && project.orcaRepositoryIds.length === 1)).toBe(true);
    },
  );

  it('requires explicit fingerprint proof for LKG and preserves only a matching proof', async () => {
    const bridgeConfig = config();
    await pass(
      [repoRow('orca-known', 'acme/known')], bridgeConfig,
      new FakeGithub(() => ({ id: 137, nameWithOwner: 'acme/known' })),
    );
    const baseOptions = {
      orca: new FakeOrca(new Error('private query marker')),
      github: new FakeGithub(() => new Error('not called')),
      store,
      config: bridgeConfig,
      now: () => new Date(T1),
    };
    const match = await runRepositoryDiscoveryPass({
      ...baseOptions,
      lastKnownGoodConfigFingerprint: bridgeConfigFingerprint(bridgeConfig),
    });
    const mismatch = await runRepositoryDiscoveryPass({
      ...baseOptions,
      lastKnownGoodConfigFingerprint: 'mismatched-proof',
    });
    const absent = await runRepositoryDiscoveryPass({
      ...baseOptions,
      lastKnownGoodConfigFingerprint: null,
    });
    const missing = await runRepositoryDiscoveryPass(baseOptions as unknown as RepositoryDiscoveryPassOptions);

    expect(match.effectiveConfig.projects).toContainEqual(expect.objectContaining({
      key: 'auto:github.com/acme/known',
    }));
    for (const result of [mismatch, absent, missing]) {
      expect(result).toMatchObject({ status: 'failed', failure: 'config_drift' });
      expect(result.effectiveConfig.projects).toEqual([]);
      expect(result.effectiveConfig.routing).toEqual({ status: 'blocked', reason: 'config_drift' });
    }
  });

  it('keeps the semantic revision stable when repo-list row order changes', async () => {
    const bridgeConfig = config();
    const valid = repoRow('orca-good', 'acme/good');
    const unsupported = repoRow('orca-unsupported', 'acme/unsupported', {
      url: 'https://example.test/acme/unsupported',
    });
    const first = await pass(
      [valid, unsupported], bridgeConfig,
      new FakeGithub(() => ({ id: 138, nameWithOwner: 'acme/good' })),
    );
    const second = await pass(
      [unsupported, valid], bridgeConfig,
      new FakeGithub(() => ({ id: 138, nameWithOwner: 'acme/good' })),
      T1,
    );

    expect(second.effectiveConfig.revision).toBe(first.effectiveConfig.revision);
    expect(second.effectiveConfig.bindings).toEqual(first.effectiveConfig.bindings);
    expect(second.effectiveConfig.projects).toEqual(first.effectiveConfig.projects);
    expect(second.effectiveConfig.diagnostics.some((row) => row.rowIndex !==
      first.effectiveConfig.diagnostics[0]?.rowIndex)).toBe(true);
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

  it('atomically replaces an incompatible routing generation and never revives it on the next failure', async () => {
    const bridgeConfig = config();
    await pass(
      Array.from({ length: 16 }, (_, index) =>
        repoRow(`orca-old-${index}`, `acme/old-${index}`)),
      bridgeConfig,
      new FakeGithub((name) => ({
        id: 121 + Number(name.slice('acme/old-'.length)), nameWithOwner: name,
      })),
    );
    const result = await pass(
      [repoRow('orca-new', 'acme/new')], bridgeConfig,
      new FakeGithub(() => ({ id: 900, nameWithOwner: 'acme/new' })), T1,
      { lastKnownGoodConfigFingerprint: 'different-config-fingerprint' },
    );

    expect(result.counts.deferredRepositories).toBe(0);
    expect(result.snapshot.repositories.map((row) => row.canonicalKey)).toEqual([
      'github.com/acme/new',
    ]);
    expect(result.effectiveConfig.projects.map((row) => row.key)).toEqual([
      'auto:github.com/acme/new',
    ]);

    const failure = await runRepositoryDiscoveryPass({
      orca: new FakeOrca(new Error('private query failure')),
      github: new FakeGithub(() => new Error('not called')),
      store,
      config: bridgeConfig,
      now: () => new Date(T2),
      lastKnownGoodConfigFingerprint: bridgeConfigFingerprint(bridgeConfig),
    });
    expect(failure).toMatchObject({ status: 'failed', failure: 'query_failed' });
    expect(failure.snapshot.repositories.map((row) => row.canonicalKey)).toEqual([
      'github.com/acme/new',
    ]);
    expect(failure.effectiveConfig.projects.map((row) => row.key)).toEqual([
      'auto:github.com/acme/new',
    ]);
  });

  it('replaces a fully inactive incompatible generation atomically across rollback and restart', async () => {
    const configA = config();
    const configB = config([], { runsPerPass: 63 });
    const proofA = bridgeConfigFingerprint(configA);
    await pass([
      repoRow('orca-one', 'acme/one'),
      repoRow('orca-two', 'acme/two'),
    ], configA, new FakeGithub((name) => ({
      id: name === 'acme/one' ? 100 : 200,
      nameWithOwner: name,
    })));
    await pass([], configA, new FakeGithub(() => new Error('not called')), T1);
    await pass([], configA, new FakeGithub(() => new Error('not called')), T2);
    expect(store.readEffectiveDiscoverySnapshot()).toEqual({
      repositories: [], bindings: [], issues: [],
    });

    const databasePath = join(directory, 'state.db');
    store.close();
    let raw = new DatabaseSync(databasePath, { readOnly: true });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM repository_registry').get())
      .toEqual({ count: 2 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM orca_repository_binding').get())
      .toEqual({ count: 2 });
    raw.close();

    store = new SqliteDigestStore(databasePath, {
      operationalFault: (point) => {
        if (point === 'after_discovery_registry') throw new Error('private rollback marker');
      },
    });
    const rolledBack = await pass(
      [repoRow('orca-current', 'acme/two')], configB,
      new FakeGithub(() => ({ id: 100, nameWithOwner: 'acme/two' })),
      '2026-08-27T02:00:00.000Z',
      { lastKnownGoodConfigFingerprint: proofA },
    );
    expect(rolledBack).toMatchObject({ status: 'failed', failure: 'config_drift' });
    expect(rolledBack.snapshot).toEqual({ repositories: [], bindings: [], issues: [] });
    store.close();

    raw = new DatabaseSync(databasePath, { readOnly: true });
    expect(raw.prepare('SELECT canonical_key, github_repository_id FROM repository_registry ORDER BY canonical_key').all())
      .toEqual([
        { canonical_key: 'github.com/acme/one', github_repository_id: 100 },
        { canonical_key: 'github.com/acme/two', github_repository_id: 200 },
      ]);
    raw.close();

    store = new SqliteDigestStore(databasePath);
    const transitioned = await pass(
      [repoRow('orca-current', 'acme/two')], configB,
      new FakeGithub(() => ({ id: 100, nameWithOwner: 'acme/two' })),
      '2026-08-27T02:00:00.000Z',
      { lastKnownGoodConfigFingerprint: proofA },
    );
    expect(transitioned).toMatchObject({ status: 'succeeded' });
    expect(transitioned.snapshot.repositories).toMatchObject([{
      canonicalKey: 'github.com/acme/two', githubRepositoryId: 100,
      projectKey: 'auto:github.com/acme/two', active: true,
    }]);
    expect(transitioned.snapshot.bindings).toMatchObject([{
      orcaRepositoryId: 'orca-current', canonicalKey: 'github.com/acme/two', active: true,
    }]);
    store.close();

    raw = new DatabaseSync(databasePath, { readOnly: true });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM repository_registry').get())
      .toEqual({ count: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM orca_repository_binding').get())
      .toEqual({ count: 1 });
    raw.close();
    store = new SqliteDigestStore(databasePath);
    expect(store.readEffectiveDiscoverySnapshot()).toEqual(transitioned.snapshot);
  });

  it('excludes an incompatible explicit Project from current conflict inference', async () => {
    const alpha = config([{ name: 'alpha', repositories: ['acme/shared'] }]);
    await pass(
      [repoRow('orca-shared', 'acme/shared')], alpha,
      new FakeGithub(() => ({ id: 901, nameWithOwner: 'acme/shared' })),
    );
    const beta = config([{ name: 'beta', repositories: ['acme/shared'] }]);
    const github = new FakeGithub(() => ({ id: 901, nameWithOwner: 'acme/shared' }));
    const current = await pass(
      [repoRow('orca-shared', 'acme/shared')], beta,
      github, T1,
      { lastKnownGoodConfigFingerprint: bridgeConfigFingerprint(alpha) },
    );

    expect(github.calls).toEqual(['acme/shared']);
    expect(current.status).toBe('succeeded');
    expect(current.snapshot.repositories).toMatchObject([{
      canonicalKey: 'github.com/acme/shared', projectKey: 'beta', projectOrigin: 'explicit',
    }]);
    expect(current.snapshot.bindings).toMatchObject([{
      orcaRepositoryId: 'orca-shared', projectKey: 'beta',
    }]);
    expect(current.effectiveConfig.bindings.some((binding) =>
      binding.status === 'blocked' && binding.reason === 'project_conflict')).toBe(false);
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
      lastKnownGoodConfigFingerprint: bridgeConfigFingerprint(bridgeConfig),
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
    expect(github.calls).toHaveLength(count);
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

  it('fails closed on a legacy snapshot whose auto key has two numeric owners', () => {
    const record = (name: 'acme/new' | 'acme/old', numeric: number) => ({
      canonicalKey: `github.com/${name}` as const,
      nameWithOwner: name,
      githubRepositoryId: numeric,
      projectKey: 'auto:github.com/acme/old',
      projectOrigin: 'auto' as const,
      active: true,
      consecutiveMissingPasses: 0,
      firstSeenAt: T0,
      lastSeenAt: T0,
      lastGoodAt: T0,
      updatedAt: T0,
    });
    const binding = (id: string, name: 'acme/new' | 'acme/old') => ({
      orcaRepositoryId: id,
      canonicalKey: `github.com/${name}` as const,
      projectKey: 'auto:github.com/acme/old',
      origin: 'discovered' as const,
      active: true,
      consecutiveMissingPasses: 0,
      firstSeenAt: T0,
      lastSeenAt: T0,
      lastGoodAt: T0,
      updatedAt: T0,
    });
    const effective = buildEffectiveBridgeConfig(config(), {
      repositories: [record('acme/new', 1), record('acme/old', 2)],
      bindings: [binding('orca-original', 'acme/new'), binding('orca-reused', 'acme/old')],
      issues: [],
    });

    expect(effective.routing).toEqual({ status: 'blocked', reason: 'project_conflict' });
    expect(effective.projects).toEqual([]);
    expect(effective.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'blocked', reason: 'project_conflict', orcaRepositoryIds: ['orca-original'],
      }),
      expect.objectContaining({
        status: 'blocked', reason: 'project_conflict', orcaRepositoryIds: ['orca-reused'],
      }),
    ]));
    expect(effective.bindings.some((row) => row.status === 'bound')).toBe(false);
  });

  it('fails closed without merging an auto repository into a colliding hand-built explicit key', async () => {
    const seedConfig = config();
    const seeded = await pass(
      [repoRow('orca-auto', 'acme/auto')], seedConfig,
      new FakeGithub(() => ({ id: 902, nameWithOwner: 'acme/auto' })),
    );
    const safeExplicit = config([{
      name: 'safe-explicit', repositories: ['acme/configured'],
    }]);
    const colliding = {
      ...safeExplicit,
      projects: [{
        ...safeExplicit.projects[0]!,
        name: 'auto:github.com/acme/auto',
      }],
    } as ParsedBridgeConfig;
    const effective = buildEffectiveBridgeConfig(colliding, seeded.snapshot);

    expect(effective.routing).toEqual({ status: 'blocked', reason: 'project_conflict' });
    expect(effective.projects).toMatchObject([{
      key: 'auto:github.com/acme/auto',
      origin: 'explicit',
      repositories: [{ canonicalKey: 'github.com/acme/configured' }],
      orcaRepositoryIds: [],
    }]);
    expect(effective.bindings).toContainEqual(expect.objectContaining({
      status: 'blocked', reason: 'project_conflict', orcaRepositoryIds: ['orca-auto'],
    }));
    expect(effective.bindings.some((binding) => binding.status === 'bound' &&
      binding.orcaRepositoryIds.includes('orca-auto'))).toBe(false);

    let writes = 0;
    const orca = new FakeOrca(envelope([repoRow('orca-auto', 'acme/auto')]));
    const failed = await runRepositoryDiscoveryPass({
      orca,
      github: new FakeGithub(() => ({ id: 902, nameWithOwner: 'acme/auto' })),
      store: countingStore(() => { writes += 1; }),
      config: colliding,
      now: () => new Date(T1),
      lastKnownGoodConfigFingerprint: bridgeConfigFingerprint(colliding),
    });
    expect(failed).toMatchObject({ status: 'failed', failure: 'config_drift' });
    expect(failed.effectiveConfig.routing).toEqual({ status: 'blocked', reason: 'project_conflict' });
    expect(orca.calls).toEqual([]);
    expect(writes).toBe(0);
  });
});
