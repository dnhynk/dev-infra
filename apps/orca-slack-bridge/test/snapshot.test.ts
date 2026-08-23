import { describe, it, expect } from 'vitest';
import { buildCorrelationView, collectRuns, summarize, type Snapshot } from '../src/snapshot/snapshot.js';
import type { OrcaRunner } from '../src/orca/client.js';

/** 실측 형태를 그대로 흉내낸 합성 fixture (DL-023). */
class FakeOrca implements OrcaRunner {
  readonly calls: string[][] = [];
  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const wrap = (result: unknown) => JSON.stringify({ id: 'x', ok: true, result });
    if (args[1] === 'run-list') {
      return wrap({
        runs: [
          {
            id: 'run_legacy_local', objective: 'Legacy orchestration state (inspect only)',
            coordinator_handle: null, coordinator_pane_key: null, legacy: 1,
            created_at: '2026-08-21T11:34:41Z', updated_at: '2026-08-21T11:34:41Z',
          },
          {
            id: 'run_a48566be983b', objective: 'demo',
            coordinator_handle: 'term_720b6c26', coordinator_pane_key: 'f39db44b:8c71884b', legacy: 0,
            created_at: '2026-08-21T14:32:45Z', updated_at: '2026-08-21T14:32:45Z',
          },
        ],
      });
    }
    if (args[1] === 'task-list') {
      return wrap({
        tasks: [{
          id: 'task_cd1991c049a8', run_id: 'run_a48566be983b',
          task_title: 'demo task', display_name: 'demo task', status: 'ready',
          deps: '[]', result: '{"kind":"reviewer_result","verdict":"approve"}',
          created_by_process_incarnation: 'ccb3c8ee::D:/dev-infra@@8c25bfec:f126ab2a',
          created_at: '2026-08-21 14:32:57',
        }],
      });
    }
    if (args[1] === 'gate-list') {
      return wrap({
        gates: [{
          id: 'gate_ac624dad74b5', run_id: 'run_a48566be983b', task_id: 'task_cd1991c049a8',
          question: 'q', options: '["A","B"]', status: 'pending', resolution: null,
          created_at: '2026-08-21 14:33:10', resolved_at: null,
        }],
      });
    }
    throw new Error('예상치 못한 호출: ' + args.join(' '));
  }
}

describe('collectRuns', () => {
  it('legacy Run에는 Task/Gate 조회를 하지 않는다', async () => {
    const orca = new FakeOrca();
    const runs = await collectRuns(orca);
    expect(runs).toHaveLength(2);
    const legacy = runs.find((r) => r.run.id === 'run_legacy_local');
    expect(legacy?.run.legacy).toBe(true);
    expect(legacy?.tasks).toEqual([]);
    const queried = orca.calls.filter((c) => c[1] === 'task-list').map((c) => c[3]);
    expect(queried).toEqual(['run_a48566be983b']);
  });

  it('JSON 문자열 필드를 파싱해 넘긴다', async () => {
    const runs = await collectRuns(new FakeOrca());
    const live = runs.find((r) => r.run.id === 'run_a48566be983b');
    expect(live?.tasks[0]?.deps).toEqual({ kind: 'value', value: [] });
    const result = live?.tasks[0]?.result;
    expect(result?.kind === 'value' && (result.value as { verdict: string }).verdict).toBe('approve');
    expect(live?.gates[0]?.options).toEqual({ kind: 'value', value: ['A', 'B'] });
  });

  it('task에서 worktree 경로를 모은다', async () => {
    const runs = await collectRuns(new FakeOrca());
    expect(runs.find((r) => r.run.id === 'run_a48566be983b')?.worktreePaths).toEqual(['D:/dev-infra']);
  });

  it('--ack를 절대 호출하지 않는다', async () => {
    const orca = new FakeOrca();
    await collectRuns(orca);
    expect(orca.calls.flat()).not.toContain('--ack');
    expect(orca.calls.flat()).not.toContain('check');
  });
});

describe('buildCorrelationView', () => {
  it('run과 task 소속을 색인한다', async () => {
    const view = buildCorrelationView(await collectRuns(new FakeOrca()));
    expect(view.runIds.has('run_a48566be983b')).toBe(true);
    expect(view.taskToRun.get('task_cd1991c049a8')).toBe('run_a48566be983b');
  });
});

describe('summarize', () => {
  /**
   * Run 줄이 읽지 못한 칸을 드러낸다(OD-079).
   *
   * `snapshot`은 inbox를 읽지 않으므로 여기 나오는 것은 task와 gate의 칸이다. 읽지 못한 것을
   * 없는 것처럼 세면 관측이 조용히 관대해진다.
   */
  it('읽지 못한 task·gate 칸을 Run 줄에 드러낸다', () => {
    const s: Snapshot = {
      observedAt: '2026-08-24T00:00:00.000Z',
      runs: [{
        run: {
          id: 'run_59bccb319e7f', objective: 'probe', coordinatorHandle: null,
          coordinatorPaneKey: null, legacy: false,
          createdAt: new Date('2026-08-23T04:50:00Z'), updatedAt: new Date('2026-08-23T04:52:36Z'),
        },
        tasks: [
          {
            id: 'task_5694362d24f8', runId: 'run_59bccb319e7f', title: 'probe', status: 'completed',
            deps: { kind: 'value', value: [] },
            result: { kind: 'unreadable', reason: 'JSON 필드를 파싱할 수 없다: {kind:reviewer_result' },
            worktreePath: null, createdAt: new Date('2026-08-23T04:50:32Z'), completedAt: null,
          },
          {
            id: 'task_ok0000000001', runId: 'run_59bccb319e7f', title: 'ok', status: 'completed',
            deps: { kind: 'value', value: [] },
            result: { kind: 'value', value: null },
            worktreePath: null, createdAt: new Date('2026-08-23T04:55:00Z'), completedAt: null,
          },
        ],
        gates: [{
          id: 'gate_badoptions1', runId: 'run_59bccb319e7f', taskId: 'task_5694362d24f8',
          question: 'q', options: { kind: 'unreadable', reason: 'JSON 필드를 파싱할 수 없다: [A,B]' },
          status: 'pending', resolution: null,
          createdAt: new Date('2026-08-23T04:51:00Z'), resolvedAt: null,
        }],
        worktreePaths: [],
      }],
      repositories: [],
    };
    const out = summarize(s);
    expect(out).toContain('unreadable=task_5694362d24f8.result,gate_badoptions1.options');
    // 읽은 row는 그대로 세어진다. 봉쇄가 관측을 줄이지 않는다.
    expect(out).toContain('tasks=2 gates=1 open=1');
  });

  it('미매핑 repository를 숨기지 않고 드러낸다', () => {
    const s: Snapshot = {
      observedAt: '2026-08-22T00:00:00.000Z',
      runs: [],
      repositories: [{
        repository: { key: 'repo:1', githubId: 1, nameWithOwner: 'o/r' },
        project: null,
        pullRequests: [
          { pr: { key: 'pr:1#1', number: 1, title: 't', body: '', url: '', state: 'OPEN', isDraft: false,
                  headRefName: 'h', headRefOid: 'sha', baseRefName: 'b', mergedAt: null,
                  reviewDecision: null, reviews: [], checks: [], checksHeadOid: 'sha',
                  requiredRules: { branch: 'b', contexts: [], branchProtection: 'absent', repositoryRuleset: 'absent' },
                  requiredChecks: [],
                  changedPaths: [], changedFilesTotal: 0 },
            correlation: { kind: 'uncorrelated', reason: 'no_metadata' } },
        ],
      }],
    };
    const out = summarize(s);
    expect(out).toContain('project=UNMAPPED');
    expect(out).toContain('uncorrelated:no_metadata=1');
  });
});
