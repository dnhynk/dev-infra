import type { RepositoryIdentity } from '../identity/repository.js';
import { ghJson, type GhRunner } from './runner.js';

/**
 * head commit rollup row 하나.
 *
 * `statusCheckRollup`은 두 종류를 섞어 준다. `CheckRun`은 `name`/`status`/`conclusion`을,
 * `StatusContext`는 `context`/`state`를 준다. 실측(2026-08-23, `kubernetes/kubernetes` open PR과
 * `dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b#1`): `StatusContext` row에는 `name`도 `status`도
 * `conclusion`도 없다. 이름 필드만 읽으면 commit status의 이름이 통째로 비어 required context와
 * 조인할 수 없다.
 */
export type CheckFact = {
  readonly kind: 'checkRun' | 'statusContext' | 'unknown';
  /**
   * GraphQL node id. `CheckRun`은 `CR_...`, `StatusContext`는 `SC_...`다.
   *
   * OD-044는 동일 head 안의 check/status를 각 resource의 timestamp와 id로 reconcile한다고 확정했다.
   * id가 없으면 완료 snapshot 뒤에 늦게 도착한 진행 snapshot을 같은 resource로 묶을 수 없다.
   * C2는 이 사실을 싣기만 하고 reconcile 규칙 자체는 쓰지 않는다.
   */
  readonly id: string;
  /** `CheckRun.name` 또는 `StatusContext.context`. required rule의 context와 맞추는 키다. */
  readonly name: string;
  /** `CheckRun.status`. `StatusContext`에는 없어 ''다. */
  readonly status: string;
  /** `CheckRun.conclusion`. `StatusContext`에는 없어 null이다. */
  readonly conclusion: string | null;
  /** `StatusContext.state`. `CheckRun`에는 없어 null이다. */
  readonly state: string | null;
  /**
   * 이 row를 보고한 GitHub App의 database id. app-bound required rule과 대조하는 값이다.
   *
   * `CheckRun`은 `checkSuite.app.databaseId`로 온다. `StatusContext`에는 app을 식별하는 field가
   * 아예 없다(GraphQL introspection: avatarUrl, commit, context, createdAt, creator, description,
   * id, isRequired, state, targetUrl, updatedAt). 그래서 commit status의 appId는 항상 null이고
   * app-bound rule을 충족시키지 못한다. 실측(2026-08-23)에서 PAT가 만든 commit status는 실제로
   * app-bound required rule을 충족시키지 못했다. app이 만든 commit status였다면 GitHub은 충족으로
   * 보지만 여기서는 구분할 사실이 없어 충족으로 올리지 않는다.
   */
  readonly appId: number | null;
  /** `CheckRun.startedAt` 또는 `StatusContext.createdAt`. */
  readonly startedAt: string | null;
  /** `CheckRun.completedAt`. commit status는 생성이 곧 종결이라 없고 null이다. */
  readonly completedAt: string | null;
};

/** head commit 하나의 rollup 관측. checks가 어느 commit의 사실인지 함께 남긴다(OD-044). */
export type RollupObservation = {
  /** rollup을 매단 commit sha. `PullRequestFacts.checksHeadOid`가 되는 값이다. */
  readonly commitOid: string;
  readonly checks: readonly CheckFact[];
  /** 실제로 읽은 page 수. */
  readonly pages: number;
};

/**
 * rollup을 `gh pr view --json statusCheckRollup`이 아니라 직접 만든 GraphQL 질의로 읽는다.
 *
 * `gh`가 박아 둔 fragment는 `id`, `databaseId`, `checkSuite.app`을 요청하지 않고
 * `contexts(last: 100)`을 cursor 없이 한 번만 읽는다(2026-08-23 `gh 2.98.0` 응답 실측:
 * CheckRun row에 `completedAt, conclusion, detailsUrl, name, startedAt, status, workflowName`만 있었다).
 * app 바인딩과 resource id는 그 응답에 없고, context가 100개를 넘으면 조용히 잘린다.
 * OD-032의 app-bound 조인과 OD-044의 reconcile 사실이 둘 다 그 응답으로는 만들어지지 않는다.
 */
const ROLLUP_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      commits(last:1){nodes{commit{
        oid
        statusCheckRollup{contexts(first:100,after:$cursor){
          pageInfo{hasNextPage endCursor}
          nodes{
            __typename
            ... on CheckRun{ id name status conclusion startedAt completedAt checkSuite{ app{ databaseId } } }
            ... on StatusContext{ id context state createdAt }
          }
        }}
      }}}
    }
  }
}`;

/** page 상한. 무한 cursor 루프를 막는다. 100 × 100 = context 10000개다. */
const MAX_PAGES = 100;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function rec(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

function toCheckFact(raw: unknown): CheckFact {
  const o = rec(raw);
  const typename = str(o['__typename']);
  if (typename === 'StatusContext') {
    return {
      kind: 'statusContext',
      id: str(o['id']),
      name: str(o['context']),
      status: '',
      conclusion: null,
      state: strOrNull(o['state']),
      appId: null,
      startedAt: strOrNull(o['createdAt']),
      completedAt: null,
    };
  }
  if (typename === 'CheckRun') {
    const databaseId = rec(rec(o['checkSuite'])['app'])['databaseId'];
    return {
      kind: 'checkRun',
      id: str(o['id']),
      name: str(o['name']),
      status: str(o['status']),
      conclusion: strOrNull(o['conclusion']),
      state: null,
      appId: typeof databaseId === 'number' ? databaseId : null,
      startedAt: strOrNull(o['startedAt']),
      completedAt: strOrNull(o['completedAt']),
    };
  }
  // rollup에 새 type이 생기면 이름도 상태도 모른다. 지어내지 않고 모른다는 사실로 남긴다.
  return {
    kind: 'unknown',
    id: str(o['id']),
    name: '',
    status: '',
    conclusion: null,
    state: null,
    appId: null,
    startedAt: null,
    completedAt: null,
  };
}

/**
 * PR head commit의 rollup을 끝까지 읽는다.
 *
 * `contexts`는 paginated connection이다. cursor를 따라가지 않으면 101번째부터가 요청 성공인 채로
 * 사라지고, 그 context가 required였다면 `missing` 판정에도 나타나지 않는다.
 */
export async function fetchStatusCheckRollup(
  runner: GhRunner,
  repo: RepositoryIdentity,
  number: number,
): Promise<RollupObservation> {
  const slash = repo.nameWithOwner.indexOf('/');
  if (slash <= 0 || slash === repo.nameWithOwner.length - 1) {
    throw new TypeError(`GraphQL 조회에 쓸 owner/name을 읽을 수 없다: ${repo.nameWithOwner}`);
  }
  const owner = repo.nameWithOwner.slice(0, slash);
  const name = repo.nameWithOwner.slice(slash + 1);

  const checks: CheckFact[] = [];
  let commitOid = '';
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    const raw = await ghJson<unknown>(runner, [
      'api', 'graphql',
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `number=${number}`,
      ...(cursor === null ? [] : ['-f', `cursor=${cursor}`]),
      '-f', `query=${ROLLUP_QUERY}`,
    ]);
    pages += 1;

    const commits = rec(rec(rec(rec(raw)['data'])['repository'])['pullRequest'])['commits'];
    const nodes = rec(commits)['nodes'];
    const commit = rec(rec(Array.isArray(nodes) ? nodes[0] : null)['commit']);
    if (commitOid === '') commitOid = str(commit['oid']);

    const contexts = rec(rec(commit['statusCheckRollup'])['contexts']);
    const rows = contexts['nodes'];
    if (Array.isArray(rows)) for (const row of rows) checks.push(toCheckFact(row));

    const pageInfo = rec(contexts['pageInfo']);
    cursor = pageInfo['hasNextPage'] === true ? strOrNull(pageInfo['endCursor']) : null;
    if (cursor === null) return { commitOid, checks, pages };
    if (pages >= MAX_PAGES) {
      throw new RangeError(
        `${repo.nameWithOwner} PR #${number} rollup이 ${MAX_PAGES} page를 넘었다. 조용히 자르지 않는다.`,
      );
    }
  }
}
