/**
 * summarizer 계약.
 *
 * LLM은 **의미 압축만** 한다. 상태와 risk는 사실에서 결정적으로 파생하므로 출력 스키마에
 * 넣지 않는다. 링크·버튼·검증 주장도 스키마에 없다. 만들 수 없으면 잘못 주장할 수도 없다.
 */

/** summarizer에 보내는 사실. 여기 없는 것은 보내지 않는다(OD-036). */
export type SummaryFacts = {
  readonly taskPurpose: string | null;
  /** worker_done 본문. 3문장 계약. */
  readonly workerDone: string | null;
  readonly prTitle: string;
  /** correlation metadata 블록을 제거하고 상한을 적용한 본문. */
  readonly prBody: string;
  /** 변경 파일 경로. diff 본문은 보내지 않는다. */
  readonly changedPaths: readonly string[];
  readonly review: ReviewFacts | null;
  readonly checks: readonly CheckFacts[];
  /** 상한 때문에 입력이 잘렸는지. 잘렸으면 결과에 남긴다. */
  readonly truncated: boolean;
};

export type ReviewFacts = {
  readonly verdict: 'approve' | 'request_changes';
  readonly findings: readonly FindingFacts[];
};

export type FindingFacts = {
  readonly severity: 'blocker' | 'major' | 'minor';
  readonly file: string;
  readonly line: number | null;
  readonly summary: string;
};

export type CheckFacts = {
  readonly name: string;
  readonly conclusion: string | null;
};

/** LLM이 만드는 것. 이것뿐이다. */
export type SummaryDraft = {
  readonly title: string;
  readonly what: string;
  readonly why: string;
  /** review 사실이 없으면 반드시 null이다. */
  readonly reviewGist: string | null;
};

export const CAPS = {
  /** PR body를 이 길이로 자른다. 실측된 PR body가 15KB급이라 상한이 필요하다. */
  prBody: 4000,
  changedPaths: 40,
  findings: 10,
  title: 80,
  what: 400,
  why: 400,
  reviewGist: 400,
} as const;

/**
 * OpenAI structured outputs strict 모드 스키마.
 *
 * strict 모드 제약: 모든 property가 `required`여야 하고 `additionalProperties: false`가 필수다.
 * 선택 필드는 `["string","null"]` union으로 표현한다.
 */
export const SUMMARY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'what', 'why', 'reviewGist'],
  properties: {
    title: {
      type: 'string',
      description: '이 변경을 사람이 알아볼 수 있는 짧은 한국어 제목. PR 제목을 그대로 쓰지 말고 의미로 옮긴다.',
    },
    what: {
      type: 'string',
      description: '무엇이 바뀌는지 1~2문장. 주어진 사실만 쓴다. PR 제목이나 파일 경로를 나열하지 않는다.',
    },
    why: {
      type: 'string',
      description: '왜 필요한지 1~2문장. 주어진 사실에서 알 수 없으면 목적을 그대로 옮겨 적고 추측을 덧붙이지 않는다.',
    },
    reviewGist: {
      type: ['string', 'null'],
      description:
        'review findings가 주어졌을 때만 그 핵심을 1~2문장으로 요약한다. review findings가 주어지지 않았으면 반드시 null이다.',
    },
  },
} as const;

/**
 * 이 프롬프트가 바뀌면 같은 사실에서 다른 요약이 나온다. `factsFingerprint`가 이 값을 함께
 * 섞어야 이미 요약한 PR도 새 계약으로 한 번 다시 요약된다. 프롬프트를 고칠 때 같이 올린다.
 */
export const SUMMARY_CONTRACT_REVISION = 2;

export const SYSTEM_PROMPT = [
  '너는 개발 상태 변화를 코드를 보지 않는 사람이 10초 안에 이해하도록 옮겨 쓴다.',
  '',
  '읽는 사람은 이동 중에 휴대폰으로 이 카드만 본다. 저장소도, 코드도, 이전 대화도 보고 있지',
  '않다. 그러므로 변경 목록을 옮겨 적는 것은 실패다. 무엇이 달라졌는지를 동작으로 말해야 한다.',
  '',
  '규칙:',
  '- 내부 용어와 약어를 그대로 쓰지 말고 그것이 하는 일로 바꿔 쓴다.',
  '  나쁜 예: "consumer_generation fencing을 revision CAS로 교체". ',
  '  좋은 예: "오래된 응답이 뒤늦게 도착해 최신 상태를 덮어쓰던 문제를 막았다".',
  '- 파일 경로·함수명·클래스명·테이블명을 나열하지 않는다. 어디를 고쳤는지가 아니라',
  '  무엇이 달라지는지를 쓴다. 꼭 필요한 식별자 하나까지만 원문 그대로 남긴다.',
  '- what은 이 변경 뒤에 무엇이 전과 다르게 동작하는지를 쓴다.',
  '- why는 무엇이 문제였는지를 쓴다. 문제가 사실에 없으면 억지로 지어내지 않는다.',
  '- 주어진 사실만 쓴다. 사실에 없는 성공·안전성·검증·테스트 통과를 주장하지 않는다.',
  '- 추측한 동기나 배경을 덧붙이지 않는다.',
  '- URL, 링크, 마크다운 링크를 만들지 않는다.',
  '- review findings가 입력에 없으면 reviewGist는 null이다. 비워 두지 말고 null로 둔다.',
  '- 한국어로 쓴다.',
  '- 상태나 위험도를 판단하지 않는다. 그것은 다른 곳에서 사실로 계산한다.',
].join('\n');

/** 사실을 프롬프트 본문으로 만든다. 없는 항목은 아예 넣지 않는다. */
export function renderFactsPrompt(facts: SummaryFacts): string {
  const parts: string[] = [];
  const add = (label: string, value: string): void => {
    parts.push(`## ${label}\n${value}`);
  };
  if (facts.taskPurpose) add('작업 목적', facts.taskPurpose);
  if (facts.workerDone) add('worker 완료 보고', facts.workerDone);
  add('PR 제목', facts.prTitle);
  if (facts.prBody.trim() !== '') add('PR 본문', facts.prBody);
  if (facts.changedPaths.length > 0) {
    add('변경 파일 경로', facts.changedPaths.slice(0, CAPS.changedPaths).join('\n'));
  }
  // 기준은 `hasReviewFindings`다. findings가 없으면 verdict도 넣지 않는다. verdict만 보여 주면
  // 모델이 그것으로 reviewGist를 채우는데 검증은 findings 없는 reviewGist를 거부하므로
  // 재시도까지 포함해 요약이 항상 실패한다. 카드의 리뷰 판정은 renderer가 사실에서 직접 그린다.
  const review = hasReviewFindings(facts) ? facts.review : null;
  if (review !== null) {
    const lines = review.findings
      .slice(0, CAPS.findings)
      .map((f) => `- [${f.severity}] ${f.file}${f.line === null ? '' : `:${f.line}`} — ${f.summary}`);
    add('review 판정', review.verdict);
    add('review findings', lines.join('\n'));
  }
  if (facts.checks.length > 0) {
    add('CI', facts.checks.map((c) => `${c.name}: ${c.conclusion ?? 'pending'}`).join('\n'));
  }
  if (facts.truncated) {
    add('참고', 'PR 본문이 상한 때문에 잘렸다. 잘린 부분을 추측해 채우지 않는다.');
  }
  return parts.join('\n\n');
}

/** review 사실이 실제로 있었는지. 프롬프트에 review 절을 넣는 기준이자 reviewGist 검증의 기준이다. */
export function hasReviewFindings(facts: SummaryFacts): boolean {
  return facts.review !== null && facts.review.findings.length > 0;
}
