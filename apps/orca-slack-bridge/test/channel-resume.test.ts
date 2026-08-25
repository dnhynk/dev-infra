import { describe, expect, it } from 'vitest';

import {
  detectGateResumeEvidence,
  normalizeGateResumeSnapshot,
  readGateResumeSnapshot,
} from '../src/channel/resume.js';
import {
  readExactResumeDispatch,
  readStrictResumeWorkers,
  type OrcaRunner,
} from '../src/orca/client.js';
import type { GateResumeSnapshot } from '../src/gate/resolution-types.js';

const RUN = 'run_resume';
const SOURCE_TASK = 'task_source';
const SOURCE_DISPATCH = 'ctx_source';

function ok(result: unknown): string {
  return JSON.stringify({ id: 'response', ok: true, result });
}

class ResumeOrca implements OrcaRunner {
  constructor(
    readonly tasks: readonly Record<string, unknown>[],
    readonly workers: readonly Record<string, unknown>[],
    readonly dispatch: Record<string, unknown> | null = null,
    readonly counts: Record<string, unknown> = workers.length === 0
      ? {}
      : { release_unknown: workers.length },
  ) {}

  run(args: readonly string[]): Promise<string> {
    if (args[1] === 'task-list') {
      return Promise.resolve(ok({
        runId: RUN,
        legacyReadOnly: false,
        count: this.tasks.length,
        tasks: this.tasks,
      }));
    }
    if (args[1] === 'worker-list') {
      return Promise.resolve(ok({ counts: this.counts, workers: this.workers }));
    }
    if (args[1] === 'dispatch-show') {
      if (this.dispatch !== null) return Promise.resolve(ok({ dispatch: this.dispatch }));
      const taskId = args[3];
      const matching = this.workers.filter((row) =>
        row['taskId'] === taskId &&
        (row['dispatchStatus'] === 'dispatched' || row['dispatchStatus'] === 'completed')
      );
      if (matching.length === 1) {
        return Promise.resolve(ok({ dispatch: {
          id: matching[0]!['dispatchId'],
          task_id: matching[0]!['taskId'],
          run_id: matching[0]!['runId'],
          status: matching[0]!['dispatchStatus'],
        } }));
      }
    }
    return Promise.reject(new Error(`unexpected ${args.join(' ')}`));
  }
}

function task(
  id: string,
  status: string,
  deps: readonly string[],
  dispatchId: string | null,
): Record<string, unknown> {
  return { id, run_id: RUN, status, deps: JSON.stringify(deps), dispatch_id: dispatchId };
}

function taskWithoutDispatch(
  id: string,
  status: string,
  deps: readonly string[],
): Record<string, unknown> {
  return { id, run_id: RUN, status, deps: JSON.stringify(deps) };
}

function worker(dispatchId: string, taskId: string, status: string): Record<string, unknown> {
  return { dispatchId, taskId, runId: RUN, dispatchStatus: status, resource: { secret: 'ignored' } };
}

function snapshot(candidates: GateResumeSnapshot['candidates']): GateResumeSnapshot {
  return normalizeGateResumeSnapshot({
    schemaVersion: 1,
    sourceTaskId: SOURCE_TASK,
    sourceDispatchId: SOURCE_DISPATCH,
    candidates,
  });
}

const baseline = snapshot([
  {
    taskId: SOURCE_TASK,
    status: 'completed',
    currentDispatchId: SOURCE_DISPATCH,
    dispatches: [{ dispatchId: SOURCE_DISPATCH, status: 'completed' }],
  },
  {
    taskId: 'task_followup',
    status: 'pending',
    currentDispatchId: null,
    dispatches: [],
  },
  {
    taskId: 'task_preexisting',
    status: 'completed',
    currentDispatchId: 'ctx_preexisting',
    dispatches: [{ dispatchId: 'ctx_preexisting', status: 'completed' }],
  },
]);
const sourceFact = baseline.candidates.find((candidate) => candidate.taskId === SOURCE_TASK)!;

describe('strict normalized Task/Dispatch resume evidence', () => {
  it('uses actual Orca terminal-state count buckets as a complete worker denominator', async () => {
    const workers = [
      worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed'),
      worker('ctx_retained', 'task_retained', 'failed'),
      worker('ctx_active', 'task_active', 'dispatched'),
    ];
    await expect(readStrictResumeWorkers(new ResumeOrca(
      [],
      workers,
      null,
      { release_unknown: 1, retained: 1, active: 1 },
    ), RUN)).resolves.toHaveLength(3);
  });

  it.each([
    ['string bucket', { release_unknown: '1' }],
    ['unsafe bucket', { release_unknown: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative bucket', { release_unknown: 2, active: -1 }],
    ['fractional bucket', { release_unknown: 0.5, active: 0.5 }],
    ['mismatched total', { release_unknown: 2 }],
    ['empty nonzero denominator', {}],
  ])('fails closed on malformed worker counts: %s', async (_label, counts) => {
    await expect(readStrictResumeWorkers(new ResumeOrca(
      [],
      [worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed')],
      null,
      counts,
    ), RUN)).rejects.toThrow(/counts/);
  });

  it('freezes source plus transitive descendants deterministically and excludes unrelated work', async () => {
    const result = await readGateResumeSnapshot(new ResumeOrca(
      [
        task('task_unrelated', 'dispatched', [], 'ctx_unrelated'),
        task('task_grandchild', 'ready', ['task_followup'], null),
        task(SOURCE_TASK, 'completed', [], SOURCE_DISPATCH),
        task('task_followup', 'pending', [SOURCE_TASK], null),
      ],
      [
        worker('ctx_unrelated', 'task_unrelated', 'dispatched'),
        worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed'),
      ],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH });

    expect(result.candidates.map((candidate) => candidate.taskId)).toEqual([
      'task_followup',
      'task_grandchild',
      SOURCE_TASK,
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result).toEqual(normalizeGateResumeSnapshot(result));
  });

  it('fails closed on duplicate identities and broken current Dispatch correlation', async () => {
    await expect(readGateResumeSnapshot(new ResumeOrca(
      [task(SOURCE_TASK, 'completed', [], SOURCE_DISPATCH)],
      [
        worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed'),
        worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed'),
      ],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /중복 Dispatch/,
    );

    await expect(readGateResumeSnapshot(new ResumeOrca(
      [task(SOURCE_TASK, 'completed', [], 'ctx_missing')],
      [worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed')],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /currentDispatchId/,
    );
  });

  it('fails closed on both directions of stable Task/worker skew', async () => {
    // The worker row is newer than both bracketing Task reads.
    await expect(readGateResumeSnapshot(new ResumeOrca(
      [
        taskWithoutDispatch(SOURCE_TASK, 'completed', []),
        taskWithoutDispatch('task_followup', 'pending', [SOURCE_TASK]),
      ],
      [
        worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed'),
        worker('ctx_followup', 'task_followup', 'dispatched'),
      ],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /current worker correlation/,
    );

    // Both Task reads are newer than the worker history cut.
    await expect(readGateResumeSnapshot(new ResumeOrca(
      [
        taskWithoutDispatch(SOURCE_TASK, 'completed', []),
        task('task_followup', 'dispatched', [SOURCE_TASK], 'ctx_followup'),
      ],
      [worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed')],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /current worker correlation|currentDispatchId/,
    );
  });

  it('fails closed on unknown Task, worker, and exact Dispatch statuses', async () => {
    await expect(readGateResumeSnapshot(new ResumeOrca(
      [task(SOURCE_TASK, 'unexpected', [], SOURCE_DISPATCH)],
      [worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed')],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /알려진 Orca status/,
    );

    await expect(readGateResumeSnapshot(new ResumeOrca(
      [task(SOURCE_TASK, 'completed', [], SOURCE_DISPATCH)],
      [worker(SOURCE_DISPATCH, SOURCE_TASK, 'unexpected')],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /알려진 Orca status/,
    );

    await expect(readExactResumeDispatch(new ResumeOrca([], [], {
      id: SOURCE_DISPATCH,
      task_id: SOURCE_TASK,
      run_id: RUN,
      status: 'unexpected',
    }), {
      runId: RUN,
      taskId: SOURCE_TASK,
      dispatchId: SOURCE_DISPATCH,
    })).rejects.toThrow(/알려진 Orca status/);
  });

  it('accepts the Orca 1.4.187 omitted dispatch_id shape but requires it for dispatched Tasks', async () => {
    const actualShape = await readGateResumeSnapshot(new ResumeOrca(
      [
        taskWithoutDispatch(SOURCE_TASK, 'completed', []),
        taskWithoutDispatch('task_followup', 'pending', [SOURCE_TASK]),
      ],
      [worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed')],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH });
    expect(actualShape.candidates).toMatchObject([
      { taskId: SOURCE_TASK, status: 'completed', currentDispatchId: null },
      { taskId: 'task_followup', status: 'pending', currentDispatchId: null },
    ].sort((a, b) => a.taskId.localeCompare(b.taskId)));

    await expect(readGateResumeSnapshot(new ResumeOrca(
      [
        taskWithoutDispatch(SOURCE_TASK, 'completed', []),
        taskWithoutDispatch('task_followup', 'dispatched', [SOURCE_TASK]),
      ],
      [worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed')],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /dispatched 상태에서 없다/,
    );
    await expect(readGateResumeSnapshot(new ResumeOrca(
      [
        taskWithoutDispatch(SOURCE_TASK, 'completed', []),
        task('task_followup', 'dispatched', [SOURCE_TASK], null),
      ],
      [worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed')],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /dispatched 상태에서 없다/,
    );
    await expect(readGateResumeSnapshot(new ResumeOrca(
      [
        taskWithoutDispatch(SOURCE_TASK, 'completed', []),
        {
          ...taskWithoutDispatch('task_followup', 'pending', [SOURCE_TASK]),
          dispatch_id: 7,
        },
      ],
      [worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed')],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /string\/null/,
    );
  });

  it.each(['dispatched', 'completed'] as const)(
    'detects one new %s Dispatch when completed Task dispatch_id is omitted',
    async (dispatchStatus) => {
      const before = await readGateResumeSnapshot(new ResumeOrca(
        [
          taskWithoutDispatch(SOURCE_TASK, 'completed', []),
          taskWithoutDispatch('task_followup', 'pending', [SOURCE_TASK]),
        ],
        [worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed')],
      ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH });
      const after = await readGateResumeSnapshot(new ResumeOrca(
        [
          taskWithoutDispatch(SOURCE_TASK, 'completed', []),
          taskWithoutDispatch('task_followup', 'completed', [SOURCE_TASK]),
        ],
        [
          worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed'),
          worker('ctx_followup', 'task_followup', dispatchStatus),
        ],
      ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH });
      expect(detectGateResumeEvidence(before, after)).toEqual({
        kind: 'new_dispatch',
        taskId: 'task_followup',
        dispatchId: 'ctx_followup',
        fromStatus: 'pending',
        toStatus: dispatchStatus,
      });
      await expect(readExactResumeDispatch(new ResumeOrca([], [], {
        id: 'ctx_followup', task_id: 'task_followup', run_id: RUN, status: dispatchStatus,
      }), {
        runId: RUN, taskId: 'task_followup', dispatchId: 'ctx_followup',
      })).resolves.toMatchObject({ status: dispatchStatus });
    },
  );

  it('rejects zero, multiple, pre-existing, and failed omitted-current witnesses', () => {
    const omittedBaseline = snapshot([
      {
        taskId: SOURCE_TASK,
        status: 'completed',
        currentDispatchId: null,
        dispatches: [{ dispatchId: SOURCE_DISPATCH, status: 'completed' }],
      },
      {
        taskId: 'task_followup', status: 'pending', currentDispatchId: null, dispatches: [],
      },
    ]);
    const omittedSource = omittedBaseline.candidates.find(
      (candidate) => candidate.taskId === SOURCE_TASK,
    )!;
    const followup = (dispatches: GateResumeSnapshot['candidates'][number]['dispatches']) =>
      snapshot([
        omittedSource,
        { taskId: 'task_followup', status: 'completed', currentDispatchId: null, dispatches },
      ]);
    expect(detectGateResumeEvidence(omittedBaseline, followup([]))).toBeNull();
    expect(detectGateResumeEvidence(omittedBaseline, followup([
      { dispatchId: 'ctx_one', status: 'completed' },
      { dispatchId: 'ctx_two', status: 'completed' },
    ]))).toBeNull();
    expect(detectGateResumeEvidence(followup([
      { dispatchId: 'ctx_old', status: 'completed' },
    ]), followup([
      { dispatchId: 'ctx_old', status: 'completed' },
    ]))).toBeNull();
    const baselineWithHistory = snapshot([
      omittedSource,
      {
        taskId: 'task_followup', status: 'pending', currentDispatchId: null,
        dispatches: [{ dispatchId: 'ctx_old', status: 'completed' }],
      },
    ]);
    expect(detectGateResumeEvidence(baselineWithHistory, followup([
      { dispatchId: 'ctx_old', status: 'completed' },
      { dispatchId: 'ctx_new', status: 'completed' },
    ]))).toMatchObject({
      kind: 'new_dispatch', taskId: 'task_followup', dispatchId: 'ctx_new',
    });
    expect(detectGateResumeEvidence(omittedBaseline, followup([
      { dispatchId: 'ctx_failed', status: 'failed' },
    ]))).toBeNull();
  });

  it('accepts only one new current dispatched/completed Dispatch in the candidate closure', () => {
    const latest = snapshot([
      ...baseline.candidates.filter((candidate) => candidate.taskId !== 'task_followup'),
      {
        taskId: 'task_followup',
        status: 'dispatched',
        currentDispatchId: 'ctx_followup',
        dispatches: [{ dispatchId: 'ctx_followup', status: 'dispatched' }],
      },
    ]);
    expect(detectGateResumeEvidence(baseline, latest)).toEqual({
      kind: 'new_dispatch',
      taskId: 'task_followup',
      dispatchId: 'ctx_followup',
      fromStatus: 'pending',
      toStatus: 'dispatched',
    });
  });

  it('accepts one unambiguous non-running to running transition on the same Dispatch', async () => {
    const before = snapshot([
      sourceFact,
      {
        taskId: 'task_followup',
        status: 'ready',
        currentDispatchId: null,
        dispatches: [{ dispatchId: 'ctx_reserved', status: 'failed' }],
      },
    ]);
    const after = snapshot([
      sourceFact,
      {
        taskId: 'task_followup',
        status: 'completed',
        currentDispatchId: null,
        dispatches: [{ dispatchId: 'ctx_reserved', status: 'completed' }],
      },
    ]);
    expect(detectGateResumeEvidence(before, after)).toMatchObject({
      kind: 'status_transition',
      taskId: 'task_followup',
      dispatchId: 'ctx_reserved',
      fromStatus: 'ready',
      toStatus: 'completed',
    });

    const noDispatchBefore = snapshot([sourceFact, {
      taskId: 'task_followup', status: 'ready', currentDispatchId: null, dispatches: [],
    }]);
    const noDispatchAfter = snapshot([sourceFact, {
      taskId: 'task_followup', status: 'completed', currentDispatchId: null, dispatches: [],
    }]);
    expect(detectGateResumeEvidence(noDispatchBefore, noDispatchAfter)).toBeNull();

    const ambiguousDispatches = [
      { dispatchId: 'ctx_old_one', status: 'completed' },
      { dispatchId: 'ctx_old_two', status: 'completed' },
    ];
    const ambiguousBefore = snapshot([sourceFact, {
      taskId: 'task_followup', status: 'ready', currentDispatchId: null,
      dispatches: ambiguousDispatches,
    }]);
    const ambiguousAfter = snapshot([sourceFact, {
      taskId: 'task_followup', status: 'completed', currentDispatchId: null,
      dispatches: ambiguousDispatches,
    }]);
    expect(detectGateResumeEvidence(ambiguousBefore, ambiguousAfter)).toBeNull();

    const twoTransitionsBefore = snapshot([sourceFact, {
      taskId: 'task_followup', status: 'ready', currentDispatchId: null,
      dispatches: [
        { dispatchId: 'ctx_failed_one', status: 'failed' },
        { dispatchId: 'ctx_failed_two', status: 'circuit_broken' },
      ],
    }]);
    const twoTransitionsAfter = snapshot([sourceFact, {
      taskId: 'task_followup', status: 'completed', currentDispatchId: null,
      dispatches: [
        { dispatchId: 'ctx_failed_one', status: 'completed' },
        { dispatchId: 'ctx_failed_two', status: 'completed' },
      ],
    }]);
    expect(detectGateResumeEvidence(twoTransitionsBefore, twoTransitionsAfter)).toBeNull();

    const rereadBefore = await readGateResumeSnapshot(new ResumeOrca(
      [
        task(SOURCE_TASK, 'completed', [], SOURCE_DISPATCH),
        taskWithoutDispatch('task_followup', 'ready', [SOURCE_TASK]),
      ],
      [
        worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed'),
        worker('ctx_reserved', 'task_followup', 'failed'),
      ],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH });
    const rereadAfter = await readGateResumeSnapshot(new ResumeOrca(
      [
        task(SOURCE_TASK, 'completed', [], SOURCE_DISPATCH),
        taskWithoutDispatch('task_followup', 'completed', [SOURCE_TASK]),
      ],
      [
        worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed'),
        worker('ctx_reserved', 'task_followup', 'completed'),
      ],
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH });
    expect(detectGateResumeEvidence(rereadBefore, rereadAfter)).toMatchObject({
      kind: 'status_transition',
      taskId: 'task_followup',
      dispatchId: 'ctx_reserved',
    });
  });

  it('rejects Task catch-up to a Dispatch that was already completed in the baseline', () => {
    const before = snapshot([sourceFact, {
      taskId: 'task_followup', status: 'pending', currentDispatchId: 'ctx_existing',
      dispatches: [{ dispatchId: 'ctx_existing', status: 'completed' }],
    }]);
    const after = snapshot([sourceFact, {
      taskId: 'task_followup', status: 'completed', currentDispatchId: null,
      dispatches: [{ dispatchId: 'ctx_existing', status: 'completed' }],
    }]);
    expect(detectGateResumeEvidence(before, after)).toBeNull();
  });

  it('fails the whole cut when an omitted completed Task current Dispatch is absent or skewed', async () => {
    const tasks = [
      task(SOURCE_TASK, 'completed', [], SOURCE_DISPATCH),
      taskWithoutDispatch('task_followup', 'completed', [SOURCE_TASK]),
    ];
    const sourceWorker = worker(SOURCE_DISPATCH, SOURCE_TASK, 'completed');
    await expect(readGateResumeSnapshot(new ResumeOrca(
      tasks,
      [sourceWorker],
      { id: 'ctx_hidden', task_id: 'task_followup', run_id: RUN, status: 'completed' },
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /omitted current Dispatch correlation/,
    );
    await expect(readGateResumeSnapshot(new ResumeOrca(
      tasks,
      [sourceWorker, worker('ctx_visible', 'task_followup', 'completed')],
      { id: 'ctx_other', task_id: 'task_followup', run_id: RUN, status: 'completed' },
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /omitted current Dispatch correlation/,
    );
    await expect(readGateResumeSnapshot(new ResumeOrca(
      tasks,
      [sourceWorker, worker('ctx_visible', 'task_followup', 'completed')],
      { id: 'ctx_visible', task_id: 'task_followup', run_id: RUN, status: 'dispatched' },
    ), { runId: RUN, taskId: SOURCE_TASK, dispatchId: SOURCE_DISPATCH })).rejects.toThrow(
      /omitted current Dispatch correlation/,
    );
  });

  it.each([
    ['ready only', baseline, snapshot(baseline.candidates.map((candidate) =>
      candidate.taskId === 'task_followup' ? { ...candidate, status: 'ready' } : candidate))],
    ['pre-existing dispatched', baseline, baseline],
    ['failed new Dispatch', baseline, snapshot([
      ...baseline.candidates,
      {
        taskId: 'task_new', status: 'failed', currentDispatchId: 'ctx_failed',
        dispatches: [{ dispatchId: 'ctx_failed', status: 'failed' }],
      },
    ])],
    ['same Dispatch activity', snapshot([
      sourceFact,
      {
        taskId: 'task_followup', status: 'dispatched', currentDispatchId: 'ctx_same',
        dispatches: [{ dispatchId: 'ctx_same', status: 'dispatched' }],
      },
    ]), snapshot([
      sourceFact,
      {
        taskId: 'task_followup', status: 'dispatched', currentDispatchId: 'ctx_same',
        dispatches: [{ dispatchId: 'ctx_same', status: 'dispatched' }],
      },
    ])],
  ])('rejects false-positive case %s', (_label, before, after) => {
    expect(detectGateResumeEvidence(before, after)).toBeNull();
  });

  it('rejects ambiguous simultaneous resume witnesses', () => {
    const latest = snapshot([
      sourceFact,
      {
        taskId: 'task_followup', status: 'dispatched', currentDispatchId: 'ctx_one',
        dispatches: [{ dispatchId: 'ctx_one', status: 'dispatched' }],
      },
      {
        taskId: 'task_second', status: 'completed', currentDispatchId: 'ctx_two',
        dispatches: [{ dispatchId: 'ctx_two', status: 'completed' }],
      },
    ]);
    expect(detectGateResumeEvidence(baseline, latest)).toBeNull();
  });

  it('strictly confirms the exact Task/Dispatch identity before positive persistence', async () => {
    const runner = new ResumeOrca([], [], {
      id: 'ctx_followup', task_id: 'task_followup', run_id: RUN, status: 'dispatched',
    });
    await expect(readExactResumeDispatch(runner, {
      runId: RUN, taskId: 'task_followup', dispatchId: 'ctx_followup',
    })).resolves.toEqual({
      runId: RUN, taskId: 'task_followup', dispatchId: 'ctx_followup', status: 'dispatched',
    });
    await expect(readExactResumeDispatch(runner, {
      runId: RUN, taskId: 'task_followup', dispatchId: 'ctx_other',
    })).rejects.toThrow(/correlation/);
  });
});
