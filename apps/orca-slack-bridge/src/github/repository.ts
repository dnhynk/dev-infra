import { repositoryIdentity, type RepositoryIdentity } from '../identity/repository.js';
import { normalizeGithubNameWithOwner } from '../discovery/github-remote.js';
import { ghJson, type GhRunner } from './runner.js';

export type RepositoryIdentityConfirmationOptions = {
  /** Discovery owns this signal and aborts it when the shared pass deadline expires. */
  readonly signal: AbortSignal;
  /** Absolute epoch deadline shared by every confirmation in one discovery pass. */
  readonly deadlineAt: number;
};

/** Injectable seam used by discovery; tests never need a live GitHub process or network. */
export interface RepositoryIdentityConfirmer {
  confirm(
    nameWithOwner: string,
    options: RepositoryIdentityConfirmationOptions,
  ): Promise<RepositoryIdentity>;
}

export function repositoryIdentityConfirmer(runner: GhRunner): RepositoryIdentityConfirmer {
  return {
    confirm: (nameWithOwner, options) => {
      const remaining = Math.trunc(options.deadlineAt - Date.now());
      if (options.signal.aborted || remaining <= 0) {
        throw new Error('GitHub repository confirmation deadline exceeded');
      }
      return fetchRepositoryIdentity(runner, nameWithOwner, {
        signal: options.signal,
        timeoutMs: remaining,
      });
    },
  };
}

/**
 * repository identity를 조회한다.
 *
 * `gh repo view --json id`의 `id`는 GraphQL node ID 문자열이므로 쓰지 않는다.
 * canonical key에 필요한 숫자 databaseId는 REST 경로에서만 나온다(OD-026).
 */
export async function fetchRepositoryIdentity(
  runner: GhRunner,
  nameWithOwner: string,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
): Promise<RepositoryIdentity> {
  const raw = await ghJson<{ id?: unknown; full_name?: unknown }>(runner, [
    'api',
    `repos/${nameWithOwner}`,
    '--jq',
    '{id: .id, full_name: .full_name}',
  ], options);
  if (typeof raw.id !== 'number') {
    throw new TypeError(`repos/${nameWithOwner} 응답에 숫자 id가 없다`);
  }
  if (typeof raw.full_name !== 'string') {
    throw new TypeError(`repos/${nameWithOwner} 응답에 full_name이 없다`);
  }
  // REST is authoritative for rename/owner-transfer spelling, but it still crosses the same
  // strict owner/name grammar as configured and Orca-derived identities.
  const authoritative = normalizeGithubNameWithOwner(raw.full_name);
  return repositoryIdentity(raw.id, authoritative.nameWithOwner);
}
