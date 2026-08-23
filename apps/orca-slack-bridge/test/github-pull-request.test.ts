import { describe, expect, it } from 'vitest';
import {
  fetchPullRequest,
  listPullRequests,
  readHeadRefOid,
} from '../src/github/pull-request.js';
import { GhCommandError, type GhRunner } from '../src/github/runner.js';
import { repositoryIdentity } from '../src/identity/repository.js';

const REPO = repositoryIdentity(1343880863, 'dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b');
const HEAD = '41326a121680602f736d39ced9f6a4990f949c0a';

/**
 * 2026-08-23 `gh pr view 1 --repo dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b --json ...` 응답에
 * 목록 조회용 필드를 붙인 fixture다. rollup 세 row는 실제 응답 그대로다.
 */
function prRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 1,
    title: 'THROWAWAY C2-2 required join probe',
    body: '<!-- orca-run: run_36d28e6e947a -->',
    url: 'https://github.com/dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b/pull/1',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'probe',
    headRefOid: HEAD,
    baseRefName: 'main',
    mergedAt: null,
    reviewDecision: null,
    reviews: [],
    statusCheckRollup: [
      { __typename: 'StatusContext', context: 'classic-failing', startedAt: '2026-08-23T10:59:41Z', state: 'FAILURE', targetUrl: '' },
      { __typename: 'StatusContext', context: 'ruleset-pending', startedAt: '2026-08-23T10:59:42Z', state: 'PENDING', targetUrl: '' },
      { __typename: 'StatusContext', context: 'classic-passing', startedAt: '2026-08-23T10:59:41Z', state: 'SUCCESS', targetUrl: '' },
    ],
    files: [{ path: 'probe.txt' }],
    changedFiles: 1,
    ...over,
  };
}

const PROTECTION_JSON = JSON.stringify({
  strict: false,
  contexts: ['classic-passing', 'classic-failing'],
  checks: [{ context: 'classic-passing', app_id: null }, { context: 'classic-failing', app_id: null }],
});

const RULES_JSON = JSON.stringify([
  {
    type: 'required_status_checks',
    parameters: {
      required_status_checks: [{ context: 'ruleset-pending' }, { context: 'ruleset-missing' }],
    },
    ruleset_source_type: 'Repository',
    ruleset_id: 21233618,
  },
]);

class FakeGh implements GhRunner {
  readonly calls: string[][] = [];
  constructor(
    private readonly rows: readonly unknown[],
    private readonly heads: readonly string[] = [],
  ) {}
  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const path = args[1] ?? '';
    if (args[0] === 'api' && path.includes('/protection/required_status_checks')) {
      return PROTECTION_JSON;
    }
    if (args[0] === 'api' && path.includes('/rules/branches/')) return RULES_JSON;
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(this.rows);
    if (args[0] === 'pr' && args[1] === 'view') {
      if (args.includes('headRefOid')) {
        const i = Math.min(this.headPolls++, this.heads.length - 1);
        return JSON.stringify({ headRefOid: this.heads[i] });
      }
      return JSON.stringify(this.rows[0]);
    }
    throw new Error('예상치 못한 gh 호출: ' + args.join(' '));
  }
  private headPolls = 0;
}

describe('listPullRequests', () => {
  it('StatusContext row의 context와 state를 잃지 않는다', async () => {
    const [pr] = await listPullRequests(new FakeGh([prRow()]), REPO);
    expect(pr?.checks).toEqual([
      { kind: 'statusContext', name: 'classic-failing', status: '', conclusion: null, state: 'FAILURE' },
      { kind: 'statusContext', name: 'ruleset-pending', status: '', conclusion: null, state: 'PENDING' },
      { kind: 'statusContext', name: 'classic-passing', status: '', conclusion: null, state: 'SUCCESS' },
    ]);
  });

  it('CheckRun row는 status/conclusion으로 읽는다', async () => {
    const row = prRow({
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'required-ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    });
    const [pr] = await listPullRequests(new FakeGh([row]), REPO);
    expect(pr?.checks).toEqual([
      { kind: 'checkRun', name: 'required-ci', status: 'COMPLETED', conclusion: 'SUCCESS', state: null },
    ]);
  });

  it('base branch의 required rule을 조인해 실측 네 상태를 그대로 싣는다', async () => {
    const [pr] = await listPullRequests(new FakeGh([prRow()]), REPO);
    expect(pr?.requiredRules.contexts.map((c) => c.context)).toEqual([
      'classic-failing', 'classic-passing', 'ruleset-missing', 'ruleset-pending',
    ]);
    expect(pr?.requiredChecks.map((r) => [r.context, r.state])).toEqual([
      ['classic-failing', 'failing'],
      ['classic-passing', 'passing'],
      ['ruleset-missing', 'missing'],
      ['ruleset-pending', 'pending'],
    ]);
  });

  it('같은 base branch의 rule을 PR마다 다시 조회하지 않는다', async () => {
    const gh = new FakeGh([prRow(), prRow({ number: 2 }), prRow({ number: 3 })]);
    await listPullRequests(gh, REPO);
    const ruleCalls = gh.calls.filter((c) => c[0] === 'api');
    expect(ruleCalls).toHaveLength(2);
  });

  it('base branch가 다르면 각각 조회한다', async () => {
    const gh = new FakeGh([prRow(), prRow({ number: 2, baseRefName: 'release' })]);
    await listPullRequests(gh, REPO);
    expect(gh.calls.filter((c) => c[0] === 'api')).toHaveLength(4);
  });

  it('review를 개수가 아니라 건별 사실로 싣는다', async () => {
    // 2026-08-23 `gh pr view 14215 --repo cli/cli --json reviews` 응답 형태.
    const row = prRow({
      reviews: [
        {
          id: 'PRR_kwDODKw3uc8AAAABKVPoxw',
          state: 'COMMENTED',
          commit: { oid: '67b3e0d13cfeb96bb7b961b57cdb664d6e76f764' },
          author: { login: 'copilot-pull-request-reviewer' },
          submittedAt: '2026-08-20T23:13:40Z',
        },
      ],
    });
    const [pr] = await listPullRequests(new FakeGh([row]), REPO);
    expect(pr?.reviews).toEqual([
      {
        id: 'PRR_kwDODKw3uc8AAAABKVPoxw',
        state: 'COMMENTED',
        commit: '67b3e0d13cfeb96bb7b961b57cdb664d6e76f764',
        author: 'copilot-pull-request-reviewer',
        submittedAt: '2026-08-20T23:13:40Z',
      },
    ]);
  });

  it('삭제된 계정의 review는 author를 지어내지 않는다', async () => {
    const row = prRow({
      reviews: [{ id: 'PRR_x', state: 'APPROVED', commit: null, author: null, submittedAt: null }],
    });
    const [pr] = await listPullRequests(new FakeGh([row]), REPO);
    expect(pr?.reviews[0]).toEqual({
      id: 'PRR_x', state: 'APPROVED', commit: null, author: null, submittedAt: null,
    });
  });
});

describe('fetchPullRequest', () => {
  it('한 PR만 다시 읽고 같은 조인 결과를 만든다', async () => {
    const gh = new FakeGh([prRow()]);
    const pr = await fetchPullRequest(gh, REPO, 1);
    expect(pr.headRefOid).toBe(HEAD);
    expect(pr.requiredChecks.find((r) => r.context === 'ruleset-missing')?.state).toBe('missing');
    expect(gh.calls[0]).toEqual([
      'pr', 'view', '1', '--repo', REPO.nameWithOwner, '--json', expect.any(String),
    ]);
  });
});

describe('readHeadRefOid', () => {
  const sleep = async (): Promise<void> => {};

  it('기대 head가 없으면 한 번만 읽는다', async () => {
    const gh = new FakeGh([prRow()], [HEAD]);
    const obs = await readHeadRefOid(gh, REPO, 1, { sleep });
    expect(obs).toEqual({ headRefOid: HEAD, attempts: 1, converged: true });
  });

  it('stale head를 다시 읽어 기대 head로 수렴한다', async () => {
    // T1 §OD-044 실측: PUT이 새 SHA를 반환한 직후 첫 조회는 이전 SHA, 두 번째 조회에서 새 SHA.
    const previous = '8ea532ad63f3e8c25c20310180cac79a9a809b36';
    const expected = '0fd0c73b04c17ec3be8958f60c517ba4af7db2cf';
    const gh = new FakeGh([prRow()], [previous, expected]);
    const obs = await readHeadRefOid(gh, REPO, 1, { expectedHeadOid: expected, sleep });
    expect(obs).toEqual({ headRefOid: expected, attempts: 2, converged: true });
  });

  it('상한까지 읽어도 수렴하지 않으면 던지지 않고 사실로 남긴다', async () => {
    const gh = new FakeGh([prRow()], ['stale']);
    const obs = await readHeadRefOid(gh, REPO, 1, {
      expectedHeadOid: 'never', maxAttempts: 3, sleep,
    });
    expect(obs).toEqual({ headRefOid: 'stale', attempts: 3, converged: false });
    expect(gh.calls).toHaveLength(3);
  });

  it('maxAttempts가 0 이하여도 최소 1회로 잘라 무한 재시도를 만들지 않는다', async () => {
    const gh = new FakeGh([prRow()], ['stale']);
    const obs = await readHeadRefOid(gh, REPO, 1, {
      expectedHeadOid: 'never', maxAttempts: 0, sleep,
    });
    expect(obs.attempts).toBe(1);
    expect(gh.calls).toHaveLength(1);
  });

  it('마지막 시도 뒤에는 기다리지 않는다', async () => {
    const waits: number[] = [];
    const gh = new FakeGh([prRow()], ['stale']);
    await readHeadRefOid(gh, REPO, 1, {
      expectedHeadOid: 'never',
      maxAttempts: 3,
      delayMs: 7,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([7, 7]);
  });

  it('조회 실패는 삼키지 않는다', async () => {
    const gh: GhRunner = {
      async run(args) {
        throw new GhCommandError(args, 1, 'gh: Not Found (HTTP 404)');
      },
    };
    await expect(readHeadRefOid(gh, REPO, 1, { sleep })).rejects.toThrow(GhCommandError);
  });
});
