import { repositoryKey, type RepositoryKey } from './keys.js';

/**
 * Repository identity.
 *
 * `key`와 `githubId`만 동등성에 관여한다. `nameWithOwner`는 표시용이며
 * rename되면 바뀐다. 두 값을 비교해 같은 repository인지 판정하지 않는다.
 */
export type RepositoryIdentity = {
  readonly key: RepositoryKey;
  readonly githubId: number;
  /** 표시용. 동등성 판정에 쓰지 않는다. */
  readonly nameWithOwner: string;
};

export function repositoryIdentity(githubId: number, nameWithOwner: string): RepositoryIdentity {
  const display = nameWithOwner.trim();
  if (display === '') throw new TypeError('nameWithOwner가 비어 있다');
  return { key: repositoryKey(githubId), githubId, nameWithOwner: display };
}

/** 같은 repository인지 판정한다. 이름은 보지 않는다. */
export function sameRepository(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  return a.githubId === b.githubId;
}
