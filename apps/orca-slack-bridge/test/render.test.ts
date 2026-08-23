import { describe, it, expect } from 'vitest';
import {
  renderCard,
  renderFingerprint,
  identityLine,
  type RenderedCard,
} from '../src/digest/render.js';
import { deriveDigestStatus } from '../src/digest/state.js';
import type {
  DigestStatus,
  ProjectedPr,
  RenderInput,
  ReviewedHeadMatch,
} from '../src/digest/types.js';
import { pullRequestKey, runKey, taskKey } from '../src/identity/keys.js';
import { repositoryIdentity } from '../src/identity/repository.js';
import type { SummaryDraft, SummaryResult } from '../src/summarize/index.js';

const REPO_ID = 42;
const PR_URL = 'https://github.com/dnhynk/dev-infra/pull/7';

const basePr: ProjectedPr = {
  key: pullRequestKey(REPO_ID, 7),
  repository: repositoryIdentity(REPO_ID, 'dnhynk/dev-infra'),
  project: 'dev-infra',
  correlation: {
    kind: 'correlated',
    run: runKey('run_7804be5a654f'),
    task: taskKey('task_c036763fd747'),
    dispatch: null,
  },
  number: 7,
  title: 'feat(c1): deterministic renderer',
  url: PR_URL,
  headSha: 'abc1234',
  checksHeadSha: 'abc1234',
  terminal: 'open',
  isDraft: false,
  review: null,
  checks: [{ kind: 'checkRun', id: 'CR_x', appId: null, startedAt: null, completedAt: null, name: 'typecheck', status: 'COMPLETED', conclusion: 'SUCCESS', state: null }],
  mergePolicy: 'unobserved',
  workerReport: {
    outcome: 'succeeded',
    body: 'renderer를 구현했다. layout이 코드에만 있음을 확인했다. 게시는 T5가 남았다.',
  },
  truncation: { prBody: false, changedFiles: false },
};

const okDraft: SummaryDraft = {
  title: '카드 layout을 코드로 고정',
  what: 'PR 사실을 Slack 카드로 옮기는 렌더러를 추가했다.',
  why: '모델이 layout이나 링크를 만들지 않게 하기 위해서다.',
  reviewGist: null,
};

const okSummary: SummaryResult = {
  kind: 'ok',
  draft: okDraft,
  risk: null,
  truncated: false,
  fingerprint: 'facts-fp-1',
};

const failedSummary: SummaryResult = {
  kind: 'failed',
  reason: 'HTTP 429 | why에 링크가 있다. 모델은 링크를 만들지 않는다',
  risk: null,
  fingerprint: 'facts-fp-1',
};

/** 스냅샷을 사람이 읽을 수 있게 blocks에서 텍스트만 뽑는다. */
function plain(card: RenderedCard): string {
  const parts = card.blocks.map((b) => {
    const o = b as Record<string, unknown>;
    if (o['type'] === 'actions') {
      const elements = o['elements'] as readonly Record<string, unknown>[];
      return elements
        .map((e) => `[${(e['text'] as Record<string, unknown>)['text']}](${e['url']})`)
        .join(' ');
    }
    return String((o['text'] as Record<string, unknown>)['text']);
  });
  return [`fallback: ${card.text}`, ...parts].join('\n---\n');
}

/** blocks 어디에든 이 문자열이 있는지. */
function contains(card: RenderedCard, needle: string): boolean {
  return JSON.stringify(card.blocks).includes(needle);
}

/** section block들의 text. Slack의 3000자 상한이 걸리는 자리다. */
function sectionTexts(card: RenderedCard): readonly string[] {
  return card.blocks
    .map((b) => b as Record<string, unknown>)
    .filter((o) => o['type'] === 'section')
    .map((o) => String((o['text'] as Record<string, unknown>)['text']));
}

/** emoji를 지운다. 색·emoji 없이도 상태를 알 수 있는지 보기 위해서다. */
function withoutEmoji(value: string): string {
  return value.replace(/\p{Extended_Pictographic}|\uFE0F/gu, '');
}

function withReview(
  verdict: 'approve' | 'request_changes',
  headMatch: ReviewedHeadMatch,
  reviewedHeadSha: string | null,
): ProjectedPr {
  return {
    ...basePr,
    review: { verdict, reviewedHeadSha, headMatch, findings: [], findingsTotal: 0 },
  };
}

/** 다섯 `DigestStatus`를 각각 한 번씩 내는 입력. 아래 여러 테스트가 공유한다. */
const ALL_STATES: readonly ProjectedPr[] = [
  basePr,
  withReview('approve', 'same', 'abc1234'),
  withReview('request_changes', 'same', 'abc1234'),
  { ...basePr, terminal: 'closed' },
  { ...basePr, terminal: 'merged' },
];

const STATUS_TEXT_LABEL: Readonly<Record<DigestStatus, string>> = {
  merged: '병합 완료',
  closed: '병합 없이 닫힘',
  changes_requested: '리뷰에서 수정 요청',
  review_approved: '리뷰 통과',
  awaiting_review: '리뷰 결과 없음',
};

const cases: Readonly<Record<string, RenderInput>> = {
  '요약 성공 · review 없음': { pr: basePr, summary: okSummary },
  '요약 실패': { pr: basePr, summary: failedSummary },
  'review request_changes': {
    pr: {
      ...basePr,
      review: {
        verdict: 'request_changes',
        reviewedHeadSha: 'abc1234',
        headMatch: 'same',
        findings: [
          {
            severity: 'blocker',
            file: 'src/digest/render.ts',
            line: 88,
            summary: 'esc()를 거치지 않은 경로가 있다',
          },
          { severity: 'minor', file: 'src/slack/post.ts', line: null, summary: '주석 오타' },
        ],
        findingsTotal: 12,
      },
      checks: [
        { kind: 'checkRun', id: 'CR_x', appId: null, startedAt: null, completedAt: null, name: 'typecheck', status: 'COMPLETED', conclusion: 'SUCCESS', state: null },
        { kind: 'checkRun', id: 'CR_x', appId: null, startedAt: null, completedAt: null, name: 'test', status: 'IN_PROGRESS', conclusion: null, state: null },
      ],
    },
    summary: {
      ...okSummary,
      draft: { ...okDraft, reviewGist: '이스케이프 누락 경로를 하나 더 막아야 한다.' },
      risk: 'high',
    },
  },
  'review approve · head가 움직임': {
    pr: {
      ...basePr,
      review: {
        verdict: 'approve',
        reviewedHeadSha: 'old9999',
        headMatch: 'different',
        findings: [],
        findingsTotal: 0,
      },
    },
    summary: { ...okSummary, risk: 'low' },
  },
  merged: {
    pr: { ...basePr, terminal: 'merged', workerReport: null },
    summary: okSummary,
  },
};

describe('renderCard', () => {
  for (const [name, input] of Object.entries(cases)) {
    it(`스냅샷: ${name}`, () => {
      expect(plain(renderCard(input))).toMatchSnapshot();
    });
  }

  it('모든 경우에 PR 링크가 blocks와 fallback 텍스트에 있다', () => {
    for (const input of Object.values(cases)) {
      const card = renderCard(input);
      expect(contains(card, PR_URL)).toBe(true);
      expect(card.text).toContain(PR_URL);
    }
  });

  it('최상단 identity는 [Project] owner/repo #N이다', () => {
    const card = renderCard({ pr: basePr, summary: okSummary });
    expect(identityLine(basePr)).toBe('[dev-infra] dnhynk/dev-infra #7');
    expect(contains(card, '[dev-infra] dnhynk/dev-infra #7')).toBe(true);
  });

  it('Project가 없으면 owner/repo #N으로 떨어진다', () => {
    const pr = { ...basePr, project: null };
    expect(identityLine(pr)).toBe('dnhynk/dev-infra #7');
    expect(contains(renderCard({ pr, summary: okSummary }), 'dnhynk/dev-infra #7')).toBe(true);
  });

  it('상태를 emoji만으로 구분하지 않는다 — 텍스트 라벨이 함께 있다', () => {
    for (const input of Object.values(cases)) {
      const card = renderCard(input);
      const labels = ['병합 완료', '병합 없이 닫힘', '리뷰에서 수정 요청', '리뷰 통과', '리뷰 결과 없음'];
      expect(labels.some((l) => contains(card, l))).toBe(true);
    }
  });

  it('요약 실패는 요약 성공처럼 보이지 않는다', () => {
    const card = renderCard({ pr: basePr, summary: failedSummary });
    expect(contains(card, '요약 실패')).toBe(true);
    // 모델이 만든 문자열이 하나도 카드에 없다.
    expect(contains(card, okDraft.what)).toBe(false);
    expect(contains(card, '무엇이 바뀌나')).toBe(false);
    // 제목은 PR 원문 제목으로 떨어진다(OD-035).
    expect(card.text).toContain(basePr.title);
    // 사실은 그대로 남는다.
    expect(contains(card, 'typecheck')).toBe(true);
    expect(contains(card, PR_URL)).toBe(true);
  });

  it('worker 보고가 없으면 없다고 표시한다', () => {
    const card = renderCard({ pr: { ...basePr, workerReport: null }, summary: okSummary });
    expect(contains(card, 'worker 보고 없음')).toBe(true);
  });

  it('worker 보고 실패를 성공처럼 그리지 않는다', () => {
    const card = renderCard({
      pr: { ...basePr, workerReport: { outcome: 'failed', body: '실패했다.' } },
      summary: okSummary,
    });
    expect(contains(card, '결과: failed')).toBe(true);
  });

  it('truncated면 입력이 잘렸다는 사실을 표시한다', () => {
    const both = renderCard({
      pr: { ...basePr, truncation: { prBody: true, changedFiles: true } },
      summary: okSummary,
    });
    expect(contains(both, 'PR 본문이 상한에서 잘려')).toBe(true);
    expect(contains(both, '변경 파일 목록을 일부만 관측했다')).toBe(true);
    // 잘리지 않았으면 그 절을 만들지 않는다.
    expect(contains(renderCard({ pr: basePr, summary: okSummary }), '관측 범위')).toBe(false);
  });

  it('findings 상한으로 가려진 건수를 숨기지 않는다', () => {
    const card = renderCard(cases['review request_changes']!);
    expect(contains(card, '외 10건은 카드에 싣지 않았다')).toBe(true);
  });

  it('checks가 다른 commit의 관측이면 CI 절이 그 사실을 표시한다', () => {
    // 조회 계층이 bounded 재관측 뒤에도 수렴시키지 못한 불일치다. 이 줄 없이 check를 나열하면
    // stale head의 결론이 현재 head의 사실로 읽힌다(OD-044).
    const card = renderCard({
      pr: { ...basePr, headSha: 'abc1234', checksHeadSha: 'zzz9999' },
      summary: okSummary,
    });
    expect(contains(card, 'check 관측은 현재 head가 아니라 commit zzz9999의 것이다')).toBe(true);
    expect(contains(card, '(현재 head abc1234)')).toBe(true);
    // check 자체는 그대로 나열된다. 사실을 숨기지 않고 결속만 밝힌다.
    expect(contains(card, 'typecheck')).toBe(true);
  });

  it('checks가 현재 head의 관측이면 결속 문구를 만들지 않는다', () => {
    const card = renderCard({ pr: basePr, summary: okSummary });
    expect(contains(card, 'check 관측은 현재 head가 아니라')).toBe(false);
  });

  it('check가 없어도 다른 commit의 관측이면 그 사실은 남는다', () => {
    // 빈 checks를 현재 head의 "check 없음"으로 읽으면 안 된다. 관측한 commit이 다르다.
    const card = renderCard({
      pr: { ...basePr, checks: [], checksHeadSha: 'zzz9999' },
      summary: okSummary,
    });
    expect(contains(card, 'check 관측은 현재 head가 아니라 commit zzz9999의 것이다')).toBe(true);
    expect(contains(card, '관찰된 check 없음')).toBe(true);
  });

  it('mrkdwn 예약 문자를 이스케이프한다', () => {
    const card = renderCard({
      pr: { ...basePr, title: 'fix: <script> & </script>' },
      summary: failedSummary,
    });
    expect(contains(card, '&lt;script&gt; &amp;')).toBe(true);
    expect(contains(card, '<script>')).toBe(false);
  });
});

/**
 * snapshot 밖의 의미 요구.
 *
 * 아래 단언은 snapshot을 갱신해도 깨진다. snapshot만으로 고정하면 두 truncation flag를 하나로
 * 합치거나 경고 문구를 지운 뒤 snapshot을 다시 찍는 것으로 통과해 버린다.
 */
describe('renderCard · 의미 요구', () => {
  it('두 절단 flag는 각각 단독으로 서로 다른 표시를 낸다', () => {
    const bodyOnly = renderCard({
      pr: { ...basePr, truncation: { prBody: true, changedFiles: false } },
      summary: okSummary,
    });
    const filesOnly = renderCard({
      pr: { ...basePr, truncation: { prBody: false, changedFiles: true } },
      summary: okSummary,
    });

    expect(contains(bodyOnly, 'PR 본문이 상한에서 잘려')).toBe(true);
    expect(contains(bodyOnly, '변경 파일 목록을 일부만 관측했다')).toBe(false);
    expect(contains(filesOnly, '변경 파일 목록을 일부만 관측했다')).toBe(true);
    expect(contains(filesOnly, 'PR 본문이 상한에서 잘려')).toBe(false);
    // 두 flag를 하나로 합치면 두 카드가 같아지고 이 단언이 깨진다.
    expect(renderFingerprint(bodyOnly)).not.toBe(renderFingerprint(filesOnly));
  });

  it('review가 null이면 리뷰 판정이 없다는 것이 드러난다', () => {
    expect(basePr.review).toBeNull();
    const card = renderCard({ pr: basePr, summary: okSummary });
    expect(contains(card, 'reviewer_result가 관찰되지 않았다')).toBe(true);
    // 판정이 있는 것처럼 보이는 줄을 만들지 않는다.
    expect(contains(card, '판정:')).toBe(false);
    expect(contains(card, '보고된 finding 없음')).toBe(false);
    expect(deriveDigestStatus(basePr)).toBe('awaiting_review');
    expect(contains(card, STATUS_TEXT_LABEL.awaiting_review)).toBe(true);
  });

  it('headMatch unknown과 different가 서로 다른 문장을 낸다', () => {
    const card = (pr: ProjectedPr): RenderedCard => renderCard({ pr, summary: okSummary });
    const different = card(withReview('approve', 'different', 'old9999'));
    const unknown = card(withReview('approve', 'unknown', null));
    const same = card(withReview('approve', 'same', basePr.headSha));

    expect(contains(different, 'reviewer가 본 commit이 현재 head와 다르다')).toBe(true);
    expect(contains(different, '알 수 없어')).toBe(false);

    expect(contains(unknown, 'reviewer가 본 commit을 알 수 없어')).toBe(true);
    expect(contains(unknown, 'reviewer가 본 commit이 현재 head와 다르다')).toBe(false);

    // same은 어느 쪽 문장도 만들지 않는다.
    expect(contains(same, 'reviewer가 본 commit')).toBe(false);

    // 세 값이 서로 다른 카드를 만든다. 하나로 뭉뚱그리면 깨진다.
    expect(new Set([different, unknown, same].map((c) => renderFingerprint(c))).size).toBe(3);

    // 사실 진술이지 approval 무효 판정이 아니다(OD-031, C2).
    for (const c of [different, unknown]) {
      expect(contains(c, '판정: approve')).toBe(true);
      for (const claim of ['무효', '만료', '다시 리뷰']) {
        expect(contains(c, claim)).toBe(false);
      }
    }
  });

  it('모든 상태에서 identity와 PR 링크가 blocks와 fallback 양쪽에 있다', () => {
    const seen = new Set<DigestStatus>();
    for (const pr of ALL_STATES) {
      for (const summary of [okSummary, failedSummary]) {
        const card = renderCard({ pr, summary });
        seen.add(deriveDigestStatus(pr));
        expect(contains(card, '[dev-infra] dnhynk/dev-infra #7')).toBe(true);
        expect(card.text).toContain('[dev-infra] dnhynk/dev-infra #7');
        expect(contains(card, PR_URL)).toBe(true);
        expect(card.text).toContain(PR_URL);
      }
    }
    // 다섯 상태를 전부 덮었다. 상태가 늘면 이 단언이 먼저 깨진다.
    expect(seen.size).toBe(5);
  });

  it('emoji와 색을 지워도 상태를 알 수 있다', () => {
    for (const pr of ALL_STATES) {
      const card = renderCard({ pr, summary: okSummary });
      const label = STATUS_TEXT_LABEL[deriveDigestStatus(pr)];
      expect(withoutEmoji(JSON.stringify(card.blocks))).toContain(label);
      expect(withoutEmoji(card.text)).toContain(label);
    }
  });

  it('closed 카드도 라벨·identity·링크를 모두 남긴다', () => {
    const card = renderCard({ pr: { ...basePr, terminal: 'closed' }, summary: failedSummary });
    expect(contains(card, STATUS_TEXT_LABEL.closed)).toBe(true);
    expect(withoutEmoji(card.text)).toContain(STATUS_TEXT_LABEL.closed);
    expect(contains(card, '[dev-infra] dnhynk/dev-infra #7')).toBe(true);
    expect(contains(card, PR_URL)).toBe(true);
  });

  it('review_approved가 병합 준비 완료를 주장하지 않는다', () => {
    const approved = withReview('approve', 'same', basePr.headSha);
    expect(deriveDigestStatus(approved)).toBe('review_approved');

    // CI가 실패해도 상태 라벨은 review verdict만 옮긴다. 둘을 결합한 판정은 C2다(OD-032).
    for (const pr of [
      approved,
      { ...approved, checks: [{ kind: 'checkRun' as const, id: 'CR_x', appId: null, startedAt: null, completedAt: null, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', state: null }] },
      { ...approved, isDraft: true },
    ]) {
      const card = renderCard({ pr, summary: okSummary });
      const all = [card.text, JSON.stringify(card.blocks)].join('\n');
      expect(all).toContain(STATUS_TEXT_LABEL.review_approved);
      for (const claim of ['병합 준비', 'merge_ready', 'merge-ready', '병합 가능', '병합해도']) {
        expect(all).not.toContain(claim);
      }
    }
  });
});

describe('renderCard · fallback text 이스케이프', () => {
  /**
   * PR 제목과 모델 title은 untrusted input이다(스펙 §10). blocks만 이스케이프하면 fallback
   * text에서 `<!channel>` 하나가 카드 한 번에 workspace 전체를 깨운다.
   */
  const HOSTILE = 'fix: <@U012ABC> <!channel> & <https://evil.example|GitHub>';

  it('요약 실패 시 PR 원문 제목이 fallback에서도 이스케이프된다', () => {
    const card = renderCard({ pr: { ...basePr, title: HOSTILE }, summary: failedSummary });
    expect(card.text).toContain('&lt;@U012ABC&gt;');
    expect(card.text).toContain('&lt;!channel&gt;');
    expect(card.text).toContain('&amp;');
    expect(card.text).not.toContain('<!channel>');
    expect(card.text).not.toContain('<@U012ABC>');
    expect(card.text).not.toContain('<https://evil.example|GitHub>');
  });

  it('요약 성공 시 모델이 만든 title도 fallback에서 이스케이프된다', () => {
    const card = renderCard({
      pr: basePr,
      summary: { ...okSummary, draft: { ...okDraft, title: HOSTILE } },
    });
    expect(card.text).toContain('&lt;!channel&gt;');
    expect(card.text).not.toContain('<!channel>');
  });

  it('identity에 들어온 예약 문자도 fallback에서 이스케이프된다', () => {
    const card = renderCard({ pr: { ...basePr, project: '<!here>' }, summary: okSummary });
    expect(card.text).toContain('[&lt;!here&gt;]');
    expect(card.text).not.toContain('<!here>');
  });

  it('fallback과 blocks가 같은 이스케이프 결과를 쓴다', () => {
    const card = renderCard({ pr: { ...basePr, title: HOSTILE }, summary: failedSummary });
    const escaped =
      'fix: &lt;@U012ABC&gt; &lt;!channel&gt; &amp; &lt;https://evil.example|GitHub&gt;';
    expect(card.text).toContain(escaped);
    expect(contains(card, escaped)).toBe(true);
    // URL을 뺀 나머지에는 예약 문자가 남지 않는다.
    expect(card.text.replace(PR_URL, '')).not.toMatch(/[<>]/);
  });
});

describe('renderCard · section text 3000자 상한', () => {
  /**
   * Slack section text는 최대 3000자다. 넘기면 `invalid_blocks`로 카드 **전체**가 거절돼
   * identity와 PR 링크까지 사라진다. `WorkerReport.body`도 `ProjectedPr.title`도 계약에
   * 상한이 없으므로 렌더 경계에서 막는다.
   */
  const LONG = 'ㄱ'.repeat(5000);
  const MARK = '표시 한도 3000자를 넘어 잘림';

  const overflowing: Readonly<Record<string, RenderInput>> = {
    'worker 보고 본문': {
      pr: { ...basePr, workerReport: { outcome: 'succeeded', body: LONG } },
      summary: failedSummary,
    },
    'PR 제목': { pr: { ...basePr, title: LONG }, summary: failedSummary },
    '모델 title': { pr: basePr, summary: { ...okSummary, draft: { ...okDraft, title: LONG } } },
    '요약 what': { pr: basePr, summary: { ...okSummary, draft: { ...okDraft, what: LONG } } },
    'check 이름': {
      pr: { ...basePr, checks: [{ kind: 'checkRun', id: 'CR_x', appId: null, startedAt: null, completedAt: null, name: LONG, status: 'COMPLETED', conclusion: 'SUCCESS', state: null }] },
      summary: okSummary,
    },
  };

  for (const [name, input] of Object.entries(overflowing)) {
    it(`${name}이 길어도 어떤 section도 3000자를 넘지 않는다`, () => {
      const texts = sectionTexts(renderCard(input));
      expect(texts.length).toBeGreaterThan(0);
      for (const t of texts) expect(t.length).toBeLessThanOrEqual(3000);
      // 하나는 실제로 상한에 닿았다. 입력이 짧아서 통과한 것이 아니다.
      expect(Math.max(...texts.map((t) => t.length))).toBe(3000);
    });

    it(`${name}을 자를 때 잘렸다는 것이 카드에 보인다`, () => {
      expect(contains(renderCard(input), MARK)).toBe(true);
    });
  }

  it('상한 안이면 자르지도 표시를 붙이지도 않는다', () => {
    for (const input of Object.values(cases)) {
      const card = renderCard(input);
      expect(contains(card, MARK)).toBe(false);
      for (const t of sectionTexts(card)) expect(t.length).toBeLessThan(3000);
    }
  });

  it('상한을 넘겨도 identity와 PR 링크는 남는다', () => {
    const card = renderCard(overflowing['PR 제목']!);
    expect(contains(card, 'dnhynk/dev-infra #7')).toBe(true);
    expect(contains(card, PR_URL)).toBe(true);
  });

  it('이스케이프 뒤의 길이로 센다', () => {
    // `&`는 이스케이프하면 5자가 된다. 원문 2000자가 escape 뒤 10000자다.
    const card = renderCard({
      pr: { ...basePr, workerReport: { outcome: 'succeeded', body: '&'.repeat(2000) } },
      summary: failedSummary,
    });
    for (const t of sectionTexts(card)) expect(t.length).toBeLessThanOrEqual(3000);
  });

  it('지문은 자른 결과를 해싱한다', () => {
    const fp = (body: string): string =>
      renderFingerprint(
        renderCard({
          pr: { ...basePr, workerReport: { outcome: 'succeeded', body } },
          summary: failedSummary,
        }),
      );
    const head = 'ㄱ'.repeat(4000);
    // 잘려 나가 카드에 없는 자리가 다르면 카드가 같으므로 지문도 같다. 없는 차이로 update하지 않는다.
    expect(fp(`${head}A`)).toBe(fp(`${head}B`));
    // 카드에 남는 자리가 다르면 지문이 바뀐다.
    expect(fp(`A${head}`)).not.toBe(fp(`B${head}`));
    // 자른 카드와 자르지 않은 카드는 다르다.
    expect(fp(head)).not.toBe(fp('짧다'));
  });
});

describe('renderCard · 상한이 astral 문자를 쪼개지 않는다', () => {
  /**
   * 상한은 UTF-16 code unit 단위이고 emoji 하나는 2 code unit이다. 자르는 지점이 그 문자
   * 가운데에 떨어지면 surrogate pair가 갈라져 lone surrogate가 남는다. Slack에 보내는 JSON은
   * 그 자리에 U+FFFD를 넣거나 요청을 거절하고, 어느 쪽이든 카드가 원문과 달라진다.
   *
   * 이 자리는 헤더 section이다. `이모지 *[project] owner/repo #N* · ` 앞머리가 홀수 code unit이라
   * 자르는 지점이 emoji 한가운데로 떨어진다. 앞머리 길이에 기대는 재현이므로 lone surrogate가
   * 실제로 없는지를 단언한다.
   */
  const EMOJI = '😀';
  /** high surrogate 짝이 없는 code unit이 있는가. */
  const hasLoneSurrogate = (value: string): boolean => {
    for (let i = 0; i < value.length; i += 1) {
      const c = value.charCodeAt(i);
      if (c < 0xd800 || c > 0xdbff) continue;
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : Number.NaN;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    }
    return false;
  };

  const card = renderCard({ pr: { ...basePr, title: EMOJI.repeat(1600) }, summary: failedSummary });

  it('자른 section에 lone surrogate가 남지 않는다', () => {
    const texts = sectionTexts(card);
    expect(Math.max(...texts.map((t) => t.length))).toBeGreaterThan(2900);
    for (const t of texts) expect(hasLoneSurrogate(t)).toBe(false);
  });

  it('경계를 지키면서도 3000자를 넘지 않는다', () => {
    for (const t of sectionTexts(card)) expect(t.length).toBeLessThanOrEqual(3000);
  });
});

describe('deriveDigestStatus', () => {
  it('merged가 review verdict보다 앞선다', () => {
    const pr: ProjectedPr = {
      ...basePr,
      terminal: 'merged',
      review: {
        verdict: 'request_changes',
        reviewedHeadSha: null,
        headMatch: 'unknown',
        findings: [],
        findingsTotal: 0,
      },
    };
    expect(deriveDigestStatus(pr)).toBe('merged');
  });

  it('closed는 merged 다음이고 verdict보다 앞선다', () => {
    expect(deriveDigestStatus({ ...basePr, terminal: 'closed' })).toBe('closed');
  });

  it('verdict가 없으면 awaiting_review다', () => {
    expect(deriveDigestStatus(basePr)).toBe('awaiting_review');
  });

  it('verdict를 그대로 옮긴다', () => {
    const approved: ProjectedPr = {
      ...basePr,
      review: {
        verdict: 'approve',
        reviewedHeadSha: 'abc1234',
        headMatch: 'same',
        findings: [],
        findingsTotal: 0,
      },
    };
    expect(deriveDigestStatus(approved)).toBe('review_approved');
    expect(
      deriveDigestStatus({ ...approved, review: { ...approved.review!, verdict: 'request_changes' } }),
    ).toBe('changes_requested');
  });
});

describe('renderFingerprint', () => {
  it('같은 입력이면 같은 지문이다', () => {
    const input: RenderInput = { pr: basePr, summary: okSummary };
    expect(renderFingerprint(renderCard(input))).toBe(renderFingerprint(renderCard(input)));
  });

  it('입력 객체가 달라도 값이 같으면 같은 지문이다', () => {
    const a = renderCard({ pr: basePr, summary: okSummary });
    const b = renderCard({ pr: { ...basePr }, summary: { ...okSummary } });
    expect(renderFingerprint(a)).toBe(renderFingerprint(b));
  });

  it('카드에 표시하는 사실이 바뀌면 지문이 바뀐다', () => {
    const base = renderFingerprint(renderCard({ pr: basePr, summary: okSummary }));
    const changed: readonly ProjectedPr[] = [
      { ...basePr, terminal: 'merged' },
      { ...basePr, isDraft: true },
      { ...basePr, checks: [{ kind: 'checkRun', id: 'CR_x', appId: null, startedAt: null, completedAt: null, name: 'typecheck', status: 'COMPLETED', conclusion: 'FAILURE', state: null }] },
      { ...basePr, workerReport: null },
      { ...basePr, truncation: { prBody: true, changedFiles: false } },
      { ...basePr, project: null },
      { ...basePr, url: `${PR_URL}9` },
      // checks가 다른 commit의 관측이라는 사실이 카드에 실린다(OD-044).
      { ...basePr, checksHeadSha: 'zzz9999' },
    ];
    for (const pr of changed) {
      expect(renderFingerprint(renderCard({ pr, summary: okSummary }))).not.toBe(base);
    }
    expect(renderFingerprint(renderCard({ pr: basePr, summary: failedSummary }))).not.toBe(base);
  });

  it('카드에 나타나지 않는 값은 지문을 바꾸지 않는다', () => {
    const base = renderFingerprint(renderCard({ pr: basePr, summary: okSummary }));
    // 일치하는 sha 값 자체는 카드에 없다. 카드에 있는 것은 headMatch·checks head 결속이 만든
    // 문장이므로, 두 sha가 함께 움직여 일치가 유지되면 카드도 지문도 그대로다.
    const other = renderFingerprint(
      renderCard({ pr: { ...basePr, headSha: 'zzz9999', checksHeadSha: 'zzz9999' }, summary: okSummary }),
    );
    expect(other).toBe(base);
    // summarizer 사실 지문도 카드에 없다.
    expect(
      renderFingerprint(
        renderCard({ pr: basePr, summary: { ...okSummary, fingerprint: 'facts-fp-2' } }),
      ),
    ).toBe(base);
  });
});
