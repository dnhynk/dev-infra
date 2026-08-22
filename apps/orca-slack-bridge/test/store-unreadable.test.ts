import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadOnlyDigestStore, SqliteDigestStore } from '../src/store/sqlite.js';
import { pullRequestKey } from '../src/identity/keys.js';

/**
 * 원본 store를 **판정할 수 없을 때** dry-run이 무엇을 하는지 검증한다.
 *
 * `store.test.ts`·`cli-digest.test.ts`와 달리 이 파일만 `node:fs`를 대역으로 바꾼다.
 * `EACCES`·`EPERM`은 OS별 권한 조작 없이는 실제 파일시스템에서 재현할 수 없고, win32에서는
 * 경로 구성요소가 파일인 경로조차 `ENOTDIR`이 아니라 `ENOENT`를 준다. 대역이 없으면 전파
 * 경로가 검증되지 않은 채 남는다. 대역은 Node의 실제 동작을 그대로 흉내낸다. `statSync`는
 * 던지고, **`existsSync`는 같은 상황에서 오류를 삼키고 `false`를 돌려준다.** 그 `false`를
 * 부재로 읽는 것이 여기서 막는 회귀다.
 *
 * 대역은 `fake.error`가 설정된 동안, 이름이 `fake.suffix`로 끝나는 경로에만 적용된다. 나머지는
 * 실제 파일시스템이므로 sqlite의 제약이 그대로 살아 있다.
 */
const fake = vi.hoisted(() => ({
  error: null as NodeJS.ErrnoException | null,
  /** 오류를 던질 경로의 끝. 빈 문자열이면 모든 경로다. */
  suffix: '',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const faked = (target: unknown): boolean =>
    fake.error !== null && typeof target === 'string' && target.endsWith(fake.suffix);
  const realStat = actual.statSync as (...args: unknown[]) => unknown;
  return {
    ...actual,
    statSync: (target: unknown, ...rest: unknown[]) => {
      if (faked(target)) throw fake.error;
      return realStat(target, ...rest);
    },
    existsSync: (target: unknown) =>
      faked(target) ? false : actual.existsSync(target as Parameters<typeof actual.existsSync>[0]),
  };
});

function errno(code: string, syscall: string, path: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`${code}: ${syscall}, stat '${path}'`);
  e.code = code;
  return e;
}

const PR = pullRequestKey(4242, 7);
const CHANNEL = 'C09ABCDEFGH';
const TS = '1700000000.000001';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-store-unreadable-'));
  dbPath = join(dir, 'state.db');
  fake.error = null;
  fake.suffix = '';
});

afterEach(() => {
  fake.error = null;
  fake.suffix = '';
  rmSync(dir, { recursive: true, force: true });
});

/** 생성자가 던진 오류를 돌려준다. 던지지 않았으면 undefined다. */
function openReadOnly(path: string): unknown {
  let thrown: unknown;
  let store: ReadOnlyDigestStore | null = null;
  try {
    store = new ReadOnlyDigestStore(path);
  } catch (e) {
    thrown = e;
  } finally {
    store?.close();
  }
  return thrown;
}

describe('원본 store를 판정할 수 없을 때', () => {
  it('ENOENT만 부재다. 행 없음으로 다뤄 create로 보고한다', () => {
    fake.error = errno('ENOENT', 'no such file or directory', dbPath);
    const store = new ReadOnlyDigestStore(dbPath);
    try {
      expect(store.findPrMessage(PR)).toBeNull();
    } finally {
      store.close();
    }
  });

  // 회귀 방지: existsSync는 경로 탐색 중의 EACCES에서도 false를 돌려준다. 그 값을 부재로 읽으면
  // 읽을 수 없는 기존 store가 "없는 store"가 되어, 이미 루트가 있는 PR을 create로 보고한다.
  // 운영자가 그 dry-run 출력을 믿고 게시하면 루트가 하나 더 생긴다(로드맵 §5).
  it('EACCES는 부재가 아니다. 조용히 create로 가지 않고 전파한다', () => {
    fake.error = errno('EACCES', 'permission denied', dbPath);
    const thrown = openReadOnly(dbPath);
    expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe('EACCES');
    // 어느 파일을 판정하지 못했는지 남는다. 채널 ID나 토큰이 아니므로 가리지 않는다.
    expect((thrown as Error).message).toContain(dbPath);
  });

  it('EPERM도 같다', () => {
    fake.error = errno('EPERM', 'operation not permitted', dbPath);
    expect((openReadOnly(dbPath) as NodeJS.ErrnoException | undefined)?.code).toBe('EPERM');
  });

  // ENOTDIR을 부재로 접지 않기로 한 판단: 경로 구성요소가 디렉터리가 아니면 그 자리에 DB가
  // 있을 수 없는 것은 맞지만, 그것은 "아직 만들지 않았다"가 아니라 store 경로 자체가 틀렸다는
  // 뜻이다. 부재로 접으면 dry-run이 열릴 수 없는 경로를 create로 보고한다.
  it('ENOTDIR도 전파한다. 열릴 수 없는 경로를 create로 보고하지 않는다', () => {
    fake.error = errno('ENOTDIR', 'not a directory', dbPath);
    expect((openReadOnly(dbPath) as NodeJS.ErrnoException | undefined)?.code).toBe('ENOTDIR');
  });

  // -wal 판정도 같은 규칙을 따른다. 여기서 접근 불가를 부재로 읽으면 checkpoint되지 않은
  // -wal에만 있는 커밋된 행을 놓쳐, 매핑이 있는 PR을 create로 보고한다.
  it('-wal을 판정할 수 없어도 부재로 접지 않는다', () => {
    const live = new SqliteDigestStore(dbPath);
    live.insertPrMessage({
      prKey: PR,
      channelId: CHANNEL,
      messageTs: TS,
      renderFingerprint: 'fp-1',
      at: '2026-08-22T00:00:00Z',
    });
    live.close();

    fake.suffix = '-wal';
    fake.error = errno('EACCES', 'permission denied', `${dbPath}-wal`);
    expect((openReadOnly(dbPath) as NodeJS.ErrnoException | undefined)?.code).toBe('EACCES');
  });
});
