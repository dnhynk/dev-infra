import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dispatchKey, gateKey, pullRequestKey, runKey, taskKey } from '../src/identity/keys.js';
import { ReadOnlyDigestStore, SqliteDigestStore } from '../src/store/sqlite.js';
import { SCHEMA_VERSION, type GateStore } from '../src/store/schema.js';
import type { GateMetadata } from '../src/gate/types.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-store-gate-'));
  dbPath = join(dir, 'nested', 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RUN = runKey('run_d2a');
const TASK = taskKey('task_gate');
const GATE = gateKey('gate_static');
const AT1 = '2026-08-24T07:00:00.000Z';
const AT2 = '2026-08-24T08:00:00.000Z';
const CHANNEL = 'C0AGENTRUNS';
const ROOT_TS = '1787554800.000001';
const GATE_TS = '1787554800.000002';

const V6_DDL = `
CREATE TABLE schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE pr_message (
  pr_key TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_ts TEXT NOT NULL,
  render_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  facts_fingerprint TEXT, summary_json TEXT
);
CREATE UNIQUE INDEX pr_message_slack_identity ON pr_message (channel_id, message_ts);
CREATE TABLE pr_task (
  pr_key TEXT NOT NULL, task_key TEXT NOT NULL, run_key TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (pr_key, task_key)
);
CREATE TABLE pr_state (
  pr_key TEXT PRIMARY KEY, terminal TEXT NOT NULL, merged_at TEXT, review_verdict TEXT,
  reviewed_head_sha TEXT, head_sha TEXT NOT NULL, checks_head_sha TEXT NOT NULL,
  checks_json TEXT NOT NULL, observed_at TEXT NOT NULL
);
CREATE TABLE pr_thread_event (
  pr_key TEXT NOT NULL, dedupe_key TEXT NOT NULL, kind TEXT NOT NULL,
  recorded_at TEXT NOT NULL, message_ts TEXT, PRIMARY KEY (pr_key, dedupe_key)
);
CREATE TABLE run_message (
  run_key TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_ts TEXT NOT NULL,
  render_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX run_message_slack_identity ON run_message (channel_id, message_ts);
CREATE TABLE run_collection_message (
  id INTEGER PRIMARY KEY CHECK (id = 1), channel_id TEXT NOT NULL, message_ts TEXT NOT NULL,
  render_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

function writeV6(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(V6_DDL);
  db.prepare('INSERT INTO schema_version (id, version, applied_at) VALUES (1, 6, ?)').run(AT1);
  const pr = pullRequestKey(1057758478, 31);
  db.prepare(
    `INSERT INTO pr_message
       (pr_key, channel_id, message_ts, render_fingerprint, created_at, updated_at,
        facts_fingerprint, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(pr, 'C0PRDIGEST', '1700.1', 'pr-fp', AT1, AT2, 'facts', '{"kind":"ok"}');
  db.prepare(
    'INSERT INTO pr_task (pr_key, task_key, run_key, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
  ).run(pr, TASK, RUN, AT1, AT2);
  const head = 'a'.repeat(40);
  db.prepare(
    `INSERT INTO pr_state
       (pr_key, terminal, merged_at, review_verdict, reviewed_head_sha, head_sha,
        checks_head_sha, checks_json, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(pr, 'open', null, null, null, head, head, '[]', AT2);
  db.prepare(
    'INSERT INTO pr_thread_event (pr_key, dedupe_key, kind, recorded_at, message_ts) VALUES (?, ?, ?, ?, ?)',
  ).run(pr, 'seed', 'seed', AT1, null);
  db.prepare(
    `INSERT INTO run_message
       (run_key, channel_id, message_ts, render_fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(RUN, CHANNEL, ROOT_TS, 'run-fp', AT1, AT2);
  db.prepare(
    `INSERT INTO run_collection_message
       (id, channel_id, message_ts, render_fingerprint, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)`,
  ).run(CHANNEL, '1787554800.000000', 'collection-fp', AT1, AT2);
  db.close();
}

/** The acceptance contract explicitly compares table_xinfo and index_xinfo, including column order. */
function schemaShape(path: string) {
  const db = new DatabaseSync(path);
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        readonly name: string;
      }[]
    )
      .map(({ name }) => name)
      .filter((name) => !name.startsWith('sqlite_'));
    return tables.map((table) => ({
      table,
      columns: db.prepare(`PRAGMA table_xinfo(${table})`).all(),
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
          columns: db.prepare(`PRAGMA index_xinfo(${name})`).all(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    }));
  } finally {
    db.close();
  }
}

function gateMasterShape(path: string) {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
          WHERE name IN ('gate_metadata', 'gate_metadata_run_key',
                         'gate_message', 'gate_message_slack_identity')
          ORDER BY type, name`,
      )
      .all();
  } finally {
    db.close();
  }
}

function metadata(over: Partial<GateMetadata> = {}): GateMetadata {
  return {
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    dispatchKey: dispatchKey('ctx_gate'),
    source: 'registered',
    askMessageId: 'msg_gate',
    questionThreadId: 'msg_gate',
    options: [
      { id: 'keep', label: '현행 유지', description: '기존 동작을 유지한다', resolution: '현행 유지' },
      { id: 'change', label: '변경', description: '새 동작으로 바꾼다', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', reason: '호환성을 보존한다' },
    impact: '후속 Task 두 개의 구현 방향이 정해진다',
    registeredAt: AT1,
    ...over,
  };
}

describe('schema v6 → current', () => {
  it('migrated v6와 fresh current schema의 table_xinfo/index_xinfo가 동형이다', () => {
    writeV6(dbPath);
    new SqliteDigestStore(dbPath).close();
    const fresh = join(dir, 'fresh', 'state.db');
    new SqliteDigestStore(fresh).close();

    expect(SCHEMA_VERSION).toBe(16);
    expect(gateMasterShape(dbPath)).toEqual(gateMasterShape(fresh));
    expect(schemaShape(dbPath)).toEqual(schemaShape(fresh));
    expect(schemaShape(dbPath).map(({ table }) => table)).toContain('gate_metadata');
    expect(schemaShape(dbPath).map(({ table }) => table)).toContain('gate_message');
  });

  it('기존 v1~v6 계열의 PR/Run/collection 행을 보존하고 current Gate 표들을 비어 붙인다', () => {
    writeV6(dbPath);
    const store = new SqliteDigestStore(dbPath);
    expect(store.findPrMessage(pullRequestKey(1057758478, 31))?.messageTs).toBe('1700.1');
    expect(store.listPrTasks(pullRequestKey(1057758478, 31))).toHaveLength(1);
    expect(store.findPrState(pullRequestKey(1057758478, 31))?.terminal).toBe('open');
    expect(store.listThreadEvents(pullRequestKey(1057758478, 31))).toHaveLength(1);
    expect(store.findRunMessage(RUN)?.messageTs).toBe(ROOT_TS);
    expect(store.findRunCollectionMessage()?.renderFingerprint).toBe('collection-fp');
    expect(store.listGateMetadata(RUN)).toEqual([]);
    expect(store.findGateMessage(GATE)).toBeNull();
    store.close();

    const db = new DatabaseSync(dbPath);
    expect(db.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({ version: 16 });
    db.close();
  });

  it('두 번째 Gate table 생성이 실패하면 첫 table과 version update를 rollback한다', () => {
    writeV6(dbPath);
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE gate_message (x TEXT)');
    seed.close();

    expect(() => new SqliteDigestStore(dbPath)).toThrow(/gate_message/);
    const db = new DatabaseSync(dbPath);
    expect(db.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({ version: 6 });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gate_metadata'").get(),
    ).toBeUndefined();
    expect(db.prepare('SELECT message_ts FROM run_message WHERE run_key = ?').get(RUN)).toEqual({
      message_ts: ROOT_TS,
    });
    db.close();
  });
});

describe('Gate metadata와 message mapping', () => {
  it('한 Task의 복수 ask/Gate를 exact row로 따로 보존한다', () => {
    const store = new SqliteDigestStore(dbPath);
    const first = metadata();
    const second = metadata({
      gateKey: gateKey('gate_second'),
      askMessageId: 'msg_second',
      questionThreadId: 'thread_second',
      registeredAt: AT2,
    });
    try {
      store.insertGateMetadata(first);
      store.insertGateMetadata(second);

      expect(store.listGateMetadata(RUN)).toEqual([second, first]);
      expect(store.findGateMetadata(first.gateKey)).toEqual(first);
    } finally {
      store.close();
    }
  });

  it('같은 ask를 다른 Gate에 덮어쓰지 않는다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.insertGateMetadata(metadata());
    expect(() =>
      store.insertGateMetadata(
        metadata({ gateKey: gateKey('gate_other'), questionThreadId: 'thread_other' }),
      ),
    ).toThrow(/sidecar metadata를 기록할 수 없다/);
    expect(store.findGateMetadata(GATE)?.askMessageId).toBe('msg_gate');
    store.close();
  });

  it('Gate reply identity를 재시작 뒤 되읽고 지문만 갱신한다', () => {
    const first = new SqliteDigestStore(dbPath);
    first.insertGateMessage({
      gateKey: GATE,
      runKey: RUN,
      channelId: CHANNEL,
      threadTs: ROOT_TS,
      messageTs: GATE_TS,
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    first.close();

    const second = new SqliteDigestStore(dbPath);
    second.updateGateObservation(GATE, 'fp-2', AT2);
    expect(second.findGateMessage(GATE)).toEqual({
      gateKey: GATE,
      runKey: RUN,
      channelId: CHANNEL,
      threadTs: ROOT_TS,
      messageTs: GATE_TS,
      renderFingerprint: 'fp-2',
      createdAt: AT1,
      updatedAt: AT2,
    });
    second.close();
  });

  it('dry-run copy는 Gate rows를 읽지만 어떤 Gate write도 거부한다', () => {
    const live = new SqliteDigestStore(dbPath);
    live.insertGateMetadata(metadata());
    live.close();

    const dry: GateStore & { close(): void } = new ReadOnlyDigestStore(dbPath);
    try {
      expect(dry.findGateMetadata(GATE)?.impact).toContain('후속 Task');
      expect(() => dry.insertGateMetadata(metadata())).toThrow(/dry-run/);
      expect(() => dry.updateGateObservation(GATE, 'fp', AT2)).toThrow(/dry-run/);
    } finally {
      dry.close();
    }
  });
});
