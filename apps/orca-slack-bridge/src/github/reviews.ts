import { ownerAndName, type RepositoryIdentity } from '../identity/repository.js';
import { ghJson, type GhRunner } from './runner.js';

/**
 * review 한 건.
 *
 * `id`는 GraphQL node ID다(`PRR_...`). T1 §OD-044에서 review id는 resource identity로 안정적이고
 * dismissal은 같은 id의 `state`를 바꾼다고 관측됐다. 그래서 id는 순서 key가 아니라 identity로만
 * 쓰고 같은 head 안의 순서는 `submittedAt`으로 본다(OD-044).
 */
export type ReviewFact = {
  readonly id: string;
  readonly state: string;
  /** review가 본 commit sha. head와 다르면 오래된 head를 봤다는 사실이다(OD-031). */
  readonly commit: string | null;
  readonly author: string | null;
  readonly submittedAt: string | null;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * review row 하나를 사실로 옮긴다.
 *
 * `gh pr list/view --json reviews`의 row와 아래 `REVIEWS_QUERY`의 node가 같은 모양이라
 * (`id`/`state`/`commit.oid`/`author.login`/`submittedAt`) 두 경로가 이 함수 하나를 쓴다.
 */
export function toReviewFact(raw: unknown): ReviewFact {
  const o = (raw ?? {}) as Record<string, unknown>;
  const commit = (o['commit'] ?? {}) as Record<string, unknown>;
  const author = (o['author'] ?? {}) as Record<string, unknown>;
  return {
    id: str(o['id']),
    state: str(o['state']),
    commit: strOrNull(commit['oid']),
    author: strOrNull(author['login']),
    submittedAt: strOrNull(o['submittedAt']),
  };
}

/**
 * `gh pr list --json reviews`의 nested connection과 같은 필드를 cursor로 끝까지 읽는 질의.
 *
 * `gh 2.98`의 nested fragment는 `reviews(first: 100)`이고 list 경로는 그 `pageInfo`를 후속
 * 조회하지 않아 101번째부터가 요청 성공인 채로 사라진다. 응답에는 totalCount도 없어 row만
 * 보고는 잘렸는지 알 수 없다(2026-08-23 실측: `--json reviews`는 bare 배열이다). 그래서
 * 상한에 닿은 PR은 이 질의로 전량을 다시 읽는다(`pull-request.ts`).
 */
const REVIEWS_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviews(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{ id state commit{oid} author{login} submittedAt }
      }
    }
  }
}`;

/** page 상한. 무한 cursor 루프를 막는다. 100 × 100 = review 10000건이다. */
const MAX_PAGES = 100;

/** 반드시 있어야 하는 응답 층. 없으면 던진다. 조회 실패를 "review 없음"으로 바꾸지 않는다. */
function envelope(v: unknown, what: string, where: string): Record<string, unknown> {
  if (v === null || v === undefined || typeof v !== 'object') {
    throw new TypeError(`${where} 응답에 ${what}가 없다. 조회 실패를 빈 결과로 바꾸지 않는다.`);
  }
  return v as Record<string, unknown>;
}

/** PR의 review 전량. nested 조회가 상한에 닿았을 때만 부른다 — PR당 GraphQL page 수만큼 조회다. */
export async function fetchAllReviews(
  runner: GhRunner,
  repo: RepositoryIdentity,
  number: number,
): Promise<ReviewFact[]> {
  const { owner, name } = ownerAndName(repo);
  const where = `${repo.nameWithOwner} PR #${number} reviews`;
  const out: ReviewFact[] = [];
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    if (pages >= MAX_PAGES) {
      throw new RangeError(`${where}가 ${MAX_PAGES} page를 넘었다. 조용히 자르지 않는다.`);
    }
    const raw = await ghJson<unknown>(runner, [
      'api', 'graphql',
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `number=${number}`,
      ...(cursor === null ? [] : ['-f', `cursor=${cursor}`]),
      '-f', `query=${REVIEWS_QUERY}`,
    ]);
    pages += 1;

    const data = envelope(envelope(raw, '본문', where)['data'], 'data', where);
    const repository = envelope(data['repository'], 'repository', where);
    const pullRequest = envelope(repository['pullRequest'], 'pullRequest', where);
    const reviews = envelope(pullRequest['reviews'], 'reviews', where);
    const rows = reviews['nodes'];
    if (!Array.isArray(rows)) {
      throw new TypeError(`${where} 응답의 reviews.nodes가 배열이 아니다`);
    }
    for (const row of rows) out.push(toReviewFact(row));

    const pageInfo = envelope(reviews['pageInfo'], 'pageInfo', where);
    const hasNext = pageInfo['hasNextPage'];
    if (typeof hasNext !== 'boolean') {
      throw new TypeError(`${where} 응답의 pageInfo.hasNextPage가 boolean이 아니다`);
    }
    if (!hasNext) return out;
    cursor = strOrNull(pageInfo['endCursor']);
    if (cursor === null) {
      // 다음 page가 있다는데 cursor가 없으면 전진할 수 없다. 여기서 멈추면 조용한 절단이다.
      throw new TypeError(`${where} 응답이 hasNextPage=true인데 endCursor가 없다`);
    }
  }
}
