import { pullRequestKey, type PullRequestKey } from '../identity/keys.js';
import type { RepositoryIdentity } from '../identity/repository.js';
import { fetchBranchRequiredRules, type BranchRequiredRules } from './branch-rules.js';
import { joinRequiredChecks, type RequiredCheckFact } from './required-checks.js';
import { ghJson, type GhRunner } from './runner.js';

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
  readonly reviews: readonly ReviewFact[];
  readonly checks: readonly CheckFact[];
  /**
   * base branch의 effective required rule. 미설정과 조회 불가를 사실로 구분해 담는다.
   * required 판정의 근거를 소비자가 확인할 수 있어야 하므로 rule 자체를 함께 싣는다(OD-032).
   */
  readonly requiredRules: BranchRequiredRules;
  /** `requiredRules`와 `checks`를 조인한 context별 상태. merge-ready 판정은 하지 않는다(OD-032). */
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
 * rollup row 하나.
 *
 * `statusCheckRollup`은 두 종류를 섞어 준다. `CheckRun`은 `name`/`status`/`conclusion`을,
 * `StatusContext`는 `context`/`state`를 준다. 실측(2026-08-23, `kubernetes/kubernetes` open PR과
 * `dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b#1`): `StatusContext` row에는 `name`도 `status`도
 * `conclusion`도 없다. 이름 필드만 읽으면 commit status의 이름이 통째로 비어 required context와
 * 조인할 수 없다.
 */
export type CheckFact = {
  readonly kind: 'checkRun' | 'statusContext' | 'unknown';
  /** `CheckRun.name` 또는 `StatusContext.context`. required rule의 context와 맞추는 키다. */
  readonly name: string;
  /** `CheckRun.status`. `StatusContext`에는 없어 ''다. */
  readonly status: string;
  /** `CheckRun.conclusion`. `StatusContext`에는 없어 null이다. */
  readonly conclusion: string | null;
  /** `StatusContext.state`. `CheckRun`에는 없어 null이다. */
  readonly state: string | null;
};

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

const FIELDS = [
  'number', 'title', 'body', 'url', 'state', 'isDraft',
  'headRefName', 'headRefOid', 'baseRefName', 'mergedAt', 'reviewDecision', 'reviews',
  'statusCheckRollup', 'files', 'changedFiles',
].join(',');

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function toCheckFact(raw: unknown): CheckFact {
  const o = (raw ?? {}) as Record<string, unknown>;
  const typename = str(o['__typename']);
  if (typename === 'StatusContext') {
    return {
      kind: 'statusContext',
      name: str(o['context']),
      status: '',
      conclusion: null,
      state: strOrNull(o['state']),
    };
  }
  return {
    // `__typename`이 없는 응답도 CheckRun 필드가 있으면 CheckRun으로 읽는다.
    kind: typename === 'CheckRun' || 'name' in o ? 'checkRun' : 'unknown',
    name: str(o['name']),
    status: str(o['status']),
    conclusion: strOrNull(o['conclusion']),
    state: null,
  };
}

function toReviewFact(raw: unknown): ReviewFact {
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

/** rule 조인 전 단계. base branch별 rule 조회를 묶기 위해 분리한다. */
type PullRequestSource = Omit<PullRequestFacts, 'requiredRules' | 'requiredChecks'>;

function toPullRequestSource(raw: unknown, repo: RepositoryIdentity): PullRequestSource {
  const o = raw as Record<string, unknown>;
  const number = o['number'];
  if (typeof number !== 'number') {
    throw new TypeError(`${repo.nameWithOwner} PR 응답에 number가 없다`);
  }
  const reviews = Array.isArray(o['reviews']) ? o['reviews'] : [];
  const rollup = Array.isArray(o['statusCheckRollup']) ? o['statusCheckRollup'] : [];
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
    checks: rollup.map(toCheckFact),
  };
}

/**
 * base branch별 required rule을 한 번씩만 조회해 조인한다.
 *
 * 같은 base를 쓰는 PR이 많으므로 branch 단위로 캐시한다. rule 조회는 PR 목록과 별개인 endpoint
 * 2개이고 404는 정상 응답이다(`branch-rules.ts`).
 */
async function attachRequiredChecks(
  runner: GhRunner,
  repo: RepositoryIdentity,
  sources: readonly PullRequestSource[],
): Promise<PullRequestFacts[]> {
  const cache = new Map<string, BranchRequiredRules>();
  const out: PullRequestFacts[] = [];
  for (const source of sources) {
    let rules = cache.get(source.baseRefName);
    if (rules === undefined) {
      rules = await fetchBranchRequiredRules(runner, repo, source.baseRefName);
      cache.set(source.baseRefName, rules);
    }
    out.push({
      ...source,
      requiredRules: rules,
      requiredChecks: joinRequiredChecks(rules, source.checks),
    });
  }
  return out;
}

export async function listPullRequests(
  runner: GhRunner,
  repo: RepositoryIdentity,
  limit = 50,
): Promise<PullRequestFacts[]> {
  const rows = await ghJson<unknown[]>(runner, [
    'pr', 'list',
    '--repo', repo.nameWithOwner,
    '--state', 'all',
    '--limit', String(limit),
    '--json', FIELDS,
  ]);
  return attachRequiredChecks(runner, repo, rows.map((row) => toPullRequestSource(row, repo)));
}

/** 한 PR만 다시 읽는다. head가 움직인 뒤 사실을 갱신하는 경로다(OD-044). */
export async function fetchPullRequest(
  runner: GhRunner,
  repo: RepositoryIdentity,
  number: number,
): Promise<PullRequestFacts> {
  const row = await ghJson<unknown>(runner, [
    'pr', 'view', String(number),
    '--repo', repo.nameWithOwner,
    '--json', FIELDS,
  ]);
  const [facts] = await attachRequiredChecks(runner, repo, [toPullRequestSource(row, repo)]);
  if (facts === undefined) {
    throw new TypeError(`${repo.nameWithOwner} PR #${number} 조회 결과가 비었다`);
  }
  return facts;
}

/** head 재조회 관측. 판정하지 않고 수렴 여부를 사실로 남긴다. */
export type HeadObservation = {
  readonly headRefOid: string;
  /** 실제 수행한 조회 횟수. */
  readonly attempts: number;
  /**
   * `expectedHeadOid`와 일치한 채로 끝났는지. `expectedHeadOid`가 없으면 항상 true다.
   * false는 상한까지 읽었는데도 기대 head를 못 봤다는 사실이며 오류가 아니다.
   */
  readonly converged: boolean;
};

export type HeadPollOptions = {
  /** 이 sha가 보일 때까지 다시 읽는다. 없으면 1회만 읽는다. */
  readonly expectedHeadOid?: string | null;
  /** 조회 횟수 상한. 무한 재시도를 막는다. */
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 2000;

/**
 * head SHA를 bounded polling으로 다시 읽는다.
 *
 * T1 §OD-044에서 content PUT이 새 SHA를 반환한 직후의 첫 `gh pr view`가 이전 SHA를 줬고 2초 뒤
 * 두 번째 조회에서 새 SHA로 수렴했다. 같은 절에서 한 응답이 서로 다른 시점의 필드를 섞는 것도
 * 관측됐다. 그래서 head가 움직였을 것으로 아는 시점에는 단발 snapshot을 믿지 않는다.
 *
 * 수렴하지 않아도 던지지 않는다. `converged: false` 관측을 그대로 돌려주고 그 사실을 어떻게 쓸지는
 * 호출자가 정한다. 기본 상한은 5회 × 2초다.
 */
export async function readHeadRefOid(
  runner: GhRunner,
  repo: RepositoryIdentity,
  number: number,
  options: HeadPollOptions = {},
): Promise<HeadObservation> {
  const expected = options.expectedHeadOid ?? null;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let headRefOid = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await ghJson<{ headRefOid?: unknown }>(runner, [
      'pr', 'view', String(number),
      '--repo', repo.nameWithOwner,
      '--json', 'headRefOid',
    ]);
    headRefOid = str(raw.headRefOid);
    if (expected === null || headRefOid === expected) {
      return { headRefOid, attempts: attempt, converged: true };
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return { headRefOid, attempts: maxAttempts, converged: false };
}
