import { describe, expect, it } from 'vitest';
import { fetchBranchRequiredRules, type BranchRequiredRules } from '../src/github/branch-rules.js';
import { checkState, joinRequiredChecks } from '../src/github/required-checks.js';
import type { CheckFact } from '../src/github/rollup.js';
import { GhCommandError, type GhRunner } from '../src/github/runner.js';
import { repositoryIdentity } from '../src/identity/repository.js';

const REPO = repositoryIdentity(1343880863, 'dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b');

/**
 * 2026-08-23 `dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b`에서 그대로 복사한 응답이다.
 *
 * classic protection에는 `classic-passing`/`classic-failing`을, ruleset에는
 * `ruleset-pending`/`ruleset-missing`을 넣고 PR #1의 head에 commit status 3개만 만들었다.
 * `ruleset-missing`은 한 번도 보고되지 않아 rollup에 row가 없다.
 */
const PROTECTION_JSON = JSON.stringify({
  url: 'https://api.github.com/repos/dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b/branches/main/protection/required_status_checks',
  strict: false,
  contexts: ['classic-passing', 'classic-failing'],
  checks: [
    { context: 'classic-passing', app_id: null },
    { context: 'classic-failing', app_id: null },
  ],
});

/**
 * 2026-08-23 `dnhynk/THROWAWAY-orca-c2-appbind-c6ddffc0`에서 그대로 복사한 응답이다.
 *
 * `app_id: -1`로 쓴 `classic-explicit-any`는 읽을 때 `null`로 돌아왔다.
 */
const APPBOUND_PROTECTION_JSON = JSON.stringify({
  strict: false,
  contexts: ['classic-anyapp', 'classic-appbound', 'classic-explicit-any'],
  checks: [
    { context: 'classic-anyapp', app_id: null },
    { context: 'classic-appbound', app_id: 15368 },
    { context: 'classic-explicit-any', app_id: null },
  ],
});

/** 같은 repository의 `rules/branches/main`. 두 ruleset이 각각 rule 하나씩을 냈다. */
const APPBOUND_RULES_JSON = JSON.stringify([
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [
        { context: 'ruleset-anyapp' },
        { context: 'ruleset-appbound', integration_id: 15368 },
      ],
    },
    ruleset_source_type: 'Repository',
    ruleset_source: 'dnhynk/THROWAWAY-orca-c2-appbind-c6ddffc0',
    ruleset_id: 21234549,
  },
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: 'ruleset-page2' }],
    },
    ruleset_source_type: 'Repository',
    ruleset_source: 'dnhynk/THROWAWAY-orca-c2-appbind-c6ddffc0',
    ruleset_id: 21234552,
  },
]);

const RULES_JSON = JSON.stringify([
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: 'ruleset-pending' }, { context: 'ruleset-missing' }],
    },
    ruleset_source_type: 'Repository',
    ruleset_source: 'dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b',
    ruleset_id: 21233618,
  },
]);

/** 같은 PR head의 rollup. 세 row 모두 commit status이며 app을 식별할 field가 없어 appId는 null이다. */
const ROLLUP: readonly CheckFact[] = [
  statusAt('SC_kwDOUBdGbs8AAAAMR1EFj1', 'classic-failing', 'FAILURE', '2026-08-23T10:59:41Z'),
  statusAt('SC_kwDOUBdGbs8AAAAMR1EFj2', 'ruleset-pending', 'PENDING', '2026-08-23T10:59:42Z'),
  statusAt('SC_kwDOUBdGbs8AAAAMR1EFj3', 'classic-passing', 'SUCCESS', '2026-08-23T10:59:41Z'),
];

function statusRow(name: string, state: string): CheckFact {
  return statusAt(`SC_${name}_${state}`, name, state, '2026-08-23T10:59:41Z');
}

function statusAt(id: string, name: string, state: string, createdAt: string): CheckFact {
  return {
    kind: 'statusContext', id, name, status: '', conclusion: null, state,
    appId: null, startedAt: createdAt, completedAt: null,
  };
}

function checkRunRow(name: string, conclusion: string | null, appId: number | null): CheckFact {
  return {
    kind: 'checkRun', id: `CR_${name}_${appId ?? 'any'}`, name,
    status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED', conclusion, state: null,
    appId, startedAt: '2026-08-23T11:40:51Z', completedAt: conclusion === null ? null : '2026-08-23T11:41:00Z',
  };
}

type Reply = string | GhCommandError;

class FakeGh implements GhRunner {
  readonly calls: string[][] = [];
  constructor(private readonly replies: { protection: Reply; rules: Reply }) {}
  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const path = args.join(' ');
    const reply = path.includes('/protection/required_status_checks')
      ? this.replies.protection
      : path.includes('/rules/branches/')
        ? this.replies.rules
        : null;
    if (reply === null) throw new Error('예상치 못한 gh 호출: ' + args.join(' '));
    if (reply instanceof GhCommandError) throw reply;
    return reply;
  }
}

function notFound(message: string): GhCommandError {
  return new GhCommandError(['api'], 1, `gh: ${message} (HTTP 404)`);
}

describe('fetchBranchRequiredRules', () => {
  it('reads explicit REST pages and keeps required rules from the final short page', async () => {
    const ruleCalls: string[][] = [];
    const gh: GhRunner = {
      run: async (args) => {
        const joined = args.join(' ');
        if (joined.includes('/protection/required_status_checks')) {
          throw notFound('Branch not protected');
        }
        ruleCalls.push([...args]);
        if (args[1]?.endsWith('page=1') === true) {
          return JSON.stringify(Array.from({ length: 100 }, () => ({ type: 'creation' })));
        }
        return JSON.stringify([{
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'page-two' }] },
        }]);
      },
    };
    const result = await fetchBranchRequiredRules(gh, REPO, 'main');
    expect(ruleCalls).toHaveLength(2);
    expect(result.contexts).toEqual([
      { context: 'page-two', sources: ['repositoryRuleset'], appId: null },
    ]);
  });

  it('fails closed before requesting a 101st repository-rules page', async () => {
    const ruleCalls: string[][] = [];
    const gh: GhRunner = {
      run: async (args) => {
        const joined = args.join(' ');
        if (joined.includes('/protection/required_status_checks')) {
          throw notFound('Branch not protected');
        }
        ruleCalls.push([...args]);
        return JSON.stringify(Array.from({ length: 100 }, () => ({ type: 'creation' })));
      },
    };
    await expect(fetchBranchRequiredRules(gh, REPO, 'main')).rejects.toThrow(/100 pages/);
    expect(ruleCalls).toHaveLength(100);
    expect(ruleCalls.at(-1)?.join(' ')).toContain('page=100');
  });

  it('classic protection과 ruleset의 required context를 합집합으로 만든다', async () => {
    const gh = new FakeGh({ protection: PROTECTION_JSON, rules: RULES_JSON });
    const rules = await fetchBranchRequiredRules(gh, REPO, 'main');

    expect(rules.branch).toBe('main');
    expect(rules.branchProtection).toBe('present');
    expect(rules.repositoryRuleset).toBe('present');
    expect(rules.contexts).toEqual([
      { context: 'classic-failing', sources: ['branchProtection'], appId: null },
      { context: 'classic-passing', sources: ['branchProtection'], appId: null },
      { context: 'ruleset-missing', sources: ['repositoryRuleset'], appId: null },
      { context: 'ruleset-pending', sources: ['repositoryRuleset'], appId: null },
    ]);
  });

  it('두 API가 같은 context를 주면 하나로 합치고 출처를 둘 다 남긴다', async () => {
    const gh = new FakeGh({
      protection: JSON.stringify({ checks: [{ context: 'ci', app_id: null }] }),
      rules: JSON.stringify([
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'ci' }] },
        },
      ]),
    });
    const rules = await fetchBranchRequiredRules(gh, REPO, 'main');
    expect(rules.contexts).toEqual([
      { context: 'ci', sources: ['branchProtection', 'repositoryRuleset'], appId: null },
    ]);
  });

  it('protection 404는 오류가 아니라 미설정 사실이다', async () => {
    const gh = new FakeGh({ protection: notFound('Branch not protected'), rules: '[]' });
    const rules = await fetchBranchRequiredRules(gh, REPO, 'main');
    expect(rules.branchProtection).toBe('absent');
    expect(rules.repositoryRuleset).toBe('present');
    expect(rules.contexts).toEqual([]);
  });

  it('403은 미설정과 구분해 forbidden으로 남긴다', async () => {
    const gh = new FakeGh({
      protection: new GhCommandError(['api'], 1, 'gh: Resource not accessible (HTTP 403)'),
      rules: '[]',
    });
    const rules = await fetchBranchRequiredRules(gh, REPO, 'main');
    expect(rules.branchProtection).toBe('forbidden');
  });

  it('404/403이 아닌 실패는 삼키지 않는다', async () => {
    const gh = new FakeGh({
      protection: new GhCommandError(['api'], 1, 'gh: Bad gateway (HTTP 502)'),
      rules: '[]',
    });
    await expect(fetchBranchRequiredRules(gh, REPO, 'main')).rejects.toThrow(GhCommandError);
  });

  it('required_status_checks가 아닌 rule은 무시한다', async () => {
    const gh = new FakeGh({
      protection: notFound('Not Found'),
      // 2026-08-23 `cli/cli` trunk 실측 응답.
      rules: JSON.stringify([
        {
          type: 'copilot_code_review',
          parameters: { review_on_push: false, review_draft_pull_requests: true },
          ruleset_source_type: 'Repository',
          ruleset_source: 'cli/cli',
          ruleset_id: 4898070,
        },
      ]),
    });
    const rules = await fetchBranchRequiredRules(gh, REPO, 'trunk');
    expect(rules.contexts).toEqual([]);
    expect(rules.repositoryRuleset).toBe('present');
  });

  it('deprecated `contexts`만 있는 protection 응답도 읽는다', async () => {
    const gh = new FakeGh({ protection: JSON.stringify({ contexts: ['legacy'] }), rules: '[]' });
    const rules = await fetchBranchRequiredRules(gh, REPO, 'main');
    expect(rules.contexts).toEqual([{ context: 'legacy', sources: ['branchProtection'], appId: null }]);
  });
});

function rules(contexts: readonly (string | { context: string; appId: number | null })[]): BranchRequiredRules {
  return {
    branch: 'main',
    contexts: contexts.map((c) =>
      typeof c === 'string'
        ? { context: c, sources: ['branchProtection' as const], appId: null }
        : { context: c.context, sources: ['branchProtection' as const], appId: c.appId },
    ),
    branchProtection: 'present',
    repositoryRuleset: 'absent',
  };
}

describe('joinRequiredChecks', () => {
  it('실측 표본의 네 결과를 각각 고정한다', () => {
    const joined = joinRequiredChecks(
      rules(['classic-failing', 'classic-passing', 'ruleset-missing', 'ruleset-pending']),
      ROLLUP,
    );
    expect(joined.map((r) => [r.context, r.state])).toEqual([
      ['classic-failing', 'failing'],
      ['classic-passing', 'passing'],
      ['ruleset-missing', 'missing'],
      ['ruleset-pending', 'pending'],
    ]);
  });

  it('rollup에 없는 required context는 missing이고 observed가 null이다', () => {
    // OD-032의 핵심. 미보고 required는 rollup에도 `gh pr checks --required`에도 나타나지 않고,
    // 그 상태의 merge는 405로 거절됐다(T1 §OD-032).
    const [missing] = joinRequiredChecks(rules(['never-starts']), ROLLUP);
    expect(missing).toEqual({
      context: 'never-starts',
      sources: ['branchProtection'],
      appId: null,
      state: 'missing',
      observed: null,
      unmatchedByApp: [],
      unattributed: [],
    });
  });

  it('required가 하나도 없으면 결과도 비어 있다', () => {
    expect(joinRequiredChecks(rules([]), ROLLUP)).toEqual([]);
  });

  it('optional check는 결과에 넣지 않는다', () => {
    const withOptional: readonly CheckFact[] = [
      ...ROLLUP,
      checkRunRow('optional-fail', 'FAILURE', null),
    ];
    const joined = joinRequiredChecks(rules(['classic-passing']), withOptional);
    expect(joined.map((r) => r.context)).toEqual(['classic-passing']);
  });

  it('바인딩 없는 rule은 어느 app이 보고해도 이름만으로 조인한다', () => {
    const [ci] = joinRequiredChecks(rules(['ci']), [checkRunRow('ci', 'SUCCESS', 99999)]);
    expect(ci?.appId).toBeNull();
    expect(ci?.state).toBe('passing');
    expect(ci?.unmatchedByApp).toEqual([]);
    expect(ci?.unattributed).toEqual([]);
  });

  it('app-bound rule은 그 app이 보고한 row만 충족시킨다', () => {
    const [ci] = joinRequiredChecks(
      rules([{ context: 'ci', appId: 15368 }]),
      [checkRunRow('ci', 'SUCCESS', 15368)],
    );
    expect(ci?.state).toBe('passing');
    expect(ci?.observed?.appId).toBe(15368);
    expect(ci?.unmatchedByApp).toEqual([]);
  });

  it('다른 app이 보고한 동명 SUCCESS는 app-bound rule을 충족시키지 않는다', () => {
    // 실측(2026-08-23, `dnhynk/THROWAWAY-orca-c2-appbind-c6ddffc0`): app_id 15368에 바인딩된
    // required context에 다른 주체가 올린 success가 있어도 merge는
    // `405 ... was not set by the expected GitHub app`이었다.
    const other = checkRunRow('ci', 'SUCCESS', 99999);
    const [ci] = joinRequiredChecks(rules([{ context: 'ci', appId: 15368 }]), [other]);
    expect(ci?.state).toBe('missing');
    expect(ci?.observed).toBeNull();
    expect(ci?.unmatchedByApp).toEqual([other]);
    expect(ci?.unattributed).toEqual([]);
  });

  it('동명 commit status만 있는 app-bound rule은 충족도 불충족도 단정하지 않는다', () => {
    // StatusContext에는 app을 식별할 field가 없다(rollup.ts introspection 실측). PAT가 만든
    // 동명 status는 실측에서 merge 405였지만, Expected-App이 만든 status도 rollup에서는 똑같이
    // 보인다. 이것을 missing으로 단정하면 app이 만든 status가 조용한 false negative가 되고,
    // 충족으로 올리면 PAT status가 false positive다. 판정 불가로 남긴다.
    const row = statusRow('classic-appbound', 'SUCCESS');
    const [ci] = joinRequiredChecks(rules([{ context: 'classic-appbound', appId: 15368 }]), [row]);
    expect(ci?.state).toBe('indeterminate');
    expect(ci?.observed).toBeNull();
    expect(ci?.unattributed).toEqual([row]);
    expect(ci?.unmatchedByApp).toEqual([]);
  });

  it('checkSuite.app이 null인 check run도 주체 미상으로 남긴다', () => {
    // appId null은 "다른 app"이 아니라 "주체를 관측하지 못했다"다(CheckFact.appId).
    const row = checkRunRow('ci', 'SUCCESS', null);
    const [ci] = joinRequiredChecks(rules([{ context: 'ci', appId: 15368 }]), [row]);
    expect(ci?.state).toBe('indeterminate');
    expect(ci?.unattributed).toEqual([row]);
    expect(ci?.unmatchedByApp).toEqual([]);
  });

  it('다른 app의 row와 주체 미상 row가 함께 있으면 각각의 bucket에 남는다', () => {
    const otherApp = checkRunRow('ci', 'SUCCESS', 99999);
    const unattributed = statusRow('ci', 'SUCCESS');
    const [ci] = joinRequiredChecks(
      rules([{ context: 'ci', appId: 15368 }]),
      [otherApp, unattributed],
    );
    expect(ci?.state).toBe('indeterminate');
    expect(ci?.unmatchedByApp).toEqual([otherApp]);
    expect(ci?.unattributed).toEqual([unattributed]);
  });

  it('기대한 app의 row가 있으면 주체 미상 row와 무관하게 그 row로 판정한다', () => {
    const matched = checkRunRow('ci', 'SUCCESS', 15368);
    const unattributed = statusRow('ci', 'FAILURE');
    const [ci] = joinRequiredChecks(rules([{ context: 'ci', appId: 15368 }]), [matched, unattributed]);
    expect(ci?.state).toBe('passing');
    expect(ci?.observed).toEqual(matched);
    expect(ci?.unattributed).toEqual([unattributed]);
  });

  it('app-bound rule과 바인딩 없는 rule이 같은 이름이면 각각 판정한다', () => {
    const joined = joinRequiredChecks(
      rules([{ context: 'ci', appId: null }, { context: 'ci', appId: 15368 }]),
      [checkRunRow('ci', 'SUCCESS', 99999)],
    );
    expect(joined.map((r) => [r.appId, r.state])).toEqual([[null, 'passing'], [15368, 'missing']]);
  });

  it('같은 context에 row가 여러 개면 가장 무거운 상태를 남긴다', () => {
    const dup: readonly CheckFact[] = [
      checkRunRow('ci', 'SUCCESS', null),
      { ...checkRunRow('ci', 'FAILURE', null), id: 'CR_ci_2' },
    ];
    const [ci] = joinRequiredChecks(rules(['ci']), dup);
    expect(ci?.state).toBe('failing');
    expect(ci?.observed?.conclusion).toBe('FAILURE');
  });
});

describe('checkState', () => {
  const checkRun = (status: string, conclusion: string | null): CheckFact =>
    ({ ...checkRunRow('x', conclusion, null), status });
  const statusContext = (state: string): CheckFact => statusRow('x', state);

  it('완료되지 않은 check run은 pending이다', () => {
    for (const s of ['REQUESTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING']) {
      expect(checkState(checkRun(s, null))).toBe('pending');
    }
  });

  it('success/skipped/neutral은 통과다', () => {
    // protected branch의 required check는 successful, skipped, neutral이면 통과다(GitHub 문서).
    for (const c of ['SUCCESS', 'SKIPPED', 'NEUTRAL']) {
      expect(checkState(checkRun('COMPLETED', c))).toBe('passing');
    }
  });

  it('나머지 terminal conclusion은 failing이다', () => {
    for (const c of ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']) {
      expect(checkState(checkRun('COMPLETED', c))).toBe('failing');
    }
  });

  it('commit status state를 그대로 읽는다', () => {
    expect(checkState(statusContext('SUCCESS'))).toBe('passing');
    expect(checkState(statusContext('FAILURE'))).toBe('failing');
    expect(checkState(statusContext('ERROR'))).toBe('failing');
    expect(checkState(statusContext('PENDING'))).toBe('pending');
    expect(checkState(statusContext('EXPECTED'))).toBe('pending');
  });

  it('완료됐는데 통과 목록에 없는 결론은 모르는 값이어도 failing이다', () => {
    // GitHub은 success/skipped/neutral이 아닌 결론이면 merge를 막는다.
    expect(checkState(checkRun('COMPLETED', 'NEW_ENUM_VALUE'))).toBe('failing');
  });

  it('결론을 확정할 수 없으면 통과로 올리지 않고 pending으로 둔다', () => {
    expect(checkState(checkRun('COMPLETED', null))).toBe('pending');
    expect(checkState(statusContext('NEW_ENUM_VALUE'))).toBe('pending');
  });
});
