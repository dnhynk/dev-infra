import { describe, expect, it } from 'vitest';
import {
  OrcaRepositoryContractError,
  parseOrcaRepositoryList,
  parseOrcaRepositoryListJson,
} from '../src/discovery/orca-repositories.js';
import { listRepositories, type OrcaRunner } from '../src/orca/client.js';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'repo_synthetic_1',
    path: 'C:/REDACTED/worktree',
    displayName: 'synthetic',
    badgeColor: '#123456',
    addedAt: 1_700_000_000_000,
    kind: 'git',
    externalWorktreeVisibilityLegacy: false,
    gitUsername: 'synthetic-user',
    repoIcon: { type: 'icon', name: 'repository' },
    upstream: null,
    gitRemoteIdentity: {
      canonicalKey: 'github.com/example/project',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/Example/Project.git',
    },
    projectHostSetupMethod: 'default',
    hookSettings: { mode: 'inherit', scripts: [] },
    externalWorktreeVisibility: 'visible',
    ...overrides,
  };
}

function rowWithoutRepoIcon(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = row(overrides);
  delete value['repoIcon'];
  return value;
}

function envelope(repos: readonly unknown[] = [row()]): Record<string, unknown> {
  return {
    id: 'request_synthetic',
    ok: true,
    result: { repos },
    _meta: { runtimeId: 'runtime_synthetic' },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function contractCode(fn: () => unknown): OrcaRepositoryContractError['code'] {
  try {
    fn();
    throw new Error('expected contract error');
  } catch (error) {
    expect(error).toBeInstanceOf(OrcaRepositoryContractError);
    return (error as OrcaRepositoryContractError).code;
  }
}

describe('parseOrcaRepositoryList', () => {
  it('accepts the fully synthetic redacted installed shape and exports only discovery fields', () => {
    const got = parseOrcaRepositoryList(envelope());
    expect(got).toEqual({
      rows: [{
        status: 'valid',
        orcaRepositoryId: 'repo_synthetic_1',
        rowIndex: 0,
        identity: {
          canonicalKey: 'github.com/example/project',
          nameWithOwner: 'example/project',
        },
      }],
      diagnostics: [],
    });
    expect(JSON.stringify(got)).not.toContain('C:/REDACTED');
    expect(JSON.stringify(got)).not.toContain('remoteUrl');
    expect(JSON.stringify(got)).not.toContain('displayName');
  });

  it('accepts the exact installed row variant that omits repoIcon', () => {
    const got = parseOrcaRepositoryList(envelope([rowWithoutRepoIcon()]));
    expect(got.rows).toEqual([{
      status: 'valid',
      orcaRepositoryId: 'repo_synthetic_1',
      rowIndex: 0,
      identity: {
        canonicalKey: 'github.com/example/project',
        nameWithOwner: 'example/project',
      },
    }]);
  });

  it('represents null remote as a row-local no_remote diagnostic', () => {
    const got = parseOrcaRepositoryList(envelope([row({ gitRemoteIdentity: null, repoIcon: null })]));
    expect(got.rows[0]).toMatchObject({ status: 'no_remote', rowIndex: 0 });
    expect(got.diagnostics).toEqual([{ rowIndex: 0, code: 'no_remote', effect: 'row_blocked' }]);
  });

  it('represents canonical mismatch as row-local conflict without guessing a binding', () => {
    const got = parseOrcaRepositoryList(envelope([row({
      gitRemoteIdentity: {
        canonicalKey: 'github.com/example/different',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/Example/Project.git',
      },
    })]));
    expect(got.rows[0]).toMatchObject({
      status: 'canonical_conflict',
      computedIdentity: { canonicalKey: 'github.com/example/project' },
      diagnostic: { code: 'canonical_conflict', effect: 'row_blocked' },
    });
  });

  it('preserves duplicate rows for later reconciliation', () => {
    const got = parseOrcaRepositoryList(envelope([
      row(),
      row({ id: 'repo_synthetic_2' }),
      row(),
    ]));
    expect(got.rows).toHaveLength(3);
    expect(got.rows.map((item) => item.orcaRepositoryId)).toEqual([
      'repo_synthetic_1',
      'repo_synthetic_2',
      'repo_synthetic_1',
    ]);
  });

  it('isolates supported row-local remote rejection categories', () => {
    const got = parseOrcaRepositoryList(envelope([
      row({ gitRemoteIdentity: {
        canonicalKey: 'gitlab.com/example/project', remoteName: 'origin',
        remoteUrl: 'https://gitlab.com/example/project',
      } }),
      row({ id: 'repo_synthetic_2', gitRemoteIdentity: {
        canonicalKey: 'github.com/example/project', remoteName: 'origin',
        remoteUrl: 'https://github.com/example/project?private=1',
      } }),
    ]));
    expect(got.rows.map((item) => item.status)).toEqual(['unsupported_remote', 'invalid_remote']);
    expect(got.diagnostics.map((item) => item.code)).toEqual(['unsupported_host', 'query_or_fragment']);
    expect(got.diagnostics.every((item) => item.effect === 'row_blocked')).toBe(true);
  });

  it('keeps unrelated valid rows usable beside row-local rejection', () => {
    const got = parseOrcaRepositoryList(envelope([
      row({ gitRemoteIdentity: null }),
      row({ id: 'repo_synthetic_2' }),
    ]));
    expect(got.rows.map((item) => item.status)).toEqual(['no_remote', 'valid']);
    expect(got.rows[1]).toMatchObject({
      status: 'valid',
      identity: { canonicalKey: 'github.com/example/project' },
    });
  });

  it.each(['id', 'ok', 'result', '_meta'])('rejects a missing envelope key: %s', (key) => {
    const value = clone(envelope());
    delete value[key];
    expect(contractCode(() => parseOrcaRepositoryList(value))).toBe('ORCA_REPOSITORY_ENVELOPE_INVALID');
  });

  it('rejects extra envelope/result/meta keys and missing result.repos', () => {
    expect(contractCode(() => parseOrcaRepositoryList({ ...envelope(), extra: true })))
      .toBe('ORCA_REPOSITORY_ENVELOPE_INVALID');
    const extraResult = clone(envelope());
    (extraResult['result'] as Record<string, unknown>)['extra'] = true;
    expect(contractCode(() => parseOrcaRepositoryList(extraResult)))
      .toBe('ORCA_REPOSITORY_RESULT_INVALID');
    const missingRepos = clone(envelope());
    delete (missingRepos['result'] as Record<string, unknown>)['repos'];
    expect(contractCode(() => parseOrcaRepositoryList(missingRepos)))
      .toBe('ORCA_REPOSITORY_RESULT_INVALID');
    const extraMeta = clone(envelope());
    (extraMeta['_meta'] as Record<string, unknown>)['extra'] = true;
    expect(contractCode(() => parseOrcaRepositoryList(extraMeta)))
      .toBe('ORCA_REPOSITORY_ENVELOPE_INVALID');
    expect(contractCode(() => parseOrcaRepositoryList({ ...envelope(), id: 1 })))
      .toBe('ORCA_REPOSITORY_ENVELOPE_INVALID');
    expect(contractCode(() => parseOrcaRepositoryList({ ...envelope(), ok: 'true' })))
      .toBe('ORCA_REPOSITORY_ENVELOPE_INVALID');
    const wrongRepos = clone(envelope());
    (wrongRepos['result'] as Record<string, unknown>)['repos'] = {};
    expect(contractCode(() => parseOrcaRepositoryList(wrongRepos)))
      .toBe('ORCA_REPOSITORY_RESULT_INVALID');
    const wrongRuntime = clone(envelope());
    (wrongRuntime['_meta'] as Record<string, unknown>)['runtimeId'] = null;
    expect(contractCode(() => parseOrcaRepositoryList(wrongRuntime)))
      .toBe('ORCA_REPOSITORY_ENVELOPE_INVALID');
  });

  const rowKeys = Object.keys(row()).filter((key) => key !== 'repoIcon');
  it.each(rowKeys)('rejects a missing top-level row key: %s', (key) => {
    const value = row();
    delete value[key];
    expect(contractCode(() => parseOrcaRepositoryList(envelope([value]))))
      .toBe('ORCA_REPOSITORY_ROW_INVALID');
  });

  it('rejects an extra top-level row key', () => {
    expect(contractCode(() => parseOrcaRepositoryList(envelope([{ ...row(), extra: true }]))))
      .toBe('ORCA_REPOSITORY_ROW_INVALID');
  });

  it('rejects every other missing or extra key in the repoIcon-omitted row variant', () => {
    for (const key of Object.keys(rowWithoutRepoIcon())) {
      const value = rowWithoutRepoIcon();
      delete value[key];
      expect(contractCode(() => parseOrcaRepositoryList(envelope([value]))))
        .toBe('ORCA_REPOSITORY_ROW_INVALID');
    }
    expect(contractCode(() => parseOrcaRepositoryList(envelope([{
      ...rowWithoutRepoIcon(),
      unexpected: true,
    }])))).toBe('ORCA_REPOSITORY_ROW_INVALID');
  });

  const wrongTypes: readonly [string, unknown][] = [
    ['id', 1], ['path', null], ['displayName', false], ['badgeColor', 1], ['addedAt', 1.5],
    ['kind', null], ['externalWorktreeVisibilityLegacy', 0], ['gitUsername', []],
    ['repoIcon', 'icon'], ['upstream', {}], ['gitRemoteIdentity', []],
    ['projectHostSetupMethod', false], ['hookSettings', null], ['externalWorktreeVisibility', 1],
  ];
  it.each(wrongTypes)('rejects wrong top-level row type: %s', (key, value) => {
    expect(contractCode(() => parseOrcaRepositoryList(envelope([row({ [key]: value })]))))
      .toBe('ORCA_REPOSITORY_ROW_INVALID');
    if (key !== 'repoIcon') {
      expect(contractCode(() => parseOrcaRepositoryList(envelope([
        rowWithoutRepoIcon({ [key]: value }),
      ])))).toBe('ORCA_REPOSITORY_ROW_INVALID');
    }
  });

  it('requires the exact three remote identity fields and string types', () => {
    const missing = { canonicalKey: 'github.com/example/project', remoteName: 'origin' };
    expect(contractCode(() => parseOrcaRepositoryList(envelope([row({ gitRemoteIdentity: missing })]))))
      .toBe('ORCA_REPOSITORY_ROW_INVALID');
    const extra = { ...missing, remoteUrl: 'https://github.com/example/project', extra: true };
    expect(contractCode(() => parseOrcaRepositoryList(envelope([row({ gitRemoteIdentity: extra })]))))
      .toBe('ORCA_REPOSITORY_ROW_INVALID');
    const wrong = { ...missing, remoteUrl: 1 };
    expect(contractCode(() => parseOrcaRepositoryList(envelope([row({ gitRemoteIdentity: wrong })]))))
      .toBe('ORCA_REPOSITORY_ROW_INVALID');
  });

  it('uses static redacted errors for JSON and schema failures', () => {
    const sentinel = 'PRIVATE-PATH-URL-ID-SENTINEL';
    for (const action of [
      () => parseOrcaRepositoryListJson(`{${sentinel}`),
      () => parseOrcaRepositoryList({ ...envelope(), [sentinel]: sentinel }),
      () => parseOrcaRepositoryList(envelope([{ ...row(), path: 1, displayName: sentinel }])),
    ]) {
      try {
        action();
        expect.unreachable('contract should fail');
      } catch (error) {
        expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(sentinel);
      }
    }
  });
});

describe('listRepositories', () => {
  it('calls the bounded runner seam with exact repo-list arguments and forwards the signal', async () => {
    const controller = new AbortController();
    const calls: unknown[][] = [];
    const runner: OrcaRunner = {
      async run(args, options): Promise<string> {
        calls.push([args, options?.signal]);
        return JSON.stringify(envelope());
      },
    };
    const got = await listRepositories(runner, { signal: controller.signal });
    expect(got.rows).toHaveLength(1);
    expect(calls).toEqual([[['repo', 'list', '--json'], controller.signal]]);
  });

  it('replaces runner failures with a static contract error that cannot leak cause fields', async () => {
    const sentinel = 'SYNTHETIC_PRIVATE_REMOTE_MARKER';
    const failure = Object.assign(new Error(sentinel), {
      stdout: sentinel,
      stderr: sentinel,
      command: sentinel,
      path: sentinel,
      url: sentinel,
      repositoryId: sentinel,
    });
    const runner: OrcaRunner = {
      async run(): Promise<string> {
        throw failure;
      },
    };

    try {
      await listRepositories(runner);
      expect.unreachable('runner failure should be replaced');
    } catch (error) {
      expect(error).toBeInstanceOf(OrcaRepositoryContractError);
      expect((error as OrcaRepositoryContractError).code)
        .toBe('ORCA_REPOSITORY_COMMAND_FAILED');
      expect(error).not.toBe(failure);
      expect('cause' in (error as object)).toBe(false);
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(sentinel);
    }
  });
});
