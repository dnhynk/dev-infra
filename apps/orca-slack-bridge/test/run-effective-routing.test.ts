import { describe, expect, it } from 'vitest';
import { buildEffectiveBridgeConfig } from '../src/discovery/effective-config.js';
import type { CanonicalGithubRepository } from '../src/discovery/types.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { collectRunFacts } from '../src/run/collect.js';
import { parseConfig, type ParsedBridgeConfig } from '../src/project/config.js';
import type {
  EffectiveDiscoverySnapshot,
  OrcaRepositoryBindingRecord,
  RepositoryRegistryRecord,
} from '../src/store/operational-types.js';

const OBSERVED_AT = new Date('2026-08-26T12:00:00.000Z');
const EVIDENCE_AT = '2026-08-26T00:00:00.000Z';

function config(
  projects: readonly {
    readonly name: string;
    readonly repositories: readonly string[];
    readonly orcaRepositoryIds?: readonly string[];
  }[],
  runsPerPass = 64,
): ParsedBridgeConfig {
  return parseConfig({ slack: null, projects, automation: { capacity: { runsPerPass } } });
}

function canonical(nameWithOwner: string): CanonicalGithubRepository {
  return {
    canonicalKey: `github.com/${nameWithOwner}` as `github.com/${string}/${string}`,
    nameWithOwner: nameWithOwner as `${string}/${string}`,
  };
}

function registry(
  nameWithOwner: string,
  githubRepositoryId: number,
  projectKey: string,
): RepositoryRegistryRecord {
  return {
    ...canonical(nameWithOwner),
    githubRepositoryId,
    projectKey,
    projectOrigin: 'explicit',
    active: true,
    consecutiveMissingPasses: 0,
    firstSeenAt: EVIDENCE_AT,
    lastSeenAt: EVIDENCE_AT,
    lastGoodAt: EVIDENCE_AT,
    updatedAt: EVIDENCE_AT,
  };
}

function binding(
  orcaRepositoryId: string,
  nameWithOwner: string,
  projectKey: string,
): OrcaRepositoryBindingRecord {
  return {
    orcaRepositoryId,
    canonicalKey: canonical(nameWithOwner).canonicalKey,
    projectKey,
    origin: 'discovered',
    active: true,
    consecutiveMissingPasses: 0,
    firstSeenAt: EVIDENCE_AT,
    lastSeenAt: EVIDENCE_AT,
    lastGoodAt: EVIDENCE_AT,
    updatedAt: EVIDENCE_AT,
  };
}

function effective(
  bridgeConfig: ParsedBridgeConfig,
  rows: readonly { id: string; repository: string; numeric: number; project: string }[],
  blocked: readonly { id: string; reason: 'capacity_deferred' | 'capacity_conflict' }[] = [],
) {
  const unique = new Map<string, RepositoryRegistryRecord>();
  const bindings: OrcaRepositoryBindingRecord[] = [];
  for (const row of rows) {
    unique.set(row.repository, registry(row.repository, row.numeric, row.project));
    bindings.push(binding(row.id, row.repository, row.project));
  }
  const snapshot: EffectiveDiscoverySnapshot = {
    repositories: [...unique.values()], bindings, issues: [],
  };
  return buildEffectiveBridgeConfig(bridgeConfig, snapshot, {
    blockedBindings: blocked.map((row) => ({
      orcaRepositoryIds: [row.id], reason: row.reason,
    })),
  });
}

type RunRow = ReturnType<typeof runRow>;

function runRow(id: string, updatedAt: string, createdAt = updatedAt) {
  return {
    id,
    objective: 'synthetic objective',
    coordinator_handle: 'term_synthetic',
    coordinator_pane_key: 'pane:synthetic',
    consumer_generation: 1,
    legacy: 0,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

class RunOrca implements OrcaRunner {
  readonly calls: string[][] = [];
  constructor(
    private readonly runs: readonly RunRow[],
    private readonly repositoryIds: ReadonlyMap<string, readonly string[]>,
    private readonly malformedRuns: ReadonlySet<string> = new Set(),
  ) {}

  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const command = args[1];
    let result: unknown;
    if (command === 'run-list') {
      result = { runs: this.runs };
    } else if (command === 'inbox') {
      result = { messages: [] };
    } else {
      const runId = args[args.indexOf('--run') + 1] ?? '';
      if (command === 'task-list') {
        const ids = this.repositoryIds.get(runId) ?? [];
        const tasks = this.malformedRuns.has(runId)
          ? [taskRow(runId, 'malformed-live-identity', 0)]
          : ids.map((id, index) => taskRow(runId, `${id}::X:/synthetic@@hash:worker`, index));
        result = { tasks, count: tasks.length };
      } else if (command === 'gate-list') {
        result = { gates: [] };
      } else if (command === 'worker-list') {
        result = { workers: [] };
      } else {
        throw new Error('unexpected synthetic Orca command');
      }
    }
    return JSON.stringify({ id: 'synthetic-call', ok: true, result });
  }
}

function taskRow(runId: string, incarnation: string, index: number) {
  return {
    id: `task_${runId}_${index}`,
    run_id: runId,
    task_title: 'synthetic task',
    status: 'ready',
    deps: '[]',
    result: null,
    created_by_process_incarnation: incarnation,
    created_by_terminal_handle: 'term_synthetic',
    created_by_pane_key: 'pane:synthetic',
    created_by_run_generation: 1,
    created_at: '2026-08-26 00:00:00',
  };
}

function isoAtMinute(minute: number): string {
  return new Date(Date.UTC(2026, 7, 26, 0, minute)).toISOString();
}

describe('O1-3 effective Run routing', () => {
  it('routes multiple canonical repositories exactly once when all IDs agree on one Project', async () => {
    const bridgeConfig = config([{
      name: 'suite', repositories: ['acme/one', 'acme/two'],
    }]);
    const routing = effective(bridgeConfig, [
      { id: 'orca-one', repository: 'acme/one', numeric: 201, project: 'suite' },
      { id: 'orca-two', repository: 'acme/two', numeric: 202, project: 'suite' },
    ]);
    const orca = new RunOrca(
      [runRow('run_same', EVIDENCE_AT)],
      new Map([['run_same', ['orca-one', 'orca-two']]]),
    );
    const result = await collectRunFacts(orca, routing, { now: () => OBSERVED_AT });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      project: 'suite', repositories: ['acme/one', 'acme/two'],
      observedRepositoryIds: ['orca-one', 'orca-two'],
    });
    expect(result.unregistered.count).toBe(0);
  });

  it('routes multiple Orca IDs for one canonical repository to the same Project', async () => {
    const bridgeConfig = config([{ name: 'suite', repositories: ['acme/one'] }]);
    const routing = effective(bridgeConfig, [
      { id: 'orca-a', repository: 'acme/one', numeric: 203, project: 'suite' },
      { id: 'orca-b', repository: 'acme/one', numeric: 203, project: 'suite' },
    ]);
    const result = await collectRunFacts(
      new RunOrca(
        [runRow('run_aliases', EVIDENCE_AT)],
        new Map([['run_aliases', ['orca-b', 'orca-a']]]),
      ),
      routing,
      { now: () => OBSERVED_AT },
    );

    expect(result.runs[0]).toMatchObject({ project: 'suite' });
    expect(result.runs[0]?.observedRepositoryIds).toEqual(['orca-a', 'orca-b']);
  });

  it('routes zero for cross-Project consensus and exposes only redacted structured facts', async () => {
    const bridgeConfig = config([
      { name: 'alpha', repositories: ['acme/one'] },
      { name: 'beta', repositories: ['acme/two'] },
    ]);
    const routing = effective(bridgeConfig, [
      { id: 'private-orca-one', repository: 'acme/one', numeric: 204, project: 'alpha' },
      { id: 'private-orca-two', repository: 'acme/two', numeric: 205, project: 'beta' },
    ]);
    const result = await collectRunFacts(
      new RunOrca(
        [runRow('run_cross', EVIDENCE_AT)],
        new Map([['run_cross', ['private-orca-one', 'private-orca-two']]]),
      ),
      routing,
      { now: () => OBSERVED_AT },
    );

    expect(result.runs).toEqual([]);
    expect(result.unregistered.count).toBe(1);
    expect(result.unregistered.runs[0]?.repositoryIds).toEqual([]);
    expect(result.unregistered.runs[0]?.repositoryRefs).toHaveLength(2);
    const degraded = result.unregistered.runs[0]?.degraded.find((row) =>
      row.kind === 'repository_route_blocked');
    expect(degraded?.counts).toMatchObject({ observedRepositories: 2, resolvedProjects: 2 });
    expect(JSON.stringify(result)).not.toContain('private-orca-one');
    expect(JSON.stringify(result)).not.toContain('private-orca-two');
  });

  it.each([
    ['unknown', 'orca-unknown', undefined],
    ['capacity-deferred', 'orca-deferred', 'capacity_deferred'],
  ] as const)('routes zero for %s identity', async (_name, id, reason) => {
    const bridgeConfig = config([{ name: 'suite', repositories: ['acme/one'] }]);
    const routing = effective(
      bridgeConfig,
      reason === undefined
        ? []
        : [{ id, repository: 'acme/one', numeric: 206, project: 'suite' }],
      reason === undefined ? [] : [{ id, reason }],
    );
    const result = await collectRunFacts(
      new RunOrca([runRow('run_blocked', EVIDENCE_AT)], new Map([['run_blocked', [id]]])),
      routing,
      { now: () => OBSERVED_AT },
    );
    expect(result.runs).toEqual([]);
    expect(result.unregistered.runs[0]?.degraded).toContainEqual(expect.objectContaining({
      kind: 'repository_route_blocked',
    }));
  });

  it('routes zero with structured facts when no repository identity is observable', async () => {
    const bridgeConfig = config([{ name: 'suite', repositories: ['acme/one'] }]);
    const routing = effective(bridgeConfig, []);
    const result = await collectRunFacts(
      new RunOrca([runRow('run_empty', EVIDENCE_AT)], new Map()),
      routing,
      { now: () => OBSERVED_AT },
    );
    expect(result.runs).toEqual([]);
    expect(result.unregistered.runs[0]?.degraded).toContainEqual(expect.objectContaining({
      kind: 'repository_unobservable',
      counts: { observedRepositories: 0, resolvedProjects: 0, blockingReasons: 1 },
    }));
  });

  it('routes zero when a present repository-bearing identity is unreadable', async () => {
    const bridgeConfig = config([{
      name: 'manual', repositories: ['acme/one'], orcaRepositoryIds: ['orca-manual'],
    }]);
    const routing = buildEffectiveBridgeConfig(bridgeConfig, {
      repositories: [], bindings: [], issues: [],
    });
    const result = await collectRunFacts(
      new RunOrca(
        [runRow('run_bad_identity', EVIDENCE_AT)],
        new Map([['run_bad_identity', ['orca-manual']]]),
        new Set(['run_bad_identity']),
      ),
      routing,
      { now: () => OBSERVED_AT },
    );
    expect(result.runs).toEqual([]);
    expect(result.unregistered.runs[0]?.degraded).toContainEqual(expect.objectContaining({
      kind: 'repository_identity_unreadable',
    }));
  });

  it('preserves D1 manual-only routing without a discovery snapshot', async () => {
    const bridgeConfig = config([{
      name: 'manual', repositories: ['acme/one'], orcaRepositoryIds: ['orca-manual'],
    }]);
    const result = await collectRunFacts(
      new RunOrca(
        [runRow('run_manual', EVIDENCE_AT)],
        new Map([['run_manual', ['orca-manual']]]),
      ),
      bridgeConfig,
      { now: () => OBSERVED_AT },
    );
    expect(result.runs[0]).toMatchObject({ project: 'manual' });
  });
});

describe('O1-3 deterministic Run capacity', () => {
  it.each([63, 64, 65])('uses a deterministic 64-Run working set at list size %i', async (count) => {
    const bridgeConfig = config([{
      name: 'manual', repositories: ['acme/one'], orcaRepositoryIds: ['orca-manual'],
    }]);
    const routing = buildEffectiveBridgeConfig(bridgeConfig, {
      repositories: [], bindings: [], issues: [],
    });
    const rows = Array.from({ length: count }, (_, index) =>
      runRow(`run_${String(index).padStart(3, '0')}`, isoAtMinute(index)));
    const ids = new Map(rows.map((row) => [row.id, ['orca-manual']]));
    const forward = await collectRunFacts(
      new RunOrca(rows, ids), routing, { now: () => OBSERVED_AT },
    );
    const reversed = await collectRunFacts(
      new RunOrca([...rows].reverse(), ids), routing, { now: () => OBSERVED_AT },
    );

    const expected = [...rows].reverse().slice(0, 64).map((row) => row.id);
    expect(forward.runs.map((row) => row.identity.runId)).toEqual(expected);
    expect(reversed.runs.map((row) => row.identity.runId)).toEqual(expected);
    const capacity = forward.degraded.find((row) => row.kind === 'capacity_deferred');
    expect(capacity?.counts?.['deferredRuns'] ?? 0).toBe(Math.max(0, count - 64));
  });

  it('orders updatedAt first, then createdAt, then runId', async () => {
    const bridgeConfig = config([{
      name: 'manual', repositories: ['acme/one'], orcaRepositoryIds: ['orca-manual'],
    }]);
    const routing = buildEffectiveBridgeConfig(bridgeConfig, {
      repositories: [], bindings: [], issues: [],
    });
    const rows = [
      runRow('run_c', '2026-08-26T03:00:00Z', '2026-08-26T01:00:00Z'),
      runRow('run_b', '2026-08-26T03:00:00Z', '2026-08-26T02:00:00Z'),
      runRow('run_a', '2026-08-26T03:00:00Z', '2026-08-26T02:00:00Z'),
      runRow('run_latest', '2026-08-26T04:00:00Z', '2026-08-26T00:00:00Z'),
    ];
    const result = await collectRunFacts(
      new RunOrca(rows, new Map(rows.map((row) => [row.id, ['orca-manual']]))),
      routing,
      { now: () => OBSERVED_AT },
    );
    expect(result.runs.map((row) => row.identity.runId)).toEqual([
      'run_latest', 'run_a', 'run_b', 'run_c',
    ]);
  });

  it.each([256, 257])('enforces the independent 256-Run hard bound at %i', async (count) => {
    const bridgeConfig = config([{
      name: 'manual', repositories: ['acme/one'], orcaRepositoryIds: ['orca-manual'],
    }], 1);
    const routing = buildEffectiveBridgeConfig(bridgeConfig, {
      repositories: [], bindings: [], issues: [],
    });
    const rows = Array.from({ length: count }, (_, index) =>
      runRow(`run_${String(index).padStart(3, '0')}`, isoAtMinute(index)));
    const orca = new RunOrca(rows, new Map(rows.map((row) => [row.id, ['orca-manual']]))) ;
    if (count === 256) {
      const result = await collectRunFacts(orca, routing, { now: () => OBSERVED_AT });
      expect(result.runs).toHaveLength(1);
      expect(result.degraded).toContainEqual(expect.objectContaining({ kind: 'capacity_deferred' }));
    } else {
      await expect(collectRunFacts(orca, routing, { now: () => OBSERVED_AT }))
        .rejects.toMatchObject({ code: 'RUN_LIST_HARD_LIMIT' });
      expect(orca.calls).toEqual([['orchestration', 'run-list', '--json']]);
    }
  });

  it('fails before per-Run reads when ordering evidence is duplicated or inconsistent', async () => {
    const bridgeConfig = config([{
      name: 'manual', repositories: ['acme/one'], orcaRepositoryIds: ['orca-manual'],
    }]);
    const routing = buildEffectiveBridgeConfig(bridgeConfig, {
      repositories: [], bindings: [], issues: [],
    });
    for (const rows of [
      [runRow('run_same', EVIDENCE_AT), runRow('run_same', EVIDENCE_AT)],
      [runRow('run_bad', '2026-08-25T00:00:00Z', '2026-08-26T00:00:00Z')],
    ]) {
      const orca = new RunOrca(rows, new Map());
      await expect(collectRunFacts(orca, routing, { now: () => OBSERVED_AT }))
        .rejects.toMatchObject({ code: 'RUN_ORDERING_UNRELIABLE' });
      expect(orca.calls).toEqual([['orchestration', 'run-list', '--json']]);
    }
  });
});
