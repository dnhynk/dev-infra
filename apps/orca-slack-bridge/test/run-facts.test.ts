import { describe, expect, it } from 'vitest';
import { collectRunFacts, formatRunCollection } from '../src/run/collect.js';
import { aggregateBlockers, aggregateDispatches, aggregateTasks } from '../src/run/aggregate.js';
import { classifyBinding, runIdentity } from '../src/run/liveness.js';
import type { OrcaRun, OrcaRunner, OrcaTask, OrcaWorker, Read } from '../src/orca/client.js';
import { askThreadsFrom, listWorkers, readInbox } from '../src/orca/client.js';
import { DEFAULT_CORRELATION_KEYS, type BridgeConfig } from '../src/project/config.js';
import { renderRunCard, renderRunCollectionCard } from '../src/run/render.js';
import { renderFingerprint } from '../src/digest/render.js';
import type { RunCollection, RunFacts } from '../src/run/types.js';

/**
 * D1-A Run 사실 집계.
 *
 * 확정 계약 넷을 고정한다.
 * - OD-069 분모는 현재 `task-list.count`이고 실행 중 추가를 즉시 반영한다. 완료율·비율은 없다.
 * - OD-069 retry Dispatch는 Task 수를 늘리지 않는다.
 * - OD-067 blocker는 원천별 badge이고 correlation ID를 함께 싣는다. 고유 총합은 없다.
 * - OD-020 live/stale은 `consumer_generation`으로 갈린다.
 * - OD-078 등록되지 않은 repository의 Run은 표시 대상이 아니고, 조용히 사라지지도 않는다.
 */

/** 읽은 칸 하나로 감싼다. OD-079 이후 봉쇄 대상 칸이 `Read<T>`다. */
function ok<T>(value: T): Read<T> {
  return { kind: 'value', value };
}

const REPO_ID = 'ccb3c8ee-6d9e-42af-af36-9fdac6566fcc';
const OTHER_REPO_ID = '0409601c-4119-4b29-ae29-e814b8853e11';

const CONFIG: BridgeConfig = {
  slack: null,
  projects: [
    { name: 'dev-infra', repositories: ['dnhynk/dev-infra'], orcaRepositoryIds: [REPO_ID] },
  ],
  correlationKeys: DEFAULT_CORRELATION_KEYS,
};

function run(over: Partial<OrcaRun> = {}): OrcaRun {
  return {
    id: 'run_1',
    objective: 'demo',
    coordinatorHandle: 'term_now',
    coordinatorPaneKey: 'pane:now',
    consumerGeneration: ok(2),
    legacy: false,
    createdAt: new Date('2026-08-23T00:00:00Z'),
    updatedAt: new Date('2026-08-23T00:00:00Z'),
    ...over,
  };
}

function task(over: Partial<OrcaTask> = {}): OrcaTask {
  return {
    id: 'task_1',
    runId: 'run_1',
    title: 't',
    status: 'ready',
    deps: ok([]),
    result: ok(null),
    worktreePath: 'D:/dev-infra',
    repositoryId: REPO_ID,
    createdBy: ok({ handle: 'term_now', paneKey: 'pane:now', generation: 2 }),
    createdAt: new Date('2026-08-23T00:00:00Z'),
    completedAt: null,
    ...over,
  };
}

function worker(over: Partial<OrcaWorker> = {}): OrcaWorker {
  return {
    dispatchId: 'ctx_1',
    taskId: 'task_1',
    runId: 'run_1',
    dispatchStatus: 'completed',
    repositoryId: REPO_ID,
    ...over,
  };
}

describe('Task 집계 (OD-069)', () => {
  it('분모는 현재 task-list.count이고 실행 중 추가를 즉시 반영한다', () => {
    const before = aggregateTasks([task({ id: 'task_1' })], 1);
    expect(before.total).toBe(1);

    // 실측(t3 §(c)): 실행 중 Task 두 개를 추가하자 count가 1 -> 3이 됐다.
    const after = aggregateTasks(
      [
        task({ id: 'task_1' }),
        task({ id: 'task_2', status: 'ready' }),
        task({ id: 'task_3', status: 'pending' }),
      ],
      3,
    );
    expect(after.total).toBe(3);
    expect(after.byStatus).toEqual([
      { status: 'ready', count: 2 },
      { status: 'pending', count: 1 },
    ]);
  });

  it('count가 행 수와 다르면 count를 쓴다', () => {
    expect(aggregateTasks([task()], 9).total).toBe(9);
  });

  it('Orca가 주지 않은 cancelled 상태를 만들지 않는다', () => {
    const a = aggregateTasks([task({ status: 'failed' }), task({ id: 'x', status: 'blocked' })], 2);
    expect(a.byStatus.map((s) => s.status)).not.toContain('cancelled');
  });
});

describe('Dispatch attempts (OD-069)', () => {
  it('retry Dispatch가 Task 수를 늘리지 않는다. attempt만 는다', () => {
    // 실측(t3 §(c)): 한 Task의 네 실패와 다섯 번째 성공은 Task 한 행 + Dispatch 다섯 행이었다.
    const tasks = [task({ id: 'task_9d8d', status: 'completed' })];
    const workers = [
      worker({ dispatchId: 'ctx_3dbd', taskId: 'task_9d8d', dispatchStatus: 'failed' }),
      worker({ dispatchId: 'ctx_4fdb', taskId: 'task_9d8d', dispatchStatus: 'failed' }),
      worker({ dispatchId: 'ctx_51a5', taskId: 'task_9d8d', dispatchStatus: 'failed' }),
      worker({ dispatchId: 'ctx_c8c3', taskId: 'task_9d8d', dispatchStatus: 'failed' }),
      worker({ dispatchId: 'ctx_5a60', taskId: 'task_9d8d', dispatchStatus: 'completed' }),
    ];
    const tasksAgg = aggregateTasks(tasks, 1);
    const dispatches = aggregateDispatches(workers);

    expect(tasksAgg.total).toBe(1);
    expect(tasksAgg.byStatus).toEqual([{ status: 'completed', count: 1 }]);
    expect(dispatches.total).toBe(5);
    expect(dispatches.retriedTasks).toBe(1);
    expect(dispatches.byStatus).toEqual([
      { status: 'failed', count: 4 },
      { status: 'completed', count: 1 },
    ]);
  });

  it('Task마다 Dispatch가 하나면 retriedTasks가 0이다', () => {
    const d = aggregateDispatches([
      worker({ dispatchId: 'ctx_a', taskId: 'task_a' }),
      worker({ dispatchId: 'ctx_b', taskId: 'task_b' }),
    ]);
    expect(d.total).toBe(2);
    expect(d.retriedTasks).toBe(0);
  });
});

describe('blocker taxonomy (OD-067)', () => {
  const gate = {
    id: 'gate_1',
    runId: 'run_1',
    taskId: 'task_blocked',
    question: 'q',
    options: ok([]),
    status: 'pending',
    resolution: null,
    createdAt: new Date('2026-08-23T00:00:00Z'),
    resolvedAt: null,
  };

  const facts = aggregateBlockers({
    tasks: [
      task({ id: 'task_blocked', status: 'blocked' }),
      task({ id: 'task_pending', status: 'pending', deps: ok(['task_blocked']) }),
      task({ id: 'task_dispatched', status: 'dispatched' }),
    ],
    gates: [gate],
    workers: [
      worker({ dispatchId: 'ctx_ok', taskId: 'task_dispatched', dispatchStatus: 'dispatched' }),
      worker({ dispatchId: 'ctx_cb', taskId: 'task_cb', dispatchStatus: 'circuit_broken' }),
    ],
    asks: [
      {
        messageId: 'msg_open',
        runId: 'run_1',
        taskId: 'task_dispatched',
        dispatchId: 'ctx_ok',
        subject: 'Question',
        createdAt: new Date('2026-08-23T00:00:00Z'),
        answered: false,
      },
      {
        messageId: 'msg_answered',
        runId: 'run_1',
        taskId: 'task_dispatched',
        dispatchId: 'ctx_ok',
        subject: 'Question',
        createdAt: new Date('2026-08-23T00:00:00Z'),
        answered: true,
      },
    ],
    escalations: [
      {
        messageId: 'msg_esc',
        runId: 'run_1',
        taskId: 'task_dispatched',
        dispatchId: 'ctx_ok',
        subject: 'Blocked',
        createdAt: new Date('2026-08-23T00:00:00Z'),
      },
    ],
    agentWaits: [
      {
        worker: worker({ dispatchId: 'ctx_ok', taskId: 'task_dispatched' }),
        wait: { source: 'prompt-text', reason: 'codex-interactive-prompt' },
      },
    ],
  });

  it('원천이 서로 다른 badge로 나온다', () => {
    expect(facts.badges.map((b) => [b.source, b.count])).toEqual([
      ['openGate', 1],
      ['blockedTask', 1],
      ['waitingDependency', 1],
      ['workerAsk', 1],
      ['escalation', 1],
      ['failedDispatch', 1],
      ['interactionWait', 1],
    ]);
  });

  it('open Gate와 blocked Task를 한 badge로 합치지 않는다', () => {
    // 실측(t3 §(b)): gate-create가 같은 Task를 blocked로 바꿨다. 합치면 한 blocker를 두 번 센다.
    const openGate = facts.badges.find((b) => b.source === 'openGate');
    const blocked = facts.badges.find((b) => b.source === 'blockedTask');
    expect(openGate?.entries[0]?.taskId).toBe('task_blocked');
    expect(blocked?.entries[0]?.taskId).toBe('task_blocked');
  });

  it('각 badge 항목이 correlation ID를 함께 싣는다', () => {
    const byId = new Map(facts.badges.map((b) => [b.source, b.entries[0]]));
    expect(byId.get('openGate')).toMatchObject({ gateId: 'gate_1', taskId: 'task_blocked' });
    expect(byId.get('blockedTask')).toMatchObject({ taskId: 'task_blocked' });
    expect(byId.get('waitingDependency')).toMatchObject({ taskId: 'task_pending' });
    expect(byId.get('workerAsk')).toMatchObject({
      messageId: 'msg_open',
      taskId: 'task_dispatched',
      dispatchId: 'ctx_ok',
    });
    expect(byId.get('escalation')).toMatchObject({
      messageId: 'msg_esc',
      dispatchId: 'ctx_ok',
    });
    expect(byId.get('failedDispatch')).toMatchObject({ dispatchId: 'ctx_cb', taskId: 'task_cb' });
    expect(byId.get('interactionWait')).toMatchObject({ dispatchId: 'ctx_ok' });
  });

  it('답변이 관측된 ask는 badge가 되지 않는다', () => {
    const ask = facts.badges.find((b) => b.source === 'workerAsk');
    expect(ask?.entries.map((e) => e.messageId)).toEqual(['msg_open']);
  });

  it('interaction 대기를 permission이라고 부르지 않는다', () => {
    const wait = facts.badges.find((b) => b.source === 'interactionWait');
    expect(wait?.entries[0]?.detail).toBe('prompt-text: codex-interactive-prompt');
    expect(JSON.stringify(facts)).not.toContain('permission');
  });

  it('CI failure를 0건 badge로 그리지 않고 관측 불가로 싣는다', () => {
    expect(facts.badges.map((b) => b.source)).not.toContain('ciFailure');
    expect(facts.notObservable.map((n) => n.source)).toEqual(['ciFailure']);
  });

  it('고유 blocker 총합이 없다', () => {
    expect(facts).not.toHaveProperty('total');
    expect(facts).not.toHaveProperty('unique');
    expect(facts).not.toHaveProperty('count');
    for (const key of Object.keys(facts)) expect(['badges', 'notObservable']).toContain(key);
  });

  it('원천이 하나도 없으면 badge가 비어 있다', () => {
    const none = aggregateBlockers({
      tasks: [task({ status: 'completed' })],
      gates: [],
      workers: [worker()],
      asks: [],
      escalations: [],
      agentWaits: [],
    });
    expect(none.badges).toEqual([]);
  });
});

describe('live/stale (OD-020)', () => {
  it('binding 수준에서는 consumer_generation이 live와 stale을 가른다', () => {
    const binding = { handle: 'term_first', paneKey: 'pane:first', generation: 1 };

    // 아직 인수되지 않은 Run. Run row가 이 binding을 현재 소유자로 말한다.
    const notHandedOver = run({
      id: 'run_live',
      coordinatorHandle: 'term_first',
      coordinatorPaneKey: 'pane:first',
      consumerGeneration: ok(1),
    });
    // 같은 binding이 만든 Task가 있지만 Run row는 이미 generation 2로 인수됐다.
    const handedOver = run({
      id: 'run_handed',
      coordinatorHandle: 'term_second',
      coordinatorPaneKey: 'pane:second',
      consumerGeneration: ok(2),
    });

    expect(classifyBinding(notHandedOver, binding)).toBe('live');
    expect(classifyBinding(handedOver, binding)).toBe('stale');
  });

  /**
   * run 수준 `stale`을 만들지 않는다.
   *
   * 이 상태를 만드는 것은 고장이 아니라 **정상 handoff**다. `run-use` 인수가
   * `consumer_generation`을 올린 직후 새 coordinator가 기존 ready task만 dispatch하면 새 세대가
   * 만든 task가 하나도 없다. 그 구간 내내 살아 있는 Run이 죽은 것으로 그려진다.
   */
  it('관측된 binding이 전부 낮은 세대여도 Run을 stale로 부르지 않는다', () => {
    const handedOver = run({
      coordinatorHandle: 'term_second',
      coordinatorPaneKey: 'pane:second',
      consumerGeneration: ok(2),
    });
    const tasks = [task({ createdBy: ok({ handle: 'term_first', paneKey: 'pane:first', generation: 1 }) })];

    const identity = runIdentity(handedOver, tasks);
    expect(identity.liveness).toBe('unknown');
    // binding 하나의 stale은 그대로 남는다. 세대 분포는 소비자가 그대로 본다.
    expect(identity.observed.map((o) => o.liveness)).toEqual(['stale']);
  });

  it('Run 수준 판정은 live 아니면 unknown 둘뿐이다', () => {
    const r = run({ coordinatorHandle: 'term_new', coordinatorPaneKey: 'pane:new', consumerGeneration: ok(2) });
    const cases: OrcaTask[][] = [
      [],
      [task({ createdBy: ok({ handle: 'term_old', paneKey: 'pane:old', generation: 1 }) })],
      [task({ createdBy: ok({ handle: 'term_x', paneKey: 'pane:new', generation: 2 }) })],
      [task({ createdBy: ok({ handle: 'term_new', paneKey: 'pane:new', generation: 9 }) })],
    ];
    for (const tasks of cases) expect(runIdentity(r, tasks).liveness).toBe('unknown');
    expect(
      runIdentity(r, [task({ createdBy: ok({ handle: 'term_new', paneKey: 'pane:new', generation: 2 }) })])
        .liveness,
    ).toBe('live');
  });

  it('한 Run 안의 두 세대 binding을 각각 판정한다', () => {
    // 실측(2026-08-24, run_36d28e6e947a): generation 1 binding 39건 + generation 2 binding 24건.
    const r = run({ coordinatorHandle: 'term_new', coordinatorPaneKey: 'pane:new', consumerGeneration: ok(2) });
    const tasks = [
      task({ id: 'a', createdBy: ok({ handle: 'term_old', paneKey: 'pane:old', generation: 1 }) }),
      task({ id: 'b', createdBy: ok({ handle: 'term_old', paneKey: 'pane:old', generation: 1 }) }),
      task({ id: 'c', createdBy: ok({ handle: 'term_new', paneKey: 'pane:new', generation: 2 }) }),
    ];
    const identity = runIdentity(r, tasks);
    expect(identity.observed).toEqual([
      {
        binding: { handle: 'term_old', paneKey: 'pane:old', generation: 1 },
        liveness: 'stale',
        tasks: 2,
      },
      {
        binding: { handle: 'term_new', paneKey: 'pane:new', generation: 2 },
        liveness: 'live',
        tasks: 1,
      },
    ]);
    expect(identity.liveness).toBe('live');
    expect(identity.current).toEqual({
      handle: 'term_new',
      paneKey: 'pane:new',
      generation: 2,
    });
  });

  it('generation이 같아도 handle이 다르면 판정하지 않는다', () => {
    const r = run({ coordinatorHandle: 'term_a', coordinatorPaneKey: 'pane:a', consumerGeneration: ok(3) });
    expect(classifyBinding(r, { handle: 'term_b', paneKey: 'pane:a', generation: 3 })).toBe('unknown');
    expect(classifyBinding(r, { handle: 'term_a', paneKey: 'pane:z', generation: 3 })).toBe('unknown');
  });

  it('Run row보다 앞선 generation을 live로 부르지 않는다', () => {
    const r = run({ consumerGeneration: ok(1) });
    expect(classifyBinding(r, { handle: 'term_now', paneKey: 'pane:now', generation: 5 })).toBe('unknown');
  });

  it('비교할 Task가 없으면 stale이 아니라 unknown이다', () => {
    expect(runIdentity(run(), []).liveness).toBe('unknown');
  });

  /** 권위인 Run row의 세대를 읽지 못하면 대조할 것이 없다. stale로 접지 않는다(OD-079). */
  it('consumer_generation을 읽지 못한 Run은 stale이 아니라 unknown이다', () => {
    const unreadable = run({ consumerGeneration: { kind: 'unreadable', reason: '정수가 아니다: null' } });
    const tasks = [task({ createdBy: ok({ handle: 'term_old', paneKey: 'pane:old', generation: 1 }) })];

    const identity = runIdentity(unreadable, tasks);
    expect(identity.liveness).toBe('unknown');
    expect(identity.current).toBeNull();
    expect(identity.observed.map((o) => o.liveness)).toEqual(['unknown']);
  });

  /** binding을 읽지 못한 Task를 기본값으로 메우면 없는 세대가 생긴다(OD-079). */
  it('created_by를 읽지 못한 Task는 binding 관측에서 뺀다', () => {
    const r = run({ coordinatorHandle: 'term_now', coordinatorPaneKey: 'pane:now', consumerGeneration: ok(2) });
    const identity = runIdentity(r, [
      task({ id: 'a', createdBy: { kind: 'unreadable', reason: '정수가 아니다: undefined' } }),
      task({ id: 'b', createdBy: ok({ handle: 'term_now', paneKey: 'pane:now', generation: 2 }) }),
    ]);
    expect(identity.observed).toEqual([
      { binding: { handle: 'term_now', paneKey: 'pane:now', generation: 2 }, liveness: 'live', tasks: 1 },
    ]);
    expect(identity.liveness).toBe('live');
  });
});

/** 관찰 1회를 흉내내는 Orca CLI. 인자별로 고정 응답을 준다. */
class FakeOrca implements OrcaRunner {
  readonly calls: string[][] = [];
  constructor(private readonly responses: Record<string, unknown>) {}
  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const key = args[1] ?? '';
    const result = this.responses[key];
    if (result === undefined) throw new Error(`예상치 못한 호출: ${args.join(' ')}`);
    return Promise.resolve(JSON.stringify({ id: 'x', ok: true, result }));
  }
}

const RUN_ROW = {
  id: 'run_1',
  objective: 'D1 관찰',
  coordinator_handle: 'term_now',
  coordinator_pane_key: 'pane:now',
  consumer_generation: 2,
  legacy: 0,
  created_at: '2026-08-23T00:00:00Z',
  updated_at: '2026-08-23T00:00:00Z',
};

function taskRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task_1',
    run_id: 'run_1',
    task_title: 't',
    status: 'ready',
    deps: '[]',
    result: null,
    created_by_process_incarnation: `${REPO_ID}::D:/dev-infra@@h:i`,
    created_by_terminal_handle: 'term_now',
    created_by_pane_key: 'pane:now',
    created_by_run_generation: 2,
    created_at: '2026-08-23 00:00:00',
    ...over,
  };
}

function workerRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dispatchId: 'ctx_1',
    taskId: 'task_1',
    runId: 'run_1',
    dispatchStatus: 'completed',
    resource: { worktreeId: `${REPO_ID}::D:/dev-infra` },
    ...over,
  };
}

function collect(over: Record<string, unknown> = {}, config = CONFIG): Promise<RunCollection> {
  const orca = new FakeOrca({
    'run-list': { runs: [RUN_ROW] },
    'task-list': { tasks: [taskRow()], count: 1 },
    'gate-list': { gates: [] },
    'worker-list': { workers: [workerRow()] },
    inbox: { messages: [] },
    ...over,
  });
  return collectRunFacts(orca, config, { now: () => new Date('2026-08-24T00:00:00Z') });
}

/** 이 Run들을 전부 미등록으로 만드는 조회 대역. 정렬 test가 미등록 목록만 보기 위해 쓴다. */
const UNREGISTERED_ONLY = {
  'task-list': {
    tasks: [taskRow({ created_by_process_incarnation: `${OTHER_REPO_ID}::D:/other@@h:i` })],
    count: 1,
  },
  'worker-list': {
    workers: [workerRow({ resource: { worktreeId: `${OTHER_REPO_ID}::D:/other` } })],
  },
};

/** 컬렉션 카드의 렌더 지문. 목록의 순서가 아니라 카드에 실제로 그려지는 축을 본다. */
function collectionFingerprint(c: RunCollection): string {
  return renderFingerprint(
    renderRunCollectionCard({
      cards: c.runs.length,
      collection: { degraded: c.degraded, unregistered: c.unregistered },
    }),
  );
}

describe('collectRunFacts (OD-068, OD-072, OD-078)', () => {
  it('등록된 repository의 Run만 표시 대상이다', async () => {
    const c = await collect();
    expect(c.runs.map((r) => r.identity.runId)).toEqual(['run_1']);
    expect(c.runs[0]?.project).toBe('dev-infra');
    expect(c.runs[0]?.repositories).toEqual(['dnhynk/dev-infra']);
    expect(c.unregistered.count).toBe(0);
  });

  it('등록되지 않은 repository의 Run은 표시 대상이 아니다', async () => {
    const c = await collect({
      'task-list': {
        tasks: [taskRow({ created_by_process_incarnation: `${OTHER_REPO_ID}::D:/other@@h:i` })],
        count: 1,
      },
      'worker-list': { workers: [workerRow({ resource: { worktreeId: `${OTHER_REPO_ID}::D:/other` } })] },
    });
    expect(c.runs).toEqual([]);
  });

  it('미등록 Run을 조용히 버리지 않고 센다', async () => {
    const c = await collect({
      'task-list': {
        tasks: [taskRow({ created_by_process_incarnation: `${OTHER_REPO_ID}::D:/other@@h:i` })],
        count: 1,
      },
      'worker-list': { workers: [workerRow({ resource: { worktreeId: `${OTHER_REPO_ID}::D:/other` } })] },
    });
    expect(c.unregistered.count).toBe(1);
    expect(c.unregistered.runs[0]?.runId).toBe('run_1');
    expect(c.unregistered.runs[0]?.repositoryIds).toEqual([OTHER_REPO_ID]);
    // 관측은 성공했고 등록에 없었다. 조회 실패와 구분되는 모습이다.
    expect(c.unregistered.runs[0]?.degraded.map((d) => d.kind)).toContain('unregistered_repository');
    expect(c.unregistered.runs[0]?.degraded.map((d) => d.kind)).not.toContain('query_failed');
  });

  /*
   * 회귀 방지 — Orca `run-list`의 출력 순서에 기대면 렌더 지문이 흔들린다.
   *
   * 미등록 목록은 상위 ENTRY_CAP건만 카드에 싣는다. 순서를 Orca에 맡기면 Orca 정렬이 바뀔 때
   * 상위 건과 그 나열 순서가 관찰마다 뒤바뀌고, 사실이 그대로여도 지문이 달라져 컬렉션 카드와
   * 모든 Run 카드의 `skip`이 발화하지 않는다. D1-B가 관측 시각으로 같은 결과를 낸 원인을 두 번에
   * 걸쳐 닫았다. 이것은 같은 결과를 내는 다른 원인이다.
   *
   * 렌더 지문으로 단언한다. 목록의 순서만 보면 카드에 실제로 그려지는 축을 보지 않는 것이다.
   *
   * 정렬 키는 `(created_at DESC, id ASC)`다. 지문 안정만 재면 `id`만으로도 통과하므로 **상위
   * ENTRY_CAP건이 최신 5건인지**도 함께 단언한다. 그 둘이 이 정렬 키가 지는 계약의 전부다.
   */
  it('run-list 출력 순서를 뒤집어도 미등록 목록의 렌더 지문이 같고, 상위 건이 최신순이다', async () => {
    // ENTRY_CAP(5)보다 많아야 "상위 몇 건"이 순서에 따라 갈린다.
    // id 오름차순과 created_at 내림차순이 정반대가 되게 둔다 — 두 키를 구분하지 못하면 실패한다.
    const rows = [
      { ...RUN_ROW, id: 'run_1', created_at: '2026-08-23T01:00:00Z' },
      { ...RUN_ROW, id: 'run_2', created_at: '2026-08-23T02:00:00Z' },
      { ...RUN_ROW, id: 'run_3', created_at: '2026-08-23T03:00:00Z' },
      { ...RUN_ROW, id: 'run_4', created_at: '2026-08-23T04:00:00Z' },
      { ...RUN_ROW, id: 'run_5', created_at: '2026-08-23T05:00:00Z' },
      { ...RUN_ROW, id: 'run_6', created_at: '2026-08-23T06:00:00Z' },
      { ...RUN_ROW, id: 'run_7', created_at: '2026-08-23T07:00:00Z' },
    ];
    const newestFirst = ['run_7', 'run_6', 'run_5', 'run_4', 'run_3', 'run_2', 'run_1'];

    const forward = await collect({ 'run-list': { runs: rows }, ...UNREGISTERED_ONLY });
    const reversed = await collect({
      'run-list': { runs: [...rows].reverse() },
      ...UNREGISTERED_ONLY,
    });

    expect(forward.unregistered.count).toBe(7);
    expect(collectionFingerprint(reversed)).toBe(collectionFingerprint(forward));
    // 무엇으로 고정했는지도 함께 남긴다. 지문만 보면 "둘 다 비어서 같다"와 구분되지 않는다.
    expect(forward.unregistered.runs.map((u) => u.runId)).toEqual(newestFirst);
    expect(reversed.unregistered.runs.map((u) => u.runId)).toEqual(newestFirst);
  });

  /*
   * 회귀 방지 — 1차 키만으로는 total order가 아니다.
   *
   * 같은 `created_at`을 가진 Run이 tie로 남으면 그 자리가 다시 `run-list` 출력 순서에 걸리고,
   * 이 describe가 막으려는 지문 흔들림이 그 자리에 그대로 남는다.
   */
  it('created_at이 같은 Run은 runId가 tie를 깬다', async () => {
    const same = '2026-08-23T00:00:00Z';
    const rows = ['run_3', 'run_1', 'run_2'].map((id) => ({ ...RUN_ROW, id, created_at: same }));

    const forward = await collect({ 'run-list': { runs: rows }, ...UNREGISTERED_ONLY });
    const reversed = await collect({
      'run-list': { runs: [...rows].reverse() },
      ...UNREGISTERED_ONLY,
    });

    expect(forward.unregistered.runs.map((u) => u.runId)).toEqual(['run_1', 'run_2', 'run_3']);
    expect(reversed.unregistered.runs.map((u) => u.runId)).toEqual(['run_1', 'run_2', 'run_3']);
  });

  /*
   * `created_at`을 읽지 못한 행의 자리를 고정한다.
   *
   * `parseOrcaTimestamp`의 타임존 없는 갈래는 형식만 맞으면 범위를 보지 않고 Invalid Date를
   * 돌려준다. 그 행이 정렬에 들어오는데 NaN을 그대로 비교하면 정렬 결과가 엔진 재량이 되고,
   * 사실이 그대로여도 지문이 흔들린다. **맨 뒤**에 두고 버리지 않는다 — 읽지 못한 시각은
   * 최신성을 주장할 근거가 아니지만, 그 Run이 미등록이라는 사실은 사라지면 안 된다.
   */
  it('created_at이 범위 밖인 Run은 버려지지 않고 맨 뒤로 간다', async () => {
    const rows = [
      { ...RUN_ROW, id: 'run_bad', created_at: '2026-13-45 99:99:99' },
      { ...RUN_ROW, id: 'run_old', created_at: '2026-08-21T00:00:00Z' },
      { ...RUN_ROW, id: 'run_new', created_at: '2026-08-23T00:00:00Z' },
    ];

    const forward = await collect({ 'run-list': { runs: rows }, ...UNREGISTERED_ONLY });
    const reversed = await collect({
      'run-list': { runs: [...rows].reverse() },
      ...UNREGISTERED_ONLY,
    });

    expect(forward.unregistered.count).toBe(3);
    expect(forward.unregistered.runs.map((u) => u.runId)).toEqual(['run_new', 'run_old', 'run_bad']);
    expect(reversed.unregistered.runs.map((u) => u.runId)).toEqual(['run_new', 'run_old', 'run_bad']);
    expect(collectionFingerprint(reversed)).toBe(collectionFingerprint(forward));
  });

  /*
   * `created_at`이 아예 없거나 형식이 어긋난 행은 여기까지 오지 않는다.
   *
   * `listRuns`의 `parseOrcaTimestamp`가 던져 **관찰이 통째로 실패한다.** 이 계약을 고정해 두지
   * 않으면 나중에 그 실패를 삼키는 변경이 들어왔을 때 그 Run이 정렬에서 조용히 사라진다.
   */
  it('created_at이 없는 Run은 조용히 사라지지 않고 관찰을 실패시킨다', async () => {
    const rows = [{ ...RUN_ROW, id: 'run_1', created_at: undefined }];
    await expect(collect({ 'run-list': { runs: rows }, ...UNREGISTERED_ONLY })).rejects.toThrow(
      RangeError,
    );
  });

  it('repository id를 exact 비교한다. 경로가 아니라 id다', async () => {
    const upper = REPO_ID.toUpperCase();
    const c = await collect(
      {},
      { ...CONFIG, projects: [{ name: 'x', repositories: ['a/b'], orcaRepositoryIds: [upper] }] },
    );
    expect(c.runs).toEqual([]);
    expect(c.unregistered.count).toBe(1);
  });

  it('미검증 플랫폼 가정을 항상 degraded로 싣는다', async () => {
    const c = await collect();
    expect(c.degraded.map((d) => d.kind)).toContain('unverified_platform_assumption');
    expect(c.degraded[0]?.detail).toContain('platform-capabilities.md');
  });

  it('Run 하나의 조회 실패를 0건으로 그리지 않고 degraded로 남긴다', async () => {
    const orca = new FakeOrca({
      'run-list': { runs: [RUN_ROW] },
      'task-list': { tasks: [taskRow()], count: 1 },
      'worker-list': { workers: [workerRow()] },
      inbox: { messages: [] },
    });
    const c = await collectRunFacts(orca, CONFIG, { now: () => new Date('2026-08-24T00:00:00Z') });
    const kinds = c.runs[0]?.degraded.map((d) => d.kind) ?? [];
    expect(kinds).toContain('query_failed');
    expect(c.runs[0]?.blockers.badges.find((b) => b.source === 'openGate')).toBeUndefined();
  });

  it('활성 Dispatch에만 worker-show를 부른다', async () => {
    const orca = new FakeOrca({
      'run-list': { runs: [RUN_ROW] },
      'task-list': { tasks: [taskRow()], count: 1 },
      'gate-list': { gates: [] },
      'worker-list': {
        workers: [
          workerRow({ dispatchId: 'ctx_done', dispatchStatus: 'completed' }),
          workerRow({ dispatchId: 'ctx_live', dispatchStatus: 'dispatched' }),
        ],
      },
      inbox: { messages: [] },
      'worker-show': { observation: { agentWait: { source: 'prompt-text', reason: 'codex-interactive-prompt' } } },
    });
    const c = await collectRunFacts(orca, CONFIG, { now: () => new Date('2026-08-24T00:00:00Z') });
    const shows = orca.calls.filter((a) => a[1] === 'worker-show');
    expect(shows).toEqual([['orchestration', 'worker-show', '--dispatch', 'ctx_live', '--json']]);
    expect(c.runs[0]?.blockers.badges.find((b) => b.source === 'interactionWait')?.count).toBe(1);
  });

  it('legacy Run은 Task/Gate 조회를 시도하지 않는다', async () => {
    const orca = new FakeOrca({
      'run-list': {
        runs: [{ ...RUN_ROW, id: 'run_legacy', consumer_generation: 0, legacy: 1, coordinator_handle: null, coordinator_pane_key: null }],
      },
      inbox: { messages: [] },
    });
    const c = await collectRunFacts(orca, CONFIG, { now: () => new Date('2026-08-24T00:00:00Z') });
    expect(orca.calls.map((a) => a[1])).toEqual(['run-list', 'inbox']);
    expect(c.unregistered.runs[0]?.runId).toBe('run_legacy');
    expect(c.unregistered.runs[0]?.repositoryIds).toEqual([]);
  });


  /**
   * 실증(2026-08-24, `run_59bccb319e7f`): task 행에는 등록된 repository id가 있는데 `result` 칸의
   * poison 때문에 `task-list` 전체가 던졌고, worker 행에 `worktreeId`가 없어 repoIds가 비었다.
   * 그 결과 **등록된 Run이 "미등록"으로 출력됐고 `query_failed`가 흔적 없이 사라졌다.**
   *
   * 그러면 OD-078이 위험을 감수한 근거가 무너진다. 그 결정은 "등록에 맞지 않는 Run을 세어
   * 노출하므로 조용한 실패가 관측 가능해진다"를 완화책으로 삼았는데, 조회에 실패한 Run이
   * 미등록으로 둔갑하면 그 수가 다른 사건을 센다.
   */
  it('조회 실패로 판정하지 못한 Run을 진짜 미등록 Run과 같게 출력하지 않는다', async () => {
    // task-list 응답을 주지 않아 그 축의 조회가 던지게 한다. worker 행에는 worktreeId가 없어
    // repository id를 하나도 관측하지 못한다 — 실측 run_59bccb319e7f과 같은 모습이다.
    const orca = new FakeOrca({
      'run-list': { runs: [{ ...RUN_ROW, id: 'run_failed' }] },
      'gate-list': { gates: [] },
      'worker-list': { workers: [workerRow({ resource: {} })] },
      inbox: { messages: [] },
    });
    const c = await collectRunFacts(orca, CONFIG, { now: () => new Date('2026-08-24T00:00:00Z') });

    const failed = c.unregistered.runs.find((u) => u.runId === 'run_failed');
    expect(failed?.repositoryIds).toEqual([]);
    // 조회가 실패했다는 사실이 미등록 항목에 그대로 남는다.
    expect(failed?.degraded.map((d) => d.kind)).toContain('query_failed');
    expect(failed?.degraded.find((d) => d.kind === 'repository_unobservable')?.detail).toContain(
      '등록 여부를 판정할 수 없다',
    );

    // 사람이 읽는 출력에서도 두 줄이 구분된다.
    const text = formatRunCollection(c);
    expect(text).toContain('task-list 실패');
    expect(text).toContain('등록 여부를 판정할 수 없다');
  });

  it('진짜 빈 Run은 조회 실패로 읽히지 않는다', async () => {
    const orca = new FakeOrca({
      'run-list': { runs: [{ ...RUN_ROW, id: 'run_empty' }] },
      'task-list': { tasks: [], count: 0 },
      'gate-list': { gates: [] },
      'worker-list': { workers: [] },
      inbox: { messages: [] },
    });
    const c = await collectRunFacts(orca, CONFIG, { now: () => new Date('2026-08-24T00:00:00Z') });
    const empty = c.unregistered.runs[0];
    expect(empty?.degraded.map((d) => d.kind)).not.toContain('query_failed');
    expect(empty?.degraded.find((d) => d.kind === 'repository_unobservable')?.detail).toContain(
      'Task도 worker도 없어',
    );
  });

  /**
   * 관측된 id가 두 등록 Project에 걸치면 사전순 첫 매치가 이긴다. 그것을 조용히 하지 않는다 —
   * 다른 Project 쪽 카드에서는 이 Run이 아무 표시 없이 빠지기 때문이다.
   */
  it('여러 Project에 걸친 Run을 조용히 한쪽으로 접지 않는다', async () => {
    const c = await collect(
      {
        'worker-list': {
          workers: [workerRow({ resource: { worktreeId: `${OTHER_REPO_ID}::D:/other` } })],
        },
      },
      {
        ...CONFIG,
        projects: [
          { name: 'alpha', repositories: ['a/a'], orcaRepositoryIds: [REPO_ID] },
          { name: 'beta', repositories: ['b/b'], orcaRepositoryIds: [OTHER_REPO_ID] },
        ],
      },
    );
    expect(c.runs[0]?.project).toBe('alpha');
    const multi = c.runs[0]?.degraded.find((d) => d.kind === 'multiple_project_match');
    expect(multi?.detail).toContain('alpha, beta');
    expect(multi?.detail).toContain('나머지 Project의 카드에서 이 Run이 빠진다');
  });

  /**
   * 포화의 더 나쁜 방향은 ask 행 자체가 조회 창 밖으로 밀린 경우다. 그때는 이 Run에 미답 ask가
   * **보이지 않으므로** Run 수준 조건으로는 아무 흔적이 남지 않는다. 컬렉션 수준에서 무조건 낸다.
   */
  it('보이는 미답 ask가 없어도 inbox 포화를 컬렉션 수준으로 드러낸다', async () => {
    const orca = new FakeOrca({
      'run-list': { runs: [RUN_ROW] },
      'task-list': { tasks: [taskRow()], count: 1 },
      'gate-list': { gates: [] },
      'worker-list': { workers: [workerRow()] },
      inbox: {
        messages: [
          {
            id: 'msg_other',
            run_id: 'run_other',
            type: 'question',
            subject: 'Question',
            thread_id: 'msg_other',
            payload: '{"taskId":"task_x","dispatchId":"ctx_x"}',
            created_at: '2026-08-23T00:00:00Z',
          },
        ],
      },
    });
    const c = await collectRunFacts(orca, CONFIG, {
      now: () => new Date('2026-08-24T00:00:00Z'),
      inboxLimit: 1,
    });
    // 이 Run에는 보이는 미답 ask가 없다.
    expect(c.runs[0]?.blockers.badges).toEqual([]);
    expect(c.runs[0]?.degraded.map((d) => d.kind)).not.toContain('inbox_saturated');
    // 그래도 포화 사실은 남는다.
    expect(c.degraded.find((d) => d.kind === 'inbox_saturated')?.detail).toContain('조회 창');
  });

  /** OD-079 봉쇄를 이 PR이 새로 넣은 세 parser에도 적용한다. */
  it('consumer_generation이 깨진 Run 하나가 run-list 전체를 죽이지 않는다', async () => {
    const orca = new FakeOrca({
      'run-list': { runs: [{ ...RUN_ROW, id: 'run_bad', consumer_generation: null }, RUN_ROW] },
      'task-list': { tasks: [taskRow()], count: 1 },
      'gate-list': { gates: [] },
      'worker-list': { workers: [workerRow()] },
      inbox: { messages: [] },
    });
    const c = await collectRunFacts(orca, CONFIG, { now: () => new Date('2026-08-24T00:00:00Z') });
    // 두 Run 모두 관측됐다. 깨진 행 하나가 나머지를 없애지 않는다.
    // 순서는 `collectRunFacts`가 `runId`로 고정한다. Orca가 준 순서가 아니다.
    expect(c.runs.map((r) => r.identity.runId)).toEqual(['run_1', 'run_bad']);
    // 읽지 못한 Run은 stale이 아니라 unknown이다.
    expect(c.runs.find((r) => r.identity.runId === 'run_bad')?.identity.liveness).toBe('unknown');
    expect(c.degraded.find((x) => x.kind === 'unreadable_field')?.detail).toContain(
      'run run_bad의 consumer_generation',
    );
  });

  it('created_by_run_generation이 깨진 task 하나가 그 Run의 task 축을 죽이지 않는다', async () => {
    const c = await collect({
      'task-list': {
        tasks: [
          taskRow({ id: 'task_bad', created_by_run_generation: null }),
          taskRow({ id: 'task_ok' }),
        ],
        count: 2,
      },
    });
    expect(c.runs[0]?.tasks.total).toBe(2);
    // 읽지 못한 binding은 관측에서 빠지고 그 사실이 degraded로 남는다.
    expect(c.runs[0]?.identity.observed).toHaveLength(1);
    expect(
      c.runs[0]?.degraded.find((x) => x.kind === 'unreadable_field')?.detail,
    ).toContain('task task_bad의 created_by');
  });

  it('payload가 깨진 inbox row 하나가 ask·escalation 축을 죽이지 않는다', async () => {
    const c = await collect({
      inbox: {
        messages: [
          {
            id: 'msg_bad',
            run_id: 'run_1',
            type: 'question',
            subject: 'Question',
            thread_id: 'msg_bad',
            payload: '{taskId:task_1}',
            created_at: '2026-08-23T00:00:00Z',
          },
          {
            id: 'msg_ok',
            run_id: 'run_1',
            type: 'question',
            subject: 'Question',
            thread_id: 'msg_ok',
            payload: '{"taskId":"task_1","dispatchId":"ctx_1"}',
            created_at: '2026-08-23T00:01:00Z',
          },
        ],
      },
    });
    // 정상 row는 그대로 badge가 된다.
    expect(c.runs[0]?.blockers.badges.find((b) => b.source === 'workerAsk')?.count).toBe(1);
    expect(c.degraded.find((x) => x.kind === 'unreadable_field')?.detail).toContain(
      'question msg_bad의 payload',
    );
  });

  /**
   * liveness_unknown 문구는 OD-078의 실패 모드를 사람이 읽는 유일한 자리다. 여기에 객체가
   * 보간되면 장치가 있어도 읽을 것이 없다.
   */
  it('handoff 직후 all-stale 구간의 문구에 Run row의 generation 수가 들어간다', async () => {
    // Run row는 generation 2인데 관측된 binding은 전부 1이다 — 정상 handoff가 만드는 구간이다.
    const c = await collect({
      'task-list': { tasks: [taskRow({ created_by_run_generation: 1 })], count: 1 },
    });
    const detail = c.runs[0]?.degraded.find((d) => d.kind === 'liveness_unknown')?.detail;
    expect(detail).toBe('관측된 binding이 Run row(generation 2)와 어긋난다');
    expect(detail).not.toContain('[object Object]');
  });

  it('consumer_generation을 읽지 못한 Run의 문구는 대조하지 못했다는 사실을 적는다', async () => {
    const orca = new FakeOrca({
      'run-list': { runs: [{ ...RUN_ROW, consumer_generation: null }] },
      'task-list': { tasks: [taskRow()], count: 1 },
      'gate-list': { gates: [] },
      'worker-list': { workers: [workerRow()] },
      inbox: { messages: [] },
    });
    const c = await collectRunFacts(orca, CONFIG, { now: () => new Date('2026-08-24T00:00:00Z') });
    const detail = c.runs[0]?.degraded.find((d) => d.kind === 'liveness_unknown')?.detail;
    expect(detail).toBe('Run row의 generation을 읽지 못해 관측된 binding과 대조할 수 없다');
    expect(detail).not.toContain('[object Object]');
  });

  it('사람이 읽는 요약도 Run 사실을 그대로 옮긴다', async () => {
    const text = formatRunCollection(await collect());
    expect(text).toContain('run_1');
    expect(text).toContain('[dev-infra]');
    expect(text).toContain('tasks      count=1');
    expect(text).toContain('dispatches attempts=1');
    expect(text).toContain('ciFailure=관측불가');
  });
});

/** 값 트리 전체를 훑어 금지된 이름과 값을 찾는다. */
function walk(node: unknown, path: string, visit: (path: string, value: unknown) => void): void {
  visit(path, node);
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
    return;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, visit);
  }
}

/*
 * 카드에 그리는 목록의 순서(`store/schema.ts`의 지문 규칙).
 *
 * Orca 조회 출력 순서에 기대는 목록이 카드에 남아 있으면, Orca 정렬이 바뀔 때 사실이 하나도
 * 바뀌지 않아도 렌더 지문이 흔들려 `publish.ts`의 `skip`이 발화하지 않는다. 매 관찰이
 * `chat.update`를 만든다. D1-B가 관측 시각으로 같은 결과를 낸 원인을 닫았고, 이것들은 같은
 * 결과를 내는 다른 원인이다.
 *
 * **정렬 키는 total이어야 한다.** 어떤 tie도 입력 순서에 남기면 그 자리에 같은 결함이 남는다.
 * 그래서 목록 자체가 아니라 **렌더 지문**으로 단언한다 — 카드에 실제로 그려지는 축이 그것이다.
 */
describe('카드에 그리는 목록의 정렬', () => {
  /** blocker 축만 다른 Run 카드 하나. 나머지 축은 두 호출에서 동일하다. */
  function cardWith(over: Partial<RunFacts>): string {
    const base: RunFacts = {
      identity: runIdentity(run(), [task()]),
      project: 'dev-infra',
      repositories: ['dnhynk/dev-infra'],
      observedRepositoryIds: [REPO_ID],
      tasks: { total: 0, byStatus: [] },
      dispatches: { total: 0, byStatus: [], retriedTasks: 0 },
      blockers: { badges: [], notObservable: [] },
      degraded: [],
      ...over,
    };
    return renderFingerprint(
      renderRunCard({
        run: base,
        pullRequests: [],
        collection: { degraded: [], unregistered: { count: 0, runs: [] } },
      }),
    );
  }

  // 회귀 방지: `render.ts`가 badge당 상위 ENTRY_CAP(5)건만 싣는다. 순서를 Orca에 맡기면
  // **상위 5건이 무엇인지까지** 관찰마다 갈린다.
  it('blocker entry 순서를 뒤집어도 렌더 지문이 같다', () => {
    const blocked = ['task_b7', 'task_b1', 'task_b5', 'task_b3', 'task_b6', 'task_b2', 'task_b4'];
    const rows = blocked.map((id) => task({ id, status: 'blocked' }));
    const blockersOf = (tasks: OrcaTask[]) =>
      aggregateBlockers({ tasks, gates: [], workers: [], asks: [], escalations: [], agentWaits: [] });

    const forward = blockersOf(rows);
    const reversed = blockersOf([...rows].reverse());

    expect(cardWith({ blockers: reversed })).toBe(cardWith({ blockers: forward }));
    // 무엇으로 고정했는지도 남긴다. 지문만 보면 "둘 다 비어서 같다"와 구분되지 않는다.
    expect(forward.badges[0]?.entries.map((e) => e.taskId)).toEqual([...blocked].sort());
    expect(reversed.badges[0]?.entries.map((e) => e.taskId)).toEqual([...blocked].sort());
  });

  // 회귀 방지: generation만으로 정렬하면 같은 generation의 binding들 사이 tie가 task-list
  // 순서로 갈린다. `render.ts`가 그 목록을 identity 절에 그대로 그린다.
  it('같은 generation의 binding 순서를 뒤집어도 렌더 지문이 같다', () => {
    const handles = ['term_d', 'term_a', 'term_c', 'term_b'];
    const rows = handles.map((h, i) =>
      task({ id: `task_${i}`, createdBy: ok({ handle: h, paneKey: `pane:${h}`, generation: 2 }) }),
    );
    const forward = runIdentity(run(), rows);
    const reversed = runIdentity(run(), [...rows].reverse());

    expect(cardWith({ identity: reversed })).toBe(cardWith({ identity: forward }));
    expect(forward.observed.map((o) => o.binding.handle)).toEqual([...handles].sort());
    expect(reversed.observed.map((o) => o.binding.handle)).toEqual([...handles].sort());
  });
});

/*
 * degraded 절도 같은 부류다. 읽지 못한 칸 한 건은 Orca 행 하나에서 오고, 그 행들의 순서가
 * 조회 출력 순서면 degraded 줄의 순서가 관찰마다 갈린다. `collect.ts`가 원천 행을 id로 고정하고
 * inbox의 읽지 못한 칸을 total key로 정렬해 닫는다.
 */
describe('degraded 줄의 정렬', () => {
  function orcaWithReversible(reverse: boolean): FakeOrca {
    // 읽지 못한 칸을 여럿 만든다. deps가 깨진 Task와 options가 깨진 Gate가 각각 degraded 한 줄이다.
    const tasks = ['task_c', 'task_a', 'task_d', 'task_b'].map((id) =>
      taskRow({ id, deps: '{깨진 JSON' }),
    );
    const gates = ['gate_c', 'gate_a', 'gate_b'].map((id) => ({
      id,
      run_id: 'run_1',
      task_id: 'task_a',
      question: 'q',
      options: '{깨진 JSON',
      status: 'resolved',
      resolution: null,
      created_at: '2026-08-23 00:00:00',
      resolved_at: null,
    }));
    const workers = ['ctx_c', 'ctx_a', 'ctx_b'].map((dispatchId) =>
      workerRow({ dispatchId, dispatchStatus: 'failed' }),
    );
    // inbox의 읽지 못한 칸은 컬렉션 수준 degraded가 되고 Run 카드의 '관찰 전체' 절에 실린다.
    const messages = ['msg_c', 'msg_a', 'msg_b'].map((id) => ({
      id,
      type: 'question',
      run_id: 'run_1',
      thread_id: null,
      subject: 'q',
      payload: '{깨진 JSON',
      created_at: '2026-08-23 00:00:00',
    }));
    const order = <T>(rows: T[]): T[] => (reverse ? [...rows].reverse() : rows);
    return new FakeOrca({
      'run-list': { runs: [RUN_ROW] },
      'task-list': { tasks: order(tasks), count: tasks.length },
      'gate-list': { gates: order(gates) },
      'worker-list': { workers: order(workers) },
      inbox: { messages: order(messages) },
    });
  }

  it('Orca 행 순서를 뒤집어도 degraded 줄의 렌더 지문이 같다', async () => {
    const run = async (reverse: boolean): Promise<string> => {
      const c = await collectRunFacts(orcaWithReversible(reverse), CONFIG, {
        now: () => new Date('2026-08-24T00:00:00Z'),
      });
      const facts = c.runs[0];
      if (facts === undefined) throw new Error('등록된 Run이 없다');
      return renderFingerprint(
        renderRunCard({
          run: facts,
          pullRequests: [],
          collection: { degraded: c.degraded, unregistered: c.unregistered },
        }),
      );
    };
    const forward = await run(false);
    expect(await run(true)).toBe(forward);
  });

  // 지문만 보면 "degraded가 비어서 같다"와 구분되지 않는다. 실제로 여러 줄이 났는지 함께 본다.
  it('위 대조가 degraded가 비어서 성립한 것이 아니다', async () => {
    const c = await collectRunFacts(orcaWithReversible(false), CONFIG, {
      now: () => new Date('2026-08-24T00:00:00Z'),
    });
    const unreadable = (c.runs[0]?.degraded ?? []).filter((d) => d.kind === 'unreadable_field');
    expect(unreadable.length).toBeGreaterThan(1);
    // 컬렉션 수준도 함께 본다. inbox의 읽지 못한 칸이 여기로 온다.
    expect(
      c.degraded
        .filter((d) => d.kind === 'unreadable_field')
        .map((d) => d.detail.split(' ').slice(0, 2).join(' ')),
    ).toEqual(['question msg_a의', 'question msg_b의', 'question msg_c의']);
    // task 넷과 gate 셋이 각각 id 오름차순으로 나온다.
    expect(unreadable.map((d) => d.detail.split(' ').slice(0, 2).join(' '))).toEqual([
      'task task_a의', 'task task_b의', 'task task_c의', 'task task_d의',
      'gate gate_a의', 'gate gate_b의', 'gate gate_c의',
    ]);
  });
});

describe('금지된 파생값 (OD-067, OD-069)', () => {
  it('비율·완료율 값이 어디에도 없다', async () => {
    const c = await collect({
      'task-list': {
        tasks: [
          taskRow({ id: 'task_1', status: 'completed' }),
          taskRow({ id: 'task_2', status: 'failed' }),
          taskRow({ id: 'task_3', status: 'blocked' }),
        ],
        count: 3,
      },
    });
    // camelCase 낱말 단위로 본다. 통짜 부분일치는 `generation`의 `ratio`까지 잡는다.
    const banned = new Set(['rate', 'ratio', 'percent', 'pct', 'progress', 'completion', 'success']);
    walk(c, 'collection', (path, value) => {
      const leaf = path.slice(path.lastIndexOf('.') + 1);
      const words = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
      for (const w of words) expect(banned.has(w), `금지된 이름: ${path}`).toBe(false);
      if (typeof value === 'number') {
        // 0과 1 사이의 값은 비율밖에 될 수 없다. 수는 전부 개수이므로 정수여야 한다.
        expect(Number.isInteger(value), `정수가 아닌 수: ${path}=${value}`).toBe(true);
      }
    });
  });

  it('고유 blocker 총합이 어디에도 없다', async () => {
    const c = await collect({
      'gate-list': {
        gates: [
          {
            id: 'gate_1',
            run_id: 'run_1',
            task_id: 'task_1',
            question: 'q',
            options: '[]',
            status: 'pending',
            resolution: null,
            created_at: '2026-08-23 00:00:00',
            resolved_at: null,
          },
        ],
      },
      'task-list': { tasks: [taskRow({ status: 'blocked' })], count: 1 },
    });
    const blockers = c.runs[0]?.blockers;
    expect(blockers?.badges.map((b) => b.source)).toEqual(['openGate', 'blockedTask']);
    walk(blockers, 'blockers', (path) => {
      const leaf = path.slice(path.lastIndexOf('.') + 1);
      // badge마다의 count는 원천별 수이므로 허용한다. 총합을 뜻하는 이름만 막는다.
      expect(/^(total|unique|sum|all)$/i.test(leaf), `총합으로 읽히는 이름: ${path}`).toBe(false);
    });
  });
});

describe('ask 답변 판정', () => {
  const inbox = {
    messages: [
      {
        id: 'msg_q1',
        run_id: 'run_1',
        type: 'question',
        subject: 'Question',
        thread_id: 'msg_q1',
        payload: '{"taskId":"task_1","dispatchId":"ctx_1"}',
        created_at: '2026-08-23T00:00:00Z',
      },
      {
        id: 'msg_r1',
        run_id: 'run_1',
        type: 'status',
        subject: 'Re',
        thread_id: 'msg_q1',
        payload: null,
        created_at: '2026-08-23T00:01:00Z',
      },
      {
        id: 'msg_q2',
        run_id: 'run_1',
        type: 'question',
        subject: 'Question',
        thread_id: 'msg_q2',
        payload: '{"taskId":"task_1","dispatchId":"ctx_1"}',
        created_at: '2026-08-23T00:02:00Z',
      },
      {
        id: 'msg_e1',
        run_id: 'run_1',
        type: 'escalation',
        subject: 'Blocked',
        thread_id: null,
        payload: '{"taskId":"task_1","dispatchId":"ctx_1"}',
        created_at: '2026-08-23T00:03:00Z',
      },
    ],
  };

  it('같은 thread의 뒤 메시지를 답변으로 읽는다', async () => {
    const orca = new FakeOrca({ inbox });
    const asks = askThreadsFrom(await readInbox(orca, 10));
    expect(asks.asks.map((a) => [a.messageId, a.answered])).toEqual([
      ['msg_q1', true],
      ['msg_q2', false],
    ]);
    expect(asks.escalations.map((e) => e.messageId)).toEqual(['msg_e1']);
  });

  it('ask와 escalation을 한 수로 합치지 않는다', async () => {
    const c = await collect({ inbox });
    const sources = c.runs[0]?.blockers.badges.map((b) => [b.source, b.count]);
    expect(sources).toEqual([
      ['workerAsk', 1],
      ['escalation', 1],
    ]);
  });

  it('inbox 포화에서 미답 ask를 답변으로 접지 않고 degraded로 싣는다', async () => {
    const c = await collect({ inbox }, CONFIG);
    expect(c.runs[0]?.degraded.map((d) => d.kind)).not.toContain('inbox_saturated');

    const saturating = new FakeOrca({
      'run-list': { runs: [RUN_ROW] },
      'task-list': { tasks: [taskRow()], count: 1 },
      'gate-list': { gates: [] },
      'worker-list': { workers: [workerRow()] },
      inbox,
    });
    const s = await collectRunFacts(saturating, CONFIG, {
      now: () => new Date('2026-08-24T00:00:00Z'),
      inboxLimit: 4,
    });
    expect(s.runs[0]?.degraded.map((d) => d.kind)).toContain('inbox_saturated');
    expect(s.runs[0]?.blockers.badges.find((b) => b.source === 'workerAsk')?.count).toBe(1);
  });

  it('다른 Run의 ask를 이 Run의 badge로 세지 않는다', async () => {
    const c = await collect({
      inbox: {
        messages: [
          {
            id: 'msg_other',
            run_id: 'run_other',
            type: 'question',
            subject: 'Question',
            thread_id: 'msg_other',
            payload: '{"taskId":"task_x","dispatchId":"ctx_x"}',
            created_at: '2026-08-23T00:00:00Z',
          },
        ],
      },
    });
    expect(c.runs[0]?.blockers.badges).toEqual([]);
  });
});

describe('worker-list 읽기', () => {
  it('resource.worktreeId에서 repository id를 뽑는다', async () => {
    const orca = new FakeOrca({
      'worker-list': {
        workers: [
          workerRow(),
          workerRow({ dispatchId: 'ctx_2', resource: { worktreeId: '' } }),
          workerRow({ dispatchId: 'ctx_3', resource: null }),
        ],
      },
    });
    const workers = await listWorkers(orca, 'run_1');
    expect(workers.map((w) => w.repositoryId)).toEqual([REPO_ID, null, null]);
  });

  it('모르는 dispatchStatus를 던지지 않고 그대로 싣는다', async () => {
    const orca = new FakeOrca({
      'worker-list': { workers: [workerRow({ dispatchStatus: 'circuit_broken' })] },
    });
    const workers = await listWorkers(orca, 'run_1');
    expect(workers[0]?.dispatchStatus).toBe('circuit_broken');
  });
});
