import type { RepositoryIdentity } from '../identity/repository.js';
import { BACKGROUND_GITHUB_MAX_PAGES } from './background.js';
import { ghJson, httpStatusOf, type GhRunner } from './runner.js';

/**
 * required context를 어느 정책 API에서 읽었는지.
 *
 * 두 API는 서로를 포함하지 않는다. 실측(2026-08-23,
 * `dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b`)에서 classic protection에만 있는 context는
 * `rules/branches/main` 응답에 나타나지 않았다. 그래서 합집합을 따로 만든다(OD-032).
 */
export type RequiredCheckSource = 'branchProtection' | 'repositoryRuleset';

/** 한쪽 정책 API의 조회 결과. 미설정과 못 읽음을 구분한다. */
export type RuleSourceStatus =
  /** 200. 아래 context가 이 API가 준 전부다. */
  | 'present'
  /**
   * 404. 이 branch에 그 정책이 없다는 뜻과 조회자가 그 정책을 볼 권한이 없다는 뜻을 GitHub이
   * 같은 코드로 준다. 실측: 소유 repository는 `Branch not protected`,
   * `cli/cli`는 `Not Found`로 둘 다 404였다. 구분할 수 있는 사실이 없으므로 구분하지 않는다.
   */
  | 'absent'
  /** 403. 권한 벽이 명시적으로 확인된 경우다. */
  | 'forbidden';

export type RequiredCheckRule = {
  readonly context: string;
  /** 이 context를 준 API. 두 곳 모두면 둘 다 들어간다. */
  readonly sources: readonly RequiredCheckSource[];
  /**
   * 이 rule을 충족시킬 수 있는 GitHub App의 database id. null이면 어느 app이 보고해도 충족한다.
   *
   * classic protection은 `checks[].app_id`, ruleset은 `required_status_checks[].integration_id`로
   * 같은 값을 준다. 실측(2026-08-23, `dnhynk/THROWAWAY-orca-c2-appbind-c6ddffc0`): app_id 15368로
   * 바인딩된 required context에 같은 이름의 PAT commit status를 success로 올려도 merge는
   * `405 Required status check "classic-appbound" was not set by the expected GitHub app.`였고,
   * 같은 status 그대로 바인딩만 지우자 merge가 `200`이었다. 이름만으로 조인하면 이 둘을 구분하지 못한다.
   */
  readonly appId: number | null;
};

/** base branch의 effective required rule. 판정하지 않고 사실만 담는다. */
export type BranchRequiredRules = {
  readonly branch: string;
  /**
   * 두 API의 합집합. context 사전순이고 같은 context 안에서는 appId 순이다.
   * context와 app 바인딩이 모두 같은 rule만 하나로 합치고 출처를 둘 다 남긴다.
   */
  readonly contexts: readonly RequiredCheckRule[];
  readonly branchProtection: RuleSourceStatus;
  readonly repositoryRuleset: RuleSourceStatus;
};

/** 한 정책 API가 준 required context 하나. 조인 전이라 출처는 아직 붙지 않는다. */
type RuleContext = {
  readonly context: string;
  readonly appId: number | null;
};

type SourceResult = {
  readonly status: RuleSourceStatus;
  readonly contexts: readonly RuleContext[];
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * app 바인딩 값을 읽는다.
 *
 * [문서] classic protection의 `app_id`는 `-1`이 "어느 app이든"이다.
 * [관측] 2026-08-23 `-1`로 쓴 뒤 다시 읽으면 응답은 `null`이었다. read에서 `-1`을 본 적은 없지만
 * 보이면 문서 정의대로 바인딩 없음으로 읽는다.
 */
function appIdOf(v: unknown): number | null {
  return typeof v === 'number' && v !== -1 ? v : null;
}

/** 404/403은 사실이고 오류가 아니다. 나머지 실패는 삼키지 않는다. */
async function readSource(
  runner: GhRunner,
  args: readonly string[],
  parse: (raw: unknown) => readonly RuleContext[],
): Promise<SourceResult> {
  try {
    return { status: 'present', contexts: parse(await ghJson<unknown>(runner, args)) };
  } catch (e) {
    const status = httpStatusOf(e);
    if (status === 404) return { status: 'absent', contexts: [] };
    if (status === 403) return { status: 'forbidden', contexts: [] };
    throw e;
  }
}

/**
 * classic branch protection의 required context.
 *
 * `contexts`는 deprecated이고 `checks[].context`가 후속 필드다. 둘 다 오므로 `checks`를 먼저 쓴다.
 * deprecated `contexts`에는 app 바인딩이 없으므로 그 경로로 읽은 rule은 바인딩 없음이다.
 * `strict`(up-to-date)는 C2 범위 밖이므로 읽지 않는다(OD-032).
 *
 * 이 endpoint는 paginated가 아니다. 실측(2026-08-23): required context 3개인 branch에
 * `?per_page=1`을 붙여도 응답은 3개를 모두 담았고 `Link` header가 없었다.
 */
function parseBranchProtection(raw: unknown): readonly RuleContext[] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const checks = o['checks'];
  if (Array.isArray(checks)) {
    return checks
      .map((c) => {
        const r = (c ?? {}) as Record<string, unknown>;
        return { context: str(r['context']), appId: appIdOf(r['app_id']) };
      })
      .filter((c) => c.context !== '');
  }
  const contexts = o['contexts'];
  return Array.isArray(contexts)
    ? contexts.map((c) => ({ context: str(c), appId: null })).filter((c) => c.context !== '')
    : [];
}

/**
 * ruleset이 이 branch에 실제로 적용한 required context.
 *
 * `rulesets` 목록이 아니라 `rules/branches/{branch}`를 읽는다. 후자는 organization ruleset까지
 * 평가한 결과를 주고 조회자가 admin이 아니어도 읽힌다. 실측: `cli/cli` trunk에서 200으로
 * `copilot_code_review` rule을 반환했고 같은 시각 protection 조회는 404였다.
 *
 * 이 응답에는 `pull_request`(required reviews)나 `merge_queue` 같은 다른 rule type도 섞여 온다.
 * 그것들은 C2 판정 근거가 아니므로 읽지 않고 버린다(OD-032).
 */
function parseRepositoryRules(raw: unknown): readonly RuleContext[] {
  if (!Array.isArray(raw)) return [];
  const pages = raw.every((row) => Array.isArray(row)) ? raw as readonly unknown[][] : [raw];
  const out: RuleContext[] = [];
  for (const rule of pages.flat()) {
    const r = (rule ?? {}) as Record<string, unknown>;
    if (r['type'] !== 'required_status_checks') continue;
    const params = (r['parameters'] ?? {}) as Record<string, unknown>;
    const required = params['required_status_checks'];
    if (!Array.isArray(required)) continue;
    for (const c of required) {
      const rc = (c ?? {}) as Record<string, unknown>;
      const context = str(rc['context']);
      if (context !== '') out.push({ context, appId: appIdOf(rc['integration_id']) });
    }
  }
  return out;
}

/** Explicit page numbers make the 100-page bound effective before `gh` follows an unbounded Link chain. */
async function readRepositoryRules(
  runner: GhRunner,
  repo: RepositoryIdentity,
  branch: string,
): Promise<SourceResult> {
  const pages: unknown[][] = [];
  try {
    for (let page = 1; page <= BACKGROUND_GITHUB_MAX_PAGES; page += 1) {
      const raw = await ghJson<unknown>(runner, [
        'api',
        `repos/${repo.nameWithOwner}/rules/branches/${branch}?per_page=100&page=${page}`,
      ]);
      if (!Array.isArray(raw)) {
        throw new TypeError('repository rules page is not an array');
      }
      pages.push(raw);
      if (raw.length < 100) {
        return { status: 'present', contexts: parseRepositoryRules(pages) };
      }
    }
    throw new RangeError(
      `repository rules exceeded ${BACKGROUND_GITHUB_MAX_PAGES} pages`,
    );
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 404) return { status: 'absent', contexts: [] };
    if (status === 403) return { status: 'forbidden', contexts: [] };
    throw error;
  }
}

export async function fetchBranchRequiredRules(
  runner: GhRunner,
  repo: RepositoryIdentity,
  branch: string,
): Promise<BranchRequiredRules> {
  const protection = await readSource(
    runner,
    ['api', `repos/${repo.nameWithOwner}/branches/${branch}/protection/required_status_checks`],
    parseBranchProtection,
  );
  // `rules/branches/{branch}`는 paginated다. page를 명시해 101번째부터의 조용한 유실과
  // `--paginate`의 unbounded Link traversal을 둘 다 피한다.
  const rules = await readRepositoryRules(runner, repo, branch);

  // 같은 이름이라도 app 바인딩이 다르면 GitHub이 따로 강제하는 별개의 rule이다. 합치지 않는다.
  const merged = new Map<string, { rule: RuleContext; sources: RequiredCheckSource[] }>();
  const add = (rule: RuleContext, source: RequiredCheckSource): void => {
    const key = `${rule.appId ?? 'any'}:${rule.context}`;
    const existing = merged.get(key);
    if (existing === undefined) merged.set(key, { rule, sources: [source] });
    else if (!existing.sources.includes(source)) existing.sources.push(source);
  };
  for (const c of protection.contexts) add(c, 'branchProtection');
  for (const c of rules.contexts) add(c, 'repositoryRuleset');

  return {
    branch,
    contexts: [...merged.values()]
      .sort((a, b) =>
        a.rule.context < b.rule.context
          ? -1
          : a.rule.context > b.rule.context
            ? 1
            : (a.rule.appId ?? -1) - (b.rule.appId ?? -1),
      )
      .map(({ rule, sources }) => ({ context: rule.context, sources, appId: rule.appId })),
    branchProtection: protection.status,
    repositoryRuleset: rules.status,
  };
}
