import { describe, it, expect } from 'vitest';
import {
  summarize,
  serializeSummary,
  parseSummary,
  MemorySummaryCache,
  validateDraft,
  deriveRisk,
  factsFingerprint,
  extractOutputText,
  SummaryProviderError,
  renderFactsPrompt,
  SUMMARY_JSON_SCHEMA,
  type SummaryFacts,
  type SummaryProvider,
} from '../src/summarize/index.js';

const base: SummaryFacts = {
  taskPurpose: '결제 중복 처리 방지',
  workerDone:
    'idempotency key를 추가했다. 재시도 시 key가 재생성되는 경로를 발견했다. 회귀 테스트가 남았다.',
  prTitle: 'fix(payment): add idempotency key',
  prBody: '## What\n키를 추가했다.',
  changedPaths: ['apps/server/src/payment/charge.ts'],
  review: null,
  checks: [{ name: 'ci', conclusion: 'SUCCESS' }],
  truncated: false,
};

const withReview: SummaryFacts = {
  ...base,
  review: {
    verdict: 'request_changes',
    findings: [
      { severity: 'blocker', file: 'charge.ts', line: 88, summary: 'timeout 후 재시도 시 key 재생성' },
    ],
  },
};

/** 지적 없이 승인된 PR. verdict는 있고 findings는 0건이다. */
const approvedNoFindings: SummaryFacts = {
  ...base,
  review: { verdict: 'approve', findings: [] },
};

class FakeProvider implements SummaryProvider {
  calls = 0;
  constructor(private readonly outputs: unknown[]) {}
  async complete(): Promise<unknown> {
    const out = this.outputs[Math.min(this.calls, this.outputs.length - 1)];
    this.calls += 1;
    if (out instanceof Error) throw out;
    return out;
  }
}

const good = {
  title: '결제 중복 방지',
  what: '같은 요청이 한 번만 처리되게 했다.',
  why: '재시도 시 중복 처리 가능성이 있었다.',
  reviewGist: null,
};

describe('스키마', () => {
  it('strict 모드 제약을 지킨다', () => {
    expect(SUMMARY_JSON_SCHEMA.additionalProperties).toBe(false);
    expect([...SUMMARY_JSON_SCHEMA.required].sort()).toEqual(['reviewGist', 'title', 'what', 'why']);
    expect(SUMMARY_JSON_SCHEMA.properties.reviewGist.type).toEqual(['string', 'null']);
  });

  it('상태와 위험도는 스키마에 없다 — LLM이 정하지 않는다', () => {
    const keys = Object.keys(SUMMARY_JSON_SCHEMA.properties);
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('risk');
  });
});

describe('검증 — 실측된 환각을 잡는다', () => {
  it('review 입력이 없는데 reviewGist를 채우면 거부한다', () => {
    const r = validateDraft({ ...good, reviewGist: '구현은 완료되었지만 race를 해결해야 한다' }, base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.join()).toContain('review findings가 없는데');
  });

  it('review 입력이 있는데 null이면 거부한다', () => {
    const r = validateDraft({ ...good, reviewGist: null }, withReview);
    expect(r.ok).toBe(false);
  });

  it('링크를 만들면 거부한다', () => {
    for (const bad of ['https://x.com 참고', '자세히는 [여기](http://a)', 'www.example.com']) {
      expect(validateDraft({ ...good, what: bad }, base).ok).toBe(false);
    }
  });

  it('빈 문자열과 상한 초과를 거부한다', () => {
    expect(validateDraft({ ...good, title: '   ' }, base).ok).toBe(false);
    expect(validateDraft({ ...good, what: 'ㄱ'.repeat(500) }, base).ok).toBe(false);
  });

  it('정상 출력은 통과하고 공백을 정리한다', () => {
    const r = validateDraft({ ...good, title: '  결제  ' }, base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.draft.title).toBe('결제');
  });
});

describe('risk 파생 — 집계된 사실이지 추정이 아니다', () => {
  it('blocker가 있으면 high', () => {
    expect(deriveRisk(withReview)).toBe('high');
  });

  it('major가 있으면 medium', () => {
    expect(
      deriveRisk({
        ...withReview,
        review: {
          verdict: 'request_changes',
          findings: [{ severity: 'major', file: 'a', line: null, summary: 's' }],
        },
      }),
    ).toBe('medium');
  });

  it('minor만 있으면 low', () => {
    expect(
      deriveRisk({
        ...withReview,
        review: {
          verdict: 'approve',
          findings: [{ severity: 'minor', file: 'a', line: null, summary: 's' }],
        },
      }),
    ).toBe('low');
  });

  it('review가 없으면 표시하지 않는다', () => {
    expect(deriveRisk(base)).toBeNull();
  });
});

describe('지문', () => {
  it('같은 사실은 같은 지문', () => {
    expect(factsFingerprint(base)).toBe(factsFingerprint({ ...base }));
  });

  it('경로 순서가 달라도 같은 지문', () => {
    expect(factsFingerprint({ ...base, changedPaths: ['a', 'b'] })).toBe(
      factsFingerprint({ ...base, changedPaths: ['b', 'a'] }),
    );
  });

  it('사실이 바뀌면 지문이 바뀐다', () => {
    expect(factsFingerprint(base)).not.toBe(factsFingerprint(withReview));
    expect(factsFingerprint(base)).not.toBe(factsFingerprint({ ...base, prTitle: 'x' }));
  });
});

describe('입력 경계', () => {
  it('review가 없으면 프롬프트에 review 절이 없다', () => {
    const p = renderFactsPrompt(base);
    expect(p).not.toContain('review');
    expect(p).toContain('작업 목적');
  });

  it('잘렸으면 그 사실을 알린다', () => {
    expect(renderFactsPrompt({ ...base, truncated: true })).toContain('잘렸다');
  });
});

describe('프롬프트와 검증의 기준이 같다 — 둘 다 findings를 본다', () => {
  it('review가 null이면 review 절이 없고 reviewGist는 null이어야 한다', () => {
    const p = renderFactsPrompt(base);
    expect(p).not.toContain('## review 판정');
    expect(p).not.toContain('## review findings');
    expect(validateDraft({ ...good, reviewGist: '리뷰 핵심' }, base).ok).toBe(false);
    expect(validateDraft({ ...good, reviewGist: null }, base).ok).toBe(true);
  });

  it('approve이고 findings가 0건이면 verdict도 넣지 않는다 — 검증이 reviewGist를 금지하므로', () => {
    const p = renderFactsPrompt(approvedNoFindings);
    expect(p).not.toContain('## review 판정');
    expect(p).not.toContain('approve');
    expect(validateDraft({ ...good, reviewGist: '지적 없이 승인됐다' }, approvedNoFindings).ok).toBe(
      false,
    );
    expect(validateDraft({ ...good, reviewGist: null }, approvedNoFindings).ok).toBe(true);
  });

  it('findings가 있으면 verdict와 findings를 함께 넣고 reviewGist를 허용한다', () => {
    const p = renderFactsPrompt(withReview);
    expect(p).toContain('## review 판정');
    expect(p).toContain('request_changes');
    expect(p).toContain('## review findings');
    expect(p).toContain('timeout 후 재시도 시 key 재생성');
    expect(
      validateDraft({ ...good, reviewGist: 'key 재생성 경로가 blocker로 지적됐다' }, withReview).ok,
    ).toBe(true);
  });
});

describe('응답 추출', () => {
  it('컨테이너 이름에 의존하지 않고 output_text를 찾는다', () => {
    expect(
      extractOutputText({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }],
      }),
    ).toBe('{"a":1}');
    expect(extractOutputText({ 무엇이든: { 중첩: [{ type: 'output_text', text: 'x' }] } })).toBe('x');
  });

  it('거부를 조용히 넘기지 않는다', () => {
    expect(() => extractOutputText({ output: [{ content: [{ refusal: '못 하겠다' }] }] })).toThrow(
      SummaryProviderError,
    );
  });

  it('찾지 못하면 실패한다', () => {
    expect(() => extractOutputText({ output: [] })).toThrow(SummaryProviderError);
  });
});

describe('조립', () => {
  it('정상 경로', async () => {
    const r = await summarize(base, { provider: new FakeProvider([good]) });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.draft.title).toBe('결제 중복 방지');
  });

  it('검증 실패 시 재시도하고 두 번째가 좋으면 통과', async () => {
    const p = new FakeProvider([{ ...good, reviewGist: '없는 리뷰' }, good]);
    const r = await summarize(base, { provider: p });
    expect(r.kind).toBe('ok');
    expect(p.calls).toBe(2);
  });

  it('계속 실패하면 failed를 반환하고 이유를 남긴다 — 숨기지 않는다', async () => {
    const r = await summarize(base, {
      provider: new FakeProvider([{ ...good, reviewGist: '없는 리뷰' }]),
    });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.reason).toContain('review findings가 없는데');
  });

  it('재시도 불가 오류는 재시도하지 않는다', async () => {
    const p = new FakeProvider([new SummaryProviderError('HTTP 400', false)]);
    const r = await summarize(base, { provider: p });
    expect(r.kind).toBe('failed');
    expect(p.calls).toBe(1);
  });

  it('실패해도 risk는 사실에서 계산된다', async () => {
    const r = await summarize(withReview, {
      provider: new FakeProvider([new SummaryProviderError('HTTP 400', false)]),
    });
    expect(r.risk).toBe('high');
  });

  it('지문이 같으면 다시 호출하지 않는다', async () => {
    const cache = new MemorySummaryCache();
    const p = new FakeProvider([good]);
    await summarize(base, { provider: p, cache });
    await summarize({ ...base }, { provider: p, cache });
    expect(p.calls).toBe(1);
  });

  it('실패도 캐시해 같은 사실로 비용을 반복 태우지 않는다', async () => {
    const cache = new MemorySummaryCache();
    const p = new FakeProvider([{ ...good, reviewGist: '없는 리뷰' }]);
    await summarize(base, { provider: p, cache });
    const before = p.calls;
    await summarize({ ...base }, { provider: p, cache });
    expect(p.calls).toBe(before);
  });
});

/**
 * durable store에 남기는 요약의 왕복.
 *
 * 이 두 함수가 OD-035의 호출 상한을 프로세스 밖으로 넘긴다. 되살리지 못하면 조용히
 * 캐시 miss가 돼야 하고, 던져서 카드를 멈추면 안 된다.
 */
describe('요약 직렬화', () => {
  const ok = {
    kind: 'ok',
    draft: { title: '제목', what: '무엇.', why: '왜.', reviewGist: '리뷰.' },
    risk: 'high',
    truncated: true,
    fingerprint: 'fp-a',
  } as const;

  it('왕복하면 카드가 쓰는 값이 그대로 남는다', () => {
    const json = serializeSummary(ok);
    expect(json).not.toBeNull();
    expect(parseSummary(json, 'fp-a')).toEqual(ok);
  });

  it('summarizer 입력을 담지 않는다', () => {
    const json = serializeSummary(ok) ?? '';
    // OD-036이 정한 전송 경계와 별개의 저장 경계를 만들지 않는다.
    expect(Object.keys(JSON.parse(json)).sort()).toEqual([
      'reviewGist',
      'risk',
      'title',
      'truncated',
      'what',
      'why',
    ]);
  });

  it('지문은 담지 않고 되살릴 때 호출자가 준다', () => {
    // 되살리는 조건 자체가 "저장된 사실 지문이 이번 지문과 같다"이므로 두 곳에 두지 않는다.
    expect(JSON.parse(serializeSummary(ok) ?? '')).not.toHaveProperty('fingerprint');
    expect(parseSummary(serializeSummary(ok), 'fp-b')?.fingerprint).toBe('fp-b');
  });

  // 실패를 durable하게 캐시하면 provider 장애가 지나간 뒤에도 사실이 바뀔 때까지 축소 카드가
  // 굳는다. C1에는 캐시를 비우는 수단이 없다. 프로세스 내 캐시의 판단과 다른 이유다.
  it('실패한 요약은 남기지 않는다', () => {
    expect(
      serializeSummary({ kind: 'failed', reason: 'provider가 죽었다', risk: null, fingerprint: 'fp-a' }),
    ).toBeNull();
  });

  it('되살릴 수 없으면 던지지 않고 null이다', () => {
    expect(parseSummary(null, 'fp-a')).toBeNull();
    expect(parseSummary('not json', 'fp-a')).toBeNull();
    expect(parseSummary('null', 'fp-a')).toBeNull();
    expect(parseSummary('[]', 'fp-a')).toBeNull();
    // 필드가 빠지거나 타입이 어긋난 경우. 저장 형식이 바뀌어도 카드가 멈추지 않는다.
    expect(parseSummary('{"title":"t","what":"w","why":"y"}', 'fp-a')).toBeNull();
    expect(parseSummary('{"title":42,"what":"w","why":"y","reviewGist":null,"risk":null,"truncated":false}', 'fp-a')).toBeNull();
    expect(parseSummary('{"title":"t","what":"w","why":"y","reviewGist":null,"risk":"세다","truncated":false}', 'fp-a')).toBeNull();
    expect(parseSummary('{"title":"t","what":"w","why":"y","reviewGist":null,"risk":null,"truncated":"yes"}', 'fp-a')).toBeNull();
  });

  it('reviewGist와 risk의 null은 유효한 값이다', () => {
    const none = parseSummary(
      '{"title":"t","what":"w","why":"y","reviewGist":null,"risk":null,"truncated":false}',
      'fp-a',
    );
    expect(none?.kind).toBe('ok');
    expect(none?.risk).toBeNull();
    expect(none?.kind === 'ok' ? none.draft.reviewGist : undefined).toBeNull();
  });
});
