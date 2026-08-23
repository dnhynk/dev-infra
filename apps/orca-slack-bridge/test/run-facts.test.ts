import { describe, expect, it } from 'vitest';
import { collectRunFacts, formatRunCollection } from '../src/run/collect.js';
import { aggregateBlockers, aggregateDispatches, aggregateTasks } from '../src/run/aggregate.js';
import { classifyBinding, runIdentity } from '../src/run/liveness.js';
import type { OrcaRun, OrcaRunner, OrcaTask, OrcaWorker } from '../src/orca/client.js';
import { askThreadsFrom, listWorkers, readInbox } from '../src/orca/client.js';
import { DEFAULT_CORRELATION_KEYS, type BridgeConfig } from '../src/project/config.js';
import type { RunCollection } from '../src/run/types.js';

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
    consumerGeneration: 2,
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
    deps: [],
    result: null,
    worktreePath: 'D:/dev-infra',
    repositoryId: REPO_ID,
    createdBy: { handle: 'term_now', paneKey: 'pane:now', generation: 2 },
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
    options: [],
    status: 'pending',
    resolution: null,
    createdAt: new Date('2026-08-23T00:00:00Z'),
    resolvedAt: null,
  };

  const facts = aggregateBlockers({
    tasks: [
      task({ id: 'task_blocked', status: 'blocked' }),
      task({ id: 'task_pending', status: 'pending', deps: ['task_blocked'] }),
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
  it('consumer_generation이 다른 두 Run이 live와 stale로 갈린다', () => {
    const binding = { handle: 'term_first', paneKey: 'pane:first', generation: 1 };

    // 아직 인수되지 않은 Run. Run row가 이 binding을 현재 소유자로 말한다.
    const notHandedOver = run({
      id: 'run_live',
      coordinatorHandle: 'term_first',
      coordinatorPaneKey: 'pane:first',
      consumerGeneration: 1,
    });
    // 같은 binding이 만든 Task가 있지만 Run row는 이미 generation 2로 인수됐다.
    const handedOver = run({
      id: 'run_stale',
      coordinatorHandle: 'term_second',
      coordinatorPaneKey: 'pane:second',
      consumerGeneration: 2,
    });

    const tasks = [task({ createdBy: binding })];
    expect(runIdentity(notHandedOver, tasks).liveness).toBe('live');
    expect(runIdentity(handedOver, tasks).liveness).toBe('stale');
  });

  it('한 Run 안의 두 세대 binding을 각각 판정한다', () => {
    // 실측(2026-08-24, run_36d28e6e947a): generation 1 binding 39건 + generation 2 binding 24건.
    const r = run({ coordinatorHandle: 'term_new', coordinatorPaneKey: 'pane:new', consumerGeneration: 2 });
    const tasks = [
      task({ id: 'a', createdBy: { handle: 'term_old', paneKey: 'pane:old', generation: 1 } }),
      task({ id: 'b', createdBy: { handle: 'term_old', paneKey: 'pane:old', generation: 1 } }),
      task({ id: 'c', createdBy: { handle: 'term_new', paneKey: 'pane:new', generation: 2 } }),
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
    const r = run({ coordinatorHandle: 'term_a', coordinatorPaneKey: 'pane:a', consumerGeneration: 3 });
    expect(classifyBinding(r, { handle: 'term_b', paneKey: 'pane:a', generation: 3 })).toBe('unknown');
    expect(classifyBinding(r, { handle: 'term_a', paneKey: 'pane:z', generation: 3 })).toBe('unknown');
  });

  it('Run row보다 앞선 generation을 live로 부르지 않는다', () => {
    const r = run({ consumerGeneration: 1 });
    expect(classifyBinding(r, { handle: 'term_now', paneKey: 'pane:now', generation: 5 })).toBe('unknown');
  });

  it('비교할 Task가 없으면 stale이 아니라 unknown이다', () => {
    expect(runIdentity(run(), []).liveness).toBe('unknown');
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
    expect(c.unregistered).toEqual({
      count: 1,
      runs: [{ runId: 'run_1', repositoryIds: [OTHER_REPO_ID] }],
    });
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
    expect(c.unregistered.runs).toEqual([{ runId: 'run_legacy', repositoryIds: [] }]);
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
