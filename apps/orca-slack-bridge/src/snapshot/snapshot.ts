import type { BridgeConfig } from '../project/config.js';
import { projectForRepository } from '../project/config.js';
import { fetchRepositoryIdentity } from '../github/repository.js';
import { listPullRequests, type PullRequestFacts } from '../github/pull-request.js';
import type { GhRunner } from '../github/runner.js';
import { listRuns, listTasks, listGates, unreadableGateFields, unreadableTaskFields, type OrcaRunner, type OrcaRun, type OrcaTask, type OrcaGate } from '../orca/client.js';
import { parseCorrelationMetadata } from '../correlate/metadata.js';
import { resolveCorrelation, type Correlation, type OrcaCorrelationView } from '../correlate/resolve.js';
import type { RepositoryIdentity } from '../identity/repository.js';

/**
 * read-only 1회 관찰 결과.
 *
 * polling·reconciliation은 상태를 갱신해야 하는 C1/C2에서 정한다(DL-022).
 */
export type Snapshot = {
  readonly observedAt: string;
  readonly runs: readonly RunView[];
  readonly repositories: readonly RepositoryView[];
};

export type RunView = {
  readonly run: OrcaRun;
  readonly tasks: readonly OrcaTask[];
  readonly gates: readonly OrcaGate[];
  /** task가 보고한 작업 디렉터리 목록. Run이 여러 repository를 쓸 수 있으므로 집합이다. */
  readonly worktreePaths: readonly string[];
};

export type RepositoryView = {
  readonly repository: RepositoryIdentity;
  /** 설정에 없으면 null. 추측하지 않는다. */
  readonly project: string | null;
  readonly pullRequests: readonly PullRequestView[];
};

export type PullRequestView = {
  readonly pr: PullRequestFacts;
  readonly correlation: Correlation;
};

export function buildCorrelationView(runs: readonly RunView[]): OrcaCorrelationView {
  const runIds = new Set<string>();
  const taskToRun = new Map<string, string>();
  for (const r of runs) {
    runIds.add(r.run.id);
    for (const t of r.tasks) taskToRun.set(t.id, t.runId);
  }
  return { runIds, taskToRun };
}

export async function collectRuns(orca: OrcaRunner): Promise<RunView[]> {
  const runs = await listRuns(orca);
  const views: RunView[] = [];
  for (const run of runs) {
    // legacy Run은 읽기 전용 placeholder이므로 Task/Gate 조회를 시도하지 않는다.
    const tasks = run.legacy ? [] : await listTasks(orca, run.id);
    const gates = run.legacy ? [] : await listGates(orca, run.id);
    const paths = [...new Set(tasks.map((t) => t.worktreePath).filter((p): p is string => p !== null))];
    views.push({ run, tasks, gates, worktreePaths: paths });
  }
  return views;
}

export async function collectRepositories(
  gh: GhRunner,
  config: BridgeConfig,
  correlationView: OrcaCorrelationView,
  prLimit: number,
): Promise<RepositoryView[]> {
  const names = config.projects.flatMap((p) => p.repositories);
  const out: RepositoryView[] = [];
  for (const name of names) {
    const repository = await fetchRepositoryIdentity(gh, name);
    const prs = await listPullRequests(gh, repository, prLimit);
    out.push({
      repository,
      project: projectForRepository(config, repository.nameWithOwner),
      pullRequests: prs.map((pr) => ({
        pr,
        correlation: resolveCorrelation(
          parseCorrelationMetadata(pr.body, config.correlationKeys),
          correlationView,
        ),
      })),
    });
  }
  return out;
}

export async function takeSnapshot(
  orca: OrcaRunner,
  gh: GhRunner,
  config: BridgeConfig,
  options: { readonly prLimit?: number; readonly now?: () => Date } = {},
): Promise<Snapshot> {
  const now = options.now ?? (() => new Date());
  const runs = await collectRuns(orca);
  const repositories = await collectRepositories(
    gh, config, buildCorrelationView(runs), options.prLimit ?? 50,
  );
  return { observedAt: now().toISOString(), runs, repositories };
}

/** 사람이 읽는 요약. 확정된 사실만 적는다. */
export function summarize(s: Snapshot): string {
  const lines: string[] = [`observed ${s.observedAt}`, ''];
  lines.push(`Runs: ${s.runs.length}`);
  for (const r of s.runs) {
    const tag = r.run.legacy ? ' [legacy]' : '';
    const open = r.gates.filter((g) => g.status === 'pending').length;
    // 읽지 못한 칸을 이 줄에서 드러낸다. 읽지 못한 것을 없는 것처럼 세면 관측이 조용히
    // 관대해진다(OD-079). 이유 전문은 `--json`의 task·gate row에 그대로 있다.
    const unreadable = [...unreadableTaskFields(r.tasks), ...unreadableGateFields(r.gates)];
    lines.push(
      `  ${r.run.id}${tag}  tasks=${r.tasks.length} gates=${r.gates.length} open=${open}` +
        (unreadable.length > 0
          ? `  unreadable=${unreadable.map((u) => `${u.id}.${u.field}`).join(',')}`
          : '') +
        (r.worktreePaths.length > 0 ? `  worktree=${r.worktreePaths.join(',')}` : ''),
    );
  }
  lines.push('', `Repositories: ${s.repositories.length}`);
  for (const rv of s.repositories) {
    const counts = new Map<string, number>();
    for (const p of rv.pullRequests) {
      const k =
        p.correlation.kind === 'correlated'
          ? 'correlated'
          : p.correlation.kind === 'conflict'
            ? 'conflict'
            : `uncorrelated:${p.correlation.reason}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const detail = [...counts].map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(
      `  ${rv.repository.nameWithOwner} (${rv.repository.key})  project=${rv.project ?? 'UNMAPPED'}` +
        `  prs=${rv.pullRequests.length}  ${detail}`,
    );
  }
  return lines.join('\n');
}
