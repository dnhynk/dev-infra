import { pullRequestKey, type PullRequestKey } from '../identity/keys.js';
import type { RepositoryIdentity } from '../identity/repository.js';
import { fetchBranchRequiredRules, type BranchRequiredRules } from './branch-rules.js';
import { joinRequiredChecks, type RequiredCheckFact } from './required-checks.js';
import { fetchAllReviews, toReviewFact, type ReviewFact } from './reviews.js';
import { fetchStatusCheckRollup, type CheckFact, type RollupObservation } from './rollup.js';
import { ghJson, type GhRunner } from './runner.js';

export type { CheckFact } from './rollup.js';
export type { ReviewFact } from './reviews.js';

/** correlation과 상태 축약에 필요한 PR 사실. summarizer 입력은 C1에서 정한다. */
export type PullRequestFacts = {
  readonly key: PullRequestKey;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefName: string;
  /** head commit sha. reviewer_result의 `reviewedHeadSha`와 대조할 대상이다. */
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly mergedAt: string | null;
  /** GitHub formal review 판정. 관측된 모든 대상 repo에서 null이다(DL-016 근거). */
  readonly reviewDecision: string | null;
  /**
   * review 전부. `gh`의 nested 조회가 상한(100)에 닿은 PR은 GraphQL로 전량을 다시 읽은
   * 결과이므로 이 배열은 잘리지 않는다(`completeReviews`).
   */
  readonly reviews: readonly ReviewFact[];
  readonly checks: readonly CheckFact[];
  /**
   * `checks`를 매단 commit sha.
   *
   * PR row와 rollup은 서로 다른 응답이고 T1 §OD-044에서 GitHub은 한 시점에 서로 다른 head를 주는
   * 응답을 냈다. 그래서 이 값이 `headRefOid`와 다를 수 있고, 다르면 check는 그 head의 사실이 아니다.
   * 두 값을 하나로 접으면 stale check를 current로 보이게 만든다. 접지 않고 둘 다 남긴다.
   */
  readonly checksHeadOid: string;
  /**
   * base branch의 effective required rule. 미설정과 조회 불가를 사실로 구분해 담는다.
   * required 판정의 근거를 소비자가 확인할 수 있어야 하므로 rule 자체를 함께 싣는다(OD-032).
   */
  readonly requiredRules: BranchRequiredRules;
  /**
   * `requiredRules`와 `checks`를 조인한 context별 상태. merge-ready 판정은 하지 않는다(OD-032).
   * `checks`에서 파생하므로 commit scope도 같다 — `checksHeadOid`의 사실이다.
   */
  readonly requiredChecks: readonly RequiredCheckFact[];
  /**
   * 변경 파일 경로. summarizer의 `changedPaths` source다.
   *
   * `gh pr list --json files`는 **최대 100개까지만** 준다. 실측: `nodejs/node` PR #65461이
   * `changedFiles` 1971에 `files` 100이었다. 그래서 이 배열 길이는 전체 수가 아니다.
   * 응답에 함께 오는 additions/deletions/changeType은 C1 카드가 쓰지 않으므로 버린다.
   */
  readonly changedPaths: readonly string[];
  /** gh `changedFiles`. 잘리지 않은 전체 변경 파일 수이며 `changedPaths.length`와 다를 수 있다. */
  readonly changedFilesTotal: number;
};

/**
 * `gh pr view/list --json`으로 읽는 PR field.
 *
 * `statusCheckRollup`은 여기서 읽지 않는다. `gh`가 박아 둔 fragment에는 resource id도 app 바인딩도
 * 없고 `contexts`를 cursor 없이 한 번만 읽는다. rollup은 `rollup.ts`가 직접 질의한다.
 *
 * `reviews`도 nested 상한이 있다. `gh 2.98`의 fragment는 `reviews(first: 100)`이고 list 경로는
 * `pageInfo`를 후속 조회하지 않는다. 상한에 닿은 PR은 `completeReviews`가 전량을 다시 읽는다.
 */
const FIELDS = [
  'number', 'title', 'body', 'url', 'state', 'isDraft',
  'headRefName', 'headRefOid', 'baseRefName', 'mergedAt', 'reviewDecision', 'reviews',
  'files', 'changedFiles',
].join(',');

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** rollup 조회와 rule 조인 전 단계. PR row 응답만으로 만들 수 있는 사실이다. */
type PullRequestSource = Omit<
  PullRequestFacts,
  'requiredRules' | 'requiredChecks' | 'checks' | 'checksHeadOid'
>;

function toPullRequestSource(raw: unknown, repo: RepositoryIdentity): PullRequestSource {
  const o = raw as Record<string, unknown>;
  const number = o['number'];
  if (typeof number !== 'number') {
    throw new TypeError(`${repo.nameWithOwner} PR 응답에 number가 없다`);
  }
  const reviews = Array.isArray(o['reviews']) ? o['reviews'] : [];
  const files = Array.isArray(o['files']) ? o['files'] : [];
  const changedFiles = o['changedFiles'];
  if (typeof changedFiles !== 'number') {
    throw new TypeError(`${repo.nameWithOwner} PR #${number} 응답에 changedFiles가 없다`);
  }
  return {
    key: pullRequestKey(repo.githubId, number),
    number,
    title: str(o['title']),
    body: str(o['body']),
    url: str(o['url']),
    state: str(o['state']),
    isDraft: o['isDraft'] === true,
    headRefName: str(o['headRefName']),
    headRefOid: str(o['headRefOid']),
    baseRefName: str(o['baseRefName']),
    mergedAt: strOrNull(o['mergedAt']),
    reviewDecision: strOrNull(o['reviewDecision']),
    reviews: reviews.map(toReviewFact),
    changedPaths: files.map((f) => str((f as Record<string, unknown>)['path'])),
    changedFilesTotal: changedFiles,
  };
}

/**
 * `gh`의 nested `reviews`가 상한에 닿았으면 전량을 다시 읽는다.
 *
 * `gh 2.98`의 nested fragment는 `reviews(first: 100)`이고 응답은 totalCount 없는 bare 배열이라
 * (2026-08-23 실측) 100건이 "전부"인지 "잘림"인지 row만으로는 가를 수 없다. 그래서 상한과 같은
 * 길이를 잘림 후보로 보고 그 PR만 GraphQL cursor로 전량을 다시 읽는다(`reviews.ts`). review가
 * 정확히 100건인 PR은 한 번 헛조회하지만, 상한 미만인 대다수 PR은 추가 조회가 없다.
 */
const REVIEWS_NESTED_CAP = 100;

async function completeReviews(
  runner: GhRunner,
  repo: RepositoryIdentity,
  source: PullRequestSource,
): Promise<PullRequestSource> {
  if (source.reviews.length < REVIEWS_NESTED_CAP) return source;
  return { ...source, reviews: await fetchAllReviews(runner, repo, source.number) };
}

/**
 * PR마다 head rollup을 읽고 base branch의 required rule과 조인한다.
 *
 * rule은 base branch별로 한 번만 조회해 캐시한다. 같은 base를 쓰는 PR이 많고 rule은 head가 아니라
 * branch의 사실이기 때문이다. rollup은 head마다 다르므로 PR마다 한 번씩 조회한다 —
 * PR N개면 GraphQL 조회도 N회다.
 *
 * **PR row와 rollup의 head가 어긋나면 그 PR만 `observePullRequest`로 재관측한다.** 두 응답은
 * 서로 다른 시점일 수 있고 T1 §OD-044 실측에서 push 직후 조회가 이전 SHA를 줬다가 2초 뒤
 * 수렴했다. 어긋난 단발 snapshot을 그대로 실으면 old head의 check가 current head의 사실로
 * 보인다. 상한까지 재관측해도 어긋나면 facts에 `headRefOid ≠ checksHeadOid`가 그대로 남고,
 * projection과 renderer가 그 사실을 카드에 표시한다(`digest/render.ts`) — 조용히 성공으로
 * 흘리지 않는다. 재관측 PR은 rule 캐시를 지나치므로 rule 조회 2회가 더 든다.
 */
async function attachChecksAndRules(
  runner: GhRunner,
  repo: RepositoryIdentity,
  sources: readonly PullRequestSource[],
  poll: HeadConvergenceOptions = {},
): Promise<PullRequestFacts[]> {
  const cache = new Map<string, BranchRequiredRules>();
  const out: PullRequestFacts[] = [];
  for (const listed of sources) {
    const rollup = await fetchStatusCheckRollup(runner, repo, listed.number);
    if (listed.headRefOid !== rollup.commitOid) {
      const observed = await observePullRequest(runner, repo, listed.number, poll);
      out.push(observed.facts);
      continue;
    }
    const source = await completeReviews(runner, repo, listed);
    let rules = cache.get(source.baseRefName);
    if (rules === undefined) {
      rules = await fetchBranchRequiredRules(runner, repo, source.baseRefName);
      cache.set(source.baseRefName, rules);
    }
    out.push({
      ...source,
      checks: rollup.checks,
      checksHeadOid: rollup.commitOid,
      requiredRules: rules,
      requiredChecks: joinRequiredChecks(rules, rollup.checks),
    });
  }
  return out;
}

/** 이미 읽은 rollup을 그대로 쓰는 조인. 재조회 loop가 rollup을 두 번 읽지 않게 한다. */
async function attachRules(
  runner: GhRunner,
  repo: RepositoryIdentity,
  source: PullRequestSource,
  rollup: RollupObservation,
): Promise<PullRequestFacts> {
  const rules = await fetchBranchRequiredRules(runner, repo, source.baseRefName);
  return {
    ...source,
    checks: rollup.checks,
    checksHeadOid: rollup.commitOid,
    requiredRules: rules,
    requiredChecks: joinRequiredChecks(rules, rollup.checks),
  };
}

/**
 * repository의 PR을 최근 것부터 `limit`개 읽는다.
 *
 * `limit`은 조회 상한이 아니라 **관측 범위**다. CLI `--pr-limit`에서 오고 도움말이 그 뜻을
 * 말한다. 그 밖의 목록(reviews, rollup contexts, rules)은 상한 없이 끝까지 읽거나, 읽지 못하면
 * 던지거나 절단 사실을 남긴다 — 각 조회 지점에 근거가 있다.
 *
 * `poll`은 head가 어긋난 PR의 재관측 상한이다(`attachChecksAndRules`). 기본값은
 * `observePullRequest`와 같다(5회 × 2초).
 */
export async function listPullRequests(
  runner: GhRunner,
  repo: RepositoryIdentity,
  limit = 50,
  poll: HeadConvergenceOptions = {},
): Promise<PullRequestFacts[]> {
  const rows = await ghJson<unknown[]>(runner, [
    'pr', 'list',
    '--repo', repo.nameWithOwner,
    '--state', 'all',
    '--limit', String(limit),
    '--json', FIELDS,
  ]);
  return attachChecksAndRules(runner, repo, rows.map((row) => toPullRequestSource(row, repo)), poll);
}

/** 한 PR의 row와 head rollup을 한 번씩 읽는다. */
async function readOnce(
  runner: GhRunner,
  repo: RepositoryIdentity,
  number: number,
): Promise<{ source: PullRequestSource; rollup: RollupObservation }> {
  const row = await ghJson<unknown>(runner, [
    'pr', 'view', String(number),
    '--repo', repo.nameWithOwner,
    '--json', FIELDS,
  ]);
  const source = toPullRequestSource(row, repo);
  return { source, rollup: await fetchStatusCheckRollup(runner, repo, number) };
}

/**
 * head를 지정한 PR 재조회 관측.
 *
 * `facts`는 마지막으로 읽은 snapshot 그대로다. `converged`가 false면 그 snapshot은 기대한 head의
 * 사실이 아니며, 그 사실을 숨기고 current인 척 반환하지 않는다. 무엇이 어긋났는지는
 * `facts.headRefOid`와 `facts.checksHeadOid`를 `expectedHeadOid`와 대조해 볼 수 있다.
 */
export type PullRequestObservation = {
  readonly facts: PullRequestFacts;
  /** 실제 수행한 재조회 횟수. */
  readonly attempts: number;
  /** 요청한 head. null이면 특정 head를 요구하지 않았다. */
  readonly expectedHeadOid: string | null;
  /**
   * `expectedHeadOid`가 있으면 `facts.headRefOid`와 `facts.checksHeadOid`가 모두 그 값일 때 true다.
   * 없으면 두 값이 서로 같기만 하면 true다.
   * false는 상한까지 읽고도 그 head를 못 봤다는 사실이며 오류가 아니다.
   */
  readonly converged: boolean;
};

export type HeadPollOptions = {
  /** 이 sha의 snapshot이 보일 때까지 다시 읽는다. 없으면 row와 rollup의 head 일치만 본다. */
  readonly expectedHeadOid?: string | null;
  /** 조회 횟수 상한. 무한 재시도를 막는다. 유한한 정수가 아니면 던지고 1 미만은 1로 자른다. */
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * bulk 경로(`listPullRequests`)가 재관측에 넘기는 상한. 특정 head를 기대하는 것이 아니라
 * row와 rollup이 한 head에 합의하는 snapshot을 구하는 것이므로 `expectedHeadOid`는 없다.
 */
export type HeadConvergenceOptions = Omit<HeadPollOptions, 'expectedHeadOid'>;

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 2000;

/**
 * 지정한 head의 PR 사실을 bounded polling으로 읽는다.
 *
 * T1 §OD-044에서 content PUT이 새 SHA를 반환한 직후의 첫 `gh pr view`가 이전 SHA를 줬고 2초 뒤
 * 두 번째 조회에서 새 SHA로 수렴했다. 같은 절에서 한 응답이 서로 다른 시점의 필드를 섞는 것도
 * 관측됐다. 그래서 head가 움직였을 것으로 아는 시점에는 단발 snapshot을 믿지 않는다.
 * 프로덕션에서는 `listPullRequests`가 PR row와 rollup의 head 불일치를 관측한 PR에 대해 부른다.
 *
 * head 수렴과 사실 조회를 나누지 않는다. 나누면 수렴을 확인한 뒤의 조회가 다시 stale일 수 있고,
 * 그 결과는 old head의 check를 current로 반환한다. OD-044가 head SHA를 review/check의 version
 * scope로 정한 이유가 이것이다. rule 조회는 head가 아니라 branch의 사실이라 loop 밖에서 한 번만 한다.
 *
 * 수렴하지 않아도 던지지 않는다. `converged: false` 관측을 그대로 돌려주고 그 사실을 어떻게 쓸지는
 * 호출자가 정한다 — `listPullRequests` 경로에서는 facts의 `headRefOid ≠ checksHeadOid`로 남아
 * 카드가 표시한다. 기본 상한은 5회 × 2초다.
 */
export async function observePullRequest(
  runner: GhRunner,
  repo: RepositoryIdentity,
  number: number,
  options: HeadPollOptions = {},
): Promise<PullRequestObservation> {
  const expected = options.expectedHeadOid ?? null;
  const requested = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  // Infinity·NaN·소수가 들어오면 "상한이 있다"는 이 함수의 계약이 조용히 사라진다.
  // `Math.max`는 Infinity를 보존하므로 clamp가 아니라 거절이 맞다.
  if (!Number.isSafeInteger(requested)) {
    throw new TypeError(`maxAttempts는 유한한 정수여야 한다: ${String(requested)}`);
  }
  const maxAttempts = Math.max(1, requested);
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last = await readOnce(runner, repo, number);
  let attempts = 1;
  const agrees = (r: { source: PullRequestSource; rollup: RollupObservation }): boolean =>
    expected === null
      ? r.source.headRefOid === r.rollup.commitOid
      : r.source.headRefOid === expected && r.rollup.commitOid === expected;

  while (!agrees(last) && attempts < maxAttempts) {
    await sleep(delayMs);
    last = await readOnce(runner, repo, number);
    attempts += 1;
  }

  // reviews 전량 보정은 수렴 판정과 무관하므로 loop 밖에서 마지막 snapshot에만 한다.
  const source = await completeReviews(runner, repo, last.source);
  return {
    facts: await attachRules(runner, repo, source, last.rollup),
    attempts,
    expectedHeadOid: expected,
    converged: agrees(last),
  };
}
