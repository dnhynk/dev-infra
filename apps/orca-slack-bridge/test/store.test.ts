import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SqliteDigestStore, SchemaVersionError, resolveStatePath } from '../src/store/sqlite.js';
import { MIGRATIONS, SCHEMA_VERSION, STATE_PATH_VAR } from '../src/store/schema.js';
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

  // XDG 명세: 상대경로는 invalid이므로 무시하고 기본값으로 간다. 던지지 않는다.
  // http://specifications.freedesktop.org/basedir/latest/
  it('상대 XDG_DATA_HOME은 무효로 보고 무시한다. cwd에 state.db를 만들지 않는다', () => {
    const fallback = join(homedir(), '.local', 'share', 'orca-slack-bridge', 'state.db');
    expect(resolveStatePath(null, { XDG_DATA_HOME: 'relative/data' }, 'linux')).toBe(fallback);
    expect(resolveStatePath(null, { XDG_DATA_HOME: '.' }, 'linux')).toBe(fallback);
  });

  // node:path의 최상위 isAbsolute는 인자로 받은 platform이 아니라 실행 호스트를 따른다.
  // 고정하지 않으면 win32 호스트에서 linux 분기를 검증할 때 Windows 형식이 유효한 XDG
  // base로 통과해, platform 인자로 나머지 분기를 검증한다는 전제가 무너진다.
  // 상대경로만으로는 두 구현이 양쪽에서 모두 false라 이 어긋남이 드러나지 않는다.
  it('XDG_DATA_HOME 절대성은 POSIX 규칙으로만 판정한다. Windows 형식은 무효다', () => {
    const fallback = join(homedir(), '.local', 'share', 'orca-slack-bridge', 'state.db');
    expect(resolveStatePath(null, { XDG_DATA_HOME: 'C:\\Users\\u\\data' }, 'linux')).toBe(fallback);
    expect(resolveStatePath(null, { XDG_DATA_HOME: '\\\\srv\\share' }, 'linux')).toBe(fallback);
  });

  // 설정 파일과 달리 DB 경로가 어긋나면 오류 없이 다른 파일이 열려 기존 카드를 잃는다.
  // 그래서 defaultConfigPath와 달리 XDG로 내려가지 않고 던진다.
  it('win32에 APPDATA가 없으면 XDG로 내려가지 않고 던진다', () => {
    expect(() => resolveStatePath(null, { XDG_DATA_HOME: '/data' }, 'win32')).toThrow(
      /APPDATA가 없어/,
    );
    // 해결책을 메시지에 담는다.
    expect(() => resolveStatePath(null, {}, 'win32')).toThrow(new RegExp(STATE_PATH_VAR));
  });

  it('win32에 APPDATA가 없어도 명시 경로나 환경변수가 있으면 던지지 않는다', () => {
    expect(resolveStatePath('D:\\explicit.db', {}, 'win32')).toBe('D:\\explicit.db');
    expect(resolveStatePath(null, { [STATE_PATH_VAR]: 'D:\\env.db' }, 'win32')).toBe('D:\\env.db');
  });

  it('빈 문자열은 지정하지 않은 것으로 본다', () => {
    expect(resolveStatePath('  ', { [STATE_PATH_VAR]: 'D:\\env.db' }, 'win32')).toBe('D:\\env.db');
  });

  // 환경변수는 한 번 설정되면 cwd가 다른 프로세스에도 상속된다. 상대경로면 실행 위치마다
  // 다른 파일이 조용히 열려 기존 pr_message 매핑을 잃고 Slack 루트가 중복된다. 사용자가
  // 명시적으로 준 값이 잘못된 것이므로 상대 XDG_DATA_HOME처럼 조용히 대체하지 않는다.
  it('상대 환경변수는 던진다. 메시지에 원인과 해결책을 담는다', () => {
    expect(() => resolveStatePath(null, { [STATE_PATH_VAR]: 'state.db' }, 'linux')).toThrow(
      new RegExp(`${STATE_PATH_VAR}가 상대경로다`),
    );
    expect(() =>
      resolveStatePath(null, { [STATE_PATH_VAR]: 'sub/state.db', APPDATA: 'D:\\AppData' }, 'win32'),
    ).toThrow(/실행 위치마다 다른 파일이 열린다/);
    expect(() => resolveStatePath(null, { [STATE_PATH_VAR]: 'state.db' }, 'linux')).toThrow(
      /절대경로를 지정하거나/,
    );
    expect(() => resolveStatePath(null, { [STATE_PATH_VAR]: 'state.db' }, 'linux')).toThrow(
      /--state로 넘긴다/,
    );
  });

  // --state는 매 실행에서 호출자가 눈으로 보고 넘기는 인자다. cwd 기준 상대경로가 통상적인
  // CLI 의미이고 무엇이 열리는지 그 자리에서 알 수 있다. 환경변수와 판정이 다른 이유다.
  it('상대 --state는 그대로 쓴다. 환경변수와 달리 던지지 않는다', () => {
    expect(resolveStatePath('state.db', {}, 'linux')).toBe('state.db');
    expect(resolveStatePath('sub/state.db', {}, 'win32')).toBe('sub/state.db');
    // 상대 --state는 상대 환경변수를 이기고, 환경변수 판정에 걸리지도 않는다.
    expect(resolveStatePath('state.db', { [STATE_PATH_VAR]: 'other.db' }, 'linux')).toBe(
      'state.db',
    );
  });

  // 절대성은 실행 호스트가 아니라 대상 platform의 경로 규칙으로 판정한다.
  it('환경변수 절대성은 대상 platform 규칙을 따른다', () => {
    // linux에서 'C:\state.db'는 파일 이름에 콜론과 역슬래시가 든 상대경로다.
    expect(() => resolveStatePath(null, { [STATE_PATH_VAR]: 'C:\\state.db' }, 'linux')).toThrow(
      new RegExp(`${STATE_PATH_VAR}가 상대경로다`),
    );
    expect(() => resolveStatePath(null, { [STATE_PATH_VAR]: '\\\\srv\\s.db' }, 'linux')).toThrow(
      new RegExp(`${STATE_PATH_VAR}가 상대경로다`),
    );
    // win32에서 '/var/lib/state.db'는 현재 드라이브 루트 기준 절대경로다.
    expect(resolveStatePath(null, { [STATE_PATH_VAR]: '/var/lib/state.db' }, 'win32')).toBe(
      '/var/lib/state.db',
    );
    expect(resolveStatePath(null, { [STATE_PATH_VAR]: '/var/lib/state.db' }, 'linux')).toBe(
      '/var/lib/state.db',
    );
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

  it('WAL로 전환되지 않으면 실제 mode를 담아 던진다', () => {
    // :memory:는 원리적으로 WAL이 될 수 없고 sqlite는 예외 대신 memory를 돌려준다.
    // 결과를 확인하지 않으면 WAL이 아닌 채로 스키마 준비까지 성공한다. 특례를 두지 않는다.
    expect(() => new SqliteDigestStore(':memory:')).toThrow(/WAL로 열지 못했다/);
    expect(() => new SqliteDigestStore(':memory:')).toThrow(/journal mode는 memory이다/);
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
      factsFingerprint: 'facts-1',
      summaryJson: null,
      at: '2026-08-22T00:00:00.000Z',
    });

    expect(() =>
      store.insertPrMessage({
        prKey: PR,
        channelId: 'C0PRDIGEST',
        messageTs: '1750000999.000999',
        renderFingerprint: 'fp-2',
        factsFingerprint: 'facts-2',
        summaryJson: null,
        at: '2026-08-22T01:00:00.000Z',
      }),
    ).toThrow(/UNIQUE constraint failed: pr_message\.pr_key/);

    // 두 번째 시도가 덮어쓰지 않았음을 확인한다. 덮어썼다면 앞서 게시한 루트를 잃는다.
    expect(store.findPrMessage(PR)).toEqual({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1750000000.000100',
      renderFingerprint: 'fp-1',
      factsFingerprint: 'facts-1',
      summaryJson: null,
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
      factsFingerprint: 'facts-1',
      summaryJson: null,
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
      factsFingerprint: 'facts-1',
      summaryJson: null,
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
      factsFingerprint: 'facts-1',
      summaryJson: null,
      at: '2026-08-22T00:00:00.000Z',
    });

    // 호출자의 판정: 지문이 같으면 chat.update를 부르지 않는다.
    const unchanged = store.findPrMessage(PR);
    expect(unchanged?.renderFingerprint).toBe('fp-1');
    expect(unchanged?.renderFingerprint === 'fp-1').toBe(true);

    store.updateObservation(
      PR,
      { renderFingerprint: 'fp-2', factsFingerprint: 'facts-2', summaryJson: '{"t":1}' },
      '2026-08-22T02:00:00.000Z',
    );
    const changed = store.findPrMessage(PR);
    store.close();

    expect(changed?.renderFingerprint).toBe('fp-2');
    expect(changed?.factsFingerprint).toBe('facts-2');
    expect(changed?.summaryJson).toBe('{"t":1}');
    expect(changed?.updatedAt).toBe('2026-08-22T02:00:00.000Z');
    // created_at은 루트를 처음 만든 시각이므로 갱신이 건드리지 않는다.
    expect(changed?.createdAt).toBe('2026-08-22T00:00:00.000Z');
    // 갱신은 message identity를 바꾸지 않는다.
    expect(changed?.messageTs).toBe('1750000000.000100');
    expect(changed?.channelId).toBe('C0PRDIGEST');
  });

  it('갱신한 관찰 결과는 다시 열어도 남는다', () => {
    const first = new SqliteDigestStore(dbPath);
    first.insertPrMessage({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1750000000.000100',
      renderFingerprint: 'fp-1',
      factsFingerprint: 'facts-1',
      summaryJson: null,
      at: '2026-08-22T00:00:00.000Z',
    });
    first.updateObservation(
      PR,
      { renderFingerprint: 'fp-2', factsFingerprint: 'facts-2', summaryJson: '{"t":1}' },
      '2026-08-22T02:00:00.000Z',
    );
    first.close();

    const second = new SqliteDigestStore(dbPath);
    const found = second.findPrMessage(PR);
    second.close();
    expect(found?.renderFingerprint).toBe('fp-2');
    expect(found?.factsFingerprint).toBe('facts-2');
    expect(found?.summaryJson).toBe('{"t":1}');
  });

  it('매핑 행이 없는 PR의 관찰 결과는 갱신하지 못한다. 새 행을 만들어 덮지 않는다', () => {
    const store = new SqliteDigestStore(dbPath);
    expect(() =>
      store.updateObservation(
        PR,
        { renderFingerprint: 'fp-1', factsFingerprint: 'facts-1', summaryJson: null },
        '2026-08-22T00:00:00.000Z',
      ),
    ).toThrow(/매핑 행이 없어/);
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
      new RegExp(`버전이 ${SCHEMA_VERSION + 1}인데 이 코드는 ${SCHEMA_VERSION}까지 안다`),
    );
  });

  it('MIGRATIONS가 시작하는 버전보다 낮으면 올릴 문장이 없어 던진다', () => {
    new SqliteDigestStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('UPDATE schema_version SET version = 0 WHERE id = 1');
    raw.close();

    expect(() => new SqliteDigestStore(dbPath)).toThrow(SchemaVersionError);
  });

  it('SCHEMA_VERSION과 MIGRATIONS 길이가 어긋나지 않는다', () => {
    // 어긋나면 v1 파일이 중간 버전에서 멈추거나 없는 문장을 찾는다. 값 두 개를 함께 고치는
    // 것을 잊지 않게 여기서 고정한다.
    expect(MIGRATIONS).toHaveLength(SCHEMA_VERSION - 1);
  });
});

/**
 * v1 파일을 올려서 여는 경로.
 *
 * 실제 `%APPDATA%\orca-slack-bridge\state.db`가 v1이고 이미 게시된 카드의 매핑이 들어 있다.
 * 그 파일을 열지 못하면 다음 게시가 루트를 하나 더 만든다. 그래서 "기존 행이 그대로 남는다"를
 * 단언한다.
 *
 * v1 DDL을 이 파일에 그대로 적는다. 옛 스키마는 과거의 산출물이라 `schema.ts`에 남아 있지
 * 않고, 남기면 지금 스키마와 헷갈린다. 여기 적힌 것이 migration이 실제로 만나는 모양이다.
 */
const V1_DDL = `
CREATE TABLE schema_version (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    INTEGER NOT NULL,
  applied_at TEXT    NOT NULL
);

CREATE TABLE pr_message (
  pr_key             TEXT PRIMARY KEY,
  channel_id         TEXT NOT NULL,
  message_ts         TEXT NOT NULL,
  render_fingerprint TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX pr_message_slack_identity ON pr_message (channel_id, message_ts);
`;

/** 게시된 카드의 매핑이 든 v1 파일을 만든다. */
function writeV1(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec(V1_DDL);
  raw
    .prepare('INSERT INTO schema_version (id, version, applied_at) VALUES (1, 1, ?)')
    .run('2026-08-22T12:58:31.014Z');
  raw
    .prepare(
      `INSERT INTO pr_message
         (pr_key, channel_id, message_ts, render_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(PR, 'C0PRDIGEST', '1787403740.833329', 'fp-v1', '2026-08-22T13:02:19.373Z', '2026-08-22T13:02:37.520Z');
  raw.close();
}

describe('v1 → v2 migration', () => {
  it('컬럼을 붙이고 버전을 올리며 기존 행을 그대로 둔다', () => {
    writeV1(dbPath);

    const store = new SqliteDigestStore(dbPath);
    const found = store.findPrMessage(PR);
    store.close();

    // 기존 행이 살아 있다. 잃으면 다음 게시가 루트를 하나 더 만든다.
    expect(found).toEqual({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1787403740.833329',
      renderFingerprint: 'fp-v1',
      // 붙인 컬럼은 비어 있다. "비교 불가"이므로 다음 관찰이 한 번 요약하고 채운다.
      factsFingerprint: null,
      summaryJson: null,
      createdAt: '2026-08-22T13:02:19.373Z',
      updatedAt: '2026-08-22T13:02:37.520Z',
    });

    const raw = new DatabaseSync(dbPath);
    const version = raw.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    const columns = (raw.prepare('PRAGMA table_info(pr_message)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    raw.close();
    expect(version).toEqual({ version: SCHEMA_VERSION });
    expect(columns).toContain('facts_fingerprint');
    expect(columns).toContain('summary_json');

    // 올린 파일과 새로 만든 파일의 스키마가 갈라지면 안 된다. ALTER TABLE ADD COLUMN은
    // 맨 뒤에만 붙일 수 있으므로 DDL의 컬럼 순서도 그것을 따라야 한다.
    const freshPath = join(dir, 'fresh', 'state.db');
    new SqliteDigestStore(freshPath).close();
    const fresh = new DatabaseSync(freshPath);
    const freshColumns = (fresh.prepare('PRAGMA table_info(pr_message)').all() as {
      name: string;
    }[]).map((c) => c.name);
    fresh.close();
    expect(columns).toEqual(freshColumns);
  });

  it('올린 파일을 다시 열어도 같은 행을 찾는다. 두 번째 열기는 아무것도 바꾸지 않는다', () => {
    writeV1(dbPath);
    new SqliteDigestStore(dbPath).close();

    const second = new SqliteDigestStore(dbPath);
    const found = second.findPrMessage(PR);
    second.close();
    expect(found?.messageTs).toBe('1787403740.833329');
    expect(found?.renderFingerprint).toBe('fp-v1');
  });

  // 트랜잭션이 실제로 DDL을 되돌리는지 확인한다. 되돌리지 않으면 컬럼은 붙었는데 버전은
  // v1인 파일이 남고, 다음 실행이 같은 ALTER TABLE을 다시 걸어 영영 열리지 않는다.
  // 그 파일에는 이미 게시된 카드의 매핑이 들어 있다.
  it('migration이 중간에 실패하면 파일이 v1 그대로 남는다', () => {
    writeV1(dbPath);
    // 첫 문장이 이미 적용된 파일. 트랜잭션이 없던 구현이 중간에 죽으면 이 모양이 된다.
    const seed = new DatabaseSync(dbPath);
    seed.exec('ALTER TABLE pr_message ADD COLUMN facts_fingerprint TEXT');
    seed.close();

    // 두 번째 ALTER는 성공하고 첫 번째가 duplicate column name으로 실패한다.
    expect(() => new SqliteDigestStore(dbPath)).toThrow(/facts_fingerprint/);

    const raw = new DatabaseSync(dbPath);
    const version = raw.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    const columns = (raw.prepare('PRAGMA table_info(pr_message)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    const rows = raw.prepare('SELECT pr_key, message_ts FROM pr_message').all();
    raw.close();

    expect(version).toEqual({ version: 1 });
    // 같은 트랜잭션의 두 번째 문장이 되돌아갔다. 절반만 적용된 파일이 남지 않는다.
    expect(columns).not.toContain('summary_json');
    // 매핑 행은 그대로다.
    expect(rows).toEqual([{ pr_key: PR, message_ts: '1787403740.833329' }]);
  });

  it('비어 있던 사실 지문은 갱신 한 번으로 채워진다', () => {
    writeV1(dbPath);
    const store = new SqliteDigestStore(dbPath);
    expect(store.findPrMessage(PR)?.factsFingerprint).toBeNull();

    store.updateObservation(
      PR,
      { renderFingerprint: 'fp-v1', factsFingerprint: 'facts-1', summaryJson: '{"t":1}' },
      '2026-08-22T14:00:00.000Z',
    );
    const filled = store.findPrMessage(PR);
    store.close();

    expect(filled?.factsFingerprint).toBe('facts-1');
    expect(filled?.summaryJson).toBe('{"t":1}');
    // 채우는 갱신이 message identity를 건드리지 않는다.
    expect(filled?.messageTs).toBe('1787403740.833329');
    expect(filled?.createdAt).toBe('2026-08-22T13:02:19.373Z');
  });

  it('버전 행이 없는 파일은 손상으로 보고 던진다', () => {
    new SqliteDigestStore(dbPath).close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('DELETE FROM schema_version');
    raw.close();

    expect(() => new SqliteDigestStore(dbPath)).toThrow(/버전 행이 없다/);
  });
});
