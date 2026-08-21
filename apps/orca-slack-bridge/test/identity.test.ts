import { describe, it, expect } from 'vitest';
import {
  repositoryKey, runKey, taskKey, dispatchKey, gateKey, pullRequestKey,
} from '../src/identity/keys.js';
import { repositoryIdentity, sameRepository } from '../src/identity/repository.js';

describe('key 파생은 결정적이다', () => {
  it('같은 입력은 항상 같은 key', () => {
    // 실측: dnhynk/dev-infra
    expect(repositoryKey(1341896986)).toBe(repositoryKey(1341896986));
    expect(repositoryKey(1341896986)).toBe('repo:1341896986');
    expect(runKey('run_a48566be983b')).toBe('run:run_a48566be983b');
    expect(taskKey('task_cd1991c049a8')).toBe('task:task_cd1991c049a8');
    expect(dispatchKey('dispatch_123')).toBe('dispatch:dispatch_123');
    expect(gateKey('gate_ac624dad74b5')).toBe('gate:gate_ac624dad74b5');
    // 실측: dnhynk/vertical-live PR #31
    expect(pullRequestKey(1335912197, 31)).toBe('pr:1335912197#31');
  });

  it('서로 다른 entity 종류의 key는 겹치지 않는다', () => {
    const keys = new Set<string>([
      repositoryKey(1), runKey('1'), taskKey('1'), dispatchKey('1'), gateKey('1'),
      pullRequestKey(1, 1),
    ]);
    expect(keys.size).toBe(6);
  });

  it('빈 id나 유효하지 않은 숫자를 통과시키지 않는다', () => {
    expect(() => runKey('   ')).toThrow(TypeError);
    expect(() => repositoryKey(0)).toThrow(TypeError);
    expect(() => repositoryKey(-1)).toThrow(TypeError);
    expect(() => repositoryKey(1.5)).toThrow(TypeError);
    expect(() => pullRequestKey(1, 0)).toThrow(TypeError);
  });
});

describe('repository 동등성은 이름을 보지 않는다', () => {
  it('rename돼도 같은 repository다', () => {
    const before = repositoryIdentity(1341896986, 'dnhynk/dev-infra');
    const after = repositoryIdentity(1341896986, 'dnhynk/agent-infra');
    expect(sameRepository(before, after)).toBe(true);
    expect(before.key).toBe(after.key);
  });

  it('이름이 같아도 id가 다르면 다른 repository다 (fork)', () => {
    const origin = repositoryIdentity(1335912197, 'dnhynk/vertical-live');
    const fork = repositoryIdentity(999999999, 'dnhynk/vertical-live');
    expect(sameRepository(origin, fork)).toBe(false);
    expect(origin.key).not.toBe(fork.key);
  });

  it('표시용 이름은 보존한다', () => {
    expect(repositoryIdentity(1, ' dnhynk/x ').nameWithOwner).toBe('dnhynk/x');
  });

  it('이름이 비면 거부한다', () => {
    expect(() => repositoryIdentity(1, '  ')).toThrow(TypeError);
  });
});
