import type { DigestStatus, PrAxes, PrTerminal } from './types.js';

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
 * 않는다. 지금 `CheckFact`에는 check run id도 completed 시각도 없고, rollup 조인은 C2-2다.
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
 * **`draft`와 `checks`는 headline에 접지 않는다.** 두 축은 `ProjectedPr`에 그대로 남고 카드가
 * 따로 표시한다. draft를 headline으로 만들면 draft PR의 review 결과가 사라지고, checks를
 * headline으로 만들면 required/optional 판정을 하게 되는데 그것은 C2-2다.
 *
 * 다음은 파생하지 않는다.
 *
 * - `CI 통과`·`병합 준비 완료`: base branch의 effective required rule과 head rollup을 조인해야
 *   나온다(OD-032). 그 조인은 C2-2이고 `mergePolicy` 축은 아직 `unobserved`다.
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
