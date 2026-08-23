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

/**
 * GraphQL 질의의 `$owner`/`$name` 변수로 쓸 두 조각.
 *
 * GraphQL은 `nameWithOwner` 통짜 주소를 받지 않으므로 여기서 한 번 가른다. 형태가 어긋난
 * 이름으로 질의하면 GitHub이 "repository 없음"으로 답해 원인이 숨으므로 조회 전에 던진다.
 */
export function ownerAndName(repo: RepositoryIdentity): { owner: string; name: string } {
  const slash = repo.nameWithOwner.indexOf('/');
  if (slash <= 0 || slash === repo.nameWithOwner.length - 1) {
    throw new TypeError(`GraphQL 조회에 쓸 owner/name을 읽을 수 없다: ${repo.nameWithOwner}`);
  }
  return { owner: repo.nameWithOwner.slice(0, slash), name: repo.nameWithOwner.slice(slash + 1) };
}
