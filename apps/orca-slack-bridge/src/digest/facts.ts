import { stripCorrelationMetadata } from '../correlate/metadata.js';
import type { PullRequestFacts } from '../github/pull-request.js';
import type { CorrelationKeys } from '../project/config.js';
import { CAPS, type CheckFacts, type SummaryFacts } from '../summarize/contract.js';
import type { ProjectedPr } from './types.js';

/**
 * `ProjectedPr`에서 summarizer 입력을 조립한다.
 *
 * `ProjectedPr`은 카드에 그릴 사실만 담고 PR 본문과 변경 파일 경로는 담지 않으므로
 * (`digest/types.ts`) 관찰 원본 `PullRequestFacts`를 함께 받는다. 두 집합이 같지 않다.
 *
 * OD-036 경계: diff 본문, transcript, 토큰·설정 값은 넣지 않는다. 설정에서 오는 값 중
 * `CorrelationKeys`만 쓰는데, 그것도 본문에서 **지울 대상**을 찾는 데만 쓰고 결과에 싣지 않는다.
 */

/** correlation metadata를 지우고 상한을 적용한 PR 본문. */
export type PreparedBody = {
  readonly text: string;
  /** 상한 때문에 잘렸는지. `SummaryFacts.truncated`와 `ObservationTruncation.prBody`의 공통 source다. */
  readonly truncated: boolean;
};

/**
 * summarizer에 보낼 PR 본문을 만든다.
 *
 * 순서가 중요하다. metadata를 **먼저** 지우고 상한을 적용한다. 반대로 하면 사람이 읽는
 * 본문이 기계용 주석 길이만큼 밀려 잘린다.
 *
 * `ProjectedPr.truncation.prBody`도 이 함수의 `truncated`를 쓴다. `digest/types.ts`가
 * 두 값을 다르게 계산하지 말라고 못박았으므로 계산 지점을 하나로 둔다.
 */
export function prepareSummaryBody(body: string, keys: CorrelationKeys): PreparedBody {
  const stripped = stripCorrelationMetadata(body, keys);
  if (stripped.length <= CAPS.prBody) {
    return { text: stripped, truncated: false };
  }
  return { text: stripped.slice(0, CAPS.prBody), truncated: true };
}

/**
 * summarizer 입력을 만든다.
 *
 * `taskPurpose`는 호출자가 준다. Orca Task의 **제목**을 넣는다. `spec`은 넣지 않는다.
 * dispatch spec은 수천 자짜리 지시문이고 그 안에 설정 값과 결정 목록이 그대로 들어 있어
 * OD-036 경계를 넘는다.
 *
 * `changedPaths`는 자르지 않는다. 프롬프트용 상한(`CAPS.changedPaths`)은
 * `renderFactsPrompt`가 걸고, 목록 절단 사실은 `ProjectedPr.truncation.changedFiles`가
 * 따로 싣는다. 여기서 자르면 `factsFingerprint`가 바뀌어 OD-035의 캐시 계약이 흔들린다.
 */
export function buildSummaryFacts(
  pr: ProjectedPr,
  source: PullRequestFacts,
  taskPurpose: string | null,
  keys: CorrelationKeys,
): SummaryFacts {
  const body = prepareSummaryBody(source.body, keys);
  return {
    taskPurpose,
    workerDone: pr.workerReport === null ? null : pr.workerReport.body,
    prTitle: pr.title,
    prBody: body.text,
    changedPaths: source.changedPaths,
    review:
      pr.review === null
        ? null
        : { verdict: pr.review.verdict, findings: pr.review.findings },
    // status는 카드가 쓰는 축이라 여기서는 결론만 넘긴다. required 판정을 하지 않는다(OD-032).
    checks: pr.checks.map((c): CheckFacts => ({ name: c.name, conclusion: c.conclusion })),
    truncated: body.truncated,
  };
}
