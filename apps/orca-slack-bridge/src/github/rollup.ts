import { ownerAndName, type RepositoryIdentity } from '../identity/repository.js';
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
   * id, isRequired, state, targetUrl, updatedAt). 그래서 commit status의 appId는 항상 null이다.
   *
   * **null은 "app이 아니다"가 아니라 "보고 주체를 관측하지 못했다"다.** app이 만든 commit
   * status도 여기서는 null이다. 조인이 null을 불충족으로 단정하면 Expected-App이 만든 status가
   * 조용히 false negative가 되므로, 그 판정은 `required-checks.ts`가 `indeterminate`로 남긴다.
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
const CONTEXTS_PAGE = `contexts(first:100,after:$cursor){
  pageInfo{hasNextPage endCursor}
  nodes{
    __typename
    ... on CheckRun{ id name status conclusion startedAt completedAt checkSuite{ app{ databaseId } } }
    ... on StatusContext{ id context state createdAt }
  }
}`;

/** 첫 page. PR의 head commit을 고르는 것은 이 질의 한 번뿐이다. */
const HEAD_ROLLUP_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      commits(last:1){nodes{commit{
        oid
        statusCheckRollup{${CONTEXTS_PAGE}}
      }}}
    }
  }
}`;

/**
 * 이어읽기 page. 첫 page에서 고정한 commit을 `object(oid:)`로 직접 지정한다.
 *
 * `commits(last:1)`을 page마다 다시 읽으면 page 사이에 head가 움직였을 때 첫 commit의 cursor가
 * 새 commit의 connection에 적용돼 서로 다른 commit의 row가 한 결과에 섞이고, `commitOid`는 첫
 * page 값이라 그 오염이 겉으로 드러나지 않는다. commit을 oid로 고정하면 어느 page도 다른
 * commit을 볼 수 없다.
 */
const PINNED_ROLLUP_QUERY = `
query($owner:String!,$name:String!,$oid:GitObjectID!,$cursor:String){
  repository(owner:$owner,name:$name){
    object(oid:$oid){
      ... on Commit{
        statusCheckRollup{${CONTEXTS_PAGE}}
      }
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

/**
 * 반드시 있어야 하는 응답 층. 없으면 던진다.
 *
 * repository/pullRequest/commit이 null인 응답을 빈 객체로 완화하면 조회 실패가 "checks 없음"
 * 이라는 성공으로 바뀐다. 실패를 사실로 위장하지 않는다 — `pull-request.ts`가 `number` 부재에
 * 던지는 것과 같은 규율이다.
 */
function envelope(v: unknown, what: string, where: string): Record<string, unknown> {
  if (v === null || v === undefined || typeof v !== 'object') {
    throw new TypeError(`${where} 응답에 ${what}가 없다. 조회 실패를 빈 결과로 바꾸지 않는다.`);
  }
  return v as Record<string, unknown>;
}

/** contexts connection 한 page를 엄격하게 읽는다. rollup이 null인 경우는 호출자가 먼저 가른다. */
function readContextsPage(
  rollup: unknown,
  where: string,
): { readonly rows: readonly unknown[]; readonly nextCursor: string | null } {
  const contexts = envelope(envelope(rollup, 'statusCheckRollup', where)['contexts'], 'contexts', where);
  const rows = contexts['nodes'];
  if (!Array.isArray(rows)) {
    throw new TypeError(`${where} 응답의 contexts.nodes가 배열이 아니다`);
  }
  const pageInfo = envelope(contexts['pageInfo'], 'pageInfo', where);
  const hasNext = pageInfo['hasNextPage'];
  if (typeof hasNext !== 'boolean') {
    throw new TypeError(`${where} 응답의 pageInfo.hasNextPage가 boolean이 아니다`);
  }
  if (!hasNext) return { rows, nextCursor: null };
  const nextCursor = strOrNull(pageInfo['endCursor']);
  if (nextCursor === null) {
    // 다음 page가 있다는데 cursor가 없으면 전진할 수 없다. 여기서 멈추면 조용한 절단이다.
    throw new TypeError(`${where} 응답이 hasNextPage=true인데 endCursor가 없다`);
  }
  return { rows, nextCursor };
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
 *
 * head commit은 첫 응답에서 한 번만 고른다. 이어읽기는 그 oid를 `object(oid:)`로 직접 지정하므로
 * page 사이에 head가 움직여도 다른 commit의 row가 섞이지 않는다. `commitOid`는 모든 row가 실제로
 * 매달린 commit이다.
 *
 * 응답 층(repository, pullRequest, head commit)이 null이면 던진다. 조회 실패를 "checks 없음"으로
 * 바꾸지 않는다. `statusCheckRollup: null`만은 check가 하나도 없는 commit의 정상 응답이므로 빈
 * 목록이다(실측: 새 THROWAWAY repo의 첫 PR).
 */
export async function fetchStatusCheckRollup(
  runner: GhRunner,
  repo: RepositoryIdentity,
  number: number,
): Promise<RollupObservation> {
  const { owner, name } = ownerAndName(repo);
  const where = `${repo.nameWithOwner} PR #${number} rollup`;

  const first = await ghJson<unknown>(runner, [
    'api', 'graphql',
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `number=${number}`,
    '-f', `query=${HEAD_ROLLUP_QUERY}`,
  ]);
  const data = envelope(envelope(first, '본문', where)['data'], 'data', where);
  const repository = envelope(data['repository'], 'repository', where);
  const pullRequest = envelope(repository['pullRequest'], 'pullRequest', where);
  const nodes = envelope(pullRequest['commits'], 'commits', where)['nodes'];
  const head = envelope(Array.isArray(nodes) ? nodes[0] : null, 'head commit node', where);
  const commit = envelope(head['commit'], 'head commit', where);
  const commitOid = commit['oid'];
  if (typeof commitOid !== 'string' || commitOid === '') {
    throw new TypeError(`${where} 응답에 head commit oid가 없다`);
  }

  // check가 하나도 없는 commit은 rollup 자체가 null이다. 이것만은 실패가 아니라 사실이다.
  if (commit['statusCheckRollup'] === null || commit['statusCheckRollup'] === undefined) {
    return { commitOid, checks: [], pages: 1 };
  }

  const checks: CheckFact[] = [];
  let page = readContextsPage(commit['statusCheckRollup'], where);
  let pages = 1;
  for (const row of page.rows) checks.push(toCheckFact(row));

  while (page.nextCursor !== null) {
    if (pages >= MAX_PAGES) {
      throw new RangeError(
        `${repo.nameWithOwner} PR #${number} rollup이 ${MAX_PAGES} page를 넘었다. 조용히 자르지 않는다.`,
      );
    }
    const raw = await ghJson<unknown>(runner, [
      'api', 'graphql',
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-f', `oid=${commitOid}`,
      '-f', `cursor=${page.nextCursor}`,
      '-f', `query=${PINNED_ROLLUP_QUERY}`,
    ]);
    pages += 1;
    const nextData = envelope(envelope(raw, '본문', where)['data'], 'data', where);
    const nextRepository = envelope(nextData['repository'], 'repository', where);
    // 고정한 oid의 commit이 사라졌거나 rollup이 없어졌다면 첫 page와 모순된 응답이다. 던진다.
    const object = envelope(nextRepository['object'], `commit ${commitOid}`, where);
    page = readContextsPage(object['statusCheckRollup'], where);
    for (const row of page.rows) checks.push(toCheckFact(row));
  }
  return { commitOid, checks, pages };
}
