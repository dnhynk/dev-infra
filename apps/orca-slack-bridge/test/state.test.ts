import { describe, it, expect } from 'vitest';
import {
  deriveDigestStatus,
  deriveTerminal,
  reconcileTerminal,
} from '../src/digest/state.js';
import type { CheckFact } from '../src/github/pull-request.js';
import type { PrAxes, PrTerminal } from '../src/digest/types.js';

const MERGED_AT = '2026-08-23T05:10:18Z';

/** check row 하나. 이 파일은 축 판정만 보므로 조인용 필드는 비워 둔다. */
function check(name: string, conclusion: string): CheckFact {
  return {
    kind: 'checkRun',
    id: `CR_${name}_${conclusion}`,
    name,
    status: 'COMPLETED',
    conclusion,
    state: null,
    appId: null,
    startedAt: null,
    completedAt: null,
  };
}

const axes: PrAxes = {
  terminal: 'open',
  isDraft: false,
  review: null,
  checks: [check('required-ci', 'SUCCESS')],
  mergePolicy: 'unobserved',
};

describe('deriveTerminal', () => {
  it('gh state 세 값을 옮긴다', () => {
    expect(deriveTerminal('OPEN', null)).toBe('open');
    expect(deriveTerminal('CLOSED', null)).toBe('closed');
    expect(deriveTerminal('MERGED', null)).toBe('merged');
  });

  it('대소문자를 가리지 않는다', () => {
    expect(deriveTerminal('open', null)).toBe('open');
  });

  it('모르는 state를 open으로 떨어뜨리지 않는다', () => {
    expect(() => deriveTerminal('DRAFTED', null)).toThrow(/PR state/);
    expect(() => deriveTerminal('', null)).toThrow(/PR state/);
  });

  it('mergedAt latch가 state 문자열을 이긴다 (OD-030)', () => {
    // 한 응답이 서로 다른 계산 시점의 필드를 섞는 것을 실측했다(§OD-044).
    // latch가 있으면 state가 무엇이든 merged다.
    expect(deriveTerminal('OPEN', MERGED_AT)).toBe('merged');
    expect(deriveTerminal('CLOSED', MERGED_AT)).toBe('merged');
    expect(deriveTerminal('DRAFTED', MERGED_AT)).toBe('merged');
  });

  it('closed-unmerged는 mergedAt이 없다', () => {
    expect(deriveTerminal('CLOSED', null)).toBe('closed');
  });
});

describe('reconcileTerminal · terminal dominance (OD-044)', () => {
  it('merged latch가 이후 관측의 open/closed에 덮이지 않는다', () => {
    expect(reconcileTerminal('merged', 'open')).toBe('merged');
    expect(reconcileTerminal('merged', 'closed')).toBe('merged');
    expect(reconcileTerminal('merged', 'merged')).toBe('merged');
  });

  it('closed → reopen이 가능하다', () => {
    expect(reconcileTerminal('closed', 'open')).toBe('open');
  });

  it('open은 closed와 merged로 갈 수 있다', () => {
    expect(reconcileTerminal('open', 'closed')).toBe('closed');
    expect(reconcileTerminal('open', 'merged')).toBe('merged');
  });

  it('이전 관측이 없으면 새 관측이 그대로 결과다', () => {
    expect(reconcileTerminal(null, 'open')).toBe('open');
    expect(reconcileTerminal(null, 'closed')).toBe('closed');
    expect(reconcileTerminal(null, 'merged')).toBe('merged');
  });

  it('merged 이후로는 어떤 관측 순서에도 merged로 남는다', () => {
    const observations: readonly PrTerminal[] = ['open', 'closed', 'open', 'closed'];
    let terminal: PrTerminal | null = deriveTerminal('MERGED', MERGED_AT);
    for (const observed of observations) {
      terminal = reconcileTerminal(terminal, observed);
    }
    expect(terminal).toBe('merged');
  });

  it('merged가 아닌 이전 상태는 선형 rank를 만들지 않는다', () => {
    // 전체 상태를 하나의 rank로 두어 closed > open으로 만드는 선택지는 reopen을 막으므로
    // OD-044가 기각했다. open ↔ closed는 양방향으로 지나간다.
    expect(reconcileTerminal('open', 'closed')).toBe('closed');
    expect(reconcileTerminal('closed', 'open')).toBe('open');
  });
});

describe('deriveDigestStatus', () => {
  it('reviewer_result가 없으면 awaiting_review다', () => {
    expect(deriveDigestStatus(axes)).toBe('awaiting_review');
  });

  it('verdict를 그대로 옮긴다', () => {
    expect(deriveDigestStatus({ ...axes, review: { verdict: 'approve' } })).toBe('review_approved');
    expect(deriveDigestStatus({ ...axes, review: { verdict: 'request_changes' } })).toBe(
      'changes_requested',
    );
  });

  it('terminal이 review 축보다 앞선다', () => {
    const reviewed = { ...axes, review: { verdict: 'approve' } } as const;
    expect(deriveDigestStatus({ ...reviewed, terminal: 'merged' })).toBe('merged');
    expect(deriveDigestStatus({ ...reviewed, terminal: 'closed' })).toBe('closed');
  });

  it('mergePolicy가 unobserved인 동안 merge-ready 계열 값을 만들지 않는다', () => {
    // required rule 조인은 C2-2다(OD-032). check가 전부 통과해도 headline은 review 축을 따른다.
    const passing = [check('required-ci', 'SUCCESS')];
    expect(deriveDigestStatus({ ...axes, checks: passing })).toBe('awaiting_review');
  });
});

describe('직교성 · draft·review·checks가 서로를 가리지 않는다', () => {
  const review = { verdict: 'request_changes' } as const;
  const failing = [check('required-ci', 'FAILURE')];

  it('draft가 review 축을 가리지 않는다', () => {
    const drafted: PrAxes = { ...axes, isDraft: true, review };
    expect(deriveDigestStatus(drafted)).toBe('changes_requested');
    // 축은 그대로 남는다. headline이 draft를 삼키지도 않는다.
    expect(drafted.isDraft).toBe(true);
    expect(drafted.review).toEqual(review);
  });

  it('checks가 review 축을 가리지 않는다', () => {
    const failed: PrAxes = { ...axes, checks: failing, review };
    expect(deriveDigestStatus(failed)).toBe('changes_requested');
    expect(failed.checks).toEqual(failing);
  });

  it('review가 draft·checks 축을 가리지 않는다', () => {
    const approved: PrAxes = { ...axes, isDraft: true, checks: failing, review: { verdict: 'approve' } };
    expect(deriveDigestStatus(approved)).toBe('review_approved');
    expect(approved.isDraft).toBe(true);
    expect(approved.checks).toEqual(failing);
  });

  it('draft와 checks는 headline을 바꾸지 않는다', () => {
    for (const isDraft of [false, true]) {
      for (const checks of [[], failing, axes.checks]) {
        expect(deriveDigestStatus({ ...axes, isDraft, checks, review })).toBe('changes_requested');
        expect(deriveDigestStatus({ ...axes, isDraft, checks })).toBe('awaiting_review');
      }
    }
  });

  it('terminal이 움직여도 나머지 세 축은 그대로다', () => {
    const before: PrAxes = { ...axes, isDraft: true, checks: failing, review };
    const after: PrAxes = { ...before, terminal: 'merged' };
    expect(deriveDigestStatus(after)).toBe('merged');
    expect(after.isDraft).toBe(before.isDraft);
    expect(after.checks).toEqual(before.checks);
    expect(after.review).toEqual(before.review);
    expect(after.mergePolicy).toBe('unobserved');
  });
});
