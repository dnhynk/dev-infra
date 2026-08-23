import type { BranchRequiredRules, RequiredCheckSource } from './branch-rules.js';
import type { CheckFact } from './rollup.js';

/**
 * required context 하나의 현재 상태.
 *
 * `missing`은 required로 지정됐지만 현재 head rollup에 row가 아예 없는 상태다.
 * T1 §OD-032 실측에서 미보고 required context는 rollup에도 `gh pr checks --required`에도
 * 나타나지 않았고, 그 상태의 merge는 `405 Required status check "never-starts" is expected`로
 * 거절됐다. 그래서 rollup만 보면 미보고 required를 통과로 오판한다(OD-032).
 */
export type RequiredCheckState = 'missing' | 'pending' | 'failing' | 'passing';

export type RequiredCheckFact = {
  readonly context: string;
  readonly sources: readonly RequiredCheckSource[];
  /** 이 rule이 요구하는 GitHub App의 database id. null이면 어느 app이 보고해도 충족한다. */
  readonly appId: number | null;
  readonly state: RequiredCheckState;
  /** 이 상태를 만든 rollup row. `missing`이면 null이다. */
  readonly observed: CheckFact | null;
  /**
   * 이름은 같지만 app 바인딩이 달라 이 rule을 충족하지 못한 row.
   *
   * 바인딩 없는 rule에서는 항상 비어 있다. 비어 있지 않은 `missing`은 "아무도 보고하지 않았다"가
   * 아니라 "기대한 app이 보고하지 않았다"라는 뜻이며, 그 구분을 잃으면 판정 근거를 볼 수 없다.
   */
  readonly unmatchedByApp: readonly CheckFact[];
};

/**
 * protected branch에서 required check를 통과로 취급하는 결론.
 *
 * GitHub 문서: required check는 `successful`, `skipped`, `neutral`이면 통과다.
 */
const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

/** commit status state. `EXPECTED`는 아직 보고되지 않은 대기 상태다. */
const PENDING_STATES = new Set(['PENDING', 'EXPECTED']);
const FAILING_STATES = new Set(['FAILURE', 'ERROR']);

/** failing > pending > passing. 같은 context에 row가 여러 개면 가장 무거운 것을 남긴다. */
const SEVERITY: Record<Exclude<RequiredCheckState, 'missing'>, number> = {
  failing: 3,
  pending: 2,
  passing: 1,
};

/**
 * rollup row 하나를 required 관점 상태로 바꾼다.
 *
 * 통과는 GitHub이 통과로 문서화한 결론에만 준다. 완료된 check run의 결론이 그 목록에 없으면
 * GitHub이 merge를 막으므로 `failing`이다. 아직 결론이 없거나 모르는 commit status state는
 * 통과도 실패도 확정할 수 없으므로 `pending`이다. 확정할 수 없는 것을 통과로 올리지 않는다.
 */
export function checkState(check: CheckFact): Exclude<RequiredCheckState, 'missing'> {
  if (check.kind === 'statusContext') {
    const state = (check.state ?? '').toUpperCase();
    if (state === 'SUCCESS') return 'passing';
    if (FAILING_STATES.has(state)) return 'failing';
    if (PENDING_STATES.has(state)) return 'pending';
    return 'pending';
  }
  const status = check.status.toUpperCase();
  // CheckStatusState: REQUESTED, QUEUED, IN_PROGRESS, COMPLETED, WAITING, PENDING.
  if (status !== 'COMPLETED') return 'pending';
  const conclusion = (check.conclusion ?? '').toUpperCase();
  if (conclusion === '') return 'pending';
  return PASSING_CONCLUSIONS.has(conclusion) ? 'passing' : 'failing';
}

/**
 * base branch의 effective required rule과 현재 head rollup을 조인한다.
 *
 * rollup 단독이나 `gh pr checks --required` 단독으로 판정하지 않는다. 둘 다 미보고 required를
 * 빠뜨린다는 것이 T1 §OD-032의 관측이다(OD-032).
 *
 * 이름이 같아도 rule이 app에 바인딩돼 있으면 그 app이 보고한 row만 충족시킨다(OD-032 추가 관측).
 *
 * merge-ready 여부는 여기서 정하지 않는다. 이 함수는 context별 사실만 만든다.
 */
export function joinRequiredChecks(
  rules: BranchRequiredRules,
  checks: readonly CheckFact[],
): readonly RequiredCheckFact[] {
  const byName = new Map<string, CheckFact[]>();
  for (const c of checks) {
    const rows = byName.get(c.name);
    if (rows === undefined) byName.set(c.name, [c]);
    else rows.push(c);
  }

  return rules.contexts.map(({ context, sources, appId }): RequiredCheckFact => {
    const rows = byName.get(context) ?? [];
    // app-bound rule은 그 app이 보고한 row만 충족시킨다. 실측(2026-08-23): 같은 이름의 PAT
    // commit status가 success여도 merge는 `was not set by the expected GitHub app`으로 405였다.
    const matched = appId === null ? rows : rows.filter((r) => r.appId === appId);
    const unmatchedByApp = appId === null ? [] : rows.filter((r) => r.appId !== appId);

    let worst: { state: Exclude<RequiredCheckState, 'missing'>; row: CheckFact } | null = null;
    for (const row of matched) {
      const state = checkState(row);
      if (worst === null || SEVERITY[state] > SEVERITY[worst.state]) worst = { state, row };
    }
    return worst === null
      ? { context, sources, appId, state: 'missing', observed: null, unmatchedByApp }
      : { context, sources, appId, state: worst.state, observed: worst.row, unmatchedByApp };
  });
}
