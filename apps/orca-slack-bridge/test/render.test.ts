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
  MergePolicy,
  ProjectedPr,
  RenderInput,
  ReviewedHeadMatch,
} from '../src/digest/types.js';
import { pullRequestKey, runKey, taskKey } from '../src/identity/keys.js';
import { repositoryIdentity } from '../src/identity/repository.js';
import type { SummaryDraft, SummaryResult } from '../src/summarize/index.js';
import {
  cardText,
  fieldValue,
  footerText,
  headerText,
  preview,
  sectionTexts,
} from './card-text.js';

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
  mergePolicy: 'passing',
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

/** 버튼의 URL. 카드의 유일한 링크다. */
function buttonUrl(card: RenderedCard): string | undefined {
  const actions = card.blocks.find((block) => block['type'] === 'actions');
  const elements = actions?.['elements'] as readonly Record<string, unknown>[] | undefined;
  return elements?.[0]?.['url'] as string | undefined;
}

/** emoji를 지운다. 색·emoji 없이도 상태를 알 수 있는지 보기 위해서다. */
function withoutEmoji(value: string): string {
  return value.replace(/\p{Extended_Pictographic}|️/gu, '');
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
  changes_requested: '수정 요청',
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
      // 진행 중인 required check가 있는 상태. 스냅샷이 축의 두 번째 값도 덮는다.
      mergePolicy: 'pending',
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
      const card = renderCard(input, '2026-10-01T05:23:05.000Z');
      expect(`fallback: ${card.text}\n${preview(card)}`).toMatchSnapshot();
    });
  }

  it('PR 링크는 모든 경우에 버튼에만 있고 대체 텍스트와 본문에는 없다', () => {
    for (const input of Object.values(cases)) {
      const card = renderCard(input);
      expect(buttonUrl(card)).toBe(PR_URL);
      expect(card.text).not.toContain(PR_URL);
      expect(JSON.stringify(card.attachments)).not.toContain('https://');
      // 버튼은 최상위에만 있다. attachment 안의 버튼 클릭은 handler가 받지 않는다.
      expect(JSON.stringify(card.attachments)).not.toContain('"type":"actions"');
    }
  });

  it('identity는 저장소·Project 칸과 대체 텍스트의 [Project] owner/repo #N이다', () => {
    const card = renderCard({ pr: basePr, summary: okSummary });
    expect(identityLine(basePr)).toBe('[dev-infra] dnhynk/dev-infra #7');
    expect(card.text).toContain('[dev-infra] dnhynk/dev-infra #7');
    expect(fieldValue(card, '저장소')).toBe('dnhynk/dev-infra · #7');
    expect(fieldValue(card, 'Project')).toBe('dev-infra');
    // 머리는 무엇이 바뀌었는가(제목)다.
    expect(headerText(card)).toBe('🟡  리뷰 결과 없음 · 카드 layout을 코드로 고정');
  });

  it('Project가 없으면 owner/repo #N으로 떨어진다', () => {
    const pr = { ...basePr, project: null };
    const card = renderCard({ pr, summary: okSummary });
    expect(identityLine(pr)).toBe('dnhynk/dev-infra #7');
    expect(card.text).toContain('dnhynk/dev-infra #7');
    expect(fieldValue(card, 'Project')).toBe('미등록');
  });

  it('상태를 emoji만으로 구분하지 않는다 — 머리에 텍스트 라벨이 함께 있다', () => {
    for (const pr of ALL_STATES) {
      const card = renderCard({ pr, summary: okSummary });
      expect(headerText(card)).toContain(STATUS_TEXT_LABEL[deriveDigestStatus(pr)]);
    }
  });

  it('상태마다 색 바가 정해져 있다', () => {
    const colors = ALL_STATES.map((pr) => renderCard({ pr, summary: okSummary }).attachments?.[0]?.color);
    // 리뷰 결과 없음 blue, 리뷰 통과 green, 수정 요청 amber, 닫힘 gray, 병합 purple.
    expect(colors).toEqual(['#2f81f7', '#1a7f37', '#bf8700', '#6e7781', '#8250df']);
  });

  it('요약 실패는 요약 성공처럼 보이지 않는다', () => {
    const card = renderCard({ pr: basePr, summary: failedSummary });
    expect(fieldValue(card, '요약')).toBe(
      '실패 · HTTP 429 | why에 링크가 있다. 모델은 링크를 만들지 않는다',
    );
    // 모델이 만든 문자열이 하나도 카드에 없다.
    expect(cardText(card)).not.toContain(okDraft.what);
    // 제목은 PR 원문 제목으로 떨어진다(OD-035).
    expect(card.text).toContain(basePr.title);
    expect(headerText(card)).toContain(basePr.title);
    // worker 보고 본문이 사실 텍스트로 남는다.
    expect(sectionTexts(card)[0]).toBe(basePr.workerReport!.body);
    expect(buttonUrl(card)).toBe(PR_URL);
  });

  it('요약이 성공하면 무엇과 왜를 한 문단으로 싣는다', () => {
    const card = renderCard({ pr: basePr, summary: okSummary });
    expect(sectionTexts(card)[0]).toBe(`${okDraft.what} ${okDraft.why}`);
    expect(fieldValue(card, '요약')).toBe('있음');
  });

  it('worker 보고가 없으면 없다고 표시한다', () => {
    const card = renderCard({ pr: { ...basePr, workerReport: null }, summary: okSummary });
    expect(fieldValue(card, 'worker 보고')).toBe('없음');
  });

  it('worker 보고 실패를 성공처럼 그리지 않는다', () => {
    const card = renderCard({
      pr: { ...basePr, workerReport: { outcome: 'failed', body: '실패했다.' } },
      summary: okSummary,
    });
    expect(fieldValue(card, 'worker 보고')).toBe('실패');
  });

  it('truncated면 입력이 잘렸다는 사실을 표시한다', () => {
    const both = renderCard({
      pr: { ...basePr, truncation: { prBody: true, changedFiles: true } },
      summary: okSummary,
    });
    expect(fieldValue(both, '관측 범위')).toBe('요약 입력 PR 본문 일부 · 변경 파일 일부');
    // 잘리지 않았으면 전체를 관측했다고 적는다.
    expect(fieldValue(renderCard({ pr: basePr, summary: okSummary }), '관측 범위')).toBe('전체');
  });

  it('findings는 severity와 요약만 싣고 파일 경로를 싣지 않는다', () => {
    const card = renderCard(cases['review request_changes']!);
    const findings = sectionTexts(card).find((text) => text.startsWith('*finding*'));
    expect(findings).toBe([
      '*finding*',
      '_이스케이프 누락 경로를 하나 더 막아야 한다._',
      '높음 · esc()를 거치지 않은 경로가 있다',
      '낮음 · 주석 오타',
      '외 10건은 카드에 싣지 않았다',
    ].join('\n'));
    expect(cardText(card)).not.toContain('src/digest/render.ts');
    expect(cardText(card)).not.toContain('src/slack/post.ts');
    expect(fieldValue(card, '리뷰')).toBe('수정 요청 · finding 12건');
    expect(fieldValue(card, '위험도')).toBe('높음');
  });

  it('checks가 다른 commit의 관측이면 CI 칸이 그 사실을 표시하고 SHA는 싣지 않는다', () => {
    // 조회 계층이 bounded 재관측 뒤에도 수렴시키지 못한 불일치다. 이 한정 없이 축을 그리면
    // stale head의 결론이 현재 head의 사실로 읽힌다(OD-044).
    const card = renderCard({
      pr: { ...basePr, headSha: 'abc1234', checksHeadSha: 'zzz9999' },
      summary: okSummary,
    });
    expect(fieldValue(card, 'CI')).toBe('통과 · 최신 커밋 기준 아님');
    // 다른 commit의 통과로 병합 준비를 말하지 않는다.
    expect(fieldValue(card, '병합 준비')).toBe('미판정 · 리뷰·merge queue·최신화 조건 미확인');
    expect(cardText(card)).not.toContain('zzz9999');
    expect(cardText(card)).not.toContain('abc1234');
  });

  it('checks가 현재 head의 관측이면 결속 문구를 만들지 않는다', () => {
    const card = renderCard({ pr: basePr, summary: okSummary });
    expect(fieldValue(card, 'CI')).toBe('통과');
  });

  it('check 목록은 집계하지 않고 결론을 그대로 옮긴다', () => {
    // required rule이 없는 저장소에서도 실패한 check가 보여야 한다. 축은 그것을 판정하지 않는다(OD-032).
    const card = renderCard({
      pr: {
        ...basePr,
        mergePolicy: 'no_required_rules',
        checks: [
          ...basePr.checks,
          { kind: 'checkRun', id: 'CR_y', appId: null, startedAt: null, completedAt: null, name: 'test', status: 'IN_PROGRESS', conclusion: null, state: null },
          { kind: 'statusContext', id: 'SC_z', appId: null, startedAt: null, completedAt: null, name: 'deploy', status: '', conclusion: null, state: 'ERROR' },
          { kind: 'checkRun', id: 'CR_w', appId: null, startedAt: null, completedAt: null, name: '', status: 'COMPLETED', conclusion: 'NEW_STATE', state: null },
        ],
      },
      summary: okSummary,
    });
    expect(sectionTexts(card).find((text) => text.startsWith('*check*'))).toBe(
      '*check*\ntypecheck · 성공\ntest · 진행 중\ndeploy · 오류\n확인 불가 · 이름 없음 · NEW_STATE',
    );
  });

  it('check가 없으면 목록을 만들지 않고, 많으면 자른 수를 드러낸다', () => {
    const none = renderCard({ pr: { ...basePr, checks: [] }, summary: okSummary });
    expect(sectionTexts(none).some((text) => text.startsWith('*check*'))).toBe(false);
    const many = renderCard({
      pr: {
        ...basePr,
        checks: Array.from({ length: 12 }, (_, index) => ({
          ...basePr.checks[0]!, id: `CR_${index}`, name: `job ${index}`,
        })),
      },
      summary: okSummary,
    });
    const list = sectionTexts(many).find((text) => text.startsWith('*check*')) ?? '';
    expect(list.split('\n')).toHaveLength(12);
    expect(list).toContain('외 2개는 카드에 싣지 않았다');
  });

  it('mrkdwn 자리는 예약 문자를 이스케이프하고 머리는 plain_text로 둔다', () => {
    const card = renderCard({
      pr: { ...basePr, title: 'fix: <script> & </script>', project: '<b>&' },
      summary: failedSummary,
    });
    expect(card.text).toContain('fix: &lt;script&gt; &amp; &lt;/script&gt;');
    expect(fieldValue(card, 'Project')).toBe('&lt;b&gt;&amp;');
    // plain_text는 해석되지 않는다. 이스케이프하면 `&lt;`가 그대로 보인다.
    const header = card.blocks[0]!['text'] as Record<string, unknown>;
    expect(header['type']).toBe('plain_text');
    expect(header['text']).toBe('🟡  리뷰 결과 없음 · fix: <script> & </script>');
  });

  it('갱신 시각은 입력으로만 받고 KST로 적는다', () => {
    const stamped = renderCard({ pr: basePr, summary: okSummary }, '2026-10-01T05:23:05.000Z');
    expect(footerText(stamped)).toBe('orca-slack-bridge · 10-01 14:23:05 KST 갱신 · GitHub·Orca 기준');
    const blank = renderCard({ pr: basePr, summary: okSummary });
    expect(footerText(blank)).toBe('orca-slack-bridge · 갱신 · GitHub·Orca 기준');
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

    expect(fieldValue(bodyOnly, '관측 범위')).toBe('요약 입력 PR 본문 일부');
    expect(fieldValue(filesOnly, '관측 범위')).toBe('변경 파일 일부');
    // 두 flag를 하나로 합치면 두 카드가 같아지고 이 단언이 깨진다.
    expect(renderFingerprint(bodyOnly)).not.toBe(renderFingerprint(filesOnly));
  });

  it('review가 null이면 리뷰 판정이 없다는 것이 드러난다', () => {
    expect(basePr.review).toBeNull();
    const card = renderCard({ pr: basePr, summary: okSummary });
    expect(fieldValue(card, '리뷰')).toBe('결과 없음');
    // 판정이 있는 것처럼 보이는 칸이나 목록을 만들지 않는다.
    expect(sectionTexts(card).some((text) => text.startsWith('*finding*'))).toBe(false);
    expect(fieldValue(card, '위험도')).toBe('계산 불가 · 리뷰 결과 없음');
    expect(deriveDigestStatus(basePr)).toBe('awaiting_review');
    expect(headerText(card)).toContain(STATUS_TEXT_LABEL.awaiting_review);
  });

  it('headMatch unknown과 different가 서로 다른 문장을 낸다', () => {
    const card = (pr: ProjectedPr): RenderedCard => renderCard({ pr, summary: okSummary });
    const different = card(withReview('approve', 'different', 'old9999'));
    const unknown = card(withReview('approve', 'unknown', null));
    const same = card(withReview('approve', 'same', basePr.headSha));

    expect(fieldValue(different, '리뷰')).toBe('통과 · finding 없음 · 이전 커밋 기준');
    expect(fieldValue(unknown, '리뷰')).toBe('통과 · finding 없음 · 커밋 대조 불가');
    // same은 어느 쪽 문장도 만들지 않는다.
    expect(fieldValue(same, '리뷰')).toBe('통과 · finding 없음');

    // 세 값이 서로 다른 카드를 만든다. 하나로 뭉뚱그리면 깨진다.
    expect(new Set([different, unknown, same].map((c) => renderFingerprint(c))).size).toBe(3);

    // 사실 진술이지 approval 무효 판정이 아니다(OD-031, C2).
    for (const c of [different, unknown]) {
      for (const claim of ['무효', '만료', '다시 리뷰']) {
        expect(cardText(c)).not.toContain(claim);
      }
    }
  });

  it('모든 상태에서 identity가 칸과 대체 텍스트에, PR 링크가 버튼에 있다', () => {
    const seen = new Set<DigestStatus>();
    for (const pr of ALL_STATES) {
      for (const summary of [okSummary, failedSummary]) {
        const card = renderCard({ pr, summary });
        seen.add(deriveDigestStatus(pr));
        expect(fieldValue(card, '저장소')).toBe('dnhynk/dev-infra · #7');
        expect(card.text).toContain('[dev-infra] dnhynk/dev-infra #7');
        expect(buttonUrl(card)).toBe(PR_URL);
      }
    }
    // 다섯 상태를 전부 덮었다. 상태가 늘면 이 단언이 먼저 깨진다.
    expect(seen.size).toBe(5);
  });

  it('emoji와 색을 지워도 상태를 알 수 있다', () => {
    for (const pr of ALL_STATES) {
      const card = renderCard({ pr, summary: okSummary });
      const label = STATUS_TEXT_LABEL[deriveDigestStatus(pr)];
      expect(withoutEmoji(headerText(card))).toContain(label);
      expect(withoutEmoji(card.text)).toContain(label);
    }
  });

  it('closed 카드도 라벨·identity·링크를 모두 남긴다', () => {
    const card = renderCard({ pr: { ...basePr, terminal: 'closed' }, summary: failedSummary });
    expect(headerText(card)).toContain(STATUS_TEXT_LABEL.closed);
    expect(withoutEmoji(card.text)).toContain(STATUS_TEXT_LABEL.closed);
    expect(card.text).toContain('[dev-infra] dnhynk/dev-infra #7');
    expect(buttonUrl(card)).toBe(PR_URL);
  });

  it('mergePolicy 축을 카드가 표시한다', () => {
    // 축이 카드에 닿지 않으면 required rule 조인이 출력에 아무 효과가 없다(OD-032).
    const values: Readonly<Record<MergePolicy, string>> = {
      passing: '통과',
      pending: '진행 중',
      failing: '실패',
      missing: '미보고 · required check 누락',
      indeterminate: '판정 불가 · 보고 주체 미확인',
      no_required_rules: '지정 없음 · merge를 막지 않음',
      rules_unreadable: '확인 불가 · required 규칙 미판독',
    };
    for (const [mergePolicy, value] of Object.entries(values)) {
      const card = renderCard({
        pr: { ...basePr, mergePolicy: mergePolicy as MergePolicy },
        summary: okSummary,
      });
      expect(fieldValue(card, 'CI')).toBe(value);
    }
  });

  it('일곱 축 값이 서로 다른 카드를 만든다', () => {
    // 두 값을 같은 문구로 합치면 여기서 깨진다. 특히 missing↔indeterminate와
    // passing↔no_required_rules는 서로 다른 사실이다(OD-032, required-checks.ts).
    const all: readonly MergePolicy[] = [
      'passing',
      'pending',
      'failing',
      'missing',
      'indeterminate',
      'no_required_rules',
      'rules_unreadable',
    ];
    const fingerprints = all.map((mergePolicy) =>
      renderFingerprint(renderCard({ pr: { ...basePr, mergePolicy }, summary: okSummary })),
    );
    expect(new Set(fingerprints).size).toBe(all.length);
  });

  it('병합 준비 완료는 축이 passing일 때만 나오고 판정하지 않은 조건을 함께 밝힌다', () => {
    // §6은 Merge Ready를 required check만으로 판정하는 derived state로 정의했다(OD-032).
    // 그래서 완료는 나오되 같은 칸이 판정하지 않은 조건을 말해야 한다.
    const card = renderCard({ pr: { ...basePr, mergePolicy: 'passing' }, summary: okSummary });
    expect(fieldValue(card, '병합 준비')).toBe(
      '완료 · required check 기준 · 리뷰·merge queue·최신화 조건 미확인',
    );
    // 머리는 여전히 review 축이다. 축을 머리로 접지 않는다.
    expect(withoutEmoji(card.text)).toContain(STATUS_TEXT_LABEL.awaiting_review);
    expect(withoutEmoji(card.text)).not.toContain('병합 준비');
    expect(headerText(card)).not.toContain('병합 준비');
  });

  it('required rule이 0개면 CI 통과도 병합 준비 완료도 주장하지 않는다', () => {
    // §6의 병합 준비 완료는 "required checks가 모두 passing"이다. 0개는 그것이 아니고
    // 아무것도 돌지 않은 PR을 통과로 그리지 않는다.
    const card = renderCard({ pr: { ...basePr, mergePolicy: 'no_required_rules' }, summary: okSummary });
    expect(fieldValue(card, 'CI')).not.toContain('통과');
    expect(fieldValue(card, 'CI')).toContain('merge를 막지 않음');
    expect(fieldValue(card, '병합 준비')?.startsWith('미판정')).toBe(true);
    for (const claim of ['CI 통과', 'merge_ready', 'merge-ready', '병합 가능']) {
      expect(cardText(card)).not.toContain(claim);
    }
  });

  it('review_approved만으로는 병합 준비 완료를 주장하지 않는다', () => {
    const approved = withReview('approve', 'same', basePr.headSha);
    expect(deriveDigestStatus(approved)).toBe('review_approved');

    // 병합 준비 완료는 review 축이 아니라 required check 축에서만 나온다(OD-032).
    // 축이 passing이 아니면 approve여도, optional check가 실패해도 완료는 카드에 없다.
    const optionalFailure = {
      kind: 'checkRun' as const, id: 'CR_x', appId: null, startedAt: null, completedAt: null,
      name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', state: null,
    };
    const notPassing = [
      'pending', 'failing', 'missing', 'indeterminate', 'no_required_rules', 'rules_unreadable',
    ] as const;
    for (const mergePolicy of notPassing) {
      for (const pr of [
        { ...approved, mergePolicy },
        { ...approved, mergePolicy, checks: [optionalFailure] },
        { ...approved, mergePolicy, isDraft: true },
      ]) {
        const card = renderCard({ pr, summary: okSummary });
        expect(headerText(card)).toContain(STATUS_TEXT_LABEL.review_approved);
        expect(fieldValue(card, '병합 준비')?.startsWith('미판정')).toBe(true);
        for (const claim of ['merge_ready', 'merge-ready', '병합 가능', '병합해도']) {
          expect(cardText(card)).not.toContain(claim);
        }
      }
    }
  });

  it('draft PR은 저장소 칸에 초안이라고 적는다', () => {
    const card = renderCard({ pr: { ...basePr, isDraft: true }, summary: okSummary });
    expect(fieldValue(card, '저장소')).toBe('dnhynk/dev-infra · #7 · 초안');
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

  it('identity에 들어온 예약 문자도 fallback과 칸에서 이스케이프된다', () => {
    const card = renderCard({ pr: { ...basePr, project: '<!here>' }, summary: okSummary });
    expect(card.text).toContain('[&lt;!here&gt;]');
    expect(card.text).not.toContain('<!here>');
    expect(fieldValue(card, 'Project')).toBe('&lt;!here&gt;');
  });

  it('fallback과 mrkdwn 본문이 같은 이스케이프 결과를 쓴다', () => {
    const card = renderCard({
      pr: { ...basePr, workerReport: { outcome: 'succeeded', body: HOSTILE } },
      summary: failedSummary,
    });
    const escaped =
      'fix: &lt;@U012ABC&gt; &lt;!channel&gt; &amp; &lt;https://evil.example|GitHub&gt;';
    expect(sectionTexts(card)[0]).toBe(escaped);
    const titled = renderCard({ pr: { ...basePr, title: HOSTILE }, summary: failedSummary });
    expect(titled.text).toContain(escaped);
    // 대체 텍스트에는 예약 문자가 남지 않는다. URL도 싣지 않는다.
    expect(titled.text).not.toMatch(/[<>]/);
  });
});

describe('renderCard · Slack 상한', () => {
  /**
   * Slack section text는 최대 3000자, field는 2000자, header는 150자다. 넘기면 `invalid_blocks`로
   * 카드 **전체**가 거절돼 identity와 PR 링크까지 사라진다. 요약 문구도 PR 제목도 계약에 상한이
   * 없으므로 렌더 경계에서 막는다.
   */
  const LONG = 'ㄱ'.repeat(5000);
  const MARK = '표시 한도 3000자를 넘어 잘림';

  it('요약 what이 길어도 section은 3000자를 넘지 않고 잘렸다는 것이 보인다', () => {
    const card = renderCard({ pr: basePr, summary: { ...okSummary, draft: { ...okDraft, what: LONG } } });
    const texts = sectionTexts(card);
    expect(Math.max(...texts.map((t) => t.length))).toBe(3000);
    expect(texts[0]).toContain(MARK);
  });

  it('제목이 길어도 머리는 150자 안에서 말줄임표로 끝난다', () => {
    for (const input of [
      { pr: { ...basePr, title: LONG }, summary: failedSummary },
      { pr: basePr, summary: { ...okSummary, draft: { ...okDraft, title: LONG } } },
    ]) {
      const header = headerText(renderCard(input));
      expect(header.length).toBeLessThanOrEqual(150);
      expect(header.endsWith('…')).toBe(true);
    }
  });

  it('칸 값이 길어도 2000자를 넘지 않고 잘렸다는 것이 보인다', () => {
    const card = renderCard({ pr: { ...basePr, project: LONG }, summary: okSummary });
    const project = fieldValue(card, 'Project') ?? '';
    expect(`*Project*\n${project}`.length).toBe(2000);
    expect(project).toContain('표시 한도 2000자를 넘어 잘림');
  });

  it('worker 보고 본문은 카드를 삼키기 전에 자기 상한에서 잘린다', () => {
    // 계약은 세 문장이지만(contracts §3) 실제 worker는 지키지 않는다. 실측에서 한 건이 1,000자를
    // 넘어 카드 전체가 그 덤프가 됐다. section 상한(3000)까지 기다리면 카드 하나를 통째로 먹는다.
    const card = renderCard({
      pr: { ...basePr, workerReport: { outcome: 'succeeded', body: LONG } },
      summary: failedSummary,
    });
    const worker = sectionTexts(card)[0];
    expect(worker).toBeDefined();
    expect((worker as string).length).toBeLessThan(600);
    // 자른 사실은 드러낸다. 조용히 지우지 않는다.
    expect(worker as string).toContain('…');
  });

  it('상한 안이면 자르지도 표시를 붙이지도 않는다', () => {
    for (const input of Object.values(cases)) {
      const card = renderCard(input);
      expect(cardText(card)).not.toContain(MARK);
      for (const t of sectionTexts(card)) expect(t.length).toBeLessThan(3000);
    }
  });

  it('상한을 넘겨도 identity와 PR 링크는 남는다', () => {
    const card = renderCard({ pr: { ...basePr, title: LONG }, summary: failedSummary });
    expect(fieldValue(card, '저장소')).toBe('dnhynk/dev-infra · #7');
    expect(buttonUrl(card)).toBe(PR_URL);
  });

  it('이스케이프 뒤의 길이로 센다', () => {
    // `&`는 이스케이프하면 5자가 된다.
    const card = renderCard({
      pr: basePr,
      summary: { ...okSummary, draft: { ...okDraft, what: '&'.repeat(2000) } },
    });
    for (const t of sectionTexts(card)) expect(t.length).toBeLessThanOrEqual(3000);
    expect(sectionTexts(card)[0]).toContain(MARK);
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
   * 머리 앞머리(`🟡  리뷰 결과 없음 · `)와 본문 앞머리가 홀수·짝수 어느 쪽이든 자르는 지점이 emoji
   * 한가운데로 떨어질 수 있다. 앞머리 길이에 기대는 재현이므로 lone surrogate가 실제로 없는지를
   * 단언한다.
   */
  const EMOJI = '😀';
  /** high surrogate 짝이 없는 code unit이 있는가. */
  const hasLoneSurrogate = (value: string): boolean => {
    for (let i = 0; i < value.length; i += 1) {
      const c = value.charCodeAt(i);
      if (c >= 0xdc00 && c <= 0xdfff) return true;
      if (c < 0xd800 || c > 0xdbff) continue;
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : Number.NaN;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    }
    return false;
  };

  const titled = renderCard({ pr: { ...basePr, title: EMOJI.repeat(1600) }, summary: failedSummary });
  const summarized = renderCard({
    pr: basePr,
    summary: { ...okSummary, draft: { ...okDraft, what: `x${EMOJI.repeat(1600)}` } },
  });

  it('자른 머리와 section에 lone surrogate가 남지 않는다', () => {
    expect(headerText(titled).length).toBeGreaterThan(140);
    expect(hasLoneSurrogate(headerText(titled))).toBe(false);
    const texts = sectionTexts(summarized);
    expect(Math.max(...texts.map((t) => t.length))).toBeGreaterThan(2900);
    for (const t of texts) expect(hasLoneSurrogate(t)).toBe(false);
  });

  it('경계를 지키면서도 상한을 넘지 않는다', () => {
    expect(headerText(titled).length).toBeLessThanOrEqual(150);
    for (const t of sectionTexts(summarized)) expect(t.length).toBeLessThanOrEqual(3000);
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
      { ...basePr, mergePolicy: 'failing' },
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

  it('attachments가 없는 카드의 지문은 text와 blocks만 해싱한다', () => {
    const bare = { text: 'x', blocks: [{ type: 'divider' }] };
    const withEmpty = { ...bare, attachments: [] };
    expect(renderFingerprint(bare)).not.toBe(renderFingerprint(withEmpty));
    expect(renderFingerprint(bare)).toBe(renderFingerprint({ text: 'x', blocks: [{ type: 'divider' }] }));
  });
});
