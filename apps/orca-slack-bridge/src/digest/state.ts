import type { BranchRequiredRules } from '../github/branch-rules.js';
import type { RequiredCheckFact, RequiredCheckState } from '../github/required-checks.js';
import type { DigestStatus, MergePolicy, PrAxes, PrTerminal } from './types.js';

/**
 * C2 PR 상태 모델.
 *
 * 상태를 하나의 enum으로 접지 않는다. terminal `open | closed | merged` 하나와 직교 축
 * `draft`·`review`·`checks`·`mergePolicy`를 함께 보존하고, 카드에 쓸 headline만 그 축들에서
 * 파생한다(OD-030). 축을 접으면 전이가 사라진다. 실측에서 draft와 reviewDecision은 `state`가
 * `OPEN`인 채로 동시에 존재했고, `mergeable=MERGEABLE`인 PR도 draft·review·required check
 * 때문에 `mergeStateStatus=BLOCKED`였다(evidence/t1-github-lifecycle.md §OD-030).
 *
 * 이 모듈은 순수하다. GitHub·Orca·Slack·durable store를 읽지 않는다.
 *
 * **terminal만 dominance로 합친다.** review와 check는 `headSha`가 scope이고, 같은 head 안에서는
 * 각 resource의 자기 timestamp와 자기 id로 reconcile한다(OD-044). reviewer_result에 대한 그
 * 규칙은 `digest/project.ts`의 `pickReviewerResult`에 있다. check는 아직 여기서 reconcile하지
 * 않는다. 지금 한 관측 안의 rollup row만 보고, 이전 관측과 합치는 규칙은 C2-3이다.
 *
 * **`reconcileTerminal`은 이번 변경에 프로덕션 호출자가 없다.** 이전 관측을 들고 있는 쪽이
 * 호출자이고 그것은 C2-3(전이 판정)이다. C2-3이 durable store에서 이전 terminal을 읽어
 * 넘긴다. C2-1은 저장을 만들지 않는다. schema v3 승격은 C2-5가 가져갔고, 두 Task가 같은
 * 버전 번호를 다루면 새 파일용 DDL과 기존 파일용 MIGRATIONS가 갈라진다.
 */

/**
 * 한 관측의 terminal을 정한다.
 *
 * `mergedAt != null`이 `merged` latch다(OD-030). latch가 `state` 문자열을 이긴다. 한 API
 * 응답이 서로 다른 계산 시점의 필드를 섞는 것을 실측했기 때문이다. push 직후 PATCH 응답은
 * `updated_at`이 새 시각인데 head는 이전 SHA였고, 바로 뒤 GraphQL은 같은 `updatedAt`에서 새
 * SHA를 줬다(§OD-044). 그래서 `mergedAt`이 있으면 `state`를 보지 않는다.
 *
 * latch가 없을 때만 `state`를 옮긴다. 모르는 값을 `open`으로 떨어뜨리지 않는다. GitHub 계약이
 * 바뀐 것이므로 드러낸다.
 *
 * `state=MERGED`인데 `mergedAt`이 없는 조합은 관측된 적이 없다. 그래도 `merged`로 옮긴다.
 * 이 조합을 `closed`나 예외로 처리하면 merged를 내리는 것이고 OD-044가 금지한다.
 */
export function deriveTerminal(state: string, mergedAt: string | null): PrTerminal {
  if (mergedAt !== null) return 'merged';
  switch (state.toUpperCase()) {
    case 'OPEN':
      return 'open';
    case 'CLOSED':
      return 'closed';
    case 'MERGED':
      return 'merged';
    default:
      throw new TypeError(`알 수 없는 PR state다: ${state}`);
  }
}

/**
 * terminal dominance rule. 이전 terminal과 새 관측을 합친다.
 *
 * **timestamp를 비교하지 않는다.** OD-044가 전역 last-write-wins를 기각했다. 근거는 실측이다.
 * 같은 PR `updated_at`에서 서로 다른 head가 관측됐고, `mergeable`이 `null→true`로 바뀌거나
 * check run이 in-progress→completed로 바뀌어도 PR `updated_at`은 그대로였다. PR `updated_at`은
 * PR resource의 change marker일 뿐 review/check/mergeability 전체의 version이 아니다.
 *
 * 규칙은 하나다. **`merged`는 내려가지 않는다.** merge는 GitHub에서 되돌릴 수 없는 사실이므로
 * 오래된 snapshot의 `open`·`closed`가 그것을 덮으면 카드가 거짓을 말한다.
 *
 * `merged`가 아닌 이전 terminal은 새 관측이 그대로 대체한다. 전체 상태를 하나의 선형 rank로
 * 두어 `closed > open`으로 만드는 선택지는 reopen을 막으므로 OD-044가 기각했다. 그래서
 * `closed → open`이 지나간다.
 *
 * `previous`가 null이면 이전 관측이 없다는 뜻이고 새 관측이 그대로 결과다.
 */
export function reconcileTerminal(previous: PrTerminal | null, observed: PrTerminal): PrTerminal {
  if (previous === 'merged') return 'merged';
  return observed;
}

/**
 * 축에서 카드 headline을 파생한다.
 *
 * terminal이 먼저다. `merged`와 `closed`는 review 축을 덮는다. 병합됐거나 닫힌 PR의 headline을
 * `리뷰 통과`로 두면 카드가 지나간 상태를 현재로 표시한다.
 *
 * **`draft`·`checks`·`mergePolicy`는 headline에 접지 않는다.** 세 축은 `ProjectedPr`에 그대로
 * 남고 카드가 따로 표시한다. draft를 headline으로 만들면 draft PR의 review 결과가 사라지고,
 * `checks` 축은 optional을 섞고 있어 그대로는 merge 판정 근거가 아니다(OD-032).
 *
 * 다음은 파생하지 않는다.
 *
 * - `CI 통과`·`병합 준비 완료`: **의미는 카드에 나오지만 headline은 아니다.** 두 의미는
 *   `mergePolicy` 축이 내고(`deriveMergePolicy`) 카드의 CI 절이 표시한다(`digest/render.ts`).
 *   headline으로 올리지 않는 이유는 headline이 PR 전체에 대해 카드가 내놓는 한 줄이기 때문이다.
 *   거기에 `병합 준비 완료`를 두면 review 축을 덮어 `리뷰에서 수정 요청`인 PR의 headline이
 *   `병합 준비 완료`가 되고, OD-032가 판정하지 않기로 한 required reviews까지 충족했다는 읽기를
 *   준다. 두 축을 하나로 접는 것은 OD-030이 기각했다. 축 줄은 자기 범위를 문장에 달고 있어
 *   같은 오독을 만들지 않는다.
 * - `수정 후 재검토 중`: `docs/contracts/observation-and-correlation.md` §6이 이 의미의 source
 *   fact를 "changes requested 이후 새 head + 재검토 상태"로 적었다. 앞의 둘은 있지만
 *   (`review.verdict`, `ReviewerResult.headMatch`) **`재검토 상태`가 없다.** 살아 있는 review
 *   Dispatch를 관측해야 나오는 사실이고 C2-1도 C2-2도 수집하지 않는다. 없는 사실로 의미를
 *   만들면 그것이 추측이다.
 * - reviewer가 본 commit과 현재 head가 다르다는 사실: verdict는 그대로 보고하고 그 사실은
 *   `ReviewerResult.headMatch`가 싣는다. 둘을 결합해 approval이 아직 유효한지 판정하는 것은
 *   OD-031이 기각했다.
 * - `worker_done` 유무와 risk: 각각 다른 축의 사실이고 카드가 따로 표시한다.
 */
export function deriveDigestStatus(axes: PrAxes): DigestStatus {
  if (axes.terminal === 'merged') return 'merged';
  if (axes.terminal === 'closed') return 'closed';
  if (axes.review === null) return 'awaiting_review';
  return axes.review.verdict === 'request_changes' ? 'changes_requested' : 'review_approved';
}

/**
 * required context 상태의 심각도. 축 하나로 접을 때 가장 무거운 것을 남긴다.
 *
 * 순서의 근거는 각 값이 gate에 대해 하는 **주장의 세기**다.
 *
 * - `failing`·`missing`은 gate가 지금 막는다는 확정 주장이다. 실측에서 미보고 required가 있는
 *   merge는 `405 ... is expected`로 거절됐다(OD-032). 둘 중 `failing`이 위인 이유는 두 값 다
 *   확정 차단이지만 보고된 실패가 더 행동 가능한 사실이기 때문이다.
 * - `indeterminate`는 확정 주장이 아니다. 보고 주체를 관측할 수 없어 충족도 불충족도 단정할 수
 *   없는 상태이므로(`github/required-checks.ts`) `missing`보다 약하다. 그러나 `pending`보다
 *   위다. `pending`은 기다리면 풀리지만 `indeterminate`는 같은 데이터로는 영원히 풀리지 않고,
 *   `pending`으로 표시하면 "기다리면 된다"는 거짓 설명을 준다.
 * - `passing`이 가장 아래다. 하나라도 다른 값이면 축은 그 값이다.
 *
 * `indeterminate`를 `passing` 쪽으로도 `missing` 쪽으로도 접지 않는다. 접으면 한쪽은 실측된
 * false positive(PAT가 만든 동명 status, merge 405)를 통과로, 다른 쪽은 Expected-App의 정상
 * 보고를 미보고로 그린다.
 */
const REQUIRED_STATE_RANK: Readonly<Record<RequiredCheckState, number>> = {
  failing: 5,
  missing: 4,
  indeterminate: 3,
  pending: 2,
  passing: 1,
};

/**
 * required check 사실을 `mergePolicy` 축 하나로 접는다.
 *
 * 입력은 base branch의 effective required rule과 그것을 current head rollup과 조인한 결과다.
 * 조회도 조인도 여기서 하지 않는다 — `github/branch-rules.ts`와 `github/required-checks.ts`가
 * 이미 사실로 만들어 `PullRequestFacts`에 싣는다. 이 함수는 그 사실을 접기만 한다.
 *
 * **optional check를 보지 않는다.** 입력이 `requiredChecks`뿐이고 `checks` 축 전체가 아니다.
 * optional failure가 남아도 실제 merge는 200이었다(OD-032, T1 독립 재현).
 *
 * 접는 순서:
 *
 * 1. rule을 읽지 못했으면(`forbidden`) `rules_unreadable`이다. 나머지 값은 전부 "required rule
 *    전체"에 대한 주장인데 그 집합을 모르는 상태다. `passing`과 `no_required_rules`는 그대로
 *    거짓이 되고, `failing`은 참이지만 그 하나만 고치면 축이 열린다는 거짓 결론을 부른다.
 *    관측된 row 자체는 카드의 CI 절이 그대로 나열하므로 이 선택으로 카드에서 사라지는 사실은
 *    없다. `absent`(404)는 여기 오지 않는다 — GitHub이 미보호와 권한 부족에 같은 코드를 주어
 *    구분할 사실이 없고, `branch-rules.ts`가 이미 구분하지 않기로 했다. 없는 구분을 축에서
 *    지어내지 않는다.
 * 2. required rule이 하나도 없으면 `no_required_rules`다. degraded가 아니라 정상이고 check 축이
 *    merge를 막지 않는다. `passing`과 합치지 않는다 — required가 0개인 것과 required가 전부
 *    통과한 것은 다른 사실이고, 앞쪽을 `CI 통과`로 그리면 아무것도 돌지 않은 PR을 통과로 그린다.
 * 3. 그 밖에는 context별 상태 중 가장 무거운 것이다(`REQUIRED_STATE_RANK`).
 *
 * `requiredChecks`는 `rules.contexts`를 조인한 결과여야 한다(`joinRequiredChecks`). 두 인자를
 * 함께 받는 이유는 조인 결과에 남지 않는 사실 — 두 정책 API의 조회 성공 여부 — 이 필요해서다.
 *
 * **이 축은 required check 축 하나이고 merge 가능 여부의 최종 답이 아니다.** merge queue·
 * required reviews·up-to-date(strict)·conversation resolution은 C2 범위 밖이다(OD-032).
 */
export function deriveMergePolicy(
  rules: BranchRequiredRules,
  requiredChecks: readonly RequiredCheckFact[],
): MergePolicy {
  if (rules.branchProtection === 'forbidden' || rules.repositoryRuleset === 'forbidden') {
    return 'rules_unreadable';
  }
  if (requiredChecks.length === 0) return 'no_required_rules';
  let worst: RequiredCheckState = 'passing';
  for (const c of requiredChecks) {
    if (REQUIRED_STATE_RANK[c.state] > REQUIRED_STATE_RANK[worst]) worst = c.state;
  }
  return worst;
}
