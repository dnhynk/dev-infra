import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDigestStore, SchemaVersionError, resolveStatePath } from '../src/store/sqlite.js';
import { SCHEMA_VERSION, STATE_PATH_VAR } from '../src/store/schema.js';
import { pullRequestKey } from '../src/identity/keys.js';

// 실제 파일을 열어 검증한다. 모킹하면 검증 대상인 sqlite의 제약이 사라진다.
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-store-'));
  // 부모 디렉터리를 일부러 만들지 않는다. store가 만드는지 함께 본다.
  dbPath = join(dir, 'nested', 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PR = pullRequestKey(123456, 7);
const OTHER_PR = pullRequestKey(123456, 8);

describe('resolveStatePath', () => {
  it('명시 경로가 환경변수와 기본 경로를 이긴다', () => {
    const env = { [STATE_PATH_VAR]: 'D:\\env.db', APPDATA: 'D:\\AppData' };
    expect(resolveStatePath('D:\\explicit.db', env, 'win32')).toBe('D:\\explicit.db');
  });

  it('환경변수가 기본 경로를 이긴다', () => {
    const env = { [STATE_PATH_VAR]: 'D:\\env.db', APPDATA: 'D:\\AppData' };
    expect(resolveStatePath(null, env, 'win32')).toBe('D:\\env.db');
  });

  it('win32 기본 경로는 APPDATA 아래다', () => {
    expect(resolveStatePath(null, { APPDATA: 'D:\\AppData' }, 'win32')).toBe(
      join('D:\\AppData', 'orca-slack-bridge', 'state.db'),
    );
  });

  it('비win32 기본 경로는 XDG_DATA_HOME 아래다. 설정이 아니라 state이므로 CONFIG가 아니다', () => {
    const env = { XDG_DATA_HOME: '/home/u/.local/share', XDG_CONFIG_HOME: '/home/u/.config' };
    expect(resolveStatePath(null, env, 'linux')).toBe(
      join('/home/u/.local/share', 'orca-slack-bridge', 'state.db'),
    );
  });

  it('비win32에 XDG_DATA_HOME이 없으면 ~/.local/share를 쓴다', () => {
    expect(resolveStatePath(null, {}, 'linux')).toBe(
      join(homedir(), '.local', 'share', 'orca-slack-bridge', 'state.db'),
    );
  });

  it('win32에 APPDATA가 없으면 추측하지 않고 XDG 규칙으로 내려간다', () => {
    expect(resolveStatePath(null, { XDG_DATA_HOME: '/data' }, 'win32')).toBe(
      join('/data', 'orca-slack-bridge', 'state.db'),
    );
  });

  it('빈 문자열은 지정하지 않은 것으로 본다', () => {
    expect(resolveStatePath('  ', { [STATE_PATH_VAR]: 'D:\\env.db' }, 'win32')).toBe('D:\\env.db');
  });
});

describe('SqliteDigestStore', () => {
  it('없는 부모 디렉터리를 만들고 WAL로 연다', () => {
    expect(existsSync(dbPath)).toBe(false);
    const store = new SqliteDigestStore(dbPath);
    store.close();

    expect(existsSync(dbPath)).toBe(true);
    // journal_mode는 파일에 남으므로 별도 연결로 확인할 수 있다.
    const raw = new DatabaseSync(dbPath);
    const mode = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const version = raw.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    raw.close();
    expect(mode.journal_mode).toBe('wal');
    expect(version).toEqual({ version: SCHEMA_VERSION });
  });

  it('기록이 없으면 null이다. 이것이 루트를 새로 만들라는 신호다', () => {
    const store = new SqliteDigestStore(dbPath);
    expect(store.findPrMessage(PR)).toBeNull();
    store.close();
  });

  it('같은 PR을 두 번 기록하면 던지고, 먼저 기록한 message identity가 남는다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.insertPrMessage({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1750000000.000100',
      renderFingerprint: 'fp-1',
      at: '2026-08-22T00:00:00.000Z',
    });

    expect(() =>
      store.insertPrMessage({
        prKey: PR,
        channelId: 'C0PRDIGEST',
        messageTs: '1750000999.000999',
        renderFingerprint: 'fp-2',
        at: '2026-08-22T01:00:00.000Z',
      }),
    ).toThrow(/UNIQUE constraint failed: pr_message\.pr_key/);

    // 두 번째 시도가 덮어쓰지 않았음을 확인한다. 덮어썼다면 앞서 게시한 루트를 잃는다.
    expect(store.findPrMessage(PR)).toEqual({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1750000000.000100',
      renderFingerprint: 'fp-1',
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    store.close();
  });

  it('두 PR이 같은 Slack 메시지를 가리킬 수 없다', () => {
    const store = new SqliteDigestStore(dbPath);
    const base = {
      channelId: 'C0PRDIGEST',
      messageTs: '1750000000.000100',
      renderFingerprint: 'fp-1',
      at: '2026-08-22T00:00:00.000Z',
    };
    store.insertPrMessage({ prKey: PR, ...base });
    expect(() => store.insertPrMessage({ prKey: OTHER_PR, ...base })).toThrow(
      /UNIQUE constraint failed: pr_message\.channel_id, pr_message\.message_ts/,
    );
    store.close();
  });

  it('같은 파일을 새 인스턴스로 열어도 기존 message identity를 찾는다', () => {
    const first = new SqliteDigestStore(dbPath);
    first.insertPrMessage({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1750000000.000100',
      renderFingerprint: 'fp-1',
      at: '2026-08-22T00:00:00.000Z',
    });
    first.close();

    // 다음 실행에 해당한다. 재관찰이 루트를 새로 만들지 않고 update로 가는 근거다.
    const second = new SqliteDigestStore(dbPath);
    const found = second.findPrMessage(PR);
    second.close();

    expect(found?.messageTs).toBe('1750000000.000100');
    expect(found?.channelId).toBe('C0PRDIGEST');
  });

  it('지문이 같으면 갱신이 필요 없고, 다르면 갱신한다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.insertPrMessage({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1750000000.000100',
      renderFingerprint: 'fp-1',
      at: '2026-08-22T00:00:00.000Z',
    });

    // 호출자의 판정: 지문이 같으면 chat.update를 부르지 않는다.
    const unchanged = store.findPrMessage(PR);
    expect(unchanged?.renderFingerprint).toBe('fp-1');
    expect(unchanged?.renderFingerprint === 'fp-1').toBe(true);

    store.updateRenderFingerprint(PR, 'fp-2', '2026-08-22T02:00:00.000Z');
    const changed = store.findPrMessage(PR);
    store.close();

    expect(changed?.renderFingerprint).toBe('fp-2');
    expect(changed?.updatedAt).toBe('2026-08-22T02:00:00.000Z');
    // created_at은 루트를 처음 만든 시각이므로 갱신이 건드리지 않는다.
    expect(changed?.createdAt).toBe('2026-08-22T00:00:00.000Z');
    // 갱신은 message identity를 바꾸지 않는다.
    expect(changed?.messageTs).toBe('1750000000.000100');
  });

  it('갱신한 지문은 다시 열어도 남는다', () => {
    const first = new SqliteDigestStore(dbPath);
    first.insertPrMessage({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1750000000.000100',
      renderFingerprint: 'fp-1',
      at: '2026-08-22T00:00:00.000Z',
    });
    first.updateRenderFingerprint(PR, 'fp-2', '2026-08-22T02:00:00.000Z');
    first.close();

    const second = new SqliteDigestStore(dbPath);
    const found = second.findPrMessage(PR);
    second.close();
    expect(found?.renderFingerprint).toBe('fp-2');
  });

  it('매핑 행이 없는 PR의 지문은 갱신하지 못한다. 새 행을 만들어 덮지 않는다', () => {
    const store = new SqliteDigestStore(dbPath);
    expect(() => store.updateRenderFingerprint(PR, 'fp-1', '2026-08-22T00:00:00.000Z')).toThrow(
      /매핑 행이 없어/,
    );
    expect(store.findPrMessage(PR)).toBeNull();
    store.close();
  });

  it('schema_version이 코드보다 높으면 추측해서 열지 않는다', () => {
    new SqliteDigestStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION + 1} WHERE id = 1`);
    raw.close();

    expect(() => new SqliteDigestStore(dbPath)).toThrow(SchemaVersionError);
    expect(() => new SqliteDigestStore(dbPath)).toThrow(
      new RegExp(`버전이 ${SCHEMA_VERSION + 1}인데 이 코드는 ${SCHEMA_VERSION}만 안다`),
    );
  });

  it('schema_version이 코드보다 낮아도 열지 않는다. C1에 migration이 없다', () => {
    new SqliteDigestStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('UPDATE schema_version SET version = 0 WHERE id = 1');
    raw.close();

    expect(() => new SqliteDigestStore(dbPath)).toThrow(SchemaVersionError);
  });

  it('버전 행이 없는 파일은 손상으로 보고 던진다', () => {
    new SqliteDigestStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('DELETE FROM schema_version');
    raw.close();

    expect(() => new SqliteDigestStore(dbPath)).toThrow(/버전 행이 없다/);
  });
});
