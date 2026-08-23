import { describe, it, expect } from 'vitest';
import { buildSummaryFacts, prepareSummaryBody } from '../src/digest/facts.js';
import type { ProjectedPr } from '../src/digest/types.js';
import type { PullRequestFacts } from '../src/github/pull-request.js';
import { pullRequestKey, runKey, taskKey } from '../src/identity/keys.js';
import { repositoryIdentity } from '../src/identity/repository.js';
import { DEFAULT_CORRELATION_KEYS } from '../src/project/config.js';
import { CAPS, renderFactsPrompt } from '../src/summarize/contract.js';

const REPO = repositoryIdentity(1042577813, 'dnhynk/dev-infra');
const KEYS = DEFAULT_CORRELATION_KEYS;

const METADATA = [
  '<!-- orca-run: run_7804be5a654f -->',
  '<!-- orca-task: task_cd5d4530c946 -->',
  '<!-- orca-dispatch: ctx_442eeb1e20c6 -->',
].join('\n');

function source(over: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    key: pullRequestKey(REPO.githubId, 3),
    number: 3,
    title: 'feat(c1): PR projection',
    body: `## 무엇을 바꾸나\n\ncorrelated PR을 ProjectedPr로 만든다.\n\n${METADATA}`,
    url: 'https://github.com/dnhynk/dev-infra/pull/3',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat/c1-projection',
    headRefOid: 'a7fc54af57ab755c6d0d9b8d5a02f45bd1bfe8a8',
    baseRefName: 'main',
    mergedAt: null,
    reviewDecision: null,
    reviewCount: 0,
    checks: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    changedPaths: ['apps/orca-slack-bridge/src/digest/project.ts'],
    changedFilesTotal: 1,
    ...over,
  };
}

function card(over: Partial<ProjectedPr> = {}): ProjectedPr {
  return {
    key: pullRequestKey(REPO.githubId, 3),
    repository: REPO,
    project: 'dev-infra',
    correlation: {
      kind: 'correlated',
      run: runKey('run_7804be5a654f'),
      task: taskKey('task_cd5d4530c946'),
      dispatch: null,
    },
    number: 3,
    title: 'feat(c1): PR projection',
    url: 'https://github.com/dnhynk/dev-infra/pull/3',
    headSha: 'a7fc54af57ab755c6d0d9b8d5a02f45bd1bfe8a8',
    terminal: 'open',
    isDraft: false,
    review: null,
    checks: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    mergePolicy: 'unobserved',
    workerReport: null,
    truncation: { prBody: false, changedFiles: false },
    ...over,
  };
}

describe('PR 본문 정리', () => {
  it('correlation metadata 블록을 지운다', () => {
    const prepared = prepareSummaryBody(source().body, KEYS);
    expect(prepared.text).not.toContain('orca-run');
    expect(prepared.text).not.toContain('orca-task');
    expect(prepared.text).not.toContain('orca-dispatch');
    expect(prepared.text).not.toContain('run_7804be5a654f');
    expect(prepared.text.endsWith('correlated PR을 ProjectedPr로 만든다.')).toBe(true);
    expect(prepared.truncated).toBe(false);
  });

  it('설정된 key 이름만 지운다', () => {
    const body = 'x\n<!-- bridge-run: run_1 -->';
    expect(prepareSummaryBody(body, KEYS).text).toContain('bridge-run');
    expect(prepareSummaryBody(body, { ...KEYS, run: 'bridge-run' }).text).toBe('x');
  });

  it('중복 key도 모두 지운다', () => {
    const body = `본문\n<!-- orca-run: run_a -->\n<!-- orca-run: run_b -->`;
    expect(prepareSummaryBody(body, KEYS).text).toBe('본문');
  });

  it('상한을 넘으면 자르고 truncated를 세운다', () => {
    const long = 'ㄱ'.repeat(CAPS.prBody + 500);
    const prepared = prepareSummaryBody(`${long}\n${METADATA}`, KEYS);
    expect(prepared.text).toHaveLength(CAPS.prBody);
    expect(prepared.truncated).toBe(true);
  });

  it('metadata를 먼저 지운 뒤 상한을 적용한다', () => {
    // 사람이 읽는 본문이 정확히 상한이면, metadata가 붙어 있어도 잘리지 않아야 한다.
    const exact = 'ㄴ'.repeat(CAPS.prBody);
    const prepared = prepareSummaryBody(`${exact}\n\n${METADATA}`, KEYS);
    expect(prepared.truncated).toBe(false);
    expect(prepared.text).toBe(exact);
  });
});

describe('SummaryFacts 조립', () => {
  it('OD-036 경계 밖의 값을 넣지 않는다', () => {
    const facts = buildSummaryFacts(card(), source(), 'T3 · PR projection', KEYS);
    expect(Object.keys(facts).sort()).toEqual(
      ['changedPaths', 'checks', 'prBody', 'prTitle', 'review', 'taskPurpose', 'truncated', 'workerDone'].sort(),
    );
    // 프롬프트에 실제로 들어가는 문자열에도 metadata·설정 값·diff 본문이 없어야 한다.
    const prompt = renderFactsPrompt(facts);
    expect(prompt).not.toContain('orca-run');
    expect(prompt).not.toContain('run_7804be5a654f');
    expect(prompt).not.toContain('task_cd5d4530c946');
    expect(prompt).not.toContain('a7fc54af57ab755c6d0d9b8d5a02f45bd1bfe8a8');
    expect(prompt).not.toContain('https://github.com');
  });

  it('worker_done 본문을 그대로 싣고, 없으면 null이다', () => {
    const withReport = buildSummaryFacts(
      card({ workerReport: { outcome: 'succeeded', body: '했다. 발견했다. 남았다.' } }),
      source(), null, KEYS,
    );
    expect(withReport.workerDone).toBe('했다. 발견했다. 남았다.');
    expect(buildSummaryFacts(card(), source(), null, KEYS).workerDone).toBeNull();
  });

  it('review는 verdict와 findings만 넘긴다', () => {
    const facts = buildSummaryFacts(
      card({
        review: {
          verdict: 'request_changes',
          reviewedHeadSha: 'dbdc4e9d8c9bb75a980b6070b4dd8448bbff22c5',
          headMatch: 'different',
          findings: [{ severity: 'blocker', file: 'a.ts', line: 7, summary: '깨진다' }],
          findingsTotal: 3,
        },
      }),
      source(), null, KEYS,
    );
    expect(facts.review).toEqual({
      verdict: 'request_changes',
      findings: [{ severity: 'blocker', file: 'a.ts', line: 7, summary: '깨진다' }],
    });
    // headMatch와 findingsTotal은 카드가 쓰는 사실이지 summarizer 입력이 아니다.
    expect(JSON.stringify(facts.review)).not.toContain('headMatch');
    expect(JSON.stringify(facts.review)).not.toContain('findingsTotal');
  });

  it('상한이 걸린 findings만 넘어간다', () => {
    const findings = Array.from({ length: CAPS.findings }, (_, i) => ({
      severity: 'minor' as const, file: `f${i}.ts`, line: null, summary: `f ${i}`,
    }));
    const facts = buildSummaryFacts(
      card({
        review: { verdict: 'approve', reviewedHeadSha: null, headMatch: 'unknown', findings, findingsTotal: 42 },
      }),
      source(), null, KEYS,
    );
    expect(facts.review?.findings).toHaveLength(CAPS.findings);
  });

  it('check는 name과 conclusion만 넘긴다', () => {
    const facts = buildSummaryFacts(card(), source(), null, KEYS);
    expect(facts.checks).toEqual([{ name: 'build', conclusion: 'SUCCESS' }]);
  });

  it('변경 파일은 경로만 넘기고 자르지 않는다', () => {
    const paths = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
    const facts = buildSummaryFacts(card(), source({ changedPaths: paths, changedFilesTotal: 1971 }), null, KEYS);
    expect(facts.changedPaths).toEqual(paths);
    // 프롬프트 상한은 renderFactsPrompt가 건다.
    expect(renderFactsPrompt(facts).split('src/f').length - 1).toBe(CAPS.changedPaths);
  });

  it('본문 절단 사실이 ProjectedPr.truncation.prBody와 같은 계산에서 나온다', () => {
    const long = source({ body: `${'ㄷ'.repeat(CAPS.prBody + 1)}\n${METADATA}` });
    const facts = buildSummaryFacts(card({ truncation: { prBody: true, changedFiles: false } }), long, null, KEYS);
    expect(facts.truncated).toBe(prepareSummaryBody(long.body, KEYS).truncated);
    expect(facts.truncated).toBe(true);
  });

  it('파일 목록 절단은 truncated를 켜지 않는다', () => {
    const facts = buildSummaryFacts(
      card({ truncation: { prBody: false, changedFiles: true } }),
      source({ changedPaths: ['a.ts'], changedFilesTotal: 1971 }),
      null, KEYS,
    );
    // truncated의 프롬프트 문구는 "PR 본문이 잘렸다"다. 파일 목록 절단으로 켜면 거짓 설명이 된다.
    expect(facts.truncated).toBe(false);
  });
});
