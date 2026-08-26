import type { CanonicalGithubRepository, GithubRemoteErrorCode } from './types.js';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

const ERROR_MESSAGES: Readonly<Record<GithubRemoteErrorCode, string>> = {
  unsafe_character: 'GitHub remote contains forbidden whitespace or control characters',
  backslash: 'GitHub remote contains a forbidden backslash',
  percent_encoding: 'GitHub remote contains forbidden percent encoding',
  query_or_fragment: 'GitHub remote contains a forbidden query or fragment',
  unsupported_scheme: 'GitHub remote scheme is not supported',
  unsupported_host: 'GitHub remote host is not supported',
  invalid_user: 'GitHub SSH remote user is invalid',
  credentials: 'GitHub remote credentials are forbidden',
  non_default_port: 'GitHub remote uses a non-default port',
  invalid_path: 'GitHub remote path must contain exactly owner and repository',
  invalid_owner: 'GitHub owner is invalid',
  invalid_repository: 'GitHub repository name is invalid',
  double_git_suffix: 'GitHub repository has a doubled .git suffix',
  invalid_syntax: 'GitHub remote syntax is invalid',
};

/** Public-safe error: code and message are static and never include the rejected remote. */
export class GithubRemoteError extends TypeError {
  constructor(readonly code: GithubRemoteErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'GithubRemoteError';
  }
}

function reject(code: GithubRemoteErrorCode): never {
  throw new GithubRemoteError(code);
}

function validateName(owner: string, repositoryWithSuffix: string): CanonicalGithubRepository {
  if (!OWNER.test(owner)) reject('invalid_owner');
  if (/\.git\.git$/i.test(repositoryWithSuffix)) reject('double_git_suffix');
  const repository = repositoryWithSuffix.replace(/\.git$/i, '');
  if (!REPOSITORY.test(repository) || repository === '.' || repository === '..') {
    reject('invalid_repository');
  }
  const ownerLower = owner.toLowerCase();
  const repositoryLower = repository.toLowerCase();
  return {
    canonicalKey: `github.com/${ownerLower}/${repositoryLower}`,
    nameWithOwner: `${ownerLower}/${repositoryLower}`,
  };
}

function parsePath(path: string, allowTrailingSlash: boolean): CanonicalGithubRepository {
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) reject('invalid_path');
  let value = path;
  if (value.endsWith('/')) {
    if (!allowTrailingSlash || value.endsWith('//')) reject('invalid_path');
    value = value.slice(0, -1);
  }
  if (value.startsWith('/')) value = value.slice(1);
  const segments = value.split('/');
  if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) {
    reject('invalid_path');
  }
  return validateName(segments[0]!, segments[1]!);
}

/** Validates a configured `owner/repository` while preserving config's display spelling. */
export function normalizeGithubNameWithOwner(value: string): CanonicalGithubRepository {
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) reject('unsafe_character');
  if (value.includes('\\')) reject('backslash');
  if (value.includes('%')) reject('percent_encoding');
  if (value.includes('?') || value.includes('#')) reject('query_or_fragment');
  if (value.startsWith('/')) reject('invalid_path');
  const repository = value.split('/')[1];
  if (repository !== undefined && /\.git$/i.test(repository)) reject('invalid_repository');
  return parsePath(value, false);
}

/**
 * Strict, independently-computed GitHub remote identity.
 *
 * Accepted forms are HTTPS, SCP-like git@github.com, and ssh://git@github.com only. The return
 * value contains no raw URL, credentials, path, or Orca-provided canonical identity.
 */
export function normalizeGithubRemote(value: string): CanonicalGithubRepository {
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) reject('unsafe_character');
  if (value.includes('\\')) reject('backslash');
  if (value.includes('%')) reject('percent_encoding');
  if (value.includes('?') || value.includes('#')) reject('query_or_fragment');

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  if (scheme === null) {
    const scp = /^([^@/:]+)@([^/:]+):(.*)$/.exec(value);
    if (scp === null) reject('invalid_syntax');
    if (scp[1] !== 'git') reject('invalid_user');
    if (scp[2]!.toLowerCase() !== 'github.com') reject('unsupported_host');
    if (scp[3]!.startsWith('/')) reject('invalid_path');
    return parsePath(scp[3]!, false);
  }
  const schemeLower = scheme[1]!.toLowerCase();
  if (schemeLower !== 'https' && schemeLower !== 'ssh') reject('unsupported_scheme');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    reject('invalid_syntax');
  }
  const authorityStart = value.indexOf('://') + 3;
  const pathStart = value.indexOf('/', authorityStart);
  const authority = pathStart === -1 ? value.slice(authorityStart) : value.slice(authorityStart, pathStart);
  const rawPath = pathStart === -1 ? '' : value.slice(pathStart);
  if (authority.endsWith(':')) reject('invalid_syntax');
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) reject('invalid_path');
  if (parsed.hostname.toLowerCase() !== 'github.com') reject('unsupported_host');

  if (schemeLower === 'https') {
    if (authority.includes('@') || parsed.username !== '' || parsed.password !== '') reject('credentials');
    if (parsed.port !== '') reject('non_default_port');
  } else {
    if (parsed.username !== 'git') reject('invalid_user');
    if (!/^git@/i.test(authority) || authority.slice(0, authority.lastIndexOf('@')).includes(':')) {
      reject('credentials');
    }
    if (parsed.password !== '') reject('credentials');
    if (parsed.port !== '' && parsed.port !== '22') reject('non_default_port');
  }

  return parsePath(parsed.pathname, true);
}
