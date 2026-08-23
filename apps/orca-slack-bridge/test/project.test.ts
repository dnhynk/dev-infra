import { describe, it, expect } from 'vitest';
import {
  capFindings,
  pickReviewerResult,
  pickWorkerReport,
  projectPullRequest,
  type OrcaFacts,
} from '../src/digest/project.js';
import { deriveDigestStatus, deriveTerminal } from '../src/digest/state.js';
import type { ProjectedPr } from '../src/digest/types.js';
import {
  INBOX_LIMIT,
  listWorkerDone,
  listTasks,
  parseReviewerResult,
  type OrcaRunner,
  type WorkerDoneInbox,
  type WorkerDoneMessage,
} from '../src/orca/client.js';
import { repositoryIdentity } from '../src/identity/repository.js';
import { pullRequestKey, runKey, taskKey } from '../src/identity/keys.js';
import type { PullRequestFacts } from '../src/github/pull-request.js';
import type { Correlation } from '../src/correlate/resolve.js';
import { DEFAULT_CORRELATION_KEYS, type BridgeConfig } from '../src/project/config.js';

const REPO = repositoryIdentity(1042577813, 'dnhynk/dev-infra');

const CONFIG: BridgeConfig = {
  slack: null,
  projects: [{ name: 'dev-infra', repositories: ['dnhynk/dev-infra'] }],
  correlationKeys: DEFAULT_CORRELATION_KEYS,
};

const CORRELATED: Correlation = {
  kind: 'correlated',
  run: runKey('run_7804be5a654f'),
  task: taskKey('task_56972eaff901'),
  dispatch: null,
};

function pr(over: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    key: pullRequestKey(REPO.githubId, 1),
    number: 1,
    title: 'feat(c1): PR digest 카드 계약과 durable store 스키마',
    body: '본문\n\n<!-- orca-run: run_7804be5a654f -->\n<!-- orca-task: task_56972eaff901 -->',
    url: 'https://github.com/dnhynk/dev-infra/pull/1',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat/c1-contract',
    headRefOid: '7e9479ebdebe35fc9956b65c0f851ff096c56130',
    baseRefName: 'main',
    mergedAt: null,
    reviewDecision: null,
    reviewCount: 0,
    checks: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    changedPaths: ['apps/orca-slack-bridge/src/digest/types.ts'],
    changedFilesTotal: 1,
    ...over,
  };
}

/**
 * 실측 형태를 그대로 흉내낸 합성 fixture (DL-023).
 *
 * 구조는 `orca orchestration task-list --run run_7804be5a654f --json`과
 * `orca orchestration inbox --limit 200 --json`을 실제로 실행해 확인한 것이다.
 * 값만 지어냈다. 특히 다음이 실측된 사실이다.
 *
 * - task row의 `result`와 message row의 `payload`는 객체가 아니라 **JSON 문자열**이다.
 * - `completed_at`은 같은 응답 안에서 두 형식이 섞인다. worker_done으로 끝난 task는
 *   `2026-08-22 10:30:36`, `task-update --result`로 끝난 task는 `2026-08-22T10:57:33.666Z`다.
 * - `inbox` 응답은 `{ messages, count }`이고 heartbeat·question·status가 섞여 온다.
 * - worker_done의 taskId/dispatchId/outcome/filesModified는 `payload` 안에만 있다.
 */
class FakeOrca implements OrcaRunner {
  readonly calls: string[][] = [];
  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const wrap = (result: unknown): string => JSON.stringify({ id: 'x', ok: true, result });
    if (args[1] === 'task-list') {
      return wrap({
        runId: 'run_7804be5a654f',
        legacyReadOnly: false,
        count: 2,
        tasks: [
          {
            id: 'task_56972eaff901', run_id: 'run_7804be5a654f', parent_id: null,
            created_by_terminal_handle: 'term_0aa39c54', created_by_pane_key: '6618bb7d:4973b03b',
            created_by_process_incarnation: 'ccb3c8ee::D:/dev-infra@@2798f0da:87e85235',
            created_by_run_generation: 1,
            task_title: 'T1 · C1 계약 설계', display_name: 'T1 · C1 계약 설계',
            spec: 'T1 · C1 계약 설계\n\n## 산출물\n...', status: 'completed', deps: '[]',
            result: '{"provenance":"worker_report","outcome":"succeeded","messageId":"msg_d7dd7cf9e9e2","body":"...","filesModified":["a.ts"],"completedAt":"2026-08-22T10:30:36.581Z"}',
            created_at: '2026-08-22 10:17:04', completed_at: '2026-08-22 10:30:36',
          },
          {
            id: 'task_8bf3d72f262a', run_id: 'run_7804be5a654f', parent_id: null,
            created_by_terminal_handle: 'term_0aa39c54', created_by_pane_key: '6618bb7d:4973b03b',
            created_by_process_incarnation: 'ccb3c8ee::D:/dev-infra@@2798f0da:87e85235',
            created_by_run_generation: 1,
            task_title: 'R1 · PR #1 리뷰', display_name: 'R1 · PR #1 리뷰',
            spec: '리뷰해라', status: 'completed', deps: '["task_56972eaff901"]',
            result: JSON.stringify({
              kind: 'reviewer_result', schemaVersion: 1, verdict: 'request_changes',
              pr: { repo: 'dnhynk/dev-infra', number: 1 },
              reviewedHeadSha: 'dbdc4e9d8c9bb75a980b6070b4dd8448bbff22c5',
              findings: [
                { severity: 'major', file: 'src/digest/types.ts', line: 79, summary: '판정을 선결한다' },
              ],
              gates: { typecheck: 'pass', test: 'fail' },
            }),
            created_at: '2026-08-22 10:33:19', completed_at: '2026-08-22T10:57:33.666Z',
          },
        ],
      });
    }
    if (args[1] === 'inbox') {
      return wrap({
        count: 3,
        messages: [
          {
            id: 'msg_e8edbe17d970', run_id: 'run_7804be5a654f', delivery_contract: 'current_delivery',
            from_handle: 'term_5e8086ba', to_handle: 'run:run_7804be5a654f',
            subject: 'alive', body: '', type: 'heartbeat', priority: 'normal', thread_id: null,
            payload: '{"taskId":"task_c036763fd747","dispatchId":"ctx_f8a3294b68c5","phase":"investigating"}',
            read: 0, sequence: 33, created_at: '2026-08-22T11:48:41Z', delivered_at: null,
            sender_pane_key: '868630f1:ba4f86d3',
          },
          {
            id: 'msg_d7dd7cf9e9e2', run_id: 'run_7804be5a654f', delivery_contract: 'current_delivery',
            from_handle: 'term_a7a12a2f', to_handle: 'run:run_7804be5a654f',
            subject: 'C1 타입 경계 3파일 확정, PR 생성',
            body: '무엇을 했는가. 무엇을 발견했는가. 무엇이 남았는가.',
            type: 'worker_done', priority: 'normal', thread_id: null,
            payload: '{"taskId":"task_56972eaff901","dispatchId":"ctx_11112222","outcome":"succeeded","filesModified":["apps/orca-slack-bridge/src/digest/types.ts"]}',
            read: 1, sequence: 12, created_at: '2026-08-22T10:30:36Z', delivered_at: null,
            sender_pane_key: '1df7f6d4:85cf940c',
          },
          {
            id: 'msg_ffff00001111', run_id: 'run_other000000', delivery_contract: 'current_delivery',
            from_handle: 'term_zzzz', to_handle: 'run:run_other000000',
            subject: '다른 Run의 완료', body: '다른 Run 본문',
            type: 'worker_done', priority: 'normal', thread_id: null,
            payload: '{"taskId":"task_56972eaff901","dispatchId":"ctx_99998888","outcome":"failed","filesModified":[]}',
            read: 1, sequence: 4, created_at: '2026-08-22T09:00:00Z', delivered_at: null,
            sender_pane_key: 'aaaa:bbbb',
          },
        ],
      });
    }
    throw new Error('예상치 못한 호출: ' + args.join(' '));
  }
}

async function facts(): Promise<OrcaFacts> {
  const orca = new FakeOrca();
  return {
    tasks: await listTasks(orca, 'run_7804be5a654f'),
    workerDone: await listWorkerDone(orca),
  };
}

/** 포화되지 않은 inbox. 여기서 못 찾은 것은 정말 없는 것이다. */
function inbox(messages: readonly WorkerDoneMessage[], saturated = false): WorkerDoneInbox {
  return { messages, saturated, limit: INBOX_LIMIT };
}

/**
 * 상한보다 많은 행을 들고 `--limit`만큼만 돌려주는 대역.
 *
 * 실제 `orca orchestration inbox`와 같은 성질을 만든다. 오래된 행이 먼저 잘리고, 호출자는
 * 잘렸다는 사실을 반환 행 수로만 알 수 있다.
 */
class SaturatingInbox implements OrcaRunner {
  constructor(private readonly rows: readonly unknown[]) {}
  async run(args: readonly string[]): Promise<string> {
    const i = args.indexOf('--limit');
    const limit = Number.parseInt(String(args[i + 1]), 10);
    return JSON.stringify({
      id: 'x',
      ok: true,
      result: { count: Math.min(limit, this.rows.length), messages: this.rows.slice(0, limit) },
    });
  }
}

/** `inbox` 응답의 worker_done row 하나. */
function row(id: string, taskId: string): unknown {
  return {
    id, run_id: 'run_7804be5a654f', type: 'worker_done',
    subject: '완료', body: '했다. 봤다. 남았다.',
    payload: JSON.stringify({ taskId, dispatchId: 'ctx_1', outcome: 'succeeded' }),
    created_at: '2026-08-22T10:30:36Z',
  };
}

describe('Orca 사실 수집', () => {
  it('worker_done을 소비하지 않는 inbox로 읽는다', async () => {
    const orca = new FakeOrca();
    const inbox = await listWorkerDone(orca);
    // check와 --ack는 coordinator의 배치를 삼키므로 인자에 나타나면 안 된다.
    expect(orca.calls).toEqual([
      ['orchestration', 'inbox', '--limit', String(INBOX_LIMIT), '--json'],
    ]);
    const msgs = inbox.messages;
    expect(msgs.map((m) => m.messageId)).toEqual(['msg_d7dd7cf9e9e2', 'msg_ffff00001111']);
    expect(msgs[0]).toMatchObject({
      runId: 'run_7804be5a654f',
      taskId: 'task_56972eaff901',
      dispatchId: 'ctx_11112222',
      outcome: 'succeeded',
      body: '무엇을 했는가. 무엇을 발견했는가. 무엇이 남았는가.',
    });
  });

  it('outcome이 계약 밖 값이면 던진다', async () => {
    const bad: OrcaRunner = {
      async run(): Promise<string> {
        return JSON.stringify({
          id: 'x', ok: true,
          result: {
            messages: [{
              id: 'msg_1', run_id: 'r', type: 'worker_done', subject: 's', body: 'b',
              payload: '{"taskId":"task_1","outcome":"cancelled"}', created_at: '2026-08-22T10:00:00Z',
            }],
          },
        });
      },
    };
    await expect(listWorkerDone(bad)).rejects.toThrow(/outcome/);
  });

  it('task result에서 reviewer_result만 읽고 나머지는 null이다', async () => {
    const tasks = await listTasks(new FakeOrca(), 'run_7804be5a654f');
    // worker_report provenance는 리뷰 결과가 아니다.
    expect(parseReviewerResult(tasks[0]?.result, 'task_56972eaff901')).toBeNull();
    expect(parseReviewerResult(tasks[1]?.result, 'task_8bf3d72f262a')).toEqual({
      verdict: 'request_changes',
      repo: 'dnhynk/dev-infra',
      prNumber: 1,
      reviewedHeadSha: 'dbdc4e9d8c9bb75a980b6070b4dd8448bbff22c5',
      findings: [{ severity: 'major', file: 'src/digest/types.ts', line: 79, summary: '판정을 선결한다' }],
    });
  });

  it('completed_at의 두 형식을 모두 읽는다', async () => {
    const tasks = await listTasks(new FakeOrca(), 'run_7804be5a654f');
    expect(tasks[0]?.completedAt?.toISOString()).toBe('2026-08-22T10:30:36.000Z');
    expect(tasks[1]?.completedAt?.toISOString()).toBe('2026-08-22T10:57:33.666Z');
  });
});

/**
 * OD-073 v1 shape 검증.
 *
 * 세 경우를 가른다. 정상 부재는 null, malformed는 throw, 미지원 버전도 throw.
 * 관대한 강제를 하면 malformed한 result의 verdict가 카드에 그려진다.
 */
describe('reviewer_result 엄격 검증', () => {
  const V1 = {
    kind: 'reviewer_result',
    schemaVersion: 1,
    verdict: 'approve',
    pr: { repo: 'dnhynk/dev-infra', number: 1 },
    reviewedHeadSha: '7e9479ebdebe35fc9956b65c0f851ff096c56130',
    findings: [{ severity: 'major', file: 'a.ts', line: 3, summary: '요지' }],
    gates: { typecheck: 'pass' },
  } as const;

  const parse = (over: Record<string, unknown>): unknown =>
    parseReviewerResult({ ...V1, ...over }, 'task_8bf3d72f262a');

  it('v1 shape를 만족하면 읽는다', () => {
    expect(parse({})).toEqual({
      verdict: 'approve',
      repo: 'dnhynk/dev-infra',
      prNumber: 1,
      reviewedHeadSha: '7e9479ebdebe35fc9956b65c0f851ff096c56130',
      findings: [{ severity: 'major', file: 'a.ts', line: 3, summary: '요지' }],
    });
  });

  // 경우 1 — 정상 부재. reviewer_result가 아예 없는 것은 실패가 아니다.
  it('reviewer_result가 아니면 null이다', () => {
    expect(parseReviewerResult(null, 'task_1')).toBeNull();
    expect(parseReviewerResult(undefined, 'task_1')).toBeNull();
    expect(parseReviewerResult('completed', 'task_1')).toBeNull();
    // worker_done으로 끝난 task의 result. malformed가 아니라 다른 종류의 사실이다.
    expect(
      parseReviewerResult(
        { provenance: 'worker_report', outcome: 'succeeded', body: '...' },
        'task_56972eaff901',
      ),
    ).toBeNull();
  });

  // 경우 2 — 미지원 버전. 모르는 버전을 아는 버전처럼 추측해 읽지 않는다.
  it('schemaVersion이 1이 아니면 던진다', () => {
    expect(() => parse({ schemaVersion: 2 })).toThrow(/schemaVersion 2/);
    expect(() => parse({ schemaVersion: 2 })).toThrow(/추측해 읽지 않는다/);
    expect(() => parse({ schemaVersion: 0 })).toThrow(/schemaVersion/);
    expect(() => parse({ schemaVersion: '1' })).toThrow(/정수가 아니다/);
    expect(() => parse({ schemaVersion: undefined })).toThrow(/정수가 아니다/);
  });

  // 경우 3 — malformed. 빈 값이나 null로 강제하지 않는다.
  it('v1 shape를 어기면 던진다', () => {
    expect(() => parse({ verdict: 'lgtm' })).toThrow(/verdict/);
    expect(() => parse({ pr: { repo: 'a/b' } })).toThrow(/pr\.number/);
    expect(() => parse({ pr: { repo: '  ', number: 1 } })).toThrow(/pr\.repo/);
    expect(() => parse({ pr: 'dnhynk/dev-infra#1' })).toThrow(/pr이 객체가 아니다/);
    // 부재를 빈 배열로 강제하지 않는다.
    expect(() => parse({ findings: undefined })).toThrow(/findings가 배열이 아니다/);
    expect(() => parse({ findings: null })).toThrow(/findings가 배열이 아니다/);
    // 잘못된 값을 빈 문자열이나 null로 강제하지 않는다.
    expect(() => parse({ findings: [{ severity: 'major', line: 3, summary: '요지' }] })).toThrow(
      /findings\[0\]\.file/,
    );
    expect(() => parse({ findings: [{ severity: 'major', file: 'a.ts', summary: 42 }] })).toThrow(
      /findings\[0\]\.summary/,
    );
    expect(() =>
      parse({ findings: [{ severity: 'major', file: 'a.ts', line: 'ㄱ', summary: '요지' }] }),
    ).toThrow(/findings\[0\]\.line/);
    expect(() => parse({ findings: [{ severity: 'nit', file: 'a.ts', summary: '요지' }] })).toThrow(
      /severity/,
    );
    expect(() => parse({ reviewedHeadSha: 12345 })).toThrow(/reviewedHeadSha/);
  });

  it('없어도 되는 값은 없어도 읽는다', () => {
    // ReviewedHeadMatch에 unknown이 있으므로 reviewedHeadSha 부재는 표현 가능한 v1 상태다.
    expect(parse({ reviewedHeadSha: undefined })).toMatchObject({ reviewedHeadSha: null });
    // 파일 단위 finding. FindingFacts.line이 number | null이다.
    expect(parse({ findings: [{ severity: 'minor', file: 'a.ts', summary: '요지' }] })).toMatchObject({
      findings: [{ severity: 'minor', file: 'a.ts', line: null, summary: '요지' }],
    });
    expect(parse({ findings: [] })).toMatchObject({ findings: [] });
  });

  it('어느 task의 result가 깨졌는지 메시지에 싣는다', () => {
    expect(() => parse({ verdict: 'lgtm' })).toThrow(/task_8bf3d72f262a/);
  });

  it('malformed reviewer_result는 projection까지 조용히 통과하지 않는다', async () => {
    const f = await facts();
    const base = f.tasks[1];
    if (base === undefined) throw new Error('fixture가 깨졌다');
    const broken = [{ ...base, result: { ...(base.result as object), schemaVersion: 2 } }];
    expect(() => projectPullRequest(REPO, pr(), CORRELATED, { ...f, tasks: broken }, CONFIG)).toThrow(
      /schemaVersion 2/,
    );
  });
});

describe('카드 대상 판정', () => {
  it('uncorrelated는 카드를 만들지 않는다', async () => {
    const p = projectPullRequest(
      REPO, pr(), { kind: 'uncorrelated', reason: 'no_metadata' }, await facts(), CONFIG,
    );
    expect(p).toEqual({ kind: 'skipped', key: pullRequestKey(REPO.githubId, 1), reason: 'uncorrelated' });
  });

  it('conflict는 카드를 만들지 않는다', async () => {
    const p = projectPullRequest(
      REPO, pr(), { kind: 'conflict', details: ['PR body에 orca-run 값이 여러 개다'] }, await facts(), CONFIG,
    );
    expect(p).toEqual({ kind: 'skipped', key: pullRequestKey(REPO.githubId, 1), reason: 'conflict' });
  });

  it('correlated지만 task가 없으면 task_missing이다', async () => {
    const p = projectPullRequest(
      REPO, pr(),
      { kind: 'correlated', run: runKey('run_7804be5a654f'), task: null, dispatch: null },
      await facts(), CONFIG,
    );
    expect(p).toEqual({ kind: 'skipped', key: pullRequestKey(REPO.githubId, 1), reason: 'task_missing' });
  });
});

describe('ProjectedPr 조립', () => {
  it('correlated PR의 사실을 그대로 싣는다', async () => {
    const p = projectPullRequest(REPO, pr(), CORRELATED, await facts(), CONFIG);
    expect(p.kind).toBe('card');
    if (p.kind !== 'card') return;
    expect(p.pr.project).toBe('dev-infra');
    expect(p.pr.number).toBe(1);
    expect(p.pr.url).toBe('https://github.com/dnhynk/dev-infra/pull/1');
    expect(p.pr.headSha).toBe('7e9479ebdebe35fc9956b65c0f851ff096c56130');
    expect(p.pr.terminal).toBe('open');
    expect(p.pr.checks).toEqual([{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }]);
    expect(p.pr.truncation).toEqual({ prBody: false, changedFiles: false });
  });

  it('설정에 없는 repository는 project가 null이다 (OD-047)', async () => {
    const p = projectPullRequest(REPO, pr(), CORRELATED, await facts(), {
      ...CONFIG, projects: [{ name: '다른', repositories: ['someone/else'] }],
    });
    expect(p.kind === 'card' && p.pr.project).toBeNull();
  });

  it('worker_done이 있으면 본문과 outcome을 싣는다', async () => {
    const p = projectPullRequest(REPO, pr(), CORRELATED, await facts(), CONFIG);
    expect(p.kind === 'card' && p.pr.workerReport).toEqual({
      outcome: 'succeeded',
      body: '무엇을 했는가. 무엇을 발견했는가. 무엇이 남았는가.',
    });
  });

  it('worker_done이 없으면 그 사실이 ProjectedPr에 남는다 (OD-070)', async () => {
    const f = await facts();
    const p = projectPullRequest(REPO, pr(), CORRELATED, { ...f, workerDone: inbox([]) }, CONFIG);
    expect(p.kind).toBe('card');
    expect(p.kind === 'card' && p.pr.workerReport).toBeNull();
  });

  it('다른 Run의 worker_done은 taskId가 같아도 쓰지 않는다', async () => {
    const f = await facts();
    const other = f.workerDone.messages.filter((m) => m.runId !== 'run_7804be5a654f');
    expect(other).toHaveLength(1);
    const p = projectPullRequest(REPO, pr(), CORRELATED, { ...f, workerDone: inbox(other) }, CONFIG);
    expect(p.kind === 'card' && p.pr.workerReport).toBeNull();
  });

  it('변경 파일 목록이 조회에서 잘리면 절단 사실을 싣는다', async () => {
    const p = projectPullRequest(
      REPO, pr({ changedPaths: ['a.ts'], changedFilesTotal: 1971 }), CORRELATED, await facts(), CONFIG,
    );
    expect(p.kind === 'card' && p.pr.truncation).toEqual({ prBody: false, changedFiles: true });
  });

  it('PR 본문이 상한을 넘으면 절단 사실을 싣는다', async () => {
    const p = projectPullRequest(
      REPO, pr({ body: 'ㄱ'.repeat(4001) }), CORRELATED, await facts(), CONFIG,
    );
    expect(p.kind === 'card' && p.pr.truncation).toEqual({ prBody: true, changedFiles: false });
  });

  it('mergedAt latch가 projection에서도 state 문자열을 이긴다 (OD-030)', async () => {
    const f = await facts();
    // 실측 조합이다. REST는 merged와 closed-unmerged를 모두 `state=closed`로 주므로
    // `state`만 보면 merged가 closed로 떨어진다(evidence/t1-github-lifecycle.md §OD-030).
    const closed = projectPullRequest(
      REPO, pr({ state: 'CLOSED', mergedAt: '2026-08-22T12:00:00Z' }), CORRELATED, f, CONFIG,
    );
    expect(closed.kind === 'card' && closed.pr.terminal).toBe('merged');
    // 한 응답이 서로 다른 계산 시점의 필드를 섞는 경우다(§OD-044). latch가 `state`를 이긴다.
    const open = projectPullRequest(
      REPO, pr({ state: 'OPEN', mergedAt: '2026-08-22T12:00:00Z' }), CORRELATED, f, CONFIG,
    );
    expect(open.kind === 'card' && open.pr.terminal).toBe('merged');
  });

  it('모르는 state를 open으로 떨어뜨리지 않는다', async () => {
    const f = await facts();
    expect(() => projectPullRequest(REPO, pr({ state: 'DRAFTED' }), CORRELATED, f, CONFIG)).toThrow(
      /PR state/,
    );
    expect(deriveTerminal('MERGED', null)).toBe('merged');
  });
});

describe('reviewer_result 파생', () => {
  it('reviewer_result가 있으면 verdict와 head 대조를 싣는다', async () => {
    const p = projectPullRequest(REPO, pr(), CORRELATED, await facts(), CONFIG);
    expect(p.kind === 'card' && p.pr.review).toEqual({
      verdict: 'request_changes',
      reviewedHeadSha: 'dbdc4e9d8c9bb75a980b6070b4dd8448bbff22c5',
      // reviewer가 본 commit과 현재 head가 다르다는 사실만 싣는다. 유효성 판정이 아니다.
      headMatch: 'different',
      findings: [{ severity: 'major', file: 'src/digest/types.ts', line: 79, summary: '판정을 선결한다' }],
      findingsTotal: 1,
    });
  });

  it('reviewedHeadSha가 현재 head와 같으면 same이다', async () => {
    const p = projectPullRequest(
      REPO, pr({ headRefOid: 'dbdc4e9d8c9bb75a980b6070b4dd8448bbff22c5' }), CORRELATED, await facts(), CONFIG,
    );
    expect(p.kind === 'card' && p.pr.review?.headMatch).toBe('same');
  });

  it('다른 PR 번호나 다른 repository의 reviewer_result는 쓰지 않는다', async () => {
    const f = await facts();
    expect(pickReviewerResult(f.tasks, REPO, 2)).toBeNull();
    expect(pickReviewerResult(f.tasks, repositoryIdentity(99, 'someone/else'), 1)).toBeNull();
  });

  it('한 PR에 reviewer_result가 여러 개면 completed_at 최신 1건을 고른다', async () => {
    const f = await facts();
    const base = f.tasks[1];
    if (base === undefined) throw new Error('fixture가 깨졌다');
    const later = {
      ...base,
      id: 'task_2379c41dcc5f',
      completedAt: new Date('2026-08-22T11:23:14.067Z'),
      result: {
        kind: 'reviewer_result', schemaVersion: 1, verdict: 'approve',
        pr: { repo: 'dnhynk/dev-infra', number: 1 },
        reviewedHeadSha: '7e9479ebdebe35fc9956b65c0f851ff096c56130',
        findings: [],
      },
    };
    // 입력 순서를 뒤집어도 같은 결과가 나와야 한다.
    for (const tasks of [[...f.tasks, later], [later, ...f.tasks]]) {
      expect(pickReviewerResult(tasks, REPO, 1)?.verdict).toBe('approve');
    }
  });

  it('completed_at이 같으면 task id 사전순 마지막을 고른다', async () => {
    const f = await facts();
    const base = f.tasks[1];
    if (base === undefined) throw new Error('fixture가 깨졌다');
    const tie = {
      ...base,
      id: 'task_zzzzzzzzzzzz',
      result: { ...(base.result as object), verdict: 'approve', findings: [] },
    };
    expect(pickReviewerResult([tie, base], REPO, 1)?.verdict).toBe('approve');
    expect(pickReviewerResult([base, tie], REPO, 1)?.verdict).toBe('approve');
  });

  it('findings를 severity 내림차순 상한 10건으로 자른다 (OD-033)', () => {
    const many = [
      ...Array.from({ length: 9 }, (_, i) => ({
        severity: 'minor' as const, file: `m${i}.ts`, line: null, summary: `minor ${i}`,
      })),
      { severity: 'blocker' as const, file: 'b.ts', line: 1, summary: 'blocker' },
      { severity: 'major' as const, file: 'j0.ts', line: 2, summary: 'major 0' },
      { severity: 'major' as const, file: 'j1.ts', line: 3, summary: 'major 1' },
    ];
    const capped = capFindings(many);
    expect(capped).toHaveLength(10);
    expect(capped.map((f) => f.severity)).toEqual([
      'blocker', 'major', 'major', 'minor', 'minor', 'minor', 'minor', 'minor', 'minor', 'minor',
    ]);
    // 같은 severity 안에서는 reviewer가 기록한 순서가 그대로 남는다.
    expect(capped.slice(1, 3).map((f) => f.file)).toEqual(['j0.ts', 'j1.ts']);
    expect(capped.at(-1)?.file).toBe('m6.ts');
  });

  it('상한 전 전체 개수를 findingsTotal에 남긴다', async () => {
    const f = await facts();
    const base = f.tasks[1];
    if (base === undefined) throw new Error('fixture가 깨졌다');
    const wide = {
      ...base,
      result: {
        ...(base.result as object),
        findings: Array.from({ length: 12 }, (_, i) => ({
          severity: 'minor', file: `f${i}.ts`, line: null, summary: `f ${i}`,
        })),
      },
    };
    const p = projectPullRequest(REPO, pr(), CORRELATED, { ...f, tasks: [wide] }, CONFIG);
    expect(p.kind === 'card' && p.pr.review?.findings).toHaveLength(10);
    expect(p.kind === 'card' && p.pr.review?.findingsTotal).toBe(12);
  });
});

describe('DigestStatus 파생', () => {
  const card = async (
    over: Partial<PullRequestFacts>,
    tasks?: OrcaFacts['tasks'],
  ): Promise<ProjectedPr> => {
    const f = await facts();
    const p = projectPullRequest(REPO, pr(over), CORRELATED, { ...f, tasks: tasks ?? f.tasks }, CONFIG);
    if (p.kind !== 'card') throw new Error('카드가 아니다');
    return p.pr;
  };

  it('reviewer_result가 없으면 awaiting_review다', async () => {
    expect(deriveDigestStatus(await card({}, []))).toBe('awaiting_review');
  });

  it('request_changes면 changes_requested다', async () => {
    expect(deriveDigestStatus(await card({}))).toBe('changes_requested');
  });

  it('approve면 review_approved다', async () => {
    const f = await facts();
    const base = f.tasks[1];
    if (base === undefined) throw new Error('fixture가 깨졌다');
    const approved = [{ ...base, result: { ...(base.result as object), verdict: 'approve', findings: [] } }];
    expect(deriveDigestStatus(await card({}, approved))).toBe('review_approved');
  });

  it('merged와 closed가 reviewer verdict보다 앞선다', async () => {
    expect(deriveDigestStatus(await card({ state: 'MERGED', mergedAt: '2026-08-22T12:00:00Z' }))).toBe('merged');
    expect(deriveDigestStatus(await card({ state: 'CLOSED' }))).toBe('closed');
  });

  it('worker_done 유무는 status를 바꾸지 않는다', async () => {
    const f = await facts();
    const withReport = projectPullRequest(REPO, pr(), CORRELATED, f, CONFIG);
    const without = projectPullRequest(REPO, pr(), CORRELATED, { ...f, workerDone: inbox([]) }, CONFIG);
    if (withReport.kind !== 'card' || without.kind !== 'card') throw new Error('카드가 아니다');
    expect(deriveDigestStatus(withReport.pr)).toBe(deriveDigestStatus(without.pr));
  });
});

describe('worker_done 선택', () => {
  it('같은 task에 여러 건이면 가장 최근 것을 쓴다', () => {
    const msg = (id: string, at: string, body: string) => ({
      messageId: id, runId: 'run_7804be5a654f', taskId: 'task_56972eaff901',
      dispatchId: null, outcome: 'succeeded' as const, subject: 's', body,
      createdAt: new Date(at),
    });
    const older = msg('msg_a', '2026-08-22T10:00:00Z', '이전 보고');
    const newer = msg('msg_b', '2026-08-22T11:00:00Z', '재dispatch 보고');
    if (CORRELATED.kind !== 'correlated' || CORRELATED.task === null) throw new Error('fixture가 깨졌다');
    const origin = { ...CORRELATED, task: CORRELATED.task };
    expect(pickWorkerReport(inbox([older, newer]), origin)?.body).toBe('재dispatch 보고');
    expect(pickWorkerReport(inbox([newer, older]), origin)?.body).toBe('재dispatch 보고');
  });
});

/**
 * inbox 포화와 "부재를 증명할 수 없음".
 *
 * `inbox`에는 `--run` 필터도 pagination도 없고 `--limit`이 유일한 손잡이다. 상한을 넘긴
 * 상태에서 worker_done을 못 찾은 것은 "없다"가 아니라 "판정 불가"다. OD-070의 "없음"
 * 규칙을 판정 불가에 적용하면 카드가 거짓을 말한다.
 */
describe('inbox 포화', () => {
  const origin = (() => {
    if (CORRELATED.kind !== 'correlated' || CORRELATED.task === null) throw new Error('fixture가 깨졌다');
    return { ...CORRELATED, task: CORRELATED.task };
  })();

  it('반환 행 수가 요청 상한과 같으면 포화로 본다', async () => {
    // 상한보다 많은 행을 들고 있는 대역. 상한만큼만 돌아온다.
    const rows = Array.from({ length: 7 }, (_, i) => row(`msg_${i}`, `task_${i}`));
    const saturated = await listWorkerDone(new SaturatingInbox(rows), 5);
    expect(saturated).toMatchObject({ saturated: true, limit: 5 });
    expect(saturated.messages).toHaveLength(5);

    const room = await listWorkerDone(new SaturatingInbox(rows), 50);
    expect(room).toMatchObject({ saturated: false, limit: 50 });
    expect(room.messages).toHaveLength(7);
  });

  it('포화 판정은 worker_done 수가 아니라 전체 행 수로 한다', async () => {
    // heartbeat가 상한을 채웠다. 걸러낸 worker_done은 1건뿐이지만 목록은 잘렸다.
    const noise = Array.from({ length: 4 }, (_, i) => ({
      id: `msg_h${i}`, run_id: 'run_7804be5a654f', type: 'heartbeat', subject: 'alive', body: '',
      payload: '{"phase":"implementing"}', created_at: '2026-08-22T11:48:41Z',
    }));
    const got = await listWorkerDone(
      new SaturatingInbox([row('msg_w', 'task_56972eaff901'), ...noise]),
      5,
    );
    expect(got.messages).toHaveLength(1);
    expect(got.saturated).toBe(true);
  });

  it('포화여도 찾았으면 정상이다', async () => {
    const found = await listWorkerDone(
      new SaturatingInbox([row('msg_w', 'task_56972eaff901'), row('msg_x', 'task_other')]),
      2,
    );
    expect(found.saturated).toBe(true);
    expect(pickWorkerReport(found, origin)).toEqual({
      outcome: 'succeeded',
      body: '했다. 봤다. 남았다.',
    });
  });

  it('포화 상태에서 못 찾으면 workerReport: null이 아니라 던진다', async () => {
    const missed = await listWorkerDone(
      new SaturatingInbox([row('msg_x', 'task_other'), row('msg_y', 'task_another')]),
      2,
    );
    expect(missed.saturated).toBe(true);
    // 원인과 손잡이가 메시지에 있어야 한다.
    expect(() => pickWorkerReport(missed, origin)).toThrow(/부재를 증명할 수 없다/);
    expect(() => pickWorkerReport(missed, origin)).toThrow(/--limit/);
    expect(() => pickWorkerReport(missed, origin)).toThrow(/task:task_56972eaff901/);
  });

  it('포화가 아니면 못 찾은 것이 부재다 (OD-070)', async () => {
    const complete = await listWorkerDone(
      new SaturatingInbox([row('msg_x', 'task_other')]),
      50,
    );
    expect(complete.saturated).toBe(false);
    expect(pickWorkerReport(complete, origin)).toBeNull();
  });

  it('포화 판정이 projection까지 전달된다', async () => {
    const f = await facts();
    const missed = await listWorkerDone(new SaturatingInbox([row('msg_x', 'task_other')]), 1);
    expect(() =>
      projectPullRequest(REPO, pr(), CORRELATED, { ...f, workerDone: missed }, CONFIG),
    ).toThrow(/부재를 증명할 수 없다/);
  });

  it('다른 Run의 같은 task id는 찾은 것으로 치지 않는다', async () => {
    const otherRun = {
      ...(row('msg_z', 'task_56972eaff901') as Record<string, unknown>),
      run_id: 'run_other000000',
    };
    const got = await listWorkerDone(new SaturatingInbox([otherRun]), 1);
    expect(got.saturated).toBe(true);
    expect(() => pickWorkerReport(got, origin)).toThrow(/부재를 증명할 수 없다/);
  });
});
