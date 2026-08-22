import { describe, it, expect } from 'vitest';
import {
  renderCard,
  renderFingerprint,
  deriveStatus,
  identityLine,
  type RenderedCard,
} from '../src/digest/render.js';
import type { ProjectedPr, RenderInput } from '../src/digest/types.js';
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
  state: 'open',
  isDraft: false,
  review: null,
  checks: [{ name: 'typecheck', status: 'COMPLETED', conclusion: 'SUCCESS' }],
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
        { name: 'typecheck', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'test', status: 'IN_PROGRESS', conclusion: null },
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
    pr: { ...basePr, state: 'merged', workerReport: null },
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

  it('mrkdwn 예약 문자를 이스케이프한다', () => {
    const card = renderCard({
      pr: { ...basePr, title: 'fix: <script> & </script>' },
      summary: failedSummary,
    });
    expect(contains(card, '&lt;script&gt; &amp;')).toBe(true);
    expect(contains(card, '<script>')).toBe(false);
  });
});

describe('deriveStatus', () => {
  it('merged가 review verdict보다 앞선다', () => {
    const pr: ProjectedPr = {
      ...basePr,
      state: 'merged',
      review: {
        verdict: 'request_changes',
        reviewedHeadSha: null,
        headMatch: 'unknown',
        findings: [],
        findingsTotal: 0,
      },
    };
    expect(deriveStatus(pr)).toBe('merged');
  });

  it('closed는 merged 다음이고 verdict보다 앞선다', () => {
    expect(deriveStatus({ ...basePr, state: 'closed' })).toBe('closed');
  });

  it('verdict가 없으면 awaiting_review다', () => {
    expect(deriveStatus(basePr)).toBe('awaiting_review');
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
    expect(deriveStatus(approved)).toBe('review_approved');
    expect(
      deriveStatus({ ...approved, review: { ...approved.review!, verdict: 'request_changes' } }),
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
      { ...basePr, state: 'merged' },
      { ...basePr, isDraft: true },
      { ...basePr, checks: [{ name: 'typecheck', status: 'COMPLETED', conclusion: 'FAILURE' }] },
      { ...basePr, workerReport: null },
      { ...basePr, truncation: { prBody: true, changedFiles: false } },
      { ...basePr, project: null },
      { ...basePr, url: `${PR_URL}9` },
    ];
    for (const pr of changed) {
      expect(renderFingerprint(renderCard({ pr, summary: okSummary }))).not.toBe(base);
    }
    expect(renderFingerprint(renderCard({ pr: basePr, summary: failedSummary }))).not.toBe(base);
  });

  it('카드에 나타나지 않는 값은 지문을 바꾸지 않는다', () => {
    const base = renderFingerprint(renderCard({ pr: basePr, summary: okSummary }));
    // headSha 자체는 카드에 없다. 카드에 있는 것은 headMatch가 만든 문장이다.
    const other = renderFingerprint(
      renderCard({ pr: { ...basePr, headSha: 'zzz9999' }, summary: okSummary }),
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
