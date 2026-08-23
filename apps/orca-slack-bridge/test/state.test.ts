import { describe, it, expect } from 'vitest';
import {
  deriveDigestStatus,
  deriveMergePolicy,
  deriveTerminal,
  reconcileTerminal,
} from '../src/digest/state.js';
import type { BranchRequiredRules } from '../src/github/branch-rules.js';
import {
  joinRequiredChecks,
  type RequiredCheckFact,
  type RequiredCheckState,
} from '../src/github/required-checks.js';
import type { CheckFact } from '../src/github/pull-request.js';
import type { MergePolicy, PrAxes, PrTerminal } from '../src/digest/types.js';

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
  mergePolicy: 'passing',
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

  it('mergePolicy 축을 headline으로 접지 않는다', () => {
    // 이 축은 required check 하나이고 required reviews·merge queue는 판정하지 않았다(OD-032).
    // 그래서 축이 어떤 값이어도 headline은 terminal·review 축만 따른다.
    const policies: readonly MergePolicy[] = [
      'passing',
      'pending',
      'failing',
      'missing',
      'indeterminate',
      'no_required_rules',
      'rules_unreadable',
    ];
    for (const mergePolicy of policies) {
      expect(deriveDigestStatus({ ...axes, mergePolicy })).toBe('awaiting_review');
      expect(deriveDigestStatus({ ...axes, mergePolicy, review: { verdict: 'approve' } })).toBe(
        'review_approved',
      );
    }
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
    expect(after.mergePolicy).toBe(before.mergePolicy);
  });
});

/**
 * required check 축(`mergePolicy`)의 집계.
 *
 * 조회도 조인도 여기서 검증하지 않는다. 그것은 `github-required-checks.test.ts`가 이미 고정했다.
 * 이 절이 고정하는 것은 **그 사실을 축 하나로 접는 규칙**이다.
 */
describe('deriveMergePolicy', () => {
  /**
   * 이 축이 "막지 않는다"고 말하는 값. 나머지는 전부 준비 완료가 아니다.
   *
   * 축 자체가 병합 가능 여부의 최종 답이 아니므로(OD-032) merge-ready가 아니라
   * "이 축이 막는가"로만 읽는다.
   */
  const NOT_BLOCKING: readonly MergePolicy[] = ['passing', 'no_required_rules'];

  function requiredFact(context: string, state: RequiredCheckState): RequiredCheckFact {
    return {
      context,
      sources: ['branchProtection'],
      appId: null,
      state,
      observed: null,
      unmatchedByApp: [],
      unattributed: [],
    };
  }

  /**
   * rule과 그 조인 결과를 함께 만든다.
   *
   * `deriveMergePolicy`는 둘을 함께 받으므로 fixture에서도 어긋나게 두지 않는다.
   * `requiredChecks`가 `rules.contexts`의 조인 결과라는 것이 그 함수의 전제다.
   */
  function joined(
    states: readonly RequiredCheckState[],
    over: Partial<BranchRequiredRules> = {},
  ): { rules: BranchRequiredRules; checks: readonly RequiredCheckFact[] } {
    const checks = states.map((state, i) => requiredFact(`ctx-${i}-${state}`, state));
    return {
      rules: {
        branch: 'main',
        contexts: checks.map((c) => ({ context: c.context, sources: c.sources, appId: c.appId })),
        branchProtection: 'present',
        repositoryRuleset: 'absent',
        ...over,
      },
      checks,
    };
  }

  function policy(
    states: readonly RequiredCheckState[],
    over: Partial<BranchRequiredRules> = {},
  ): MergePolicy {
    const { rules, checks } = joined(states, over);
    return deriveMergePolicy(rules, checks);
  }

  it('required 하나가 missing이면 준비 완료가 아니다', () => {
    // 실측에서 미보고 required가 있는 merge는 405였다(OD-032).
    expect(policy(['missing'])).toBe('missing');
    expect(NOT_BLOCKING).not.toContain(policy(['missing']));
    expect(policy(['passing', 'missing', 'passing'])).toBe('missing');
  });

  it('required 하나가 failing이면 준비 완료가 아니다', () => {
    expect(policy(['failing'])).toBe('failing');
    expect(NOT_BLOCKING).not.toContain(policy(['failing']));
    expect(policy(['passing', 'failing'])).toBe('failing');
  });

  it('required 하나가 pending이면 준비 완료가 아니다', () => {
    expect(policy(['pending'])).toBe('pending');
    expect(NOT_BLOCKING).not.toContain(policy(['pending']));
    expect(policy(['passing', 'pending'])).toBe('pending');
  });

  it('required 하나가 indeterminate면 준비 완료가 아니고 missing과도 구분된다', () => {
    // 보고 주체를 관측할 수 없어 충족도 불충족도 단정할 수 없는 상태다(required-checks.ts).
    // passing 쪽으로 접으면 실측된 false positive(PAT 동명 status, merge 405)를 통과로 그리고,
    // missing 쪽으로 접으면 Expected-App의 정상 보고를 미보고로 그린다.
    expect(policy(['indeterminate'])).toBe('indeterminate');
    expect(NOT_BLOCKING).not.toContain(policy(['indeterminate']));
    expect(policy(['indeterminate'])).not.toBe(policy(['missing']));
    expect(policy(['indeterminate'])).not.toBe(policy(['passing']));
    expect(policy(['passing', 'indeterminate'])).toBe('indeterminate');
  });

  it('전부 passing이면 이 축이 막지 않는다', () => {
    expect(policy(['passing'])).toBe('passing');
    expect(policy(['passing', 'passing', 'passing'])).toBe('passing');
    expect(NOT_BLOCKING).toContain(policy(['passing']));
  });

  it('required rule이 0개면 check 축이 막지 않고 passing과도 구분된다', () => {
    const none = policy([], { branchProtection: 'absent', repositoryRuleset: 'absent' });
    expect(none).toBe('no_required_rules');
    expect(NOT_BLOCKING).toContain(none);
    // required가 0개인 것과 required가 전부 통과한 것은 다른 사실이다.
    expect(none).not.toBe(policy(['passing']));
  });

  it('rule 조회 불가는 degraded이며 준비 완료가 아니다', () => {
    const overrides: readonly Partial<BranchRequiredRules>[] = [
      { branchProtection: 'forbidden' },
      { repositoryRuleset: 'forbidden' },
      { branchProtection: 'forbidden', repositoryRuleset: 'forbidden' },
    ];
    for (const over of overrides) {
      const p = policy([], over);
      expect(p).toBe('rules_unreadable');
      expect(NOT_BLOCKING).not.toContain(p);
      // 미설정과 다르다. 앞은 정상이고 이쪽은 rule 집합 자체를 모른다.
      expect(p).not.toBe(policy([], { branchProtection: 'absent', repositoryRuleset: 'absent' }));
    }
  });

  it('rule을 읽지 못했으면 관측된 context가 전부 통과해도 충족을 단정하지 않는다', () => {
    expect(policy(['passing', 'passing'], { repositoryRuleset: 'forbidden' })).toBe(
      'rules_unreadable',
    );
  });

  it('404(absent)를 조회 불가로 읽지 않는다', () => {
    // GitHub이 미보호와 권한 부족에 같은 404를 주므로 branch-rules.ts가 둘을 구분하지 않는다.
    // 없는 구분을 축에서 지어내지 않는다.
    expect(policy([], { branchProtection: 'absent', repositoryRuleset: 'absent' })).toBe(
      'no_required_rules',
    );
    expect(policy(['passing'], { branchProtection: 'absent' })).toBe('passing');
  });

  it('가장 무거운 상태 하나가 축이 된다', () => {
    expect(policy(['passing', 'pending', 'indeterminate', 'missing', 'failing'])).toBe('failing');
    expect(policy(['passing', 'pending', 'indeterminate', 'missing'])).toBe('missing');
    expect(policy(['passing', 'pending', 'indeterminate'])).toBe('indeterminate');
    expect(policy(['passing', 'pending'])).toBe('pending');
    // 입력 순서에 의존하지 않는다.
    expect(policy(['failing', 'passing'])).toBe(policy(['passing', 'failing']));
    expect(policy(['missing', 'indeterminate'])).toBe(policy(['indeterminate', 'missing']));
  });

  it('joinRequiredChecks의 실제 출력에 그대로 붙는다', () => {
    // 손으로 만든 fact가 아니라 조인이 실제로 내는 값으로 축을 확인한다.
    // optional failure는 rule에 없으므로 축에 닿지 않는다(OD-032, T1이 실제 merge 200으로 재현).
    const rules: BranchRequiredRules = {
      branch: 'main',
      contexts: [
        { context: 'classic-passing', sources: ['branchProtection'], appId: null },
        { context: 'ruleset-missing', sources: ['repositoryRuleset'], appId: null },
      ],
      branchProtection: 'present',
      repositoryRuleset: 'present',
    };
    const rows: readonly CheckFact[] = [
      {
        kind: 'statusContext', id: 'SC_1', name: 'classic-passing', status: '',
        conclusion: null, state: 'SUCCESS', appId: null, startedAt: null, completedAt: null,
      },
      {
        kind: 'checkRun', id: 'CR_1', name: 'optional-lint', status: 'COMPLETED',
        conclusion: 'FAILURE', state: null, appId: null, startedAt: null, completedAt: null,
      },
    ];
    const facts = joinRequiredChecks(rules, rows);
    expect(facts.map((f) => f.state)).toEqual(['passing', 'missing']);
    expect(deriveMergePolicy(rules, facts)).toBe('missing');
  });

  it('app-bound rule의 unattributed row는 indeterminate로 축에 남는다', () => {
    // 이름은 같지만 보고 주체를 관측할 수 없는 row다. missing으로도 passing으로도 접지 않는다.
    const rules: BranchRequiredRules = {
      branch: 'main',
      contexts: [{ context: 'classic-appbound', sources: ['branchProtection'], appId: 15368 }],
      branchProtection: 'present',
      repositoryRuleset: 'absent',
    };
    const rows: readonly CheckFact[] = [
      {
        kind: 'statusContext', id: 'SC_2', name: 'classic-appbound', status: '',
        conclusion: null, state: 'SUCCESS', appId: null, startedAt: null, completedAt: null,
      },
    ];
    const facts = joinRequiredChecks(rules, rows);
    expect(facts[0]?.state).toBe('indeterminate');
    expect(deriveMergePolicy(rules, facts)).toBe('indeterminate');
  });
});
