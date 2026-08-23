import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDigestStore, formatDigestError } from '../src/cli.js';
import { SqliteDigestStore, SchemaVersionError } from '../src/store/sqlite.js';
import { SCHEMA_VERSION } from '../src/store/schema.js';
import { pullRequestKey } from '../src/identity/keys.js';
import type { DigestStore, NewPrMessage } from '../src/store/schema.js';

/**
 * digest 명령의 CLI 경계 검증.
 *
 * 실제 파일과 실제 sqlite를 쓴다. 모킹하면 검증 대상인 "dry-run이 파일을 만들지 않는다"의
 * 근거가 사라진다.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-cli-digest-'));
  // 부모 디렉터리를 일부러 만들지 않는다. dry-run이 그것마저 만들지 않는지 함께 본다.
  dbPath = join(dir, 'nested', 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PR = pullRequestKey(4242, 7);
const CHANNEL = 'C09ABCDEFGH';
const TS = '1700000000.000001';

const MAPPING: NewPrMessage = {
  prKey: PR,
  channelId: CHANNEL,
  messageTs: TS,
  renderFingerprint: 'fp-1',
  factsFingerprint: 'facts-1',
  summaryJson: null,
  at: '2026-08-22T00:00:00Z',
};

/** store 디렉터리의 파일 이름과 내용 해시. 곁파일(-wal, -shm) 생성도 여기서 드러난다. */
function fileprint(target: string): Record<string, string> {
  const parent = dirname(target);
  if (!existsSync(parent)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(parent).sort()) {
    out[name] = createHash('sha256').update(readFileSync(join(parent, name))).digest('hex');
  }
  return out;
}

describe('dry-run store', () => {
  // 회귀 방지: 이전 버전은 dry-run에서도 SqliteDigestStore를 열어 부모 디렉터리·DB 파일·WAL·
  // schema_version을 만들고 close에서 checkpoint까지 했다. 도움말은 "store에 쓰지 않는다"였다.
  it('없는 경로에 아무것도 만들지 않고 행 없음으로 다룬다', () => {
    const store = openDigestStore(dbPath, true);
    try {
      expect(store.findPrMessage(PR)).toBeNull();
    } finally {
      store.close();
    }
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(dirname(dbPath))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  // 대조군. 실제 게시 경로의 store는 같은 경로를 만든다. dry-run이 이 경로를 쓰면 안 되는 이유다.
  it('실제 게시 경로의 store는 같은 경로를 만든다', () => {
    const store = openDigestStore(dbPath, false);
    store.close();
    expect(existsSync(dbPath)).toBe(true);
  });

  it('기존 store를 읽되 파일을 바꾸지 않는다', () => {
    const live = openDigestStore(dbPath, false);
    live.insertPrMessage(MAPPING);
    live.close();
    const before = fileprint(dbPath);

    const dry = openDigestStore(dbPath, true);
    try {
      // 읽지 못하면 매핑이 있는 PR을 create로 보고한다. 그것이 dry-run의 쓸모를 없앤다.
      expect(dry.findPrMessage(PR)?.messageTs).toBe(TS);
    } finally {
      dry.close();
    }
    expect(fileprint(dbPath)).toEqual(before);
  });

  it('checkpoint되지 않은 -wal에만 있는 행도 읽는다', () => {
    // 이전 실행이 죽어 -wal이 남은 상태를 만든다. 연결을 연 채로 두면 checkpoint되지 않는다.
    const live = new SqliteDigestStore(dbPath);
    try {
      live.insertPrMessage(MAPPING);
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      const before = fileprint(dbPath);

      const dry = openDigestStore(dbPath, true);
      try {
        expect(dry.findPrMessage(PR)?.messageTs).toBe(TS);
      } finally {
        dry.close();
      }
      expect(fileprint(dbPath)).toEqual(before);
    } finally {
      // 단언이 실패해도 handle을 남기지 않는다. 남기면 win32에서 afterEach의 rmSync가 EPERM이다.
      live.close();
    }
  });

  // 실제 %APPDATA%\orca-slack-bridge\state.db가 v1이고 게시된 카드의 매핑이 들어 있다.
  // dry-run이 그 행을 못 읽으면 이미 루트가 있는 PR을 create로 보고하고, 그 보고를 믿고
  // 게시하면 루트가 하나 더 생긴다. 올리는 대상은 복사본이므로 원본은 v1로 남는다.
  it('v1 파일을 원본을 바꾸지 않고 읽는다', () => {
    mkdirSync(dirname(dbPath), { recursive: true });
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
CREATE TABLE schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE pr_message (
  pr_key TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_ts TEXT NOT NULL,
  render_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);`);
    raw.exec("INSERT INTO schema_version VALUES (1, 1, '2026-08-22T12:58:31.014Z')");
    raw
      .prepare('INSERT INTO pr_message VALUES (?, ?, ?, ?, ?, ?)')
      .run(PR, CHANNEL, TS, 'fp-v1', MAPPING.at, MAPPING.at);
    raw.close();
    const before = fileprint(dbPath);

    const dry = openDigestStore(dbPath, true);
    try {
      const found = dry.findPrMessage(PR);
      expect(found?.messageTs).toBe(TS);
      expect(found?.renderFingerprint).toBe('fp-v1');
      // 붙인 컬럼은 비어 있다. 다음 실제 실행이 한 번 요약하고 채운다.
      expect(found?.factsFingerprint).toBeNull();
      expect(found?.summaryJson).toBeNull();
    } finally {
      dry.close();
    }
    // 원본은 v1 그대로다. migration은 복사본에만 걸렸다.
    expect(fileprint(dbPath)).toEqual(before);
    const after = new DatabaseSync(dbPath);
    const version = after.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    after.close();
    expect(version).toEqual({ version: 1 });
  });

  it('모르는 스키마 버전이면 실제 실행과 똑같이 던진다', () => {
    openDigestStore(dbPath, false).close();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION + 1} WHERE id = 1`);
    raw.close();
    const before = fileprint(dbPath);

    // dry-run이 실제 실행과 다른 판정을 내리면 dry-run으로 확인한 의미가 없다.
    expect(() => openDigestStore(dbPath, true)).toThrow(SchemaVersionError);
    // 던지는 경로에서도 원본을 바꾸지 않는다.
    expect(fileprint(dbPath)).toEqual(before);
  });

  it('write를 던진다. 게시하지 않은 카드의 매핑을 남기지 않는다', () => {
    const store = openDigestStore(dbPath, true);
    try {
      expect(() => store.insertPrMessage(MAPPING)).toThrow(/dry-run/);
      expect(() =>
        store.updateObservation(
          PR,
          { renderFingerprint: 'fp-2', factsFingerprint: 'facts-2', summaryJson: null },
          MAPPING.at,
        ),
      ).toThrow(/dry-run/);
    } finally {
      store.close();
    }
    expect(existsSync(dbPath)).toBe(false);
  });
});

/** `insertPrMessage`가 채널 ID를 담은 오류를 던지는 대역. */
class ChannelLeakingStore implements DigestStore {
  findPrMessage(): null {
    return null;
  }
  insertPrMessage(input: NewPrMessage): void {
    throw new Error(
      `${input.prKey}의 루트 메시지를 기록할 수 없다 ` +
        `(channel ${input.channelId}, ts ${input.messageTs}): disk I/O error`,
    );
  }
  updateObservation(): void {}
  recordPrTask(): void {}
  listPrTasks(): readonly [] {
    return [];
  }
  findPrState(): null {
    return null;
  }
  savePrState(): void {}
  listThreadEvents(): readonly [] {
    return [];
  }
  recordThreadEvent(): void {}
  close(): void {}
}

describe('digest 오류 출력', () => {
  // 회귀 방지: 이전 버전은 store 오류 message를 그대로 stderr에 썼다. 설정에서만 와야 할
  // 실제 채널 ID가 로그에 남는다(스펙 §10).
  it('대역이 던진 오류에서 채널 ID가 사라진다', () => {
    const store = new ChannelLeakingStore();
    let thrown: unknown;
    try {
      store.insertPrMessage(MAPPING);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toContain(CHANNEL);

    const out = formatDigestError(thrown, CHANNEL);
    expect(out).not.toContain(CHANNEL);
    // 통상 길이의 채널 ID는 maskToken이 통째로 가린다. 앞자리도 남지 않는다.
    expect(out).toContain('(channel ***,');
    // 진단에 필요한 나머지는 남는다. 채널 ID만 가린다.
    expect(out).toContain(PR);
    expect(out).toContain('disk I/O error');
    expect(out).toContain(TS);
  });

  it('실제 store가 던지는 오류에서도 채널 ID가 사라진다', () => {
    const store = new SqliteDigestStore(dbPath);
    let thrown: unknown;
    try {
      store.insertPrMessage(MAPPING);
      // 같은 channel/ts를 다른 PR로 넣으면 UNIQUE(channel_id, message_ts)가 막는다.
      store.insertPrMessage({ ...MAPPING, prKey: pullRequestKey(4242, 8) });
    } catch (e) {
      thrown = e;
    } finally {
      store.close();
    }
    expect((thrown as Error).message).toContain(CHANNEL);
    expect(formatDigestError(thrown, CHANNEL)).not.toContain(CHANNEL);
  });

  it('채널 ID가 없는 오류는 그대로 둔다', () => {
    expect(formatDigestError(new Error('gh 호출 실패'), CHANNEL)).toBe('gh 호출 실패');
    expect(formatDigestError('문자열 오류', CHANNEL)).toBe('문자열 오류');
  });
});
