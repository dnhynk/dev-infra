import type { RepositoryIdentity } from '../identity/repository.js';
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
};

/** base branch의 effective required rule. 판정하지 않고 사실만 담는다. */
export type BranchRequiredRules = {
  readonly branch: string;
  /** 두 API의 합집합. context 사전순이며 중복은 하나로 합쳐진다. */
  readonly contexts: readonly RequiredCheckRule[];
  readonly branchProtection: RuleSourceStatus;
  readonly repositoryRuleset: RuleSourceStatus;
};

type SourceResult = {
  readonly status: RuleSourceStatus;
  readonly contexts: readonly string[];
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 404/403은 사실이고 오류가 아니다. 나머지 실패는 삼키지 않는다. */
async function readSource(
  runner: GhRunner,
  args: readonly string[],
  parse: (raw: unknown) => readonly string[],
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
 * `strict`(up-to-date)는 C2 범위 밖이므로 읽지 않는다(OD-032).
 */
function parseBranchProtection(raw: unknown): readonly string[] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const checks = o['checks'];
  if (Array.isArray(checks)) {
    return checks.map((c) => str((c as Record<string, unknown>)['context'])).filter((c) => c !== '');
  }
  const contexts = o['contexts'];
  return Array.isArray(contexts) ? contexts.map(str).filter((c) => c !== '') : [];
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
function parseRepositoryRules(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const rule of raw) {
    const r = (rule ?? {}) as Record<string, unknown>;
    if (r['type'] !== 'required_status_checks') continue;
    const params = (r['parameters'] ?? {}) as Record<string, unknown>;
    const required = params['required_status_checks'];
    if (!Array.isArray(required)) continue;
    for (const c of required) {
      const context = str((c as Record<string, unknown>)['context']);
      if (context !== '') out.push(context);
    }
  }
  return out;
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
  const rules = await readSource(
    runner,
    ['api', `repos/${repo.nameWithOwner}/rules/branches/${branch}`],
    parseRepositoryRules,
  );

  const merged = new Map<string, RequiredCheckSource[]>();
  const add = (context: string, source: RequiredCheckSource): void => {
    const existing = merged.get(context);
    if (existing === undefined) merged.set(context, [source]);
    else if (!existing.includes(source)) existing.push(source);
  };
  for (const c of protection.contexts) add(c, 'branchProtection');
  for (const c of rules.contexts) add(c, 'repositoryRuleset');

  return {
    branch,
    contexts: [...merged.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([context, sources]) => ({ context, sources })),
    branchProtection: protection.status,
    repositoryRuleset: rules.status,
  };
}
