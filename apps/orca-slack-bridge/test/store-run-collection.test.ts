import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SqliteDigestStore, ReadOnlyDigestStore } from '../src/store/sqlite.js';
import { SCHEMA_VERSION, type RunStore } from '../src/store/schema.js';
import { pullRequestKey, runKey, taskKey } from '../src/identity/keys.js';

/**
 * schema v6 `run_collection_message`(OD-080).
 *
 * **실제 사용자 store를 건드리지 않는다.** 임시 디렉터리의 파일만 연다. 모킹하지 않는 것도
 * 의도다 — 모킹하면 검증 대상인 sqlite 제약(PRIMARY KEY, CHECK)이 사라진다.
 *
 * v1 → v5 경로는 `store.test.ts`와 `store-run.test.ts`가 단계별로 검증한다. 여기서는
 * v5 → v6 한 단계만 본다.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-store-collection-'));
  dbPath = join(dir, 'nested', 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RUN = runKey('run_36d28e6e947a');
const PR = pullRequestKey(1057758478, 25);
const TASK = taskKey('task_42914531e46b');
const CHANNEL = 'C0AGENTRUNS';
const AT1 = '2026-08-24T01:00:00.000Z';
const AT2 = '2026-08-24T02:00:00.000Z';
const TS = '1787403740.000001';
const HEAD = 'a'.repeat(40);

/**
 * v5 파일을 올려서 여는 경로.
 *
 * v1~v4와 같은 이유로 v5 DDL을 여기 그대로 적는다. 옛 스키마는 `schema.ts`에 남아 있지 않고,
 * 여기 적힌 것이 migration이 실제로 만나는 모양이다.
 */
const V5_DDL = `
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

CREATE TABLE pr_task (
  pr_key        TEXT NOT NULL,
  task_key      TEXT NOT NULL,
  run_key       TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (pr_key, task_key)
);

CREATE TABLE pr_state (
  pr_key            TEXT PRIMARY KEY,
  terminal          TEXT NOT NULL,
  merged_at         TEXT,
  review_verdict    TEXT,
  reviewed_head_sha TEXT,
  head_sha          TEXT NOT NULL,
  checks_head_sha   TEXT NOT NULL,
  checks_json       TEXT NOT NULL,
  observed_at       TEXT NOT NULL
);

CREATE TABLE pr_thread_event (
  pr_key      TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  message_ts  TEXT,
  PRIMARY KEY (pr_key, dedupe_key)
);

CREATE TABLE run_message (
  run_key            TEXT PRIMARY KEY,
  channel_id         TEXT NOT NULL,
  message_ts         TEXT NOT NULL,
  render_fingerprint TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX run_message_slack_identity ON run_message (channel_id, message_ts);
`;

/** 여섯 표에 모두 행이 든 v5 파일을 만든다. migration이 그 행들을 그대로 두는지 본다. */
function writeV5(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec(V5_DDL);
  raw
    .prepare('INSERT INTO schema_version (id, version, applied_at) VALUES (1, 5, ?)')
    .run('2026-08-24T00:58:31.014Z');
  raw
    .prepare(
      `INSERT INTO pr_message
         (pr_key, channel_id, message_ts, render_fingerprint, created_at, updated_at,
          facts_fingerprint, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(PR, 'C0PRDIGEST', '1787403740.833329', 'fp-v5', AT1, AT2, 'facts-v5', '{"kind":"ok"}');
  raw
    .prepare(
      `INSERT INTO pr_task (pr_key, task_key, run_key, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(PR, TASK, RUN, AT1, AT2);
  raw
    .prepare(
      `INSERT INTO pr_state
         (pr_key, terminal, merged_at, review_verdict, reviewed_head_sha, head_sha,
          checks_head_sha, checks_json, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(PR, 'merged', AT2, 'approve', HEAD, HEAD, HEAD, '[]', AT2);
  raw
    .prepare(
      `INSERT INTO pr_thread_event (pr_key, dedupe_key, kind, recorded_at, message_ts)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(PR, 'terminal:merged', 'merged', AT2, '1700000001.000001');
  raw
    .prepare(
      `INSERT INTO run_message
         (run_key, channel_id, message_ts, render_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(RUN, CHANNEL, '1787403741.000009', 'fp-run-v5', AT1, AT2);
  raw.close();
}

/**
 * 스키마 비교용 구조를 뽑는다.
 *
 * `store.test.ts`·`store-run.test.ts`의 같은 이름 함수와 같은 대조 범위다. 컬럼 이름만 비교하면
 * type·notnull·default·PK가 갈라져도 통과하고 인덱스는 아예 보이지 않으므로 `table_info` 행을
 * 그대로 담고 인덱스 메타데이터를 함께 담는다. `cid`를 지우지 않는 것이 의도다 —
 * `ALTER TABLE ADD COLUMN`은 맨 뒤에만 붙일 수 있으므로 컬럼 순서도 계약이다.
 *
 * **대조하지 못하는 것: CHECK 제약**, foreign key, trigger, collation, 인덱스 sort order,
 * partial index의 WHERE 절, generated/hidden 컬럼. v6이 CHECK를 새로 들여왔으므로 그 축은
 * 이 함수가 아니라 아래 `rejectsSecondRow`가 **동작으로** 대조한다. `sqlite_master.sql` 문자열
 * 비교로 넓히지 않는 이유는 그 값이 새 파일과 올린 파일에서 서로 다른 텍스트를 담기 때문이다.
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

/**
 * `CHECK (id = 1)`이 실제로 걸려 있는지 본다. `readSchemaShape`가 보지 못하는 축이다.
 *
 * `id = 2`를 직접 넣어 본다. CHECK가 없으면 두 번째 행이 들어가고, 그 순간 "어느 것이 현재
 * 컬렉션 루트인가"의 답이 사라진다.
 */
function rejectsSecondRow(path: string): boolean {
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      `INSERT INTO run_collection_message
         (id, channel_id, message_ts, render_fingerprint, created_at, updated_at)
       VALUES (2, ?, ?, ?, ?, ?)`,
    ).run(CHANNEL, TS, 'fp', AT1, AT1);
    return false;
  } catch {
    return true;
  } finally {
    db.close();
  }
}

describe('v5 → current migration (v6 collection step 포함)', () => {
  // 이 파일의 알려진 함정이다. SCHEMA_DDL에만 있고 MIGRATIONS에는 없는 테이블(또는 그 반대)이
  // 생기면 새 파일과 기존 파일이 다른 스키마로 갈라진다.
  it('올린 v5 파일과 새로 만든 v6 파일의 스키마가 같다', () => {
    writeV5(dbPath);
    new SqliteDigestStore(dbPath).close();

    const freshPath = join(dir, 'fresh', 'state.db');
    new SqliteDigestStore(freshPath).close();
    expect(readSchemaShape(dbPath)).toEqual(readSchemaShape(freshPath));
  });

  // `readSchemaShape`가 CHECK를 보지 못하므로 그 축만 따로 본다. 한쪽에만 CHECK가 걸리면
  // 두 파일이 같은 스키마라는 위 단언이 통과하면서도 서로 다르게 동작한다.
  it('두 파일 모두 두 번째 행을 거부한다 (CHECK (id = 1))', () => {
    writeV5(dbPath);
    new SqliteDigestStore(dbPath).close();
    const freshPath = join(dir, 'fresh', 'state.db');
    new SqliteDigestStore(freshPath).close();

    expect(rejectsSecondRow(dbPath)).toBe(true);
    expect(rejectsSecondRow(freshPath)).toBe(true);
  });

  it('run_collection_message 표를 붙이고 current 버전까지 올린다', () => {
    writeV5(dbPath);

    const store = new SqliteDigestStore(dbPath);
    // 붙인 표는 비어 있다. 과거에 게시한 컬렉션 카드가 없으므로 소급해 채울 값도 없다.
    const found = store.findRunCollectionMessage();
    store.close();
    expect(found).toBeNull();

    const raw = new DatabaseSync(dbPath);
    const version = raw.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    raw.close();
    expect(version).toEqual({ version: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(16);
  });

  it('기존 여섯 표의 행을 그대로 둔다', () => {
    writeV5(dbPath);

    const store = new SqliteDigestStore(dbPath);
    const message = store.findPrMessage(PR);
    const tasks = store.listPrTasks(PR);
    const state = store.findPrState(PR);
    const events = store.listThreadEvents(PR);
    const runMessage = store.findRunMessage(RUN);
    store.close();

    expect(message).toEqual({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1787403740.833329',
      renderFingerprint: 'fp-v5',
      factsFingerprint: 'facts-v5',
      summaryJson: '{"kind":"ok"}',
      createdAt: AT1,
      updatedAt: AT2,
    });
    expect(tasks).toEqual([
      { prKey: PR, taskKey: TASK, runKey: RUN, firstSeenAt: AT1, lastSeenAt: AT2 },
    ]);
    expect(state?.terminal).toBe('merged');
    expect(events.map((e) => e.dedupeKey)).toEqual(['terminal:merged']);
    // 이 행을 잃으면 이미 게시한 Run 루트를 잃어 다음 관찰이 루트를 하나 더 만든다.
    expect(runMessage).toEqual({
      runKey: RUN,
      channelId: CHANNEL,
      messageTs: '1787403741.000009',
      renderFingerprint: 'fp-run-v5',
      createdAt: AT1,
      updatedAt: AT2,
    });
  });

  // 트랜잭션이 되돌리는지 본다. 되돌리지 않으면 표는 있는데 버전은 v5인 파일이 남고, 다음
  // 실행이 같은 CREATE TABLE을 다시 걸어 영영 열리지 않는다.
  it('migration이 실패하면 파일이 v5 그대로 남는다', () => {
    writeV5(dbPath);
    const seed = new DatabaseSync(dbPath);
    // 이름을 먼저 점유해 CREATE TABLE을 실패시킨다.
    seed.exec('CREATE TABLE run_collection_message (x TEXT)');
    seed.close();

    expect(() => new SqliteDigestStore(dbPath)).toThrow(/run_collection_message/);

    const raw = new DatabaseSync(dbPath);
    const version = raw.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    const rows = raw.prepare('SELECT run_key, message_ts FROM run_message').all();
    raw.close();
    expect(version).toEqual({ version: 5 });
    expect(rows).toEqual([{ run_key: RUN, message_ts: '1787403741.000009' }]);
  });
});

describe('run_collection_message 매핑', () => {
  it('없으면 null이다. 그것이 컬렉션 루트를 아직 만들지 않았다는 뜻이다', () => {
    const store = new SqliteDigestStore(dbPath);
    const found = store.findRunCollectionMessage();
    store.close();
    expect(found).toBeNull();
  });

  it('기록한 뒤 같은 값을 되읽는다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.insertRunCollectionMessage({
      channelId: CHANNEL,
      messageTs: TS,
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    const found = store.findRunCollectionMessage();
    store.close();
    expect(found).toEqual({
      channelId: CHANNEL,
      messageTs: TS,
      renderFingerprint: 'fp-1',
      createdAt: AT1,
      updatedAt: AT1,
    });
  });

  // 조용히 덮어쓰면 앞서 게시한 Slack 루트를 잃는다. `insertRunMessage`와 같은 판정이다.
  it('두 번째 insert는 던진다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.insertRunCollectionMessage({
      channelId: CHANNEL,
      messageTs: TS,
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    expect(() =>
      store.insertRunCollectionMessage({
        channelId: CHANNEL,
        messageTs: '1787403740.000002',
        renderFingerprint: 'fp-2',
        at: AT2,
      }),
    ).toThrow(/컬렉션 루트 메시지를 기록할 수 없다/);
    store.close();
  });

  it('갱신은 지문과 updated_at만 옮기고 message identity는 그대로 둔다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.insertRunCollectionMessage({
      channelId: CHANNEL,
      messageTs: TS,
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    store.updateRunCollectionObservation('fp-2', AT2);
    const found = store.findRunCollectionMessage();
    store.close();
    expect(found).toEqual({
      channelId: CHANNEL,
      messageTs: TS,
      renderFingerprint: 'fp-2',
      createdAt: AT1,
      updatedAt: AT2,
    });
  });

  // 갱신할 행이 없다는 것은 호출 순서가 깨졌다는 뜻이다. 새 행을 만들어 덮지 않는다.
  it('행이 없는데 갱신하면 던진다', () => {
    const store = new SqliteDigestStore(dbPath);
    expect(() => store.updateRunCollectionObservation('fp-1', AT1)).toThrow(/매핑 행이 없어/);
    store.close();
  });

  // 재시작 뒤에도 같은 루트를 재사용한다. 판정 근거가 프로세스 메모리가 아니라 파일이다.
  it('재시작 뒤에도 같은 행을 읽는다', () => {
    const first = new SqliteDigestStore(dbPath);
    first.insertRunCollectionMessage({
      channelId: CHANNEL,
      messageTs: TS,
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    first.close();

    const second = new SqliteDigestStore(dbPath);
    const found = second.findRunCollectionMessage();
    second.close();
    expect(found?.messageTs).toBe(TS);
  });
});

describe('dry-run store의 컬렉션 루트', () => {
  it('기존 행을 읽되 write는 던진다', () => {
    const live = new SqliteDigestStore(dbPath);
    live.insertRunCollectionMessage({
      channelId: CHANNEL,
      messageTs: TS,
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    live.close();

    // 인터페이스 타입으로 받는다. 구현 클래스의 write 메서드는 인자를 받지 않고 던지기만 하므로,
    // 구체 타입으로 받으면 호출자가 실제로 넘기는 인자를 이 자리에서 볼 수 없다.
    const dry: RunStore & { close(): void } = new ReadOnlyDigestStore(dbPath);
    try {
      // 읽지 못하면 이미 루트가 있는데 create로 보고하고, 그 보고를 믿고 게시하면 루트가 둘이 된다.
      expect(dry.findRunCollectionMessage()?.messageTs).toBe(TS);
      expect(() =>
        dry.insertRunCollectionMessage({
          channelId: CHANNEL,
          messageTs: TS,
          renderFingerprint: 'fp-2',
          at: AT2,
        }),
      ).toThrow(/dry-run/);
      expect(() => dry.updateRunCollectionObservation('fp-2', AT2)).toThrow(/dry-run/);
    } finally {
      dry.close();
    }
  });

  it('파일이 없으면 행 없음으로 다룬다', () => {
    const dry = new ReadOnlyDigestStore(dbPath);
    try {
      expect(dry.findRunCollectionMessage()).toBeNull();
    } finally {
      dry.close();
    }
  });
});
