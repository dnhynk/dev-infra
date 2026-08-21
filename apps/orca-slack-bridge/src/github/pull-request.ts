import { pullRequestKey, type PullRequestKey } from '../identity/keys.js';
import type { RepositoryIdentity } from '../identity/repository.js';
import { ghJson, type GhRunner } from './runner.js';

/** correlation과 상태 축약에 필요한 PR 사실. summarizer 입력은 C1에서 정한다. */
export type PullRequestFacts = {
  readonly key: PullRequestKey;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly mergedAt: string | null;
  /** GitHub formal review 판정. 관측된 모든 대상 repo에서 null이다(DL-016 근거). */
  readonly reviewDecision: string | null;
  readonly reviewCount: number;
  readonly checks: readonly CheckFact[];
};

export type CheckFact = {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
};

const FIELDS = [
  'number', 'title', 'body', 'url', 'state', 'isDraft',
  'headRefName', 'baseRefName', 'mergedAt', 'reviewDecision', 'reviews', 'statusCheckRollup',
].join(',');

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export async function listPullRequests(
  runner: GhRunner,
  repo: RepositoryIdentity,
  limit = 50,
): Promise<PullRequestFacts[]> {
  const rows = await ghJson<unknown[]>(runner, [
    'pr', 'list',
    '--repo', repo.nameWithOwner,
    '--state', 'all',
    '--limit', String(limit),
    '--json', FIELDS,
  ]);
  return rows.map((row) => {
    const o = row as Record<string, unknown>;
    const number = o['number'];
    if (typeof number !== 'number') {
      throw new TypeError(`${repo.nameWithOwner} PR 응답에 number가 없다`);
    }
    const reviews = Array.isArray(o['reviews']) ? o['reviews'] : [];
    const rollup = Array.isArray(o['statusCheckRollup']) ? o['statusCheckRollup'] : [];
    return {
      key: pullRequestKey(repo.githubId, number),
      number,
      title: str(o['title']),
      body: str(o['body']),
      url: str(o['url']),
      state: str(o['state']),
      isDraft: o['isDraft'] === true,
      headRefName: str(o['headRefName']),
      baseRefName: str(o['baseRefName']),
      mergedAt: strOrNull(o['mergedAt']),
      reviewDecision: strOrNull(o['reviewDecision']),
      reviewCount: reviews.length,
      checks: rollup.map((c) => {
        const co = c as Record<string, unknown>;
        return {
          name: str(co['name']),
          status: str(co['status']),
          conclusion: strOrNull(co['conclusion']),
        };
      }),
    };
  });
}
