import { describe, expect, it } from 'vitest';
import { fetchBranchRequiredRules, type BranchRequiredRules } from '../src/github/branch-rules.js';
import { checkState, joinRequiredChecks } from '../src/github/required-checks.js';
import type { CheckFact } from '../src/github/pull-request.js';
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

/** 같은 PR의 `gh pr view --json statusCheckRollup` 응답. 세 row 모두 StatusContext다. */
const ROLLUP: readonly CheckFact[] = [
  { kind: 'statusContext', name: 'classic-failing', status: '', conclusion: null, state: 'FAILURE' },
  { kind: 'statusContext', name: 'ruleset-pending', status: '', conclusion: null, state: 'PENDING' },
  { kind: 'statusContext', name: 'classic-passing', status: '', conclusion: null, state: 'SUCCESS' },
];

type Reply = string | GhCommandError;

class FakeGh implements GhRunner {
  readonly calls: string[][] = [];
  constructor(private readonly replies: { protection: Reply; rules: Reply }) {}
  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const path = args[1] ?? '';
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
  it('classic protection과 ruleset의 required context를 합집합으로 만든다', async () => {
    const gh = new FakeGh({ protection: PROTECTION_JSON, rules: RULES_JSON });
    const rules = await fetchBranchRequiredRules(gh, REPO, 'main');

    expect(rules.branch).toBe('main');
    expect(rules.branchProtection).toBe('present');
    expect(rules.repositoryRuleset).toBe('present');
    expect(rules.contexts).toEqual([
      { context: 'classic-failing', sources: ['branchProtection'] },
      { context: 'classic-passing', sources: ['branchProtection'] },
      { context: 'ruleset-missing', sources: ['repositoryRuleset'] },
      { context: 'ruleset-pending', sources: ['repositoryRuleset'] },
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
      { context: 'ci', sources: ['branchProtection', 'repositoryRuleset'] },
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
    expect(rules.contexts).toEqual([{ context: 'legacy', sources: ['branchProtection'] }]);
  });
});

function rules(contexts: readonly string[]): BranchRequiredRules {
  return {
    branch: 'main',
    contexts: contexts.map((context) => ({ context, sources: ['branchProtection' as const] })),
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
      state: 'missing',
      observed: null,
    });
  });

  it('required가 하나도 없으면 결과도 비어 있다', () => {
    expect(joinRequiredChecks(rules([]), ROLLUP)).toEqual([]);
  });

  it('optional check는 결과에 넣지 않는다', () => {
    const withOptional: readonly CheckFact[] = [
      ...ROLLUP,
      { kind: 'checkRun', name: 'optional-fail', status: 'COMPLETED', conclusion: 'FAILURE', state: null },
    ];
    const joined = joinRequiredChecks(rules(['classic-passing']), withOptional);
    expect(joined.map((r) => r.context)).toEqual(['classic-passing']);
  });

  it('같은 context에 row가 여러 개면 가장 무거운 상태를 남긴다', () => {
    const dup: readonly CheckFact[] = [
      { kind: 'checkRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', state: null },
      { kind: 'checkRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', state: null },
    ];
    const [ci] = joinRequiredChecks(rules(['ci']), dup);
    expect(ci?.state).toBe('failing');
    expect(ci?.observed?.conclusion).toBe('FAILURE');
  });
});

describe('checkState', () => {
  const checkRun = (status: string, conclusion: string | null): CheckFact =>
    ({ kind: 'checkRun', name: 'x', status, conclusion, state: null });
  const statusContext = (state: string): CheckFact =>
    ({ kind: 'statusContext', name: 'x', status: '', conclusion: null, state });

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
