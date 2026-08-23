import type { PullRequestKey, TaskKey } from '../identity/keys.js';
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
 * correlated로 판정됐고 Task까지 확정된 correlation.
 *
 * C1은 uncorrelated PR에 카드를 만들지 않으므로 타입 수준에서 그 불변식을 고정한다.
 * `uncorrelated`·`conflict`를 들고 여기까지 오면 컴파일이 막는다.
 *
 * `task`를 non-null로 좁힌다. `resolveCorrelation`은 `orca-run`만 있고 `orca-task`가 없는
 * PR body도 `correlated` + `task: null`로 보고한다. 그런 PR은 `worker_done`도 Task 목적도
 * 찾을 수 없어 카드 입력을 구성할 수 없다. 좁히는 지점은 projection이며
 * `correlate/resolve.ts`의 출력은 바꾸지 않는다. 그 출력은 S0에서 검증된 계약이고, OD-077이
 * 별도 `run_correlated` kind를 Run-level 제품 의미가 필요해질 때까지 미뤘다.
 *
 * 좁히기에서 탈락한 PR은 버리지 않는다. `PrProjection`의 `skipped`가 이유와 함께 남기며,
 * 그 이유는 정상 출력이 아니라 degraded 입력이다(`PrSkipReason`).
 *
 * 좁히는 방법: `c.task !== null` 검사만으로는 `c` 자체가 좁혀지지 않는다. TypeScript는
 * 속성 참조만 좁히고 객체 타입은 그대로 둔다. 타입 술어를 쓴다.
 *
 * ```ts
 * function isCorrelatedOrigin(c: Correlation): c is CorrelatedOrigin {
 *   return c.kind === 'correlated' && c.task !== null;
 * }
 * ```
 */
export type CorrelatedOrigin = Extract<Correlation, { readonly kind: 'correlated' }> & {
  readonly task: TaskKey;
};

/**
 * GitHub이 보고한 PR 상태.
 *
 * `gh pr list --json state`의 `OPEN`/`CLOSED`/`MERGED`를 소문자로 옮긴 값이다. 다른 값이
 * 오면 조용히 `open`으로 떨어뜨리지 않는다. GitHub 계약이 바뀐 것이므로 드러내야 한다.
 */
export type PrState = 'open' | 'closed' | 'merged';

/**
 * reviewer가 본 commit과 현재 head의 관계.
 *
 * **사실 진술이지 유효성 판정이 아니다.** 이 값으로 "이전 approval이 아직 유효한가"를
 * 판정하지 않는다. 그 판정은 OD-031이고 C2다. C1 카드는 두 값이 다르다는 관찰 사실만
 * 표시한다.
 */
export type ReviewedHeadMatch =
  /** `reviewedHeadSha`가 `ProjectedPr.headSha`와 같다. */
  | 'same'
  /** 두 값이 다르다. reviewer가 본 뒤 head가 움직였다는 사실만 뜻한다. */
  | 'different'
  /** `reviewedHeadSha`가 없어 대조하지 못했다. 같다는 뜻도 다르다는 뜻도 아니다. */
  | 'unknown';

/**
 * Orca reviewer task의 result에서 읽은 사실과, 그것을 현재 head와 대조한 결과.
 *
 * review verdict의 durable source는 Orca다(DL-016). GitHub review 본문은 신뢰 경계상
 * untrusted content이므로 상태 source로 쓰지 않는다.
 */
export type ReviewerResult = {
  /** `request_changes`여도 review task 자체는 completed다. 두 값 외에는 없다. */
  readonly verdict: 'approve' | 'request_changes';
  /** reviewer가 본 commit. 현재 head와의 관계는 `headMatch`가 사실로 싣는다. */
  readonly reviewedHeadSha: string | null;
  /**
   * `reviewedHeadSha`를 `ProjectedPr.headSha`와 대조한 결과. projection이 계산한다.
   *
   * 이 필드가 타입에 있으므로 renderer는 "reviewer가 다른 commit을 봤다"는 사실을 보지
   * 못한 채 verdict만 그릴 수 없다. 두 값을 결합해 approval 유효성을 판정하는 것은
   * OD-031이며 C1이 하지 않는다.
   */
  readonly headMatch: ReviewedHeadMatch;
  /** severity 내림차순 상한 10건(OD-033). 카드가 findings를 전부 나열하지 않는다. */
  readonly findings: readonly FindingFacts[];
  /**
   * 상한 적용 전 전체 개수. 잘렸다는 사실을 카드가 숨기지 않게 한다(UX §6).
   *
   * 파생 경로: Orca task result의 `findings` 배열 길이다. reviewer는 상한 없이 전부
   * 기록하고(OD-073에 상한이 없다), 상한 10은 Bridge가 카드와 프롬프트를 만들 때만
   * 적용한다(`summarize/contract.ts`의 `CAPS.findings`). 그래서 읽은 배열의 길이가
   * 상한 적용 전 전체 수다.
   */
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
 * - reviewer가 본 commit이 현재 head와 다르다는 사실: verdict는 그대로 보고하고 그 사실은
 *   `ReviewerResult.headMatch`가 싣는다. 둘을 결합해 approval이 아직 유효한지 판정하는 것은
 *   OD-031이며 C2다.
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
 * 관측이 잘린 지점. 원인별로 따로 싣는다.
 *
 * 카드는 부분만 보고 말한 경우 그 사실을 숨기지 않는다(UX §6). 두 절단은 원인도 의미도
 * 다르므로 하나의 boolean으로 합치지 않는다.
 *
 * **이 사실을 `SummaryResult`에서 읽지 않는다.** 이유가 둘이다.
 *
 * - `SummaryResult`의 `truncated`는 `ok` 변형에만 있다. 요약이 실패하면 축소 카드를
 *   그려야 하는데 바로 그때 값이 없다.
 * - `SummaryFacts.truncated`는 단일 boolean이고 프롬프트 문구가 "PR 본문이 상한 때문에
 *   잘렸다"로 본문 전용이다(`summarize/contract.ts`). 파일 목록 절단을 그 플래그로 켜면
 *   모델에게 거짓 설명을 주게 된다.
 *
 * 그래서 절단은 관측 사실로서 `ProjectedPr`이 싣고, renderer는 요약 성공·실패 어느 쪽에서도
 * 여기서 읽는다.
 *
 * summarizer 쪽을 고치려 하지 마라. `CAPS.changedPaths`가 프롬프트용 목록을 이미 40개로
 * 자르므로 summarizer는 애초에 전체 목록을 보지 않는 설계다. 절단을 알아야 하는 것은
 * summarizer가 아니라 카드다. 게다가 `SummaryFacts`를 바꾸면 `factsFingerprint`가 바뀌어
 * OD-035의 캐시 계약이 흔들리고, OD-034는 실제 API 호출로 검증된 계약이다.
 */
export type ObservationTruncation = {
  /**
   * PR 본문이 summarizer 입력 상한(`CAPS.prBody`)에서 잘렸다.
   *
   * 카드 본문에는 영향이 없고, 요약이 본문 전체를 보지 못했다는 뜻이다.
   * `SummaryFacts.truncated`와 같은 조건에서 켜진다. 두 값을 다르게 계산하지 않는다.
   * 여기에도 두는 이유는 요약이 실패하면 `SummaryResult`에서 그 사실이 사라지기 때문이다.
   */
  readonly prBody: boolean;
  /**
   * 변경 파일 목록이 잘렸다.
   *
   * `PullRequestFacts.changedFilesTotal > changedPaths.length`에서 파생한다. 관측된 원인은
   * `gh pr list --json files`의 100건 상한이다(실측: `nodejs/node` PR #65461이
   * `changedFiles` 1971에 `files` 100). Bridge는 읽을 때 목록을 자르지 않으므로 길이가
   * 전체보다 짧다는 것은 조회 쪽에서 잘렸다는 뜻이다.
   *
   * 몇 개가 잘렸는지는 싣지 않는다. C1 카드는 "일부만 관측했다"는 사실만 표시한다.
   */
  readonly changedFiles: boolean;
};

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
  /**
   * 현재 head commit sha. `PullRequestFacts.headRefOid`에서 온다.
   *
   * 관찰한 check 결론과 reviewer_result가 어느 commit의 사실인지 고정한다.
   */
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
  /** 관측이 잘린 지점. 카드가 부분 관측을 숨기지 않게 한다. */
  readonly truncation: ObservationTruncation;
};

/**
 * projection이 카드를 만들지 않은 이유.
 *
 * 카드가 없다는 것도 관찰 결과다. 조용히 버리지 않고 이유를 남긴다(UX §6).
 */
export type PrSkipReason =
  /** correlation이 `uncorrelated`다. 실패가 아니라 정상 출력이다(OD-022). */
  | 'uncorrelated'
  /** correlation이 `conflict`다. 모순을 자동으로 한쪽으로 덮지 않는다(OD-022). */
  | 'conflict'
  /**
   * `orca-run`은 있고 필수 `orca-task`가 없다. **invalid/degraded input이다**(OD-077).
   *
   * 위 둘과 성격이 다르므로 이름이 그것을 말한다. `uncorrelated`는 metadata가 없거나 Run을
   * 확정할 수 없는 정상 출력이지만, 이쪽은 OD-021이 `orca-task`를 필수로 정한 뒤의 계약 위반
   * 입력이다. 원인은 누락이나 수동 편집 같은 partial input이다.
   *
   * Task를 찾을 수 없으므로 Task 목적도 `worker_done`도 붙일 수 없고 카드 입력이 서지 않는다.
   * `CorrelatedOrigin`이 컴파일로 막는 경우가 런타임에서 여기로 온다.
   *
   * **branch 이름·PR 제목·author로 Task를 보완하지 않는다.** no-guessing 계약에 반하며
   * OD-077이 그 대안을 기각했다. 별도 `run_correlated` kind도 만들지 않는다.
   */
  | 'run_only_degraded';

/**
 * PR 하나에 대한 projection 결과.
 *
 * 합타입으로 두어 "카드를 만들지 않았다"를 반환값에서 빠뜨릴 수 없게 한다. 호출자는
 * `skipped`를 받으면 이유를 사람이 보는 출력에 남긴다.
 */
export type PrProjection =
  | { readonly kind: 'card'; readonly pr: ProjectedPr }
  | {
      readonly kind: 'skipped';
      readonly key: PullRequestKey;
      readonly reason: PrSkipReason;
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
 *
 * 절단 사실도 `summary`에서 읽지 않는다. `pr.truncation`이 유일한 source다. 이유는
 * `ObservationTruncation`에 적었다.
 */
export type RenderInput = {
  readonly pr: ProjectedPr;
  readonly summary: SummaryResult;
};
