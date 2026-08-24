import type {
  OrcaAgentWait,
  OrcaAsk,
  OrcaEscalation,
  OrcaGate,
  OrcaTask,
  OrcaWorker,
} from '../orca/client.js';
import type {
  BlockerBadge,
  BlockerEntry,
  BlockerFacts,
  BlockerSource,
  DispatchAttempts,
  StatusCount,
  TaskAggregate,
} from './types.js';

/**
 * Task·Dispatch 집계와 blocker taxonomy(OD-069, OD-067).
 *
 * 이 파일에 나눗셈이 없다. 확인 방법: `/` 연산자와 `percent`·`rate`·`ratio`·`progress`를 검색해
 * 하나도 나오지 않아야 한다. `test/run-facts.test.ts`가 그 성질을 고정한다.
 */

function countByStatus(rows: readonly { readonly status: string }[]): StatusCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  // 같은 입력이 같은 목록을 내야 카드가 흔들리지 않는다. 수 내림차순, 같으면 이름 사전순.
  return [...counts]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => (b.count === a.count ? a.status.localeCompare(b.status) : b.count - a.count));
}

/**
 * Task 집계(OD-069).
 *
 * `total`은 `task-list.result.count`다. **행 수로 대체하지 않는다.** 두 값은 보통 같지만
 * count가 원천이 말하는 분모이고, 행이 잘리는 조회 계약이 생기면 행 수가 조용히 작아진다.
 *
 * 실행 중 추가된 Task는 다음 관찰의 `count`에 그대로 들어온다. 시작 시점 값을 어디에도
 * 저장하지 않으므로 분모가 고정될 자리가 없다.
 *
 * @param count `task-list.result.count`. 조회가 주지 않으면 호출자가 행 수를 넘긴다.
 */
export function aggregateTasks(tasks: readonly OrcaTask[], count: number): TaskAggregate {
  return { total: count, byStatus: countByStatus(tasks) };
}

/**
 * Dispatch attempt 이력(OD-069).
 *
 * Task 집계와 **분리한다.** retry Dispatch는 같은 Task ID를 다시 쓰므로 여기 수를 분모에 더하면
 * 같은 작업을 여러 번 센다.
 */
export function aggregateDispatches(workers: readonly OrcaWorker[]): DispatchAttempts {
  const perTask = new Map<string, number>();
  for (const w of workers) perTask.set(w.taskId, (perTask.get(w.taskId) ?? 0) + 1);
  return {
    total: workers.length,
    byStatus: countByStatus(workers.map((w) => ({ status: w.dispatchStatus }))),
    retriedTasks: [...perTask.values()].filter((n) => n > 1).length,
  };
}

/**
 * badge 표시 순서. 원천마다 성격이 달라 수로 정렬하지 않는다 — 순서가 흔들리면 같은 Run의
 * 카드가 관찰마다 다르게 읽힌다.
 */
const BLOCKER_ORDER: readonly BlockerSource[] = [
  'openGate',
  'blockedTask',
  'waitingDependency',
  'workerAsk',
  'escalation',
  'failedDispatch',
  'interactionWait',
];

/** Dispatch가 진행 중이거나 끝난 상태. 나머지는 전부 실패 badge로 간다. */
const HEALTHY_DISPATCH: ReadonlySet<string> = new Set(['completed', 'dispatched']);

export type BlockerInput = {
  readonly tasks: readonly OrcaTask[];
  readonly gates: readonly OrcaGate[];
  readonly workers: readonly OrcaWorker[];
  /** 이 Run의 ask만. 답변이 관측되지 않은 것만 badge가 된다. */
  readonly asks: readonly OrcaAsk[];
  readonly escalations: readonly OrcaEscalation[];
  /** 활성 Dispatch에서 관측된 agent 대기. 없으면 빈 배열. */
  readonly agentWaits: readonly { readonly worker: OrcaWorker; readonly wait: OrcaAgentWait }[];
};

/**
 * badge 안의 entry 순서. **입력 순서에 tie를 남기지 않는 total order다.**
 *
 * entry는 Orca `task-list`·`gate-list`·`worker-list`·`inbox`가 준 순서 그대로 쌓인다. 그 순서에
 * 기대면 Orca 정렬이 바뀔 때 `render.ts`가 싣는 상위 ENTRY_CAP건과 그 나열이 관찰마다 뒤바뀌고,
 * 사실이 그대로여도 렌더 지문이 흔들려 `publish.ts`의 `skip`이 발화하지 않는다. `collect.ts`가
 * Run 목록에, `sqlite.ts`의 `SELECT_RUN_PULL_REQUESTS`가 PR 목록에 거는 것과 같은 규율이다.
 *
 * **`detail`까지 키에 넣는다.** 앞의 네 ID가 모두 같은 두 entry가 생기면 그 tie가 입력 순서로
 * 갈리고, 그러면 이 함수가 막으려던 것이 그 자리에 그대로 남는다.
 *
 * **이 순서는 우선순위가 아니다.** ID 순이라 심각도 순도 최신순도 아니다. `render.ts`가 싣는 상위
 * ENTRY_CAP건은 그래서 임의-안정 부분집합이다 — 관찰마다 같다는 것만 말하고, 그 badge에서 가장
 * 급한 것이라고는 말하지 않는다.
 *
 * **완전성은 상위 ENTRY_CAP건이 아니라 badge의 수와 "외 N건" 줄이 진다.** 카드에 실린 목록에서
 * 무엇이 빠졌는지 읽으려 하지 말고 그 둘을 봐라.
 *
 * **시간순 키를 쓰지 않은 이유.** entry의 원천은 넷(`task-list`·`gate-list`·`worker-list`·`inbox`)
 * 이고 `worker-list` 행에는 timestamp가 없다. 없는 사실로 시간순을 만들 수 없으므로 네 원천의
 * 공통 total key는 ID뿐이다. 원천마다 다른 키를 쓰면 한 badge 안에서 원천 간 순서가 다시 입력
 * 순서에 걸려 지문이 흔들린다. `collect.ts`의 Run 목록이 `createdAt`을 1차 키로 쓰는 것은 그
 * 원천(`run-list`)이 하나고 그 행에 `created_at`이 있기 때문이다 — 정렬 키는 원천마다 다르다.
 *
 * **심각도 순으로 바꾸지 않는다.** OD-067이 원천들을 같은 개념으로 취급하지 않기로 확정했고 고유
 * 총합도 금지했다. 원천을 가로지르는 심각도 서열은 그 결정을 우회한다.
 */
function byEntryKey(a: BlockerEntry, b: BlockerEntry): number {
  const key = (e: BlockerEntry): string =>
    [e.taskId ?? '', e.dispatchId ?? '', e.gateId ?? '', e.messageId ?? '', e.detail].join('\u0000');
  const [x, y] = [key(a), key(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

function entry(e: Partial<BlockerEntry> & { readonly detail: string }): BlockerEntry {
  return {
    taskId: e.taskId ?? null,
    dispatchId: e.dispatchId ?? null,
    gateId: e.gateId ?? null,
    messageId: e.messageId ?? null,
    detail: e.detail,
  };
}

/**
 * blocker taxonomy(OD-067).
 *
 * 원천별로 별도 badge를 만들고 각 항목에 `taskId`·`dispatchId`·Gate ID·message ID를 함께 싣는다.
 *
 * **고유 총합을 만들지 않는다.** 실측에서 open Gate와 blocked Task가 같은 사건을, ask와
 * escalation과 dispatched Task가 같은 Task/Dispatch를 중복 표현했다. 신호 집합이 배타적이지
 * 않으므로 더하면 한 blocker가 여러 번 셈된다. dedup 정책이 확정된 뒤에 추가한다.
 *
 * `interactionWait`를 permission이라고 부르지 않는다. 실측 `reason`은 permission 전용 enum이
 * 아니라 `codex-interactive-prompt`였다.
 *
 * `CI failure`는 taxonomy 항목이지만 여기서 만들지 않는다. Orca schema에 CI 전용 상태나 필드가
 * 없다는 것이 실측이다. 0건 badge로 그리면 "CI 실패 없음"이라는 거짓을 말하므로
 * `notObservable`에 관측 불가로 싣는다.
 */
export function aggregateBlockers(input: BlockerInput): BlockerFacts {
  const bySource = new Map<BlockerSource, BlockerEntry[]>();
  const push = (source: BlockerSource, e: BlockerEntry): void => {
    const found = bySource.get(source);
    if (found === undefined) bySource.set(source, [e]);
    else found.push(e);
  };

  for (const g of input.gates) {
    if (g.status !== 'pending') continue;
    push('openGate', entry({ gateId: g.id, taskId: g.taskId, detail: g.question }));
  }
  for (const t of input.tasks) {
    if (t.status === 'blocked') {
      push('blockedTask', entry({ taskId: t.id, detail: t.title }));
    } else if (t.status === 'pending') {
      // 의존성이 남아 아직 ready가 아닌 상태다. 실측에서 root 완료 뒤 자동으로 ready가 됐다.
      // `deps`를 읽지 못한 row도 badge에서 빼지 않는다. pending이라는 사실은 `status` 칸에서
      // 왔고 그 칸은 읽혔다. 읽지 못한 것은 detail에 그렇게 적는다(OD-079).
      const deps =
        t.deps.kind === 'unreadable' ? '읽지 못함' : t.deps.value.join(', ') || '없음';
      push('waitingDependency', entry({ taskId: t.id, detail: `${t.title} (deps: ${deps})` }));
    }
  }
  for (const a of input.asks) {
    if (a.answered) continue;
    push('workerAsk', entry({ messageId: a.messageId, taskId: a.taskId, dispatchId: a.dispatchId, detail: a.subject }));
  }
  for (const e of input.escalations) {
    push('escalation', entry({ messageId: e.messageId, taskId: e.taskId, dispatchId: e.dispatchId, detail: e.subject }));
  }
  for (const w of input.workers) {
    if (HEALTHY_DISPATCH.has(w.dispatchStatus)) continue;
    push('failedDispatch', entry({ dispatchId: w.dispatchId, taskId: w.taskId, detail: w.dispatchStatus }));
  }
  for (const { worker, wait } of input.agentWaits) {
    push(
      'interactionWait',
      entry({
        dispatchId: worker.dispatchId,
        taskId: worker.taskId,
        detail: `${wait.source}: ${wait.reason}`,
      }),
    );
  }

  const badges: BlockerBadge[] = [];
  for (const source of BLOCKER_ORDER) {
    const entries = bySource.get(source);
    if (entries === undefined || entries.length === 0) continue;
    badges.push({ source, count: entries.length, entries: [...entries].sort(byEntryKey) });
  }
  return {
    badges,
    notObservable: [
      {
        source: 'ciFailure',
        reason:
          'Orca Task/Gate/Dispatch/message schema에 CI 전용 상태나 필드가 없다' +
          '(docs/evidence/t3-orca-gate-and-aggregation.md §(b)). GitHub 축을 조인하는 쪽이 채운다',
      },
    ],
  };
}
