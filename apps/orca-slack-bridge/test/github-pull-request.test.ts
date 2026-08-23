import { describe, expect, it } from 'vitest';
import { listPullRequests, observePullRequest } from '../src/github/pull-request.js';
import { fetchStatusCheckRollup } from '../src/github/rollup.js';
import { GhCommandError, type GhRunner } from '../src/github/runner.js';
import { repositoryIdentity } from '../src/identity/repository.js';

const REPO = repositoryIdentity(1343880863, 'dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b');
const HEAD = '41326a121680602f736d39ced9f6a4990f949c0a';

/**
 * 2026-08-23 `gh pr view 1 --repo dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b --json ...` 응답에
 * 목록 조회용 필드를 붙인 fixture다. rollup은 이 응답에서 읽지 않는다(`FIELDS` 주석).
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

/**
 * rollup GraphQL 응답의 `StatusContext` node.
 *
 * `dnhynk/THROWAWAY-orca-c2-appbind-c6ddffc0`에서 관측한 대로 commit status에는 app을 식별할
 * field가 없다. 그래서 이 fixture에도 app이 없다.
 */
function statusNode(id: string, context: string, state: string, createdAt: string): unknown {
  return { __typename: 'StatusContext', id, context, state, createdAt };
}

const ROLLUP_NODES: readonly unknown[] = [
  statusNode('SC_kwDOUBdGbs8AAAAMR1EFj1', 'classic-failing', 'FAILURE', '2026-08-23T10:59:41Z'),
  statusNode('SC_kwDOUBdGbs8AAAAMR1EFj2', 'ruleset-pending', 'PENDING', '2026-08-23T10:59:42Z'),
  statusNode('SC_kwDOUBdGbs8AAAAMR1EFj3', 'classic-passing', 'SUCCESS', '2026-08-23T10:59:41Z'),
];

/** 첫 page 질의(`HEAD_ROLLUP_QUERY`)의 응답 한 장. PR 경유로 head commit을 함께 준다. */
function rollupPage(
  commitOid: string,
  nodes: readonly unknown[],
  next: string | null = null,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  oid: commitOid,
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: next !== null, endCursor: next },
                      nodes,
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
}

/** 이어읽기 질의(`PINNED_ROLLUP_QUERY`)의 응답 한 장. commit은 `object(oid:)`로 온다. */
function pinnedPage(nodes: readonly unknown[], next: string | null = null): string {
  return JSON.stringify({
    data: {
      repository: {
        object: {
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: next !== null, endCursor: next },
              nodes,
            },
          },
        },
      },
    },
  });
}

/** review GraphQL 응답 한 page. node는 `gh --json reviews`의 row와 같은 모양이다. */
function reviewsPage(count: number, offset: number, next: string | null = null): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviews: {
            pageInfo: { hasNextPage: next !== null, endCursor: next },
            nodes: Array.from({ length: count }, (_, i) => ({
              id: `PRR_${offset + i}`,
              state: 'COMMENTED',
              commit: { oid: HEAD },
              author: { login: 'reviewer' },
              submittedAt: '2026-08-23T00:00:00Z',
            })),
          },
        },
      },
    },
  });
}

/** nested `reviews` row `count`개. 상한 fixture용이다. */
function nestedReviews(count: number): readonly unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `PRR_nested_${i}`,
    state: 'COMMENTED',
    commit: { oid: HEAD },
    author: { login: 'reviewer' },
    submittedAt: '2026-08-23T00:00:00Z',
  }));
}

type Snapshot = { readonly row: Record<string, unknown>; readonly rollupOid: string };

/**
 * `gh` 대역.
 *
 * `snapshots`는 재조회할 때마다 순서대로 나오고 마지막 것이 이후에도 반복된다. PR row의 head와
 * rollup의 commit이 어긋난 응답을 만들 수 있어야 OD-044의 stale 조합을 재현할 수 있다.
 * rollup 이어읽기(`object(oid:)`)와 review 전량 조회는 그것을 검증하는 테스트가 fixture를 직접
 * 주고, 여기서는 `reviewsPages`가 없으면 예상치 못한 호출로 던진다.
 */
class FakeGh implements GhRunner {
  readonly calls: string[][] = [];
  private views = 0;
  private rollups = 0;
  private reviewsCalls = 0;
  constructor(
    private readonly snapshots: readonly Snapshot[],
    private readonly listRows: readonly unknown[] = [],
    private readonly reviewsPages: readonly string[] = [],
  ) {}

  private snapshot(i: number): Snapshot {
    const s = this.snapshots[Math.min(i, this.snapshots.length - 1)];
    if (s === undefined) throw new Error('snapshot이 없다');
    return s;
  }

  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const joined = args.join(' ');
    if (args[0] === 'api' && joined.includes('/protection/required_status_checks')) {
      return PROTECTION_JSON;
    }
    if (args[0] === 'api' && joined.includes('/rules/branches/')) return RULES_JSON;
    if (args[0] === 'api' && args[1] === 'graphql') {
      if (joined.includes('statusCheckRollup') && !joined.includes('object(oid:')) {
        const s = this.snapshot(this.rollups);
        this.rollups += 1;
        return rollupPage(s.rollupOid, ROLLUP_NODES);
      }
      if (joined.includes('reviews(first:100')) {
        const page = this.reviewsPages[this.reviewsCalls];
        if (page === undefined) throw new Error('예상치 못한 review 전량 조회: ' + joined);
        this.reviewsCalls += 1;
        return page;
      }
      throw new Error('예상치 못한 graphql 호출: ' + joined);
    }
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(this.listRows);
    if (args[0] === 'pr' && args[1] === 'view') {
      const s = this.snapshot(this.views);
      this.views += 1;
      return JSON.stringify(s.row);
    }
    throw new Error('예상치 못한 gh 호출: ' + args.join(' '));
  }
}

/** PR row와 rollup이 같은 head를 준 snapshot. */
function at(head: string, over: Record<string, unknown> = {}): Snapshot {
  return { row: prRow({ headRefOid: head, ...over }), rollupOid: head };
}

const sleep = async (): Promise<void> => {};
const OLD = '8ea532ad63f3e8c25c20310180cac79a9a809b36';
const NEW = '0fd0c73b04c17ec3be8958f60c517ba4af7db2cf';

describe('fetchStatusCheckRollup', () => {
  it('StatusContext row의 id/context/state/createdAt을 잃지 않는다', async () => {
    const gh = new FakeGh([at(HEAD)]);
    const rollup = await fetchStatusCheckRollup(gh, REPO, 1);
    expect(rollup.commitOid).toBe(HEAD);
    expect(rollup.pages).toBe(1);
    expect(rollup.checks).toEqual([
      {
        kind: 'statusContext', id: 'SC_kwDOUBdGbs8AAAAMR1EFj1', name: 'classic-failing',
        status: '', conclusion: null, state: 'FAILURE',
        appId: null, startedAt: '2026-08-23T10:59:41Z', completedAt: null,
      },
      {
        kind: 'statusContext', id: 'SC_kwDOUBdGbs8AAAAMR1EFj2', name: 'ruleset-pending',
        status: '', conclusion: null, state: 'PENDING',
        appId: null, startedAt: '2026-08-23T10:59:42Z', completedAt: null,
      },
      {
        kind: 'statusContext', id: 'SC_kwDOUBdGbs8AAAAMR1EFj3', name: 'classic-passing',
        status: '', conclusion: null, state: 'SUCCESS',
        appId: null, startedAt: '2026-08-23T10:59:41Z', completedAt: null,
      },
    ]);
  });

  it('CheckRun row의 id와 checkSuite.app.databaseId를 싣는다', async () => {
    // 2026-08-23 `cli/cli#14215` head rollup 응답 형태. app 15368은 github-actions다.
    const node = {
      __typename: 'CheckRun',
      id: 'CR_kwDODKw3uc8AAAAWfsErsg',
      name: 'label-external',
      status: 'COMPLETED',
      conclusion: 'SKIPPED',
      startedAt: '2026-08-20T23:27:21Z',
      completedAt: '2026-08-20T23:27:20Z',
      checkSuite: { app: { databaseId: 15368 } },
    };
    const gh: GhRunner = { async run() { return rollupPage(HEAD, [node]); } };
    const rollup = await fetchStatusCheckRollup(gh, REPO, 1);
    expect(rollup.checks).toEqual([
      {
        kind: 'checkRun', id: 'CR_kwDODKw3uc8AAAAWfsErsg', name: 'label-external',
        status: 'COMPLETED', conclusion: 'SKIPPED', state: null,
        appId: 15368, startedAt: '2026-08-20T23:27:21Z', completedAt: '2026-08-20T23:27:20Z',
      },
    ]);
  });

  it('contexts가 여러 page면 첫 page에서 고정한 commit을 oid로 지정해 끝까지 읽는다', async () => {
    // 첫 page만 읽으면 뒤의 required가 요청 성공인 채로 사라지고 missing 판정에도 나타나지 않는다.
    // 이어읽기가 PR의 head를 다시 고르면 page 사이에 head가 움직였을 때 서로 다른 commit의
    // row가 한 결과에 섞인다. 그래서 이어읽기는 첫 page의 commit을 oid로 직접 지정해야 한다.
    const pages = [
      rollupPage(HEAD, [statusNode('SC_1', 'page1', 'SUCCESS', '2026-08-23T10:59:41Z')], 'Mg'),
      pinnedPage([statusNode('SC_2', 'page2', 'SUCCESS', '2026-08-23T10:59:42Z')]),
    ];
    const calls: string[][] = [];
    let i = 0;
    const gh: GhRunner = {
      async run(args) {
        calls.push([...args]);
        const page = pages[Math.min(i, pages.length - 1)];
        i += 1;
        return page ?? '';
      },
    };
    const rollup = await fetchStatusCheckRollup(gh, REPO, 1);
    expect(rollup.pages).toBe(2);
    expect(rollup.commitOid).toBe(HEAD);
    expect(rollup.checks.map((c) => c.name)).toEqual(['page1', 'page2']);
    expect(calls[0]?.join(' ')).not.toContain('cursor=');
    const second = calls[1]?.join(' ') ?? '';
    expect(second).toContain('cursor=Mg');
    expect(second).toContain(`oid=${HEAD}`);
    // 이어읽기는 PR을 다시 보지 않는다. PR 번호로 head를 재선택하면 고정이 깨진다.
    expect(second).not.toContain('number=');
  });

  it('고정한 commit을 이어읽지 못하면 던진다', async () => {
    // 첫 page가 있다고 말한 rollup이 이어읽기에서 사라졌다면 응답이 모순이다. 빈 결과로 위장하지 않는다.
    const pages = [
      rollupPage(HEAD, [statusNode('SC_1', 'page1', 'SUCCESS', '2026-08-23T10:59:41Z')], 'Mg'),
      JSON.stringify({ data: { repository: { object: null } } }),
    ];
    let i = 0;
    const gh: GhRunner = { async run() { const p = pages[Math.min(i, pages.length - 1)]; i += 1; return p ?? ''; } };
    await expect(fetchStatusCheckRollup(gh, REPO, 1)).rejects.toThrow(TypeError);
  });

  it('rollup이 없는 head는 빈 목록이고 던지지 않는다', async () => {
    const empty = JSON.stringify({
      data: {
        repository: {
          pullRequest: { commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }] } },
        },
      },
    });
    const gh: GhRunner = { async run() { return empty; } };
    expect(await fetchStatusCheckRollup(gh, REPO, 1)).toEqual({
      commitOid: HEAD, checks: [], pages: 1,
    });
  });

  it('repository가 null인 응답은 조회 실패다. 빈 checks로 바꾸지 않는다', async () => {
    const gh: GhRunner = { async run() { return JSON.stringify({ data: { repository: null } }); } };
    await expect(fetchStatusCheckRollup(gh, REPO, 1)).rejects.toThrow(/repository/);
  });

  it('pullRequest가 null인 응답은 조회 실패다', async () => {
    const gh: GhRunner = {
      async run() { return JSON.stringify({ data: { repository: { pullRequest: null } } }); },
    };
    await expect(fetchStatusCheckRollup(gh, REPO, 1)).rejects.toThrow(/pullRequest/);
  });

  it('head commit이 없는 응답은 조회 실패다', async () => {
    const gh: GhRunner = {
      async run() {
        return JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [] } } } } });
      },
    };
    await expect(fetchStatusCheckRollup(gh, REPO, 1)).rejects.toThrow(/head commit/);
  });

  it('hasNextPage=true인데 endCursor가 없으면 던진다', async () => {
    // 여기서 멈추고 반환하면 남은 page가 요청 성공인 채로 사라진다. 조용한 절단을 만들지 않는다.
    const broken = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            commits: {
              nodes: [{
                commit: {
                  oid: HEAD,
                  statusCheckRollup: {
                    contexts: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
                  },
                },
              }],
            },
          },
        },
      },
    });
    const gh: GhRunner = { async run() { return broken; } };
    await expect(fetchStatusCheckRollup(gh, REPO, 1)).rejects.toThrow(/endCursor/);
  });

  it('알 수 없는 rollup type은 이름을 지어내지 않는다', async () => {
    const gh: GhRunner = {
      async run() { return rollupPage(HEAD, [{ __typename: 'NewRollupType', id: 'X_1' }]); },
    };
    const [row] = (await fetchStatusCheckRollup(gh, REPO, 1)).checks;
    expect(row?.kind).toBe('unknown');
    expect(row?.name).toBe('');
  });
});

describe('listPullRequests', () => {
  it('PR row와 별개로 읽은 rollup을 checks로 싣는다', async () => {
    const gh = new FakeGh([at(HEAD)], [prRow()]);
    const [pr] = await listPullRequests(gh, REPO);
    expect(pr?.checksHeadOid).toBe(HEAD);
    expect(pr?.checks.map((c) => [c.name, c.state])).toEqual([
      ['classic-failing', 'FAILURE'],
      ['ruleset-pending', 'PENDING'],
      ['classic-passing', 'SUCCESS'],
    ]);
  });

  it('base branch의 required rule을 조인해 실측 네 상태를 그대로 싣는다', async () => {
    const gh = new FakeGh([at(HEAD)], [prRow()]);
    const [pr] = await listPullRequests(gh, REPO);
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
    const gh = new FakeGh([at(HEAD)], [prRow(), prRow({ number: 2 }), prRow({ number: 3 })]);
    await listPullRequests(gh, REPO);
    const ruleCalls = gh.calls.filter((c) => c[0] === 'api' && c[1] !== 'graphql');
    expect(ruleCalls).toHaveLength(2);
  });

  it('rollup은 head마다 달라 PR마다 조회한다', async () => {
    const gh = new FakeGh([at(HEAD)], [prRow(), prRow({ number: 2 }), prRow({ number: 3 })]);
    await listPullRequests(gh, REPO);
    expect(gh.calls.filter((c) => c[1] === 'graphql')).toHaveLength(3);
  });

  it('base branch가 다르면 각각 조회한다', async () => {
    const gh = new FakeGh([at(HEAD)], [prRow(), prRow({ number: 2, baseRefName: 'release' })]);
    await listPullRequests(gh, REPO);
    expect(gh.calls.filter((c) => c[0] === 'api' && c[1] !== 'graphql')).toHaveLength(4);
  });

  it('PR row와 rollup의 head가 일치하면 재관측하지 않는다', async () => {
    const gh = new FakeGh([at(HEAD)], [prRow()]);
    await listPullRequests(gh, REPO);
    expect(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'view')).toHaveLength(0);
  });

  it('PR row와 rollup의 head가 어긋나면 재관측해 한 head의 snapshot으로 수렴시킨다', async () => {
    // 이 배선이 없으면 old head의 rollup이 current head의 checks로 실려 내려간다(OD-044).
    // list 응답의 head는 NEW인데 첫 rollup은 OLD를 줬다 — T1 §OD-044의 stale 조합이다.
    const gh = new FakeGh(
      [{ row: prRow({ headRefOid: NEW }), rollupOid: OLD }, at(NEW)],
      [prRow({ headRefOid: NEW })],
    );
    const [pr] = await listPullRequests(gh, REPO, 50, { sleep });
    expect(pr?.headRefOid).toBe(NEW);
    expect(pr?.checksHeadOid).toBe(NEW);
    // 재관측이 실제로 일어났다. bulk 경로는 pr view를 쓰지 않으므로 이 호출이 그 증거다.
    expect(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'view').length).toBeGreaterThan(0);
  });

  it('상한까지 재관측해도 어긋나면 두 head를 그대로 실어 숨기지 않는다', async () => {
    // 접어 버리면 old head의 check가 current head의 사실로 보인다(OD-044). 던지지도 않는다 —
    // 관측된 사실이고, projection과 renderer가 카드에 표시한다.
    const gh = new FakeGh(
      [{ row: prRow({ headRefOid: NEW }), rollupOid: OLD }],
      [prRow({ headRefOid: NEW })],
    );
    const [pr] = await listPullRequests(gh, REPO, 50, { maxAttempts: 2, sleep });
    expect(pr?.headRefOid).toBe(NEW);
    expect(pr?.checksHeadOid).toBe(OLD);
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
    const [pr] = await listPullRequests(new FakeGh([at(HEAD)], [row]), REPO);
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
    const [pr] = await listPullRequests(new FakeGh([at(HEAD)], [row]), REPO);
    expect(pr?.reviews[0]).toEqual({
      id: 'PRR_x', state: 'APPROVED', commit: null, author: null, submittedAt: null,
    });
  });

  it('nested review가 상한 미만이면 전량 재조회를 하지 않는다', async () => {
    const gh = new FakeGh([at(HEAD)], [prRow({ reviews: nestedReviews(99) })]);
    const [pr] = await listPullRequests(gh, REPO);
    expect(pr?.reviews).toHaveLength(99);
    expect(gh.calls.some((c) => c.join(' ').includes('reviews(first:100'))).toBe(false);
  });

  it('nested review가 상한에 닿으면 cursor로 전량을 다시 읽는다', async () => {
    // `gh 2.98`의 nested `reviews`는 `first: 100`이고 list 경로는 pageInfo를 후속 조회하지
    // 않는다. 응답은 totalCount 없는 bare 배열이라(실측) 100건이 전부인지 잘림인지 row만으로
    // 가를 수 없다 — 상한에 닿은 PR만 전량을 다시 읽는다.
    const gh = new FakeGh(
      [at(HEAD)],
      [prRow({ reviews: nestedReviews(100) })],
      [reviewsPage(100, 0, 'R2'), reviewsPage(50, 100)],
    );
    const [pr] = await listPullRequests(gh, REPO);
    expect(pr?.reviews).toHaveLength(150);
    expect(pr?.reviews[149]?.id).toBe('PRR_149');
    const reviewCalls = gh.calls.filter((c) => c.join(' ').includes('reviews(first:100'));
    expect(reviewCalls).toHaveLength(2);
    expect(reviewCalls[1]?.join(' ')).toContain('cursor=R2');
  });
});

describe('observePullRequest', () => {
  it('기대 head가 없으면 row와 rollup의 head 일치만 본다', async () => {
    const gh = new FakeGh([at(HEAD)]);
    const obs = await observePullRequest(gh, REPO, 1, { sleep });
    expect(obs.attempts).toBe(1);
    expect(obs.converged).toBe(true);
    expect(obs.expectedHeadOid).toBeNull();
    expect(obs.facts.headRefOid).toBe(HEAD);
  });

  it('stale snapshot을 다시 읽어 기대 head의 facts로 수렴한다', async () => {
    // T1 §OD-044 실측: PUT이 새 SHA를 반환한 직후 첫 조회는 이전 SHA, 두 번째 조회에서 새 SHA.
    const gh = new FakeGh([at(OLD), at(NEW)]);
    const obs = await observePullRequest(gh, REPO, 1, { expectedHeadOid: NEW, sleep });
    expect(obs.attempts).toBe(2);
    expect(obs.converged).toBe(true);
    expect(obs.facts.headRefOid).toBe(NEW);
    expect(obs.facts.checksHeadOid).toBe(NEW);
  });

  it('head는 수렴했는데 rollup이 stale이면 수렴으로 보지 않는다', async () => {
    // head만 확인하고 사실을 따로 읽으면 이 조합에서 old head의 check가 current로 반환된다.
    const gh = new FakeGh([{ row: prRow({ headRefOid: NEW }), rollupOid: OLD }]);
    const obs = await observePullRequest(gh, REPO, 1, {
      expectedHeadOid: NEW, maxAttempts: 2, sleep,
    });
    expect(obs.converged).toBe(false);
    expect(obs.facts.headRefOid).toBe(NEW);
    expect(obs.facts.checksHeadOid).toBe(OLD);
  });

  it('상한까지 읽어도 수렴하지 않으면 던지지 않고 마지막 snapshot을 사실로 남긴다', async () => {
    const gh = new FakeGh([at(OLD)]);
    const obs = await observePullRequest(gh, REPO, 1, {
      expectedHeadOid: NEW, maxAttempts: 3, sleep,
    });
    expect(obs.attempts).toBe(3);
    expect(obs.converged).toBe(false);
    expect(obs.expectedHeadOid).toBe(NEW);
    expect(obs.facts.headRefOid).toBe(OLD);
    expect(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'view')).toHaveLength(3);
  });

  it('maxAttempts가 0 이하여도 최소 1회로 잘라 무한 재시도를 만들지 않는다', async () => {
    const gh = new FakeGh([at(OLD)]);
    const obs = await observePullRequest(gh, REPO, 1, {
      expectedHeadOid: NEW, maxAttempts: 0, sleep,
    });
    expect(obs.attempts).toBe(1);
    expect(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'view')).toHaveLength(1);
  });

  it('maxAttempts가 유한한 정수가 아니면 조회 전에 던진다', async () => {
    // `Math.max`는 Infinity를 보존한다. 그대로 두면 비수렴 PR에서 폴링이 끝나지 않는다.
    const gh = new FakeGh([at(OLD)]);
    for (const bad of [Infinity, Number.NaN, 2.5]) {
      await expect(
        observePullRequest(gh, REPO, 1, { expectedHeadOid: NEW, maxAttempts: bad, sleep }),
      ).rejects.toThrow(TypeError);
    }
    expect(gh.calls).toHaveLength(0);
  });

  it('마지막 시도 뒤에는 기다리지 않는다', async () => {
    const waits: number[] = [];
    const gh = new FakeGh([at(OLD)]);
    await observePullRequest(gh, REPO, 1, {
      expectedHeadOid: NEW,
      maxAttempts: 3,
      delayMs: 7,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([7, 7]);
  });

  it('rule 조회는 재시도마다 반복하지 않는다', async () => {
    const gh = new FakeGh([at(OLD)]);
    await observePullRequest(gh, REPO, 1, { expectedHeadOid: NEW, maxAttempts: 3, sleep });
    expect(gh.calls.filter((c) => c[0] === 'api' && c[1] !== 'graphql')).toHaveLength(2);
  });

  it('조회 실패는 삼키지 않는다', async () => {
    const gh: GhRunner = {
      async run(args) {
        throw new GhCommandError(args, 1, 'gh: Not Found (HTTP 404)');
      },
    };
    await expect(observePullRequest(gh, REPO, 1, { sleep })).rejects.toThrow(GhCommandError);
  });
});
