import type { PullRequestKey } from '../identity/keys.js';
import type { RepositoryIdentity } from '../identity/repository.js';
import type { Correlation } from '../correlate/resolve.js';
import type { CheckFact } from '../github/pull-request.js';
import type { FindingFacts } from '../summarize/contract.js';
import type { SummaryResult } from '../summarize/index.js';

/**
 * PR digest 카드의 입력 계약.
 *
 * 관찰에서 카드까지의 경로는 두 갈래다.
 *
 * ```text
 * 관찰 사실 ─┬─→ SummaryFacts ─→ summarize() ─→ SummaryResult ─┐
 *            └─→ ProjectedPr ───────────────────────────────────┴─→ RenderInput ─→ Slack blocks
 * ```
 *
 * `ProjectedPr`은 **카드에 그릴 사실**만 담는다. summarizer에 보내는 입력(PR 본문, 변경 파일
 * 경로)은 담지 않는다. 두 집합이 같지 않고, LLM 전송 경계는 따로 정해져 있다(OD-036).
 *
 * C1 범위: 관찰 시점에 존재하는 사실을 그대로 표시한다. 상태 전이 정의, merge-ready 판정,
 * 새 commit 이후 approval 유효성, thread transition은 C2다.
 */

/**
 * correlated로 판정된 correlation.
 *
 * C1은 uncorrelated PR에 카드를 만들지 않으므로 타입 수준에서 그 불변식을 고정한다.
 * `uncorrelated`·`conflict`를 들고 여기까지 오면 컴파일이 막는다.
 */
export type CorrelatedOrigin = Extract<Correlation, { readonly kind: 'correlated' }>;

/**
 * GitHub이 보고한 PR 상태.
 *
 * `gh pr list --json state`의 `OPEN`/`CLOSED`/`MERGED`를 소문자로 옮긴 값이다. 다른 값이
 * 오면 조용히 `open`으로 떨어뜨리지 않는다. GitHub 계약이 바뀐 것이므로 드러내야 한다.
 */
export type PrState = 'open' | 'closed' | 'merged';

/**
 * Orca reviewer task의 result에서 읽은 사실.
 *
 * review verdict의 durable source는 Orca다(DL-016). GitHub review 본문은 신뢰 경계상
 * untrusted content이므로 상태 source로 쓰지 않는다.
 */
export type ReviewerResult = {
  /** `request_changes`여도 review task 자체는 completed다. 두 값 외에는 없다. */
  readonly verdict: 'approve' | 'request_changes';
  /** reviewer가 본 commit. 현재 head와 다른지의 판정(approval 유효성)은 C2다. */
  readonly reviewedHeadSha: string | null;
  /** severity 내림차순 상한 10건(OD-033). 카드가 findings를 전부 나열하지 않는다. */
  readonly findings: readonly FindingFacts[];
  /** 상한 적용 전 전체 개수. 잘렸다는 사실을 카드가 숨기지 않게 한다(UX §6). */
  readonly findingsTotal: number;
};

/**
 * `worker_done` 사실.
 *
 * 없으면 `ProjectedPr.workerReport`가 null이고, 카드는 "worker 보고 없음"을 표시한다(OD-070).
 * `worker-read` fallback은 쓰지 않는다(OD-025).
 */
export type WorkerReport = {
  /** Orca CLI가 두 값만 받는다(플랫폼 검증 §2.5). failed 보고를 성공처럼 그리지 않는다. */
  readonly outcome: 'succeeded' | 'failed';
  /** 3문장 계약 본문. summarizer 입력이자 요약 실패 시 카드의 사실 텍스트다. */
  readonly body: string;
};

/**
 * 카드가 표시하는 상태.
 *
 * **사실에서 결정적으로 파생 가능한 값만 넣는다.** 아래 순서로 처음 맞는 것을 고른다.
 *
 * 1. `state === 'merged'` → `merged`
 * 2. `state === 'closed'` → `closed`
 * 3. `review.verdict === 'request_changes'` → `changes_requested`
 * 4. `review.verdict === 'approve'` → `review_approved`
 * 5. 그 외 → `awaiting_review`
 *
 * 다음은 이 값에 넣지 않는다.
 *
 * - CI 결론: required/optional 구분과 merge-ready 판정이 아직 계약이 아니다(OD-032).
 *   카드는 `checks`를 check별 결론 그대로 표시한다.
 * - `worker_done` 유무: 리뷰와 다른 축의 사실이다. `workerReport`가 null인지로 표시한다(OD-070).
 * - draft 여부: `isDraft`로 따로 표시한다.
 * - risk: `SummaryResult.risk`가 싣는다(OD-037).
 * - `merge_ready`: review·CI·merge 조건의 결합 판정이므로 C2다.
 */
export type DigestStatus =
  /** GitHub merged 사실. */
  | 'merged'
  /** merge 없이 닫혔다. reopen과 close 전이 처리는 C2다. */
  | 'closed'
  /** reviewer verdict가 `request_changes`다. */
  | 'changes_requested'
  /** reviewer verdict가 `approve`다. 병합 준비 완료라는 주장이 아니다. */
  | 'review_approved'
  /** reviewer_result가 관찰되지 않았다. 리뷰가 진행 중이라는 주장이 아니다. */
  | 'awaiting_review';

/**
 * 카드 하나를 그리는 데 필요한 관찰 사실 전부.
 *
 * 여기 없는 값은 카드에 나타나지 않는다. 렌더러는 이 타입 밖에서 사실을 가져오지 않는다.
 */
export type ProjectedPr = {
  /** 카드와 durable store의 identity. 관측에서 결정적으로 파생된다. */
  readonly key: PullRequestKey;
  /** 카드 상단 identity. rename돼도 같은 repository로 남는다. */
  readonly repository: RepositoryIdentity;
  /** 설정에 있으면 `[Project] owner/repo #N`, 없으면 `owner/repo #N`으로 쓴다(OD-047). */
  readonly project: string | null;
  /** 이 카드가 어느 Orca Run/Task/Dispatch의 결과인지. */
  readonly correlation: CorrelatedOrigin;
  /** identity 표시와 PR 링크 문구에 쓴다. */
  readonly number: number;
  /** PR 원문 제목. summarizer가 실패하면 카드 제목의 fallback이다(OD-035). */
  readonly title: string;
  /** GitHub 원문 링크. C1 카드의 유일한 action이다. */
  readonly url: string;
  /** 현재 head commit sha. 관찰한 check 결론과 reviewer_result가 어느 commit의 사실인지 고정한다. */
  readonly headSha: string;
  readonly state: PrState;
  /** draft PR에 리뷰 결과가 없는 것은 정상이므로 카드가 그 이유를 표시할 수 있어야 한다. */
  readonly isDraft: boolean;
  /** 없으면 null. 없다는 사실 자체를 카드가 표시한다. */
  readonly review: ReviewerResult | null;
  /** head commit의 check 결론. 집계도 required 판정도 하지 않는다(OD-032). */
  readonly checks: readonly CheckFact[];
  /** 없으면 null(OD-070). */
  readonly workerReport: WorkerReport | null;
};

/**
 * 렌더러 입력.
 *
 * 사실(`pr`)과 의미 압축(`summary`)을 분리해 넘긴다. 요약이 실패해도 `pr`만으로 축소
 * 카드를 만들 수 있어야 하고, 요약이 성공해도 상태·링크·risk는 `pr`과 `summary.risk`에서
 * 오지 모델 출력에서 오지 않는다.
 *
 * `DigestStatus`는 여기 싣지 않는다. `pr`에서 결정적으로 파생되므로 두 곳에 두면
 * 서로 어긋날 수 있다.
 */
export type RenderInput = {
  readonly pr: ProjectedPr;
  readonly summary: SummaryResult;
};
