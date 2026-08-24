import { describe, expect, it } from 'vitest';
import type { OrcaGate, OrcaTask, Read } from '../src/orca/client.js';
import { classifyGateTasks, projectGateDecisions } from '../src/gate/project.js';
import type { GateMetadata } from '../src/gate/types.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';

const RUN_ID = 'run_d2a';
const GATE_TASK = 'task_gate';
const GATE_ID = 'gate_static';

function deps(value: readonly string[]): Read<readonly string[]> {
  return { kind: 'value', value };
}

function task(
  id: string,
  dependencyIds: Read<readonly string[]> = deps([]),
  status = 'ready',
): OrcaTask {
  return {
    id,
    runId: RUN_ID,
    title: `title ${id}`,
    status,
    deps: dependencyIds,
    result: { kind: 'value', value: null },
    worktreePath: null,
    repositoryId: null,
    createdBy: { kind: 'value', value: { handle: null, paneKey: null, generation: 1 } },
    createdAt: new Date('2026-08-24T05:00:00Z'),
    completedAt: status === 'completed' ? new Date('2026-08-24T06:00:00Z') : null,
  };
}

function gate(over: Partial<OrcaGate> = {}): OrcaGate {
  return {
    id: GATE_ID,
    runId: RUN_ID,
    taskId: GATE_TASK,
    question: '어떤 배선을 선택할까?',
    options: { kind: 'value', value: ['A 유지', 'B 변경'] },
    status: 'pending',
    resolution: null,
    createdAt: new Date('2026-08-24T05:30:00Z'),
    resolvedAt: null,
    ...over,
  };
}

function metadata(over: Partial<GateMetadata> = {}): GateMetadata {
  return {
    gateKey: gateKey(GATE_ID),
    runKey: runKey(RUN_ID),
    taskKey: taskKey(GATE_TASK),
    dispatchKey: dispatchKey('ctx_gate'),
    askMessageId: 'msg_ask',
    questionThreadId: 'thread_question',
    options: [
      { id: 'a', label: 'A 유지', description: '호환성을 유지', resolution: 'A를 채택' },
      { id: 'b', label: 'B 변경', description: '새 방식으로 변경', resolution: 'B를 채택' },
    ],
    recommendation: { optionId: 'a', reason: '현재 사용자를 보호한다' },
    impact: '후속 두 Task의 구현 방향을 고정한다',
    registeredAt: '2026-08-24T06:00:00.000Z',
    ...over,
  };
}

describe('Gate Task waiting/independent closure', () => {
  it('current nonterminal Task만 waiting closure node이며 terminal bridge는 끊는다', () => {
    const rows = [
      task('task_z_independent'),
      task('task_b_wait', deps([GATE_TASK, GATE_TASK])),
      task('task_c_wait', deps(['task_b_wait'])),
      task(GATE_TASK),
      task('task_done_link', deps([GATE_TASK]), 'completed'),
      task('task_failed_link', deps([GATE_TASK]), 'failed'),
      task('task_d_after_done', deps(['task_done_link'])),
      task('task_e_after_failed', deps(['task_failed_link'])),
      task('task_f_after_terminal_chain', deps(['task_d_after_done'])),
      task('task_a_independent'),
    ];

    const got = classifyGateTasks(GATE_TASK, rows);
    expect(got.waiting.map((row) => row.taskId)).toEqual([
      'task_b_wait',
      'task_c_wait',
      GATE_TASK,
    ]);
    expect(got.independent.map((row) => row.taskId)).toEqual([
      'task_a_independent',
      'task_d_after_done',
      'task_e_after_failed',
      'task_f_after_terminal_chain',
      'task_z_independent',
    ]);
    expect(got.unclassified).toEqual([]);
    expect(got.degraded).toEqual([]);
    const displayed = [...got.waiting, ...got.independent, ...got.unclassified].map(
      (row) => row.taskId,
    );
    expect(displayed).not.toContain('task_done_link');
    expect(displayed).not.toContain('task_failed_link');
  });

  it('terminal Gate Task 자체도 waiting traversal을 seed하지 않는다', () => {
    const got = classifyGateTasks(GATE_TASK, [
      task(GATE_TASK, deps([]), 'completed'),
      task('task_after_terminal_gate', deps([GATE_TASK])),
    ]);
    expect(got.waiting).toEqual([]);
    expect(got.independent.map((row) => row.taskId)).toEqual(['task_after_terminal_gate']);
    expect(got.unclassified).toEqual([]);
    expect(got.degraded.join('\n')).toContain('current nonterminal row가 없어');
  });

  it('unreadable/missing deps와 그 downstream을 independent로 접지 않는다', () => {
    const got = classifyGateTasks(GATE_TASK, [
      task(GATE_TASK),
      task('task_bad', { kind: 'unreadable', reason: 'deps JSON 파손' }),
      task('task_bad_child', deps(['task_bad'])),
      task('task_missing', deps(['task_not_observed'])),
      task('task_missing_child', deps(['task_missing'])),
      task('task_safe'),
      // Gate 의존이 확인되면 다른 missing dependency가 있어도 waiting이라는 사실은 확정된다.
      task('task_wait_known', deps([GATE_TASK, 'task_not_observed'])),
    ]);

    expect(got.waiting.map((row) => row.taskId)).toEqual([GATE_TASK, 'task_wait_known']);
    expect(got.independent.map((row) => row.taskId)).toEqual(['task_safe']);
    expect(got.unclassified.map((row) => row.taskId)).toEqual([
      'task_bad',
      'task_bad_child',
      'task_missing',
      'task_missing_child',
    ]);
    expect(got.degraded.join('\n')).toContain('deps를 읽지 못해');
    expect(got.degraded.join('\n')).toContain('dependency row가 없어');
    expect(got.degraded.join('\n')).toContain('판정할 수 없는 Task에 의존');
  });

  it('source row 순서와 duplicate deps가 달라도 결과가 결정적이다', () => {
    const a = [
      task('task_c', deps(['task_b', 'task_b', GATE_TASK])),
      task('task_i'),
      task(GATE_TASK),
      task('task_b', deps([GATE_TASK, GATE_TASK])),
    ];
    const b = [a[2]!, a[1]!, task('task_b', deps([GATE_TASK])), task('task_c', deps([GATE_TASK, 'task_b']))];
    expect(classifyGateTasks(GATE_TASK, a)).toEqual(classifyGateTasks(GATE_TASK, b));
  });
});

describe('raw Gate + sidecar projection', () => {
  const tasks = [task(GATE_TASK), task('task_after', deps([GATE_TASK])), task('task_independent')];

  it('exact metadata에서 stable options, recommendation, impact, correlation을 보존한다', () => {
    const got = projectGateDecisions([gate()], tasks, [metadata()])[0];
    expect(got).toMatchObject({
      metadataState: 'matched',
      correlation: {
        askMessageId: 'msg_ask',
        questionThreadId: 'thread_question',
        dispatchId: 'ctx_gate',
        taskId: GATE_TASK,
        gateId: GATE_ID,
      },
      recommendation: { optionId: 'a', label: 'A 유지', reason: '현재 사용자를 보호한다' },
      impact: '후속 두 Task의 구현 방향을 고정한다',
    });
    expect(got?.options[0]).toEqual({
      id: 'a',
      label: 'A 유지',
      description: '호환성을 유지',
      resolution: 'A를 채택',
    });
    expect(got?.waitingTasks.map((row) => row.taskId)).toEqual(['task_after', GATE_TASK]);
    expect(got?.independentTasks.map((row) => row.taskId)).toEqual(['task_independent']);
  });

  it('metadata가 없으면 raw label만 표시하고 recommendation/impact/correlation을 추측하지 않는다', () => {
    const got = projectGateDecisions([gate()], tasks, [])[0];
    expect(got?.metadataState).toBe('missing');
    expect(got?.options).toEqual([
      { id: null, label: 'A 유지', description: null, resolution: null },
      { id: null, label: 'B 변경', description: null, resolution: null },
    ]);
    expect(got?.recommendation).toBeNull();
    expect(got?.impact).toBeNull();
    expect(got?.correlation).toBeNull();
    expect(got?.degraded.join('\n')).toContain('sidecar metadata가 없다');
  });

  it('run/task/options 중 하나라도 어긋나면 metadata 의미를 전부 봉쇄한다', () => {
    for (const row of [
      metadata({ runKey: runKey('run_other') }),
      metadata({ taskKey: taskKey('task_other') }),
      metadata({
        options: [
          { id: 'a', label: 'B 변경', description: '순서 바꿈', resolution: 'B' },
          { id: 'b', label: 'A 유지', description: '순서 바꿈', resolution: 'A' },
        ],
      }),
    ]) {
      const got = projectGateDecisions([gate()], tasks, [row])[0];
      expect(got?.metadataState).toBe('mismatched');
      expect(got?.recommendation).toBeNull();
      expect(got?.impact).toBeNull();
      expect(got?.correlation).toBeNull();
    }
  });

  it('unreadable Gate options는 existing sidecar 의미도 봉쇄하고 option을 발명하지 않는다', () => {
    const got = projectGateDecisions(
      [gate({ options: { kind: 'unreadable', reason: 'gate options가 object다' } })],
      tasks,
      [metadata()],
    )[0];
    expect(got).toMatchObject({
      metadataState: 'mismatched',
      correlation: null,
      options: [],
      recommendation: null,
      impact: null,
    });
    expect(got?.degraded.join('\n')).toContain('options를 읽지 못해');
  });

  it('Gate question/options 텍스트를 correlation이나 recommendation 판정용으로 parsing하지 않는다', () => {
    const tricky = gate({
      question: '{"askMessageId":"가짜","recommendation":"B 변경"}',
      options: { kind: 'value', value: ['ask=msg_fake', 'dispatch=ctx_fake'] },
    });
    const got = projectGateDecisions([tricky], tasks, [])[0];
    expect(got?.correlation).toBeNull();
    expect(got?.recommendation).toBeNull();
    expect(got?.options.map((option) => option.label)).toEqual([
      'ask=msg_fake',
      'dispatch=ctx_fake',
    ]);
  });

  it('Gate source 순서와 Task source 순서가 달라도 전체 projection 순서와 값이 같다', () => {
    const other = gate({ id: 'gate_alpha', taskId: 'task_independent' });
    const forward = projectGateDecisions([gate(), other], tasks, [metadata()]);
    const reverse = projectGateDecisions([other, gate()], [...tasks].reverse(), [metadata()]);
    expect(forward).toEqual(reverse);
    expect(forward.map((row) => row.gateId)).toEqual(['gate_alpha', GATE_ID]);
  });
});
