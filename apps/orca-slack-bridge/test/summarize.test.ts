import { describe, it, expect } from 'vitest';
import {
  summarize,
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
