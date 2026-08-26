import { describe, expect, it } from 'vitest';
import {
  GithubRemoteError,
  normalizeGithubNameWithOwner,
  normalizeGithubRemote,
} from '../src/discovery/github-remote.js';

describe('normalizeGithubRemote', () => {
  const accepted: readonly [string, string][] = [
    ['https://github.com/Owner/Repository', 'github.com/owner/repository'],
    ['HTTPS://GITHUB.COM/Owner/Repository.GIT', 'github.com/owner/repository'],
    ['https://github.com/Owner/Repository/', 'github.com/owner/repository'],
    ['https://github.com:443/Owner/Repository.git', 'github.com/owner/repository'],
    ['git@github.com:Owner/Repository', 'github.com/owner/repository'],
    ['git@GITHUB.COM:Owner/Repository.git', 'github.com/owner/repository'],
    ['ssh://git@github.com/Owner/Repository', 'github.com/owner/repository'],
    ['SSH://git@GITHUB.COM/Owner/Repository.GIT/', 'github.com/owner/repository'],
    ['ssh://git@github.com:22/Owner/Repository', 'github.com/owner/repository'],
  ];

  it.each(accepted)('accepts and canonicalizes %s', (remote, canonicalKey) => {
    expect(normalizeGithubRemote(remote)).toEqual({
      canonicalKey,
      nameWithOwner: canonicalKey.replace('github.com/', ''),
    });
  });

  const rejected: readonly [string, GithubRemoteError['code']][] = [
    ['http://github.com/o/r', 'unsupported_scheme'],
    ['git://github.com/o/r', 'unsupported_scheme'],
    ['file:///o/r', 'unsupported_scheme'],
    ['https://api.github.com/o/r', 'unsupported_host'],
    ['https://github.com.example/o/r', 'unsupported_host'],
    ['git@gitlab.com:o/r', 'unsupported_host'],
    ['https://user@github.com/o/r', 'credentials'],
    ['https://user:password@github.com/o/r', 'credentials'],
    ['https://@github.com/o/r', 'credentials'],
    ['ssh://git:@github.com/o/r', 'credentials'],
    ['ssh://root@github.com/o/r', 'invalid_user'],
    ['root@github.com:o/r', 'invalid_user'],
    ['https://github.com:444/o/r', 'non_default_port'],
    ['ssh://git@github.com:2222/o/r', 'non_default_port'],
    ['git@github.com:/owner/repository', 'invalid_path'],
    ['https://github.com:/owner/repository', 'invalid_syntax'],
    ['ssh://git@github.com:/owner/repository', 'invalid_syntax'],
    ['git@github.com:o/r.git/', 'invalid_path'],
    ['https://github.com/o/r?x=1', 'query_or_fragment'],
    ['https://github.com/o/r#fragment', 'query_or_fragment'],
    ['https://github.com/o%2fhidden/r', 'percent_encoding'],
    ['https://github.com/o/r%2egit', 'percent_encoding'],
    ['https://github.com/o/r name', 'unsafe_character'],
    ['https://github.com/o/r\n', 'unsafe_character'],
    ['https://github.com/o\\r', 'backslash'],
    ['https://github.com/o/../r', 'invalid_path'],
    ['https://github.com/o/../replacement/repository', 'invalid_path'],
    ['https://github.com/./r', 'invalid_path'],
    ['https://github.com/o', 'invalid_path'],
    ['https://github.com/o/r/extra', 'invalid_path'],
    ['https://github.com/o//r', 'invalid_path'],
    ['https://github.com/o/r//', 'invalid_path'],
    ['https://github.com/-owner/r', 'invalid_owner'],
    ['https://github.com/owner-/r', 'invalid_owner'],
    [`https://github.com/${'o'.repeat(40)}/r`, 'invalid_owner'],
    ['https://github.com/o/.', 'invalid_path'],
    ['https://github.com/o/..', 'invalid_path'],
    ['https://github.com/o/r!', 'invalid_repository'],
    [`https://github.com/o/${'r'.repeat(101)}`, 'invalid_repository'],
    ['https://github.com/o/r.git.git', 'double_git_suffix'],
    ['github.com/o/r', 'invalid_syntax'],
    ['C:/work/o/r', 'invalid_syntax'],
    ['\\\\server\\share\\o\\r', 'backslash'],
  ];

  it.each(rejected)('rejects %s as %s', (remote, code) => {
    try {
      normalizeGithubRemote(remote);
      expect.unreachable('remote should be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(GithubRemoteError);
      expect((error as GithubRemoteError).code).toBe(code);
    }
  });

  it('accepts owner/repository length boundaries', () => {
    const owner = `o${'a'.repeat(37)}z`;
    const repository = 'r'.repeat(100);
    expect(normalizeGithubRemote(`https://github.com/${owner}/${repository}`).nameWithOwner)
      .toBe(`${owner}/${repository}`);
  });

  it('normalizes case independently for a table of valid identities', () => {
    for (let length = 1; length <= 39; length += 1) {
      const owner = length === 1 ? 'A' : `A${'b'.repeat(length - 2)}Z`;
      const got = normalizeGithubRemote(`git@github.com:${owner}/Repo_${length}.git`);
      expect(got.canonicalKey).toBe(`github.com/${owner.toLowerCase()}/repo_${length}`);
    }
  });

  it('never includes the rejected remote in public error fields', () => {
    const secret = 'PRIVATE-REMOTE-SENTINEL';
    const remote = `https://user:${secret}@github.com/o/r`;
    try {
      normalizeGithubRemote(remote);
      expect.unreachable('remote should be rejected');
    } catch (error) {
      const publicText = `${String(error)} ${JSON.stringify(error)}`;
      expect(publicText).not.toContain(secret);
      expect(publicText).not.toContain(remote);
    }
  });
});

describe('normalizeGithubNameWithOwner', () => {
  it('uses the same owner/repository bounds without accepting a URL', () => {
    expect(normalizeGithubNameWithOwner('Owner/Repo')).toEqual({
      canonicalKey: 'github.com/owner/repo',
      nameWithOwner: 'owner/repo',
    });
    expect(() => normalizeGithubNameWithOwner('https://github.com/o/r')).toThrow(GithubRemoteError);
    try {
      normalizeGithubNameWithOwner('/owner/repository');
      expect.unreachable('leading slash should be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(GithubRemoteError);
      expect((error as GithubRemoteError).code).toBe('invalid_path');
    }
  });
});
