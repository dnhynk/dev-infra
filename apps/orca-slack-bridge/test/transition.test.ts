import { describe, it, expect } from 'vitest';
import type { BranchRequiredRules } from '../src/github/branch-rules.js';
import type { CheckFact } from '../src/github/pull-request.js';
import { renderThreadEvent } from '../src/digest/render.js';
import { reconcileChecks, reconcileObservation } from '../src/digest/transition.js';
import type { ProjectedPr } from '../src/digest/types.js';
import { pullRequestKey, runKey, taskKey } from '../src/identity/keys.js';
import { repositoryIdentity } from '../src/identity/repository.js';
import type { PrStateSnapshot } from '../src/store/schema.js';

/**
 * 관측 사이의 변화(OD-044, OD-046).
 *
 * 이 파일은 순수 함수만 본다. store를 읽고 thread에 게시하는 배선은 `digest.test.ts`가 실제
 * sqlite 파일과 대역으로 검증한다.
 */

const REPO_ID = 42;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

const basePr: ProjectedPr = {
  key: pullRequestKey(REPO_ID, 7),
  repository: repositoryIdentity(REPO_ID, 'dnhynk/dev-infra'),
  project: 'dev-infra',
  correlation: {
    kind: 'correlated',
    run: runKey('run_36d28e6e947a'),
    task: taskKey('task_f830a2feefd5'),
    dispatch: null,
  },
  number: 7,
  title: 'feat(c2): 전이 판정',
  url: 'https://github.com/dnhynk/dev-infra/pull/7',
  headSha: HEAD_A,
  checksHeadSha: HEAD_A,
  terminal: 'open',
  isDraft: false,
  review: null,
  checks: [],
  mergePolicy: 'no_required_rules',
  workerReport: null,
  truncation: { prBody: false, changedFiles: false },
};

/** required rule이 하나도 없는 base branch. dev-infra 실측과 같은 모양이다. */
const NO_RULES: BranchRequiredRules = {
  branch: 'main',
  contexts: [],
  branchProtection: 'absent',
  repositoryRuleset: 'absent',
};

/** `build` 하나를 요구하는 base branch. app 바인딩은 없다. */
const BUILD_REQUIRED: BranchRequiredRules = {
  branch: 'main',
  contexts: [{ context: 'build', sources: ['branchProtection'], appId: null }],
  branchProtection: 'present',
  repositoryRuleset: 'absent',
};

function check(over: Partial<CheckFact> = {}): CheckFact {
  return {
    kind: 'checkRun',
    id: 'CR_build',
    name: 'build',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    state: null,
    appId: null,
    startedAt: '2026-08-23T01:00:00Z',
    completedAt: '2026-08-23T01:05:00Z',
    ...over,
  };
}

/** 진행 중인 같은 resource. 완료 row와 id가 같고 `completedAt`만 없다. */
const RUNNING = check({ status: 'IN_PROGRESS', conclusion: null, completedAt: null });
const DONE = check();

function snapshot(over: Partial<PrStateSnapshot> = {}): PrStateSnapshot {
  return {
    terminal: 'open',
    mergedAt: null,
    reviewVerdict: null,
    reviewedHeadSha: null,
    headSha: HEAD_A,
    checksHeadSha: HEAD_A,
    checks: [],
    ...over,
  };
}

function keys(r: { readonly candidates: readonly { readonly dedupeKey: string }[] }): string[] {
  return r.candidates.map((c) => c.dedupeKey);
}

describe('terminal dominance', () => {
  // 이 Task가 닫는 미배선이다. `reconcileTerminal`은 C2-1이 만들었고 호출자가 없었다.
  it('merged 뒤에 도착한 open snapshot이 merged를 되돌리지 않는다', () => {
    const previous = snapshot({ terminal: 'merged', mergedAt: '2026-08-23T02:00:00Z' });
    const result = reconcileObservation(previous, { ...basePr, terminal: 'open' }, NO_RULES, null);
    expect(result.pr.terminal).toBe('merged');
    expect(result.state.terminal).toBe('merged');
  });

  it('merged 뒤에 도착한 closed snapshot도 merged를 되돌리지 않는다', () => {
    const previous = snapshot({ terminal: 'merged', mergedAt: '2026-08-23T02:00:00Z' });
    const observed = { ...basePr, terminal: 'closed' as const };
    const result = reconcileObservation(previous, observed, NO_RULES, null);
    expect(result.pr.terminal).toBe('merged');
  });

  // merged latch의 occurred time도 내려가지 않는다. 오래된 snapshot의 mergedAt은 null이다.
  it('오래된 snapshot의 mergedAt: null이 저장된 발생 시각을 지우지 않는다', () => {
    const previous = snapshot({ terminal: 'merged', mergedAt: '2026-08-23T02:00:00Z' });
    const result = reconcileObservation(previous, { ...basePr, terminal: 'open' }, NO_RULES, null);
    expect(result.state.mergedAt).toBe('2026-08-23T02:00:00Z');
  });

  // 전체 상태를 하나의 선형 rank로 두어 closed > open으로 만드는 선택지는 OD-044가 기각했다.
  it('closed는 latch가 아니라 open이 지나간다', () => {
    const previous = snapshot({ terminal: 'closed' });
    const result = reconcileObservation(previous, { ...basePr, terminal: 'open' }, NO_RULES, null);
    expect(result.pr.terminal).toBe('open');
  });

  it('이전 상태가 없으면 관측이 그대로 결과다', () => {
    const result = reconcileObservation(null, { ...basePr, terminal: 'merged' }, NO_RULES, 'T');
    expect(result.pr.terminal).toBe('merged');
    expect(result.state.mergedAt).toBe('T');
  });
});

describe('reconcileChecks', () => {
  // OD-044: 동일 head 안의 check는 각 resource의 timestamp와 id로 reconcile한다.
  it('완료 뒤에 도착한 진행 snapshot이 완료를 되돌리지 않는다', () => {
    expect(reconcileChecks([DONE], [RUNNING])).toEqual([DONE]);
  });

  it('진행 뒤에 도착한 완료 snapshot은 진행을 대체한다', () => {
    expect(reconcileChecks([RUNNING], [DONE])).toEqual([DONE]);
  });

  it('같은 단계면 나중 완료 시각이 이긴다', () => {
    const later = check({ conclusion: 'FAILURE', completedAt: '2026-08-23T01:09:00Z' });
    expect(reconcileChecks([DONE], [later])).toEqual([later]);
    expect(reconcileChecks([later], [DONE])).toEqual([later]);
  });

  // 같은 resource의 같은 단계이므로 되돌아갈 것이 없다. 방금 읽은 값이 더 최신이다.
  it('같은 단계에 같은 시각이면 이번 관측을 쓴다', () => {
    const other = check({ conclusion: 'NEUTRAL' });
    expect(reconcileChecks([DONE], [other])).toEqual([other]);
  });

  // 합집합이다. 완료된 row가 통째로 빠진 snapshot이 뒤늦게 와도 그 사실을 잃지 않는다.
  it('이번 관측에 없는 row도 남긴다', () => {
    const other = check({ id: 'CR_lint', name: 'lint' });
    expect(reconcileChecks([DONE, other], [DONE])).toEqual([DONE, other]);
  });

  it('이번 관측에만 있는 row는 그대로 들어온다', () => {
    const other = check({ id: 'CR_lint', name: 'lint' });
    expect(reconcileChecks([DONE], [DONE, other])).toEqual([DONE, other]);
  });

  // id가 없으면 같은 resource인지 확정할 근거가 없다(`github/rollup.ts`).
  it('id가 빈 이전 row는 버리고 이번 관측 것만 싣는다', () => {
    const stale = check({ id: '', kind: 'unknown', name: '' });
    const fresh = check({ id: '', kind: 'unknown', name: '' });
    expect(reconcileChecks([stale], [fresh])).toEqual([fresh]);
  });

  it('순서를 이름과 id로 고정한다', () => {
    const a = check({ id: 'CR_a', name: 'alpha' });
    const z = check({ id: 'CR_z', name: 'zulu' });
    expect(reconcileChecks([z], [a]).map((c) => c.name)).toEqual(['alpha', 'zulu']);
    expect(reconcileChecks([a], [z]).map((c) => c.name)).toEqual(['alpha', 'zulu']);
  });
});

describe('reconcileObservation의 check scope', () => {
  // 이것이 "완료가 유지된다"가 실제 카드에 닿는 경로다. 축을 직접 합치지 않고 reconcile된
  // check로 deriveMergePolicy를 다시 부른다.
  it('같은 head면 완료 뒤 진행 snapshot이 와도 축이 passing에 남는다', () => {
    const previous = snapshot({ checks: [DONE] });
    const observed = { ...basePr, checks: [RUNNING], mergePolicy: 'pending' as const };
    const result = reconcileObservation(previous, observed, BUILD_REQUIRED, null);
    expect(result.pr.mergePolicy).toBe('passing');
    expect(result.pr.checks).toEqual([DONE]);
  });

  // head가 다르면 두 관측은 서로 다른 commit의 사실이다. 어느 쪽이 나중인지 SHA로 알 수 없다.
  it('head가 다르면 합치지 않고 이번 관측이 그대로 결과다', () => {
    const previous = snapshot({ checksHeadSha: HEAD_B, checks: [DONE] });
    const observed = { ...basePr, checks: [RUNNING], mergePolicy: 'pending' as const };
    const result = reconcileObservation(previous, observed, BUILD_REQUIRED, null);
    expect(result.pr.mergePolicy).toBe('pending');
    expect(result.pr.checks).toEqual([RUNNING]);
  });

  it('이전 상태가 없으면 이번 관측이 그대로 결과다', () => {
    const observed = { ...basePr, checks: [RUNNING] };
    const result = reconcileObservation(null, observed, BUILD_REQUIRED, null);
    expect(result.pr.checks).toEqual([RUNNING]);
    expect(result.pr.mergePolicy).toBe('pending');
  });
});

describe('전이 후보', () => {
  it('review도 required rule도 없고 open이면 후보가 없다', () => {
    expect(keys(reconcileObservation(null, basePr, NO_RULES, null))).toEqual([]);
  });

  it('merged는 scope 없는 key 하나다', () => {
    const r = reconcileObservation(null, { ...basePr, terminal: 'merged' }, NO_RULES, 'T');
    expect(keys(r)).toEqual(['terminal:merged']);
    expect(r.candidates[0]?.kind).toBe('merged');
    // 발생 시각은 latch가 싣고 있는 값이다. 관측 시각으로 대신하지 않는다.
    expect(r.candidates[0]?.occurredAt).toBe('T');
  });

  it('review key의 scope는 reviewer가 본 commit이다', () => {
    const review = {
      verdict: 'approve' as const,
      reviewedHeadSha: HEAD_B,
      headMatch: 'different' as const,
      findings: [],
      findingsTotal: 0,
    };
    const r = reconcileObservation(null, { ...basePr, review }, NO_RULES, null);
    expect(keys(r)).toEqual([`review:approve@${HEAD_B}`]);
    expect(r.candidates[0]?.kind).toBe('review_approved');
  });

  it('reviewedHeadSha가 없으면 scope를 지어내지 않고 unknown으로 남긴다', () => {
    const review = {
      verdict: 'request_changes' as const,
      reviewedHeadSha: null,
      headMatch: 'unknown' as const,
      findings: [],
      findingsTotal: 2,
    };
    const r = reconcileObservation(null, { ...basePr, review }, NO_RULES, null);
    expect(keys(r)).toEqual(['review:request_changes@unknown']);
    expect(r.candidates[0]?.kind).toBe('review_changes_requested');
  });

  it('check 축 key의 scope는 checks를 매단 commit이다', () => {
    const observed = { ...basePr, checks: [DONE] };
    const r = reconcileObservation(null, observed, BUILD_REQUIRED, null);
    expect(keys(r)).toEqual([`mergePolicy:passing@${HEAD_A}`]);
    // 축이 참이 된 시각은 마지막 required가 끝난 시각이다.
    expect(r.candidates[0]?.occurredAt).toBe('2026-08-23T01:05:00.000Z');
  });

  it('failing은 첫 required 실패가 난 시각을 싣는다', () => {
    const failed = check({ conclusion: 'FAILURE' });
    const r = reconcileObservation(null, { ...basePr, checks: [failed] }, BUILD_REQUIRED, null);
    expect(keys(r)).toEqual([`mergePolicy:failing@${HEAD_A}`]);
    expect(r.candidates[0]?.occurredAt).toBe('2026-08-23T01:05:00.000Z');
  });

  it('시각을 만들 수 없는 row가 있으면 발생 시각은 null이다', () => {
    const noTime = check({ startedAt: null, completedAt: null });
    const r = reconcileObservation(null, { ...basePr, checks: [noTime] }, BUILD_REQUIRED, null);
    expect(r.candidates[0]?.occurredAt).toBeNull();
  });

  // 축의 다섯 값 중 둘만 전이다. 나머지는 결론이 아니거나 판정 근거의 상태다.
  it.each(['pending', 'missing', 'indeterminate', 'no_required_rules', 'rules_unreadable'] as const)(
    'mergePolicy가 %s면 후보가 아니다',
    (policy) => {
      // 조인 결과를 그 값으로 만드는 대신 축 자체를 확인한다. 파생 규칙은 state.ts의 계약이다.
      // `indeterminate`는 app 바인딩이 있는 rule과 보고 주체를 관측하지 못한 row에서만 나온다.
      const rules: BranchRequiredRules =
        policy === 'no_required_rules'
          ? NO_RULES
          : policy === 'rules_unreadable'
            ? { ...BUILD_REQUIRED, branchProtection: 'forbidden' }
            : policy === 'indeterminate'
              ? {
                  ...BUILD_REQUIRED,
                  contexts: [{ context: 'build', sources: ['branchProtection'], appId: 15368 }],
                }
              : BUILD_REQUIRED;
      const checks =
        policy === 'pending'
          ? [RUNNING]
          : policy === 'indeterminate'
            ? [check({ appId: null })]
            : [];
      const r = reconcileObservation(null, { ...basePr, checks }, rules, null);
      expect(keys(r).filter((k) => k.startsWith('mergePolicy:'))).toEqual([]);
    },
  );

  // 순서가 흔들리면 같은 사실이 실행마다 다른 thread를 만든다.
  it('여러 후보의 순서를 고정한다: review → check → merged', () => {
    const review = {
      verdict: 'approve' as const,
      reviewedHeadSha: HEAD_A,
      headMatch: 'same' as const,
      findings: [],
      findingsTotal: 0,
    };
    const observed = { ...basePr, review, checks: [DONE], terminal: 'merged' as const };
    const r = reconcileObservation(null, observed, BUILD_REQUIRED, 'T');
    expect(keys(r)).toEqual([
      `review:approve@${HEAD_A}`,
      `mergePolicy:passing@${HEAD_A}`,
      'terminal:merged',
    ]);
  });

  // 후보는 diff가 아니라 지금 참인 사실에서 나온다. 같은 사실을 다시 관측하면 같은 key다.
  it('같은 사실을 다시 reconcile하면 같은 key가 나온다', () => {
    const observed = { ...basePr, terminal: 'merged' as const, checks: [DONE] };
    const first = reconcileObservation(null, observed, BUILD_REQUIRED, 'T');
    const second = reconcileObservation(first.state, observed, BUILD_REQUIRED, 'T');
    expect(keys(second)).toEqual(keys(first));
  });
});

describe('renderThreadEvent', () => {
  const observedAt = '2026-08-23T03:00:00.000Z';

  function text(pr: ProjectedPr, kind: Parameters<typeof renderThreadEvent>[0]['transition']) {
    return renderThreadEvent({ pr, transition: kind, observedAt });
  }

  it('발생 시각이 있으면 관측 시각과 함께 적는다', () => {
    const out = text(basePr, {
      kind: 'merged',
      dedupeKey: 'terminal:merged',
      occurredAt: '2026-08-23T02:00:00Z',
    });
    const body = JSON.stringify(out.blocks);
    expect(body).toContain('병합 완료');
    expect(body).toContain('발생 2026-08-23T02:00:00Z');
    expect(body).toContain(`관측 ${observedAt}`);
  });

  // 관측 시각을 발생 시각인 척하지 않는다(UX §5의 occurred/observed).
  it('발생 시각이 없으면 없다고 말한다', () => {
    const out = text(basePr, {
      kind: 'review_approved',
      dedupeKey: `review:approve@${HEAD_A}`,
      occurredAt: null,
    });
    const body = JSON.stringify(out.blocks);
    expect(body).toContain('발생 시각이 실려 있지 않다');
    expect(body).not.toContain('발생 2026');
  });

  it('changes requested는 finding 수를 함께 적는다', () => {
    const review = {
      verdict: 'request_changes' as const,
      reviewedHeadSha: HEAD_A,
      headMatch: 'same' as const,
      findings: [],
      findingsTotal: 3,
    };
    const out = text(
      { ...basePr, review },
      { kind: 'review_changes_requested', dedupeKey: 'x', occurredAt: null },
    );
    expect(JSON.stringify(out.blocks)).toContain('보고된 finding 3건');
  });

  // required check 축은 merge 가능 여부의 최종 답이 아니다(OD-032). 카드와 같은 단서를 단다.
  it('passing 문구가 판정하지 않은 조건을 함께 밝힌다', () => {
    const out = text(basePr, { kind: 'checks_passing', dedupeKey: 'x', occurredAt: null });
    expect(JSON.stringify(out.blocks)).toContain('merge queue');
  });

  // 알림 자리에는 thread 맥락이 없다. identity가 없으면 어느 PR인지 알 수 없다.
  it('fallback text에 identity와 상태 라벨이 남는다', () => {
    const out = text(basePr, { kind: 'merged', dedupeKey: 'x', occurredAt: null });
    expect(out.text).toContain('[dev-infra] dnhynk/dev-infra #7');
    expect(out.text).toContain('병합 완료');
  });

  // 카드와 같은 이스케이프를 쓴다. PR 제목은 untrusted input이다(스펙 §10).
  it('identity를 이스케이프한다', () => {
    const pr = { ...basePr, project: '<!channel>' };
    const out = text(pr, { kind: 'merged', dedupeKey: 'x', occurredAt: null });
    expect(out.text).toContain('&lt;!channel&gt;');
    expect(out.text).not.toContain('<!channel>');
  });

  it('같은 입력이면 같은 출력이다', () => {
    const t = { kind: 'merged' as const, dedupeKey: 'x', occurredAt: null };
    expect(text(basePr, t)).toEqual(text(basePr, t));
  });
});
