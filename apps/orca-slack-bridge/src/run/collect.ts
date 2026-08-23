import {
  askThreadsFrom,
  listGates,
  listRuns,
  listTaskPage,
  listWorkers,
  readInbox,
  showAgentWait,
  unreadableGateFields,
  unreadableRunFields,
  unreadableTaskFields,
  type AskInbox,
  type OrcaAgentWait,
  type OrcaGate,
  type OrcaRun,
  type OrcaRunner,
  type OrcaTask,
  type OrcaWorker,
  type UnreadableField,
} from '../orca/client.js';
import { projectForOrcaRepositoryId, type BridgeConfig } from '../project/config.js';
import { aggregateBlockers, aggregateDispatches, aggregateTasks } from './aggregate.js';
import { runIdentity } from './liveness.js';
import type {
  RunCollection,
  RunDegraded,
  RunFacts,
  UnregisteredRun,
  UnregisteredRuns,
} from './types.js';

/**
 * Orca를 read-only로 1회 읽어 Run 카드가 쓸 사실을 만든다(D1-A).
 *
 * 새 조회 계층을 만들지 않는다. `orca/client.ts`의 명령 경계만 쓴다.
 *
 * ## 조회 횟수
 *
 * `run-list` 1회 + `inbox` 1회 + Run마다 `task-list`·`gate-list`·`worker-list` 각 1회 +
 * **활성 Dispatch마다** `worker-show` 1회다. 마지막 항목만 Run 크기가 아니라 활성 Dispatch 수에
 * 비례한다. `agentWait`는 `worker-show`에만 있고 `worker-list` 행에는 없다. `dispatchStatus`가
 * `dispatched`인 행으로 좁혀 부른다 — 정산된 Dispatch의 대기는 현재 사실이 아니다.
 * 실측(2026-08-24, `run_36d28e6e947a`): Dispatch 71행 중 활성 1건.
 *
 * ## 실패를 삼키지 않는다
 *
 * Run 하나의 조회 실패가 다른 Run을 막지 않는다. 실패한 축은 빈 사실이 되고 그 Run의
 * `degraded`에 `query_failed`가 남는다. 실패를 0건으로 그리면 카드가 "blocker 없음"을 말한다(OD-072).
 */
export type CollectOptions = {
  readonly now?: () => Date;
  readonly inboxLimit?: number;
};

/** 한 Run의 원천 사실. 조회 실패는 여기서 degraded로 바뀐다. */
export type RunSources = {
  readonly tasks: readonly OrcaTask[];
  readonly taskCount: number;
  readonly gates: readonly OrcaGate[];
  readonly workers: readonly OrcaWorker[];
  readonly agentWaits: readonly { readonly worker: OrcaWorker; readonly wait: OrcaAgentWait }[];
  readonly degraded: readonly RunDegraded[];
  /** 읽은 row 중 읽지 못한 칸 전부(OD-079). 조회 실패(`degraded`)와 다른 사건이다. */
  readonly unreadable: readonly UnreadableField[];
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 읽지 못한 칸 하나를 degraded 한 줄로 옮긴다. 어느 row의 어느 칸인지를 잃지 않는다(OD-079). */
function unreadableDegraded(f: UnreadableField): RunDegraded {
  return {
    kind: 'unreadable_field',
    detail: `${f.subject} ${f.id}의 ${f.field}를 읽지 못했다: ${f.reason}`,
  };
}

async function readRunSources(orca: OrcaRunner, run: OrcaRun): Promise<RunSources> {
  // legacy Run은 읽기 전용 placeholder다. Task/Gate 조회를 시도하지 않는다(snapshot.ts와 같다).
  if (run.legacy) {
    return {
      tasks: [],
      taskCount: 0,
      gates: [],
      workers: [],
      agentWaits: [],
      degraded: [],
      unreadable: [],
    };
  }
  const degraded: RunDegraded[] = [];
  let tasks: readonly OrcaTask[] = [];
  let taskCount = 0;
  try {
    const page = await listTaskPage(orca, run.id);
    tasks = page.tasks;
    taskCount = page.count;
  } catch (e) {
    degraded.push({ kind: 'query_failed', detail: `task-list 실패: ${message(e)}` });
  }
  let gates: readonly OrcaGate[] = [];
  try {
    gates = await listGates(orca, run.id);
  } catch (e) {
    degraded.push({ kind: 'query_failed', detail: `gate-list 실패: ${message(e)}` });
  }
  let workers: readonly OrcaWorker[] = [];
  try {
    workers = await listWorkers(orca, run.id);
  } catch (e) {
    degraded.push({ kind: 'query_failed', detail: `worker-list 실패: ${message(e)}` });
  }
  const agentWaits: { worker: OrcaWorker; wait: OrcaAgentWait }[] = [];
  for (const worker of workers) {
    if (worker.dispatchStatus !== 'dispatched') continue;
    try {
      const wait = await showAgentWait(orca, worker.dispatchId);
      if (wait !== null) agentWaits.push({ worker, wait });
    } catch (e) {
      degraded.push({
        kind: 'query_failed',
        detail: `worker-show ${worker.dispatchId} 실패: ${message(e)}`,
      });
    }
  }
  return {
    tasks,
    taskCount,
    gates,
    workers,
    agentWaits,
    degraded,
    unreadable: [...unreadableTaskFields(tasks), ...unreadableGateFields(gates)],
  };
}

/** 이 Run에서 관측된 Orca repository id. Task와 worker 두 표면을 모두 본다. */
function observedRepositoryIds(sources: RunSources): string[] {
  const ids = new Set<string>();
  for (const t of sources.tasks) if (t.repositoryId !== null) ids.add(t.repositoryId);
  for (const w of sources.workers) if (w.repositoryId !== null) ids.add(w.repositoryId);
  return [...ids].sort();
}

/**
 * Run 하나를 사실로 접는다. 등록 판정 결과는 싣되 목록에서 빼는 것은 호출자가 한다.
 *
 * 순수 함수다. 조회는 `readRunSources`가 끝냈고 여기서는 집계만 한다.
 */
export function projectRun(
  run: OrcaRun,
  sources: RunSources,
  askInbox: AskInbox,
  config: BridgeConfig,
): RunFacts {
  const identity = runIdentity(run, sources.tasks);
  const repositoryIds = observedRepositoryIds(sources);
  // 매치를 전부 모은다. 첫 매치만 보면 두 Project에 걸친 Run이 조용히 한쪽으로 간다.
  const matched = [
    ...new Set(
      repositoryIds
        .map((id) => projectForOrcaRepositoryId(config, id))
        .filter((n): n is string => n !== null),
    ),
  ].sort();
  const project = matched[0] ?? null;
  const repositories =
    project === null ? [] : (config.projects.find((p) => p.name === project)?.repositories ?? []);

  const degraded: RunDegraded[] = [
    ...sources.degraded,
    ...sources.unreadable.map(unreadableDegraded),
  ];
  if (repositoryIds.length === 0) {
    // 원인이 둘이다. 조회가 실패했으면 "관측할 것이 없었다"가 아니라 "관측하지 못했다"이고,
    // 그 차이가 아래 등록 판정을 신뢰할 수 있는지를 가른다(OD-078의 완화 장치가 여기 걸린다).
    const failed = sources.degraded.some((d) => d.kind === 'query_failed');
    degraded.push({
      kind: 'repository_unobservable',
      detail: failed
        ? 'Orca 조회가 실패해 repository id를 관측하지 못했다. 등록 여부를 판정할 수 없다'
        : 'Task도 worker도 없어 Orca repository id를 관측하지 못했다',
    });
  } else if (project === null) {
    degraded.push({
      kind: 'unregistered_repository',
      detail:
        `관측된 Orca repository id가 설정에 없다: ${repositoryIds.join(', ')}. ` +
        'projects[].orcaRepositoryIds에 등록해야 이 Run이 표시 대상이 된다(OD-078)',
    });
  } else if (matched.length > 1) {
    degraded.push({
      kind: 'multiple_project_match',
      detail:
        `관측된 repository id가 Project ${matched.join(', ')}에 걸쳐 있다. ` +
        `${project}로 접었으므로 나머지 Project의 카드에서 이 Run이 빠진다`,
    });
  }
  if (identity.liveness === 'unknown') {
    degraded.push({
      kind: 'liveness_unknown',
      detail:
        identity.observed.length === 0
          ? 'Task가 없어 Run row와 대조할 binding이 없다'
          : `관측된 binding이 Run row(generation ${run.consumerGeneration})와 어긋난다`,
    });
  }

  const asks = askInbox.asks.filter((a) => a.runId === run.id);
  const escalations = askInbox.escalations.filter((e) => e.runId === run.id);
  // 포화 자체는 컬렉션 수준 사실이므로 `collectRunFacts`가 무조건 싣는다. 여기서는 이 Run에
  // 실제로 미답 ask가 보일 때만 덧붙인다 — 그 badge의 수를 확정으로 읽지 말라는 표시다.
  if (askInbox.saturated && asks.some((a) => !a.answered)) {
    degraded.push({
      kind: 'inbox_saturated',
      detail:
        `inbox가 요청 상한 ${askInbox.limit}행에 닿아 ask 답변의 부재를 증명할 수 없다. ` +
        '미답으로 표시된 ask가 실제로는 답변됐을 수 있다',
    });
  }

  return {
    identity,
    project,
    repositories,
    observedRepositoryIds: repositoryIds,
    tasks: aggregateTasks(sources.tasks, sources.taskCount),
    dispatches: aggregateDispatches(sources.workers),
    blockers: aggregateBlockers({
      tasks: sources.tasks,
      gates: sources.gates,
      workers: sources.workers,
      asks,
      escalations,
      agentWaits: sources.agentWaits,
    }),
    degraded,
  };
}

/**
 * 관찰 1회.
 *
 * 미등록 Run을 버리지 않고 센다. OD-078의 열쇠(Orca repository id)가 어긋나면 카드가 조용히
 * 비는 대신 `unregistered.count`가 오른다. 이것이 그 결정의 유일한 실패 모드를 관측 가능하게
 * 만드는 장치다(OD-072).
 */
export async function collectRunFacts(
  orca: OrcaRunner,
  config: BridgeConfig,
  options: CollectOptions = {},
): Promise<RunCollection> {
  const now = options.now ?? (() => new Date());
  const runs = await listRuns(orca);

  const degraded: RunDegraded[] = [
    {
      kind: 'unverified_platform_assumption',
      detail:
        'live/stale 판정은 run-use가 consumer_generation을 올린다는 미검증 가정 위에 있다' +
        '(docs/platform-capabilities.md §7.2). 플랫폼 동작이 바뀌면 이 판정이 깨진다',
    },
  ];

  // Run row의 세대를 읽지 못한 것은 Run 하나가 아니라 관찰의 사실이다. 그 Run의 live/stale이
  // `unknown`으로 접히는 이유가 여기 남는다(OD-079).
  for (const f of unreadableRunFields(runs)) degraded.push(unreadableDegraded(f));

  let askInbox: AskInbox = {
    asks: [],
    escalations: [],
    unreadable: [],
    saturated: false,
    limit: 0,
  };
  try {
    askInbox = askThreadsFrom(await readInbox(orca, options.inboxLimit));
  } catch (e) {
    degraded.push({
      kind: 'query_failed',
      detail: `inbox 실패: ${message(e)}. ask와 escalation badge가 없다`,
    });
  }
  for (const f of askInbox.unreadable) degraded.push(unreadableDegraded(f));
  // 포화는 **무조건** 컬렉션 수준으로 드러낸다. 이 Run에 미답 ask가 보일 때만 알리면 포화의 더
  // 나쁜 방향 — ask 행 자체가 조회 창 밖으로 밀려 badge도 degraded도 없이 사라지는 경우 — 이
  // 아무 흔적 없이 지나간다. 그 경우가 바로 아무것도 보이지 않는 경우다(OD-072).
  if (askInbox.saturated) {
    degraded.push({
      kind: 'inbox_saturated',
      detail:
        `inbox가 요청 상한 ${askInbox.limit}행에 닿았다. 더 오래된 ask·escalation 행이 조회 창 ` +
        '밖으로 밀렸을 수 있고, 그런 행은 어느 Run의 badge에도 나타나지 않는다',
    });
  }

  const facts: RunFacts[] = [];
  const unregisteredRuns: UnregisteredRun[] = [];
  for (const run of runs) {
    const projected = projectRun(run, await readRunSources(orca, run), askInbox, config);
    if (projected.project === null) {
      // degraded를 함께 싣는다. 이것이 없으면 조회에 실패한 Run이 미등록으로 둔갑해 OD-078의
      // 완화 장치가 다른 사건을 센다.
      unregisteredRuns.push({
        runId: run.id,
        repositoryIds: projected.observedRepositoryIds,
        degraded: projected.degraded,
      });
      continue;
    }
    facts.push(projected);
  }

  const unregistered: UnregisteredRuns = { count: unregisteredRuns.length, runs: unregisteredRuns };
  return { observedAt: now().toISOString(), runs: facts, unregistered, degraded };
}

/** 사람이 읽는 요약. 확정된 사실만 적는다. 비율을 만들지 않는다(OD-069). */
export function formatRunCollection(c: RunCollection): string {
  const lines: string[] = [`observed ${c.observedAt}`, ''];
  lines.push(`Runs: ${c.runs.length}`);
  for (const r of c.runs) {
    const id = r.identity;
    lines.push(
      `  ${id.runId}  [${r.project}]  ${id.liveness}` +
        `  gen=${id.current === null ? '읽지 못함' : id.current.generation}` +
        `  handle=${id.current?.handle ?? '없음'}`,
    );
    lines.push(`    objective  ${id.objective.split('\n')[0] ?? ''}`);
    const status = r.tasks.byStatus.map((s) => `${s.status}=${s.count}`).join(' ') || '없음';
    lines.push(`    tasks      count=${r.tasks.total}  ${status}`);
    const dispatch = r.dispatches.byStatus.map((s) => `${s.status}=${s.count}`).join(' ') || '없음';
    lines.push(
      `    dispatches attempts=${r.dispatches.total}  ${dispatch}` +
        `  retried_tasks=${r.dispatches.retriedTasks}`,
    );
    if (r.blockers.badges.length === 0) {
      lines.push('    blockers   관측된 원천 없음');
    }
    for (const b of r.blockers.badges) {
      const ids = b.entries
        .map((e) =>
          [e.gateId, e.taskId, e.dispatchId, e.messageId].filter((v) => v !== null).join('/'),
        )
        .join(' ');
      lines.push(`    blocker    ${b.source}=${b.count}  ${ids}`);
    }
    for (const n of r.blockers.notObservable) {
      lines.push(`    blocker    ${n.source}=관측불가  ${n.reason}`);
    }
    for (const d of r.degraded) lines.push(`    degraded   ${d.kind}  ${d.detail}`);
  }
  lines.push('', `등록되지 않은 Run: ${c.unregistered.count}`);
  for (const u of c.unregistered.runs) {
    lines.push(`  ${u.runId}  repoIds=${u.repositoryIds.join(',') || '관측 없음'}`);
    // 여기를 비우면 "조회했더니 등록에 없다"와 "조회가 실패해 판정할 수 없다"가 같은 줄이 된다.
    for (const d of u.degraded) lines.push(`    degraded   ${d.kind}  ${d.detail}`);
  }
  lines.push('');
  for (const d of c.degraded) lines.push(`degraded  ${d.kind}  ${d.detail}`);
  return lines.join('\n');
}
