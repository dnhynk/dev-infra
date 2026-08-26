import { describe, it, expect } from 'vitest';
import {
  fetchRepositoryIdentity,
  repositoryIdentityConfirmer,
} from '../src/github/repository.js';
import { ghJson, type GhRunner } from '../src/github/runner.js';

class FakeGh implements GhRunner {
  readonly calls: string[][] = [];
  constructor(private readonly stdout: string) {}
  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    return this.stdout;
  }
}

describe('fetchRepositoryIdentity', () => {
  it('REST 숫자 id로 identity를 만든다', async () => {
    // 실측 응답 형태
    const gh = new FakeGh('{"id":1341896986,"full_name":"dnhynk/dev-infra"}');
    const id = await fetchRepositoryIdentity(gh, 'dnhynk/dev-infra');
    expect(id.githubId).toBe(1341896986);
    expect(id.key).toBe('repo:1341896986');
    expect(id.nameWithOwner).toBe('dnhynk/dev-infra');
  });

  it('node ID를 주는 gh repo view 경로를 쓰지 않는다', async () => {
    const gh = new FakeGh('{"id":1341896986,"full_name":"dnhynk/dev-infra"}');
    await fetchRepositoryIdentity(gh, 'dnhynk/dev-infra');
    expect(gh.calls[0]?.[0]).toBe('api');
    expect(gh.calls[0]?.[1]).toBe('repos/dnhynk/dev-infra');
    expect(gh.calls[0]).not.toContain('repo');
  });

  it('id가 문자열(node ID)로 오면 거부한다', async () => {
    const gh = new FakeGh('{"id":"R_kgDOT_u5Gg","full_name":"dnhynk/dev-infra"}');
    await expect(fetchRepositoryIdentity(gh, 'dnhynk/dev-infra')).rejects.toThrow(TypeError);
  });

  it('full_name이 없으면 거부한다', async () => {
    const gh = new FakeGh('{"id":1}');
    await expect(fetchRepositoryIdentity(gh, 'x/y')).rejects.toThrow(TypeError);
  });

  it('authoritative full_name도 strict canonical grammar를 통과하고 lowercase로 저장한다', async () => {
    const gh = new FakeGh('{"id":7,"full_name":"Acme/Widget"}');
    await expect(repositoryIdentityConfirmer(gh).confirm('acme/widget')).resolves.toMatchObject({
      githubId: 7, nameWithOwner: 'acme/widget',
    });

    const malformed = new FakeGh('{"id":7,"full_name":"acme/widget/extra"}');
    await expect(fetchRepositoryIdentity(malformed, 'acme/widget')).rejects.toThrow(TypeError);
  });
});

describe('ghJson', () => {
  it('JSON이 아니면 조용히 넘기지 않는다', async () => {
    const gh = new FakeGh('gh: command not found');
    await expect(ghJson(gh, ['api', 'x'])).rejects.toThrow(SyntaxError);
  });
});
