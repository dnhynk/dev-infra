import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SqliteDigestStore, SchemaVersionError, resolveStatePath } from '../src/store/sqlite.js';
import { MIGRATIONS, SCHEMA_VERSION, STATE_PATH_VAR } from '../src/store/schema.js';
import { pullRequestKey, runKey, taskKey } from '../src/identity/keys.js';

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
const RUN = runKey('run_36d28e6e947a');
const TASK_A = taskKey('task_42914531e46b');
const TASK_B = taskKey('task_8bf3d72f262a');

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

/**
 * 스키마 비교용 구조를 뽑는다.
 *
 * 컬럼 **이름만** 비교하면 type·notnull·default·PK가 갈라져도 통과하고 인덱스는 아예 보이지
 * 않는다. 그래서 `table_info` 행을 그대로 담고 인덱스 메타데이터를 함께 담는다. `cid`를
 * 지우지 않는 것이 의도다. `ALTER TABLE ADD COLUMN`은 맨 뒤에만 붙일 수 있으므로 컬럼
 * 순서도 계약이다.
 *
 * `sqlite_master`의 SQL 문자열은 비교하지 않는다. 올린 파일에는 v1 `CREATE TABLE` 뒤에
 * ALTER가 덧붙인 텍스트가 남고 새 파일에는 `SCHEMA_DDL` 원문이 남아, 스키마가 같아도
 * 문자열은 다르다.
 *
 * 인덱스는 이름으로 정렬한다. 같아야 하는 것은 생성 순서가 아니라 집합이다.
 */
function readSchemaShape(path: string) {
  const db = new DatabaseSync(path);
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        readonly name: string;
      }[]
    )
      .map((t) => t.name)
      // sqlite가 스스로 만드는 내부 테이블은 스키마 계약이 아니다.
      .filter((name) => !name.startsWith('sqlite_'));

    return tables.map((table) => ({
      table,
      columns: db.prepare(`PRAGMA table_info(${table})`).all(),
      indexes: (
        db.prepare(`PRAGMA index_list(${table})`).all() as {
          readonly name: string;
          readonly unique: number;
          readonly origin: string;
          readonly partial: number;
        }[]
      )
        .map(({ name, unique, origin, partial }) => ({
          name,
          unique,
          origin,
          partial,
          columns: db.prepare(`PRAGMA index_info(${name})`).all(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    }));
  } finally {
    db.close();
  }
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

    // 올린 파일과 새로 만든 파일의 스키마가 갈라지면 안 된다. SCHEMA_DDL에만 있고
    // MIGRATIONS에는 없는 컬럼(또는 그 반대)이 생기면 여기서 걸린다. 컬럼 이름뿐 아니라
    // type·notnull·default·PK와 인덱스까지 비교한다.
    const freshPath = join(dir, 'fresh', 'state.db');
    new SqliteDigestStore(freshPath).close();
    expect(readSchemaShape(dbPath)).toEqual(readSchemaShape(freshPath));
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
    // **마지막** 문장만 미리 적용한다. 그래야 첫 ALTER가 성공한 뒤 둘째가 실패해, 되돌릴
    // DDL이 트랜잭션 안에 실제로 남는다. 첫 문장을 미리 적용하면 아무것도 적용되기 전에
    // 실패하므로 BEGIN/ROLLBACK을 지운 구현도 이 테스트를 통과한다.
    const seed = new DatabaseSync(dbPath);
    seed.exec('ALTER TABLE pr_message ADD COLUMN summary_json TEXT');
    seed.close();

    // facts_fingerprint는 붙고 summary_json이 duplicate column name으로 실패한다.
    expect(() => new SqliteDigestStore(dbPath)).toThrow(/summary_json/);

    const raw = new DatabaseSync(dbPath);
    const version = raw.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    const columns = (raw.prepare('PRAGMA table_info(pr_message)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    const rows = raw.prepare('SELECT pr_key, message_ts FROM pr_message').all();
    raw.close();

    expect(version).toEqual({ version: 1 });
    // 이 단언 하나가 ROLLBACK을 검증한다. 성공했던 첫 ALTER가 되돌아가지 않으면 컬럼은
    // 붙었는데 버전은 v1인 파일이 남고 여기서 걸린다.
    expect(columns).not.toContain('facts_fingerprint');
    // 미리 심은 컬럼은 트랜잭션 밖에서 붙었으므로 그대로다.
    expect(columns).toContain('summary_json');
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

/**
 * v2 파일을 올려서 여는 경로.
 *
 * v1과 같은 이유로 여기에 v2 DDL을 그대로 적는다. 옛 스키마는 `schema.ts`에 남아 있지 않고,
 * 여기 적힌 것이 migration이 실제로 만나는 모양이다. v1 → v3 경로는 위 describe가 이미
 * 검증하므로(두 단계를 순서대로 적용한다) 여기서는 v2 → v3 한 단계만 본다.
 */
const V2_DDL = `
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
  updated_at         TEXT NOT NULL,
  facts_fingerprint  TEXT,
  summary_json       TEXT
);

CREATE UNIQUE INDEX pr_message_slack_identity ON pr_message (channel_id, message_ts);
`;

/** 게시된 카드의 매핑이 든 v2 파일을 만든다. */
function writeV2(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec(V2_DDL);
  raw
    .prepare('INSERT INTO schema_version (id, version, applied_at) VALUES (1, 2, ?)')
    .run('2026-08-22T12:58:31.014Z');
  raw
    .prepare(
      `INSERT INTO pr_message
         (pr_key, channel_id, message_ts, render_fingerprint, created_at, updated_at,
          facts_fingerprint, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      PR, 'C0PRDIGEST', '1787403740.833329', 'fp-v2',
      '2026-08-22T13:02:19.373Z', '2026-08-22T13:02:37.520Z',
      'facts-v2', '{"kind":"ok"}',
    );
  raw.close();
}

describe('v2 → v3 migration', () => {
  // 이 파일의 알려진 함정이다. SCHEMA_DDL에만 있고 MIGRATIONS에는 없는 테이블(또는 그 반대)이
  // 생기면 새 파일과 기존 파일이 다른 스키마로 갈라진다. 컬럼 이름뿐 아니라
  // type·notnull·default·PK와 인덱스까지 대조한다.
  it('올린 v2 파일과 새로 만든 v3 파일의 스키마가 같다', () => {
    writeV2(dbPath);
    new SqliteDigestStore(dbPath).close();

    const freshPath = join(dir, 'fresh', 'state.db');
    new SqliteDigestStore(freshPath).close();
    expect(readSchemaShape(dbPath)).toEqual(readSchemaShape(freshPath));
  });

  it('pr_task를 붙이고 버전을 올리며 기존 매핑 행을 그대로 둔다', () => {
    writeV2(dbPath);

    const store = new SqliteDigestStore(dbPath);
    const found = store.findPrMessage(PR);
    // 붙인 테이블은 비어 있다. 과거 Task를 소급해 채우지 않는다.
    const tasks = store.listPrTasks(PR);
    store.close();

    expect(found).toEqual({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1787403740.833329',
      renderFingerprint: 'fp-v2',
      factsFingerprint: 'facts-v2',
      summaryJson: '{"kind":"ok"}',
      createdAt: '2026-08-22T13:02:19.373Z',
      updatedAt: '2026-08-22T13:02:37.520Z',
    });
    expect(tasks).toEqual([]);

    const raw = new DatabaseSync(dbPath);
    const version = raw.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    raw.close();
    expect(version).toEqual({ version: SCHEMA_VERSION });
  });

  // 트랜잭션이 CREATE TABLE도 되돌리는지 본다. 되돌리지 않으면 테이블은 있는데 버전은 v2인
  // 파일이 남고, 다음 실행이 같은 CREATE TABLE을 다시 걸어 영영 열리지 않는다.
  it('migration이 실패하면 파일이 v2 그대로 남는다', () => {
    writeV2(dbPath);
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE pr_task (x TEXT)');
    seed.close();

    expect(() => new SqliteDigestStore(dbPath)).toThrow(/pr_task/);

    const raw = new DatabaseSync(dbPath);
    const version = raw.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    const rows = raw.prepare('SELECT pr_key, message_ts FROM pr_message').all();
    raw.close();
    expect(version).toEqual({ version: 2 });
    expect(rows).toEqual([{ pr_key: PR, message_ts: '1787403740.833329' }]);
  });
});

/**
 * PR↔Task N 연관(OD-076).
 *
 * PR body는 primary/latest Task 하나만 담으므로, 이 표가 남기지 않으면 이전 Task와의 연관을
 * 어디에서도 복원할 수 없다.
 */
describe('pr_task 연관', () => {
  const AT1 = '2026-08-23T01:00:00.000Z';
  const AT2 = '2026-08-23T02:00:00.000Z';
  const AT3 = '2026-08-23T03:00:00.000Z';

  it('한 PR에 Task가 여럿 남는다. 뒤 Task가 앞 Task를 덮지 않는다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    store.recordPrTask({ prKey: PR, taskKey: TASK_B, runKey: RUN, at: AT2 });
    const rows = store.listPrTasks(PR);
    store.close();

    expect(rows).toEqual([
      { prKey: PR, taskKey: TASK_A, runKey: RUN, firstSeenAt: AT1, lastSeenAt: AT1 },
      { prKey: PR, taskKey: TASK_B, runKey: RUN, firstSeenAt: AT2, lastSeenAt: AT2 },
    ]);
  });

  it('같은 쌍을 다시 관측하면 행이 늘지 않고 lastSeenAt만 옮긴다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    store.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT3 });
    const rows = store.listPrTasks(PR);
    store.close();

    // insertPrMessage와 달리 던지지 않는다. 같은 쌍의 반복 관측이 정상 경로다.
    expect(rows).toEqual([
      { prKey: PR, taskKey: TASK_A, runKey: RUN, firstSeenAt: AT1, lastSeenAt: AT3 },
    ]);
  });

  it('다른 PR의 연관은 섞이지 않고, 없는 PR은 빈 배열이다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    store.recordPrTask({ prKey: OTHER_PR, taskKey: TASK_B, runKey: RUN, at: AT2 });

    expect(store.listPrTasks(PR).map((r) => r.taskKey)).toEqual([TASK_A]);
    expect(store.listPrTasks(OTHER_PR).map((r) => r.taskKey)).toEqual([TASK_B]);
    expect(store.listPrTasks(pullRequestKey(999999, 1))).toEqual([]);
    store.close();
  });

  it('재시작해도 같은 파일에서 연관을 그대로 읽는다', () => {
    const first = new SqliteDigestStore(dbPath);
    first.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    first.recordPrTask({ prKey: PR, taskKey: TASK_B, runKey: RUN, at: AT2 });
    first.close();

    const second = new SqliteDigestStore(dbPath);
    const rows = second.listPrTasks(PR);
    second.close();
    expect(rows.map((r) => r.taskKey)).toEqual([TASK_A, TASK_B]);
  });

  // firstSeenAt이 같으면 taskKey 사전순으로 고정한다. 정렬을 지정하지 않으면 같은 파일이
  // 실행마다 다른 순서를 낼 수 있다.
  it('firstSeenAt이 같으면 taskKey 사전순이다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.recordPrTask({ prKey: PR, taskKey: TASK_B, runKey: RUN, at: AT1 });
    store.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    const rows = store.listPrTasks(PR);
    store.close();
    expect(rows.map((r) => r.taskKey)).toEqual([TASK_A, TASK_B]);
  });
});
