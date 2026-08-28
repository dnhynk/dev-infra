import {
  askThreadsFrom,
  listGates,
  listRuns,
  listTaskPage,
  listWorkerPage,
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
import {
  DEFAULT_AUTOMATION_CONFIG,
  type BridgeConfig,
} from '../project/config.js';
import { isEffectiveBridgeConfig } from '../discovery/effective-config.js';
import { redactedEntityRef } from '../discovery/redaction.js';
import type { EffectiveBridgeConfig } from '../discovery/types.js';
import { projectGateDecisions } from '../gate/project.js';
import type { GateMetadata } from '../gate/types.js';
import { runKey } from '../identity/keys.js';
import type { GateStore } from '../store/schema.js';
import { OperationalStoreError } from '../store/sqlite.js';
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
  /** Sidecar reader. Omitted callers get fail-closed, action-free missing-metadata Gate cards. */
  readonly gateStore?: GateStore;
};

/** 한 Run의 원천 사실. 조회 실패는 여기서 degraded로 바뀐다. */
export type RunSources = {
  readonly tasks: readonly OrcaTask[];
  readonly taskCount: number;
  readonly gates: readonly OrcaGate[];
  readonly gateMetadata: readonly GateMetadata[];
  readonly workers: readonly OrcaWorker[];
  readonly agentWaits: readonly { readonly worker: OrcaWorker; readonly wait: OrcaAgentWait }[];
  readonly degraded: readonly RunDegraded[];
  /** 읽은 row 중 읽지 못한 칸 전부(OD-079). 조회 실패(`degraded`)와 다른 사건이다. */
  readonly unreadable: readonly UnreadableField[];
  /** False if either repository-bearing query failed or a non-empty identity was malformed. */
  readonly repositoryIdentityReliable?: boolean;
};

export type RunRoutingConfig = BridgeConfig | EffectiveBridgeConfig;

export type RunCollectionContractErrorCode =
  | 'RUN_LIST_HARD_LIMIT'
  | 'RUN_ORDERING_UNRELIABLE';

const RUN_CONTRACT_MESSAGES: Readonly<Record<RunCollectionContractErrorCode, string>> = {
  RUN_LIST_HARD_LIMIT: 'Orca Run list exceeds the supported hard limit',
  RUN_ORDERING_UNRELIABLE: 'Orca Run ordering evidence is missing or inconsistent',
};

export class RunCollectionContractError extends TypeError {
  constructor(readonly code: RunCollectionContractErrorCode) {
    super(RUN_CONTRACT_MESSAGES[code]);
    this.name = 'RunCollectionContractError';
  }
}

export const RUN_LIST_HARD_LIMIT = 256;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 읽지 못한 칸 하나를 degraded 한 줄로 옮긴다. 어느 row의 어느 칸인지를 잃지 않는다(OD-079). */
function unreadableDegraded(f: UnreadableField, redact = false): RunDegraded {
  if (redact) {
    return {
      kind: 'unreadable_field',
      detail: 'Orca Run 원천의 필드를 읽지 못했다',
      entityRefs: [redactedEntityRef(
        'orca-unreadable-field',
        [f.subject, f.id, f.field, f.reason].join('\u0000'),
      )],
      counts: { unreadableFields: 1 },
    };
  }
  return {
    kind: 'unreadable_field',
    detail: `${f.subject} ${f.id}의 ${f.field}를 읽지 못했다: ${f.reason}`,
  };
}

function redactedSourceFailure(row: RunDegraded): RunDegraded {
  return {
    kind: row.kind,
    detail: 'Orca Run 원천 조회가 실패했다',
    entityRefs: [redactedEntityRef('orca-run-source-failure', row.detail)],
    counts: { failedSources: 1 },
  };
}

/**
 * 읽지 못한 칸의 표시 순서. **입력 순서에 tie를 남기지 않는 total order다.**
 *
 * `askThreadsFrom`이 주는 목록은 Orca `inbox`의 행 순서를 그대로 물려받는다. 그 순서로 degraded를
 * 그리면 Orca 정렬이 바뀔 때 카드의 degraded 절이 뒤바뀌어 지문이 흔들린다. Run 목록과 blocker
 * entry에 건 것과 같은 규율이다.
 */
function byUnreadableField(a: UnreadableField, b: UnreadableField): number {
  const key = (f: UnreadableField): string =>
    [f.subject, f.id, f.field, f.reason].join('\u0000');
  const [x, y] = [key(a), key(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** id 오름차순. Orca 조회 출력 순서가 카드에 새지 않게 원천에서 고정한다. */
function byId<T>(pick: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const [x, y] = [pick(a), pick(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

async function readRunSources(
  orca: OrcaRunner,
  run: OrcaRun,
  gateStore: GateStore | undefined,
): Promise<RunSources> {
  // legacy Run은 읽기 전용 placeholder다. Task/Gate 조회를 시도하지 않는다(snapshot.ts와 같다).
  if (run.legacy) {
    return {
      tasks: [],
      taskCount: 0,
      gates: [],
      gateMetadata: [],
      workers: [],
      agentWaits: [],
      degraded: [],
      unreadable: [],
      repositoryIdentityReliable: true,
    };
  }
  const degraded: RunDegraded[] = [];
  let tasks: readonly OrcaTask[] = [];
  let taskCount = 0;
  let repositoryIdentityReliable = true;
  try {
    const page = await listTaskPage(orca, run.id);
    // 원천 행의 순서를 여기서 고정한다. `unreadableTaskFields`·`unreadableGateFields`와 아래
    // worker-show 실패가 이 순서 그대로 degraded 줄이 되고, 그 줄들이 카드에 그려진다. Orca
    // 정렬이 바뀌면 사실이 그대로여도 지문이 흔들려 `publish.ts`의 `skip`이 발화하지 않는다.
    // 집계(`aggregateTasks`·`aggregateDispatches`)와 badge 순서는 이 순서에 의존하지 않는다.
    tasks = [...page.tasks].sort(byId((t) => t.id));
    taskCount = page.count;
    repositoryIdentityReliable = page.repositoryEvidenceComplete;
  } catch (e) {
    repositoryIdentityReliable = false;
    degraded.push({ kind: 'query_failed', detail: `task-list 실패: ${message(e)}` });
  }
  let gates: readonly OrcaGate[] = [];
  try {
    gates = [...(await listGates(orca, run.id))].sort(byId((g) => g.id));
  } catch (e) {
    degraded.push({ kind: 'query_failed', detail: `gate-list 실패: ${message(e)}` });
  }
  let gateMetadata: readonly GateMetadata[] = [];
  if (gateStore !== undefined) {
    try {
      gateMetadata = gateStore.listGateMetadata(runKey(run.id));
    } catch (e) {
      if (e instanceof OperationalStoreError) throw e;
      degraded.push({
        kind: 'query_failed',
        detail: `gate_metadata 조회 실패: ${message(e)}`,
      });
    }
  }
  let workers: readonly OrcaWorker[] = [];
  try {
    const page = await listWorkerPage(orca, run.id);
    workers = [...page.workers].sort(byId((w) => w.dispatchId));
    repositoryIdentityReliable = repositoryIdentityReliable && page.repositoryEvidenceComplete;
  } catch (e) {
    repositoryIdentityReliable = false;
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
    gateMetadata,
    workers,
    agentWaits,
    degraded,
    unreadable: [...unreadableTaskFields(tasks), ...unreadableGateFields(gates)],
    repositoryIdentityReliable: repositoryIdentityReliable &&
      !tasks.some((task) => task.repositoryIdReadability === 'unreadable') &&
      !workers.some((worker) => worker.repositoryIdReadability === 'unreadable'),
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
  config: RunRoutingConfig,
): RunFacts {
  const identity = runIdentity(run, sources.tasks);
  const repositoryIds = observedRepositoryIds(sources);
  const effective = isEffectiveBridgeConfig(config);
  const base = effective ? config.base : config;
  const matched: string[] = [];
  const routeBlocks = new Set<string>();
  let remoteUnverified = false;
  if (effective) {
    if (config.routing.status === 'blocked') routeBlocks.add(config.routing.reason);
    for (const id of repositoryIds) {
      const rows = config.bindings.filter((binding) => binding.orcaRepositoryIds.includes(id));
      if (rows.length !== 1) {
        routeBlocks.add(rows.length === 0 ? 'unregistered_repository' : 'binding_conflict');
        continue;
      }
      const binding = rows[0]!;
      if (binding.status === 'blocked') {
        routeBlocks.add(binding.reason);
        continue;
      }
      const targetProject = config.projects.find((project) => project.key === binding.projectKey);
      if (targetProject === undefined ||
          (binding.verification === 'github_verified' &&
           (binding.identity === null || binding.githubRepositoryId === null)) ||
          (binding.identity !== null && !targetProject.repositories.some((repository) =>
            repository.canonicalKey === binding.identity?.canonicalKey))) {
        routeBlocks.add('project_conflict');
        continue;
      }
      matched.push(binding.projectKey);
      if (binding.verification === 'remote_unverified') remoteUnverified = true;
    }
    if (sources.repositoryIdentityReliable === false) {
      routeBlocks.add('repository_identity_unreadable');
    }
  } else {
    for (const id of repositoryIds) {
      for (const project of base.projects) {
        if (project.orcaRepositoryIds.includes(id)) matched.push(project.name);
      }
    }
  }
  const consensus = [...new Set(matched)].sort();
  if (effective && consensus.length > 1) routeBlocks.add('project_conflict');
  const complete = repositoryIds.length > 0 && matched.length === repositoryIds.length;
  const project = routeBlocks.size === 0 && complete && consensus.length === 1
    ? consensus[0]!
    : null;
  const repositories = project === null
    ? []
    : effective
      ? (config.projects.find((p) => p.key === project)?.repositories.map((r) => r.nameWithOwner) ?? [])
      : (base.projects.find((p) => p.name === project)?.repositories ?? []);

  const degraded: RunDegraded[] = [
    ...(effective ? sources.degraded.map(redactedSourceFailure) : sources.degraded),
    ...sources.unreadable.map((field) => unreadableDegraded(field, effective)),
  ];
  if (repositoryIds.length === 0) {
    if (effective && sources.repositoryIdentityReliable === false) {
      degraded.push({
        kind: 'repository_identity_unreadable',
        detail: 'repository 근거는 있었지만 그 identity를 읽지 못했다',
        counts: { observedRepositories: 0, blockingReasons: 1 },
      });
    } else {
      // 원인이 둘이다. 조회가 실패했으면 "관측할 것이 없었다"가 아니라 "관측하지 못했다"이고,
      // 그 차이가 아래 등록 판정을 신뢰할 수 있는지를 가른다(OD-078의 완화 장치가 여기 걸린다).
      const failed = sources.degraded.some((d) => d.kind === 'query_failed');
      degraded.push({
        kind: 'repository_unobservable',
        detail: failed
          ? 'Orca 조회가 실패해 repository id를 관측하지 못했다. 등록 여부를 판정할 수 없다'
          : 'Task도 worker도 없어 Orca repository id를 관측하지 못했다',
        ...(effective ? {
          counts: { observedRepositories: 0, resolvedProjects: 0, blockingReasons: 1 },
        } : {}),
      });
    }
  } else if (effective && project === null) {
    const kinds = [...routeBlocks].sort();
    degraded.push({
      kind: routeBlocks.has('repository_identity_unreadable')
        ? 'repository_identity_unreadable'
        : 'repository_route_blocked',
      detail: '관측된 repository id로 Project 하나를 확정하지 못해 route하지 않았다',
      entityRefs: repositoryIds.map((id) => redactedEntityRef('orca-repository', id)),
      counts: {
        observedRepositories: repositoryIds.length,
        resolvedProjects: consensus.length,
        blockingReasons: kinds.length,
      },
    });
  } else if (project === null && consensus.length <= 1) {
    degraded.push({
      kind: 'unregistered_repository',
      detail:
        `관측된 Orca repository id가 설정에 없다: ${repositoryIds.join(', ')}. ` +
        'projects[].orcaRepositoryIds에 등록해야 이 Run이 표시 대상이 된다(OD-078)',
    });
  } else if (project === null && consensus.length > 1) {
    degraded.push({
      kind: 'multiple_project_match',
      detail: '관측된 repository id가 여러 Project에 걸쳐 있어 어느 쪽으로도 route하지 않았다',
      counts: { observedRepositories: repositoryIds.length, resolvedProjects: consensus.length },
    });
  }
  if (effective && project !== null && remoteUnverified) {
    degraded.push({
      kind: 'remote_unverified_repository',
      detail: '수동 등록한 repository identity가 확인된 live remote 없이 쓰이고 있다',
      entityRefs: repositoryIds.map((id) => redactedEntityRef('orca-repository', id)),
      counts: { observedRepositories: repositoryIds.length },
    });
  }
  if (identity.liveness === 'unknown') {
    degraded.push({
      kind: 'liveness_unknown',
      detail:
        identity.observed.length === 0
          ? 'Task가 없어 Run row와 대조할 binding이 없다'
          : run.consumerGeneration.kind === 'unreadable'
            ? 'Run row의 generation을 읽지 못해 관측된 binding과 대조할 수 없다'
            : `관측된 binding이 Run row(generation ${run.consumerGeneration.value})와 어긋난다`,
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
    gates: projectGateDecisions(sources.gates, sources.tasks, sources.gateMetadata),
    degraded,
  };
}

/**
 * Run 목록의 순서. **입력 순서에 tie를 남기지 않는 total order다.**
 *
 * `(updatedAt DESC, createdAt DESC, runId ASC)`. Orca `run-list`의 출력 순서에 기대면 그 정렬이 바뀔 때 미등록
 * 목록의 상위 ENTRY_CAP건과 run-row degraded 줄의 순서가 관찰마다 뒤바뀌고, 사실이 그대로여도
 * 렌더 지문이 흔들려 `publish.ts`의 `skip`이 컬렉션 카드와 모든 Run 카드에서 발화하지 않는다.
 * `sqlite.ts`의 `SELECT_RUN_PULL_REQUESTS`가 `ORDER BY`로 같은 것을 막는다.
 *
 * **최신성 키가 `runId`보다 먼저인 이유.** `runId`는 최신성과 무관해서 상위 ENTRY_CAP건이
 * 임의-안정 부분집합이 된다. 실측(2026-08-24, 미등록 18건)에서 id 순 상위 5건이 폐기용 probe Run을
 * 싣고 그날 만들어진 Run을 밀어냈다. 지문은 안정됐지만 사람이 보는 5건이 무의미해진 것이다.
 * `runId`는 tie만 깬다 — 두 키를 합치면 여전히 total order라 지문 안정성은 그대로다.
 *
 * **문자열 비교를 쓰지 않는다.** `parseOrcaTimestamp`가 받는 형식이 둘이고(`2026-08-21T14:32:45Z`와
 * 타임존 없는 `2026-08-21 14:32:45`), 한 응답에 섞여 나온 것이 실측이다. 문자열 비교는 `' ' < 'T'`
 * 때문에 실제 시각과 무관하게 후자를 앞세운다. 파싱된 `Date`의 epoch로 비교한다.
 *
 * 두 시각 중 하나라도 읽을 수 없거나 updatedAt이 createdAt보다 이르면 working set 자체를
 * 증명할 수 없으므로 pass를 실패시킨다. 불완전한 행을 뒤로 미는 것은 deterministic처럼 보여도
 * 최신 64건이라는 주장을 뒷받침하지 못한다.
 */
function byRunRecency(a: OrcaRun, b: OrcaRun): number {
  const [updatedA, updatedB] = [a.updatedAt.getTime(), b.updatedAt.getTime()];
  if (updatedA !== updatedB) return updatedA > updatedB ? -1 : 1;
  const [createdA, createdB] = [a.createdAt.getTime(), b.createdAt.getTime()];
  if (createdA !== createdB) return createdA > createdB ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function validateRunWorkingSet(runs: readonly OrcaRun[]): void {
  if (runs.length > RUN_LIST_HARD_LIMIT) {
    throw new RunCollectionContractError('RUN_LIST_HARD_LIMIT');
  }
  const ids = new Set<string>();
  for (const run of runs) {
    const created = run.createdAt.getTime();
    const updated = run.updatedAt.getTime();
    if (run.id.trim() === '' || run.id !== run.id.trim() || ids.has(run.id) ||
        !Number.isFinite(created) || !Number.isFinite(updated) || updated < created) {
      throw new RunCollectionContractError('RUN_ORDERING_UNRELIABLE');
    }
    ids.add(run.id);
  }
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
  config: RunRoutingConfig,
  options: CollectOptions = {},
): Promise<RunCollection> {
  const now = options.now ?? (() => new Date());
  const observedAt = now();
  if (!Number.isFinite(observedAt.getTime())) {
    throw new RunCollectionContractError('RUN_ORDERING_UNRELIABLE');
  }
  let listedRuns: readonly OrcaRun[];
  try {
    listedRuns = await listRuns(orca);
  } catch (error) {
    // Transport/process failures remain retryable daemon outages. JSON/envelope/row-shape failures
    // are contract drift and must retain their typed fatal boundary.
    if (!(error instanceof TypeError) && !(error instanceof SyntaxError) &&
        !(error instanceof RangeError)) throw error;
    throw new RunCollectionContractError('RUN_ORDERING_UNRELIABLE');
  }
  validateRunWorkingSet(listedRuns);
  const orderedRuns = [...listedRuns].sort(byRunRecency);
  const effective = isEffectiveBridgeConfig(config);
  const base = effective ? config.base : config;
  const runLimit = base.automation?.capacity.runsPerPass ??
    DEFAULT_AUTOMATION_CONFIG.capacity.runsPerPass;
  const runs = orderedRuns.slice(0, runLimit);
  const deferredRuns = orderedRuns.slice(runLimit);

  const degraded: RunDegraded[] = [
    {
      kind: 'unverified_platform_assumption',
      detail:
        'live/stale 판정은 run-use가 consumer_generation을 올린다는 미검증 가정 위에 있다' +
        '(docs/platform-capabilities.md §7.2). 플랫폼 동작이 바뀌면 이 판정이 깨진다',
    },
  ];

  if (deferredRuns.length > 0) {
    const oldestUpdated = Math.min(...deferredRuns.map((run) => run.updatedAt.getTime()));
    degraded.push({
      kind: 'capacity_deferred',
      detail:
        `Run 수 상한에 걸려 ${orderedRuns.length}건 중 ${deferredRuns.length}건을 이번 관찰에서 ` +
        `미뤘다. 가장 오래 미뤄진 Run은 ${Math.max(0, Math.floor(
          (observedAt.getTime() - oldestUpdated) / 1_000,
        ))}초 전 갱신됐다`,
      counts: {
        totalRuns: orderedRuns.length,
        deferredRuns: deferredRuns.length,
        oldestDeferredAgeSeconds: Math.max(0, Math.floor(
          (observedAt.getTime() - oldestUpdated) / 1_000,
        )),
      },
    });
  }

  // Run row의 세대를 읽지 못한 것은 Run 하나가 아니라 관찰의 사실이다. 그 Run의 live/stale이
  // `unknown`으로 접히는 이유가 여기 남는다(OD-079).
  for (const f of unreadableRunFields(runs)) degraded.push(unreadableDegraded(f, effective));

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
    degraded.push(effective ? {
      kind: 'query_failed',
      detail: 'Orca inbox 조회가 실패해 ask와 escalation 사실을 얻지 못했다',
      entityRefs: [redactedEntityRef('orca-inbox-failure', message(e))],
      counts: { failedSources: 1 },
    } : {
      kind: 'query_failed',
      detail: `inbox 실패: ${message(e)}. ask와 escalation badge가 없다`,
    });
  }
  for (const f of [...askInbox.unreadable].sort(byUnreadableField)) {
    degraded.push(unreadableDegraded(f, effective));
  }
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
    const projected = projectRun(
      run,
      await readRunSources(orca, run, options.gateStore),
      askInbox,
      config,
    );
    if (projected.project === null) {
      // degraded를 함께 싣는다. 이것이 없으면 조회에 실패한 Run이 미등록으로 둔갑해 OD-078의
      // 완화 장치가 다른 사건을 센다.
      unregisteredRuns.push({
        runId: effective ? '' : run.id,
        repositoryIds: effective ? [] : projected.observedRepositoryIds,
        ...(effective ? {
          runRef: redactedEntityRef('orca-run', run.id),
          repositoryRefs: projected.observedRepositoryIds.map((id) =>
            redactedEntityRef('orca-repository', id)),
        } : {}),
        degraded: projected.degraded,
      });
      continue;
    }
    facts.push(projected);
  }

  const unregistered: UnregisteredRuns = { count: unregisteredRuns.length, runs: unregisteredRuns };
  return { observedAt: observedAt.toISOString(), runs: facts, unregistered, degraded };
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
    const identities = u.repositoryRefs ?? u.repositoryIds;
    const label = u.repositoryRefs === undefined ? 'repoIds' : 'repoRefs';
    lines.push(`  ${u.runRef ?? u.runId}  ${label}=${identities.join(',') || '관측 없음'}`);
    // 여기를 비우면 "조회했더니 등록에 없다"와 "조회가 실패해 판정할 수 없다"가 같은 줄이 된다.
    for (const d of u.degraded) lines.push(`    degraded   ${d.kind}  ${d.detail}`);
  }
  lines.push('');
  for (const d of c.degraded) lines.push(`degraded  ${d.kind}  ${d.detail}`);
  return lines.join('\n');
}
