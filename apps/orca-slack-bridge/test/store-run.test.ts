import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SqliteDigestStore, ReadOnlyDigestStore } from '../src/store/sqlite.js';
import { SCHEMA_VERSION, type RunStore } from '../src/store/schema.js';
import { pullRequestKey, pullRequestNumber, runKey, taskKey } from '../src/identity/keys.js';

/**
 * schema v5 `run_message`와 Run↔PR 조회.
 *
 * **실제 사용자 store를 건드리지 않는다.** 임시 디렉터리의 파일만 연다. 모킹하지 않는 것도
 * 의도다 — 모킹하면 검증 대상인 sqlite 제약(PRIMARY KEY, UNIQUE INDEX)이 사라진다.
 *
 * v1 → v4 경로는 `store.test.ts`가 단계별로 검증한다. 여기서는 v4 → v5 한 단계만 본다.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-store-run-'));
  dbPath = join(dir, 'nested', 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RUN = runKey('run_36d28e6e947a');
const OTHER_RUN = runKey('run_59bccb319e7f');
const PR = pullRequestKey(1057758478, 25);
const PR_LATER = pullRequestKey(1057758478, 9);
const OTHER_PR = pullRequestKey(1057758478, 26);
const TASK_A = taskKey('task_42914531e46b');
const TASK_B = taskKey('task_8bf3d72f262a');
const CHANNEL = 'C0AGENTRUNS';
const AT1 = '2026-08-24T01:00:00.000Z';
const AT2 = '2026-08-24T02:00:00.000Z';

/**
 * v4 파일을 올려서 여는 경로.
 *
 * v1·v2·v3과 같은 이유로 v4 DDL을 여기 그대로 적는다. 옛 스키마는 `schema.ts`에 남아 있지
 * 않고, 여기 적힌 것이 migration이 실제로 만나는 모양이다.
 */
const V4_DDL = `
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
`;

const HEAD = 'a'.repeat(40);

/** 네 표에 모두 행이 든 v4 파일을 만든다. migration이 그 행들을 그대로 두는지 본다. */
function writeV4(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec(V4_DDL);
  raw
    .prepare('INSERT INTO schema_version (id, version, applied_at) VALUES (1, 4, ?)')
    .run('2026-08-23T12:58:31.014Z');
  raw
    .prepare(
      `INSERT INTO pr_message
         (pr_key, channel_id, message_ts, render_fingerprint, created_at, updated_at,
          facts_fingerprint, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(PR, 'C0PRDIGEST', '1787403740.833329', 'fp-v4', AT1, AT2, 'facts-v4', '{"kind":"ok"}');
  raw
    .prepare(
      `INSERT INTO pr_task (pr_key, task_key, run_key, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(PR, TASK_A, RUN, AT1, AT2);
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
  raw.close();
}

/**
 * 스키마 비교용 구조를 뽑는다.
 *
 * `store.test.ts`의 같은 이름 함수와 같은 대조 범위다. 컬럼 이름만 비교하면
 * type·notnull·default·PK가 갈라져도 통과하고 인덱스는 아예 보이지 않으므로 `table_info` 행을
 * 그대로 담고 인덱스 메타데이터를 함께 담는다. `cid`를 지우지 않는 것이 의도다 —
 * `ALTER TABLE ADD COLUMN`은 맨 뒤에만 붙일 수 있으므로 컬럼 순서도 계약이다.
 *
 * 대조하지 못하는 것: CHECK 제약, foreign key, trigger, collation, 인덱스 sort order,
 * partial index의 WHERE 절, generated/hidden 컬럼.
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
 * v4 파일을 여는 경로.
 *
 * **`SCHEMA_VERSION`을 리터럴로 고정하지 않는다.** 파일을 열면 v4부터 현재 버전까지 모든 단계가
 * 적용되므로, 이 describe가 보는 것은 "v5 한 단계"가 아니라 "v4 파일이 열리고 기존 행이 남는다"다.
 * 단계 하나를 보는 곳은 그 단계를 추가한 테스트다 — v5 → v6은 `store-run-collection.test.ts`다.
 */
describe('v4 파일 열기', () => {
  // 이 파일의 알려진 함정이다. SCHEMA_DDL에만 있고 MIGRATIONS에는 없는 테이블(또는 그 반대)이
  // 생기면 새 파일과 기존 파일이 다른 스키마로 갈라진다.
  it('올린 v4 파일과 새로 만든 파일의 스키마가 같다', () => {
    writeV4(dbPath);
    new SqliteDigestStore(dbPath).close();

    const freshPath = join(dir, 'fresh', 'state.db');
    new SqliteDigestStore(freshPath).close();
    expect(readSchemaShape(dbPath)).toEqual(readSchemaShape(freshPath));
  });

  it('run_message 표를 붙이고 버전을 올린다', () => {
    writeV4(dbPath);

    const store = new SqliteDigestStore(dbPath);
    // 붙인 표는 비어 있다. 과거에 게시한 Run 카드가 없으므로 소급해 채울 값도 없다.
    const found = store.findRunMessage(RUN);
    store.close();
    expect(found).toBeNull();

    const raw = new DatabaseSync(dbPath);
    const version = raw.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    raw.close();
    expect(version).toEqual({ version: SCHEMA_VERSION });
  });

  it('기존 pr_message·pr_task·pr_state·pr_thread_event 행을 그대로 둔다', () => {
    writeV4(dbPath);

    const store = new SqliteDigestStore(dbPath);
    const message = store.findPrMessage(PR);
    const tasks = store.listPrTasks(PR);
    const state = store.findPrState(PR);
    const events = store.listThreadEvents(PR);
    store.close();

    expect(message).toEqual({
      prKey: PR,
      channelId: 'C0PRDIGEST',
      messageTs: '1787403740.833329',
      renderFingerprint: 'fp-v4',
      factsFingerprint: 'facts-v4',
      summaryJson: '{"kind":"ok"}',
      createdAt: AT1,
      updatedAt: AT2,
    });
    expect(tasks).toEqual([
      { prKey: PR, taskKey: TASK_A, runKey: RUN, firstSeenAt: AT1, lastSeenAt: AT2 },
    ]);
    expect(state?.terminal).toBe('merged');
    expect(state?.reviewVerdict).toBe('approve');
    expect(state?.mergedAt).toBe(AT2);
    expect(events.map((e) => e.dedupeKey)).toEqual(['terminal:merged']);
  });

  // 트랜잭션이 CREATE TABLE과 CREATE INDEX를 함께 되돌리는지 본다. 되돌리지 않으면 표는 있는데
  // 버전은 v4인 파일이 남고, 다음 실행이 같은 CREATE TABLE을 다시 걸어 영영 열리지 않는다.
  it('migration이 실패하면 파일이 v4 그대로 남는다', () => {
    writeV4(dbPath);
    const seed = new DatabaseSync(dbPath);
    // 인덱스 이름을 먼저 점유해 두 번째 문장에서 실패시킨다. 첫 문장이 되돌아가는지 함께 본다.
    seed.exec('CREATE TABLE occupied (x TEXT)');
    seed.exec('CREATE INDEX run_message_slack_identity ON occupied (x)');
    seed.close();

    expect(() => new SqliteDigestStore(dbPath)).toThrow(/run_message_slack_identity/);

    const raw = new DatabaseSync(dbPath);
    const version = raw.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    const rows = raw.prepare('SELECT pr_key, message_ts FROM pr_message').all();
    const leftover = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_message'")
      .all();
    raw.close();
    expect(version).toEqual({ version: 4 });
    expect(rows).toEqual([{ pr_key: PR, message_ts: '1787403740.833329' }]);
    expect(leftover).toEqual([]);
  });
});

describe('run_message 매핑', () => {
  it('없으면 null이다. 그것이 이 Run의 루트를 아직 만들지 않았다는 뜻이다', () => {
    const store = new SqliteDigestStore(dbPath);
    const found = store.findRunMessage(RUN);
    store.close();
    expect(found).toBeNull();
  });

  it('기록하고 되읽는다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.insertRunMessage({
      runKey: RUN,
      channelId: CHANNEL,
      messageTs: '1787403740.111111',
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    const found = store.findRunMessage(RUN);
    store.close();
    expect(found).toEqual({
      runKey: RUN,
      channelId: CHANNEL,
      messageTs: '1787403740.111111',
      renderFingerprint: 'fp-1',
      createdAt: AT1,
      updatedAt: AT1,
    });
  });

  // 조용히 덮어쓰면 앞서 게시한 Slack 루트를 잃는다. `insertPrMessage`와 같은 판정이다.
  it('같은 Run을 다시 insert하면 던진다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.insertRunMessage({
      runKey: RUN,
      channelId: CHANNEL,
      messageTs: 'ts1',
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    expect(() =>
      store.insertRunMessage({
        runKey: RUN,
        channelId: CHANNEL,
        messageTs: 'ts2',
        renderFingerprint: 'fp-2',
        at: AT2,
      }),
    ).toThrow(new RegExp(RUN));
    const found = store.findRunMessage(RUN);
    store.close();
    expect(found?.messageTs).toBe('ts1');
  });

  it('두 Run이 같은 Slack 메시지를 가리키지 못한다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.insertRunMessage({
      runKey: RUN,
      channelId: CHANNEL,
      messageTs: 'ts1',
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    expect(() =>
      store.insertRunMessage({
        runKey: OTHER_RUN,
        channelId: CHANNEL,
        messageTs: 'ts1',
        renderFingerprint: 'fp-2',
        at: AT2,
      }),
    ).toThrow(new RegExp(OTHER_RUN));
    store.close();
  });

  it('지문과 updated_at만 갱신하고 message identity는 건드리지 않는다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.insertRunMessage({
      runKey: RUN,
      channelId: CHANNEL,
      messageTs: 'ts1',
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    store.updateRunObservation(RUN, 'fp-2', AT2);
    const found = store.findRunMessage(RUN);
    store.close();
    expect(found).toEqual({
      runKey: RUN,
      channelId: CHANNEL,
      messageTs: 'ts1',
      renderFingerprint: 'fp-2',
      createdAt: AT1,
      updatedAt: AT2,
    });
  });

  // 갱신할 행이 없다는 것은 호출 순서가 깨졌다는 뜻이다. 새 행을 만들어 덮으면 그 사실이 사라진다.
  it('행이 없는데 갱신하면 던진다', () => {
    const store = new SqliteDigestStore(dbPath);
    expect(() => store.updateRunObservation(RUN, 'fp', AT1)).toThrow(new RegExp(RUN));
    store.close();
  });

  it('재시작해도 같은 파일에서 매핑을 읽는다', () => {
    const first = new SqliteDigestStore(dbPath);
    first.insertRunMessage({
      runKey: RUN,
      channelId: CHANNEL,
      messageTs: 'ts1',
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    first.close();

    const second = new SqliteDigestStore(dbPath);
    const found = second.findRunMessage(RUN);
    second.close();
    expect(found?.messageTs).toBe('ts1');
  });

  it('dry-run store는 읽기만 하고 쓰기는 던진다', () => {
    const seed = new SqliteDigestStore(dbPath);
    seed.insertRunMessage({
      runKey: RUN,
      channelId: CHANNEL,
      messageTs: 'ts1',
      renderFingerprint: 'fp-1',
      at: AT1,
    });
    seed.close();

    // `RunStore`로 받는다. write 메서드는 인자를 쓰지 않으므로 구현이 0개로 선언돼 있고,
    // 구체 클래스 타입으로 호출하면 계약이 아니라 그 선언이 보인다.
    const ro: RunStore & { close(): void } = new ReadOnlyDigestStore(dbPath);
    const found = ro.findRunMessage(RUN);
    expect(found?.messageTs).toBe('ts1');
    expect(() =>
      ro.insertRunMessage({
        runKey: OTHER_RUN,
        channelId: CHANNEL,
        messageTs: 'ts2',
        renderFingerprint: 'fp',
        at: AT2,
      }),
    ).toThrow(/dry-run은 store에 쓰지 않는다/);
    expect(() => ro.updateRunObservation(RUN, 'fp-2', AT2)).toThrow(
      /dry-run은 store에 쓰지 않는다/,
    );
    ro.close();
  });
});

describe('Run↔PR 조회 (OD-076, OD-044)', () => {
  const HEAD_SHA = 'b'.repeat(40);
  const state = (terminal: 'open' | 'closed' | 'merged', verdict: 'approve' | null) => ({
    terminal,
    mergedAt: terminal === 'merged' ? AT2 : null,
    reviewVerdict: verdict,
    reviewedHeadSha: verdict === null ? null : HEAD_SHA,
    headSha: HEAD_SHA,
    checksHeadSha: HEAD_SHA,
    checks: [],
  });

  it('연결된 PR이 없으면 빈 배열이다', () => {
    const store = new SqliteDigestStore(dbPath);
    const rows = store.listRunPullRequests(RUN);
    store.close();
    expect(rows).toEqual([]);
  });

  it('pr_task.run_key로 이 Run의 PR을 찾고 pr_state의 terminal·verdict를 함께 준다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    store.savePrState(PR, state('merged', 'approve'), AT2);
    const rows = store.listRunPullRequests(RUN);
    store.close();

    expect(rows).toEqual([
      {
        prKey: PR,
        number: 25,
        firstSeenAt: AT1,
        lastSeenAt: AT1,
        state: { terminal: 'merged', mergedAt: AT2, reviewVerdict: 'approve', observedAt: AT2 },
      },
    ]);
  });

  // 상태를 아직 저장하지 않았다는 사실과 PR이 없다는 사실은 다르다. terminal을 추측해 채우지 않는다.
  it('pr_state 행이 없어도 PR을 목록에서 빼지 않는다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    const rows = store.listRunPullRequests(RUN);
    store.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBeNull();
  });

  // OD-076이 요구한 모양은 PR↔Task N이다. 카드가 그 N행을 PR 하나로 접는다.
  it('한 PR을 여러 Task가 갱신해도 PR당 한 원소다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    store.recordPrTask({ prKey: PR, taskKey: TASK_B, runKey: RUN, at: AT2 });
    const rows = store.listRunPullRequests(RUN);
    store.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.firstSeenAt).toBe(AT1);
    expect(rows[0]?.lastSeenAt).toBe(AT2);
  });

  it('다른 Run의 PR은 섞이지 않는다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    store.recordPrTask({ prKey: OTHER_PR, taskKey: TASK_B, runKey: OTHER_RUN, at: AT1 });
    const mine = store.listRunPullRequests(RUN);
    const theirs = store.listRunPullRequests(OTHER_RUN);
    store.close();
    expect(mine.map((r) => r.number)).toEqual([25]);
    expect(theirs.map((r) => r.number)).toEqual([26]);
  });

  // `pr_key` 사전순이면 `#10`이 `#9`보다 앞선다. 번호로 정렬하지 않으면 카드 순서가 뒤집힌다.
  it('PR 번호 오름차순으로 준다', () => {
    const store = new SqliteDigestStore(dbPath);
    store.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    store.recordPrTask({ prKey: PR_LATER, taskKey: TASK_B, runKey: RUN, at: AT1 });
    const rows = store.listRunPullRequests(RUN);
    store.close();
    expect(rows.map((r) => r.number)).toEqual([9, 25]);
  });

  it('dry-run store도 같은 목록을 읽는다', () => {
    const seed = new SqliteDigestStore(dbPath);
    seed.recordPrTask({ prKey: PR, taskKey: TASK_A, runKey: RUN, at: AT1 });
    seed.savePrState(PR, state('open', null), AT2);
    seed.close();

    const ro = new ReadOnlyDigestStore(dbPath);
    const rows = ro.listRunPullRequests(RUN);
    ro.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state?.terminal).toBe('open');
    expect(rows[0]?.state?.reviewVerdict).toBeNull();
  });
});

describe('pullRequestNumber', () => {
  it('key에서 번호를 되읽는다', () => {
    expect(pullRequestNumber(PR)).toBe(25);
    expect(pullRequestNumber(pullRequestKey(1, 1))).toBe(1);
  });

  // store에서 읽은 값은 문자열 캐스팅이라 타입이 지켜주지 않는다. 0을 돌려주면 `#0`이 그려진다.
  it('형식이 어긋나면 던진다', () => {
    expect(() => pullRequestNumber('pr:1#0' as never)).toThrow(/PR 번호를 읽을 수 없다/);
    expect(() => pullRequestNumber('pr:1' as never)).toThrow(/PR 번호를 읽을 수 없다/);
    expect(() => pullRequestNumber('pr:1#x' as never)).toThrow(/PR 번호를 읽을 수 없다/);
  });
});
