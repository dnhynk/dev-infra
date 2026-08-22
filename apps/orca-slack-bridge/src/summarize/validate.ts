import { CAPS, hasReviewFindings, type SummaryDraft, type SummaryFacts } from './contract.js';

/**
 * schema 통과만으로는 부족하다.
 *
 * 실측: 필드 설명 없이 호출했을 때 모델이 review 입력이 없는데도 reviewGist를 채우고
 * 입력에 없던 보안 주장을 why에 넣었다. schema는 통과했다. 사실 근거 검증이 따로 필요하다.
 */
export type ValidationResult =
  | { readonly ok: true; readonly draft: SummaryDraft }
  | { readonly ok: false; readonly violations: readonly string[] };

const URLISH = /(https?:\/\/|\]\(|www\.)/i;

function checkText(name: string, value: unknown, cap: number, out: string[]): string | null {
  if (typeof value !== 'string') {
    out.push(`${name}이(가) 문자열이 아니다`);
    return null;
  }
  const v = value.trim();
  if (v === '') {
    out.push(`${name}이(가) 비어 있다`);
    return null;
  }
  if (v.length > cap) {
    out.push(`${name}이(가) 상한 ${cap}자를 넘는다 (${v.length}자)`);
    return null;
  }
  if (URLISH.test(v)) {
    // 링크는 renderer가 사실에서 붙인다. 모델이 만든 링크는 신뢰할 수 없다.
    out.push(`${name}에 링크가 있다. 모델은 링크를 만들지 않는다`);
    return null;
  }
  return v;
}

export function validateDraft(raw: unknown, facts: SummaryFacts): ValidationResult {
  const violations: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, violations: ['출력이 객체가 아니다'] };
  }
  const o = raw as Record<string, unknown>;

  const title = checkText('title', o['title'], CAPS.title, violations);
  const what = checkText('what', o['what'], CAPS.what, violations);
  const why = checkText('why', o['why'], CAPS.why, violations);

  // 핵심 검증: review 사실이 없으면 reviewGist는 반드시 null이다.
  const gistRaw = o['reviewGist'];
  let reviewGist: string | null = null;
  if (hasReviewFindings(facts)) {
    if (gistRaw === null || gistRaw === undefined) {
      violations.push('review findings가 있는데 reviewGist가 null이다');
    } else {
      reviewGist = checkText('reviewGist', gistRaw, CAPS.reviewGist, violations);
    }
  } else if (gistRaw !== null && gistRaw !== undefined && String(gistRaw).trim() !== '') {
    violations.push('review findings가 없는데 reviewGist를 만들었다');
  }

  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    draft: { title: title!, what: what!, why: why!, reviewGist },
  };
}

/** reviewer findings severity 집계로 risk를 파생한다. LLM이 정하지 않는다(OD-037). */
export type Risk = 'high' | 'medium' | 'low';

export function deriveRisk(facts: SummaryFacts): Risk | null {
  if (facts.review === null) return null;
  const sev = facts.review.findings.map((f) => f.severity);
  if (sev.includes('blocker')) return 'high';
  if (sev.includes('major')) return 'medium';
  return 'low';
}
