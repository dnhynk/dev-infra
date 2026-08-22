import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PullRequestKey } from '../identity/keys.js';
import {
  ENABLE_WAL,
  SCHEMA_DDL,
  SCHEMA_VERSION,
  STATE_PATH_VAR,
  type DigestStore,
  type NewPrMessage,
  type PrMessageRecord,
} from './schema.js';

/**
 * `node:sqlite` 기반 `DigestStore` 구현(OD-043).
 *
 * 스키마와 그 스키마가 보장하는 것·보장하지 않는 것은 `schema.ts`에 있다. 이 파일은 그
 * 계약을 실행하는 방법만 담는다.
 */

/**
 * durable store 파일 경로를 정한다.
 *
 * 순서는 `schema.ts`가 정한 대로 `--state` 인자 → `ORCA_SLACK_BRIDGE_STATE` → 기본 경로다.
 * 설정 파일은 이 순서에 없다. `config.json`은 채널 ID나 Project 매핑처럼 머신을 옮겨도
 * 의미가 유지되는 값을 담는데 DB 절대경로는 머신마다 다르기 때문이다.
 *
 * 기본 경로의 base는 설정 파일과 다르다. DB는 설정이 아니라 state이므로 비win32에서
 * `XDG_CONFIG_HOME`이 아니라 `XDG_DATA_HOME`(없으면 `~/.local/share`) 아래에 둔다.
 *
 * `platform`을 인자로 받는 이유는 하나다. 한 OS에서만 실행해도 나머지 분기가 검증돼야 한다.
 */
export function resolveStatePath(
  explicit: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (explicit !== null && explicit.trim() !== '') return explicit;
  const fromEnv = env[STATE_PATH_VAR];
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    if (appData && appData.trim() !== '') {
      return join(appData, 'orca-slack-bridge', 'state.db');
    }
  }
  const xdg = env['XDG_DATA_HOME'];
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'orca-slack-bridge', 'state.db');
}

/**
 * 파일의 스키마 버전이 이 코드가 아는 버전과 다를 때 던진다.
 *
 * C1에는 migration이 없다. 다른 버전의 파일을 열면 읽는 컬럼이 실제와 어긋날 수 있으므로
 * 추측해서 열지 않는다. 버전이 늘어날 때 무엇을 할지는 그때 정한다.
 */
export class SchemaVersionError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
    readonly expected: number,
  ) {
    super(
      `store 파일의 스키마 버전이 ${found}인데 이 코드는 ${expected}만 안다: ${path}\n` +
        'migration이 없으므로 열지 않는다.',
    );
    this.name = 'SchemaVersionError';
  }
}

const SELECT_ROW = `
SELECT pr_key, channel_id, message_ts, render_fingerprint, created_at, updated_at
  FROM pr_message WHERE pr_key = ?`;

const INSERT_ROW = `
INSERT INTO pr_message
  (pr_key, channel_id, message_ts, render_fingerprint, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)`;

const UPDATE_FINGERPRINT = `
UPDATE pr_message SET render_fingerprint = ?, updated_at = ? WHERE pr_key = ?`;

/** sqlite가 돌려주는 pr_message 한 행. 컬럼명 그대로다. */
type PrMessageRow = {
  readonly pr_key: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly render_fingerprint: string;
  readonly created_at: string;
  readonly updated_at: string;
};

function toRecord(row: PrMessageRow): PrMessageRecord {
  return {
    prKey: row.pr_key as PullRequestKey,
    channelId: row.channel_id,
    messageTs: row.message_ts,
    renderFingerprint: row.render_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteDigestStore implements DigestStore {
  private readonly db: DatabaseSync;

  /** 파일을 열고 스키마를 준비한다. 부모 디렉터리가 없으면 만든다. */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(ENABLE_WAL);
      prepareSchema(this.db, path);
    } catch (e) {
      // 스키마 판정에 실패한 파일을 열린 채로 남기지 않는다.
      this.db.close();
      throw e;
    }
  }

  findPrMessage(prKey: PullRequestKey): PrMessageRecord | null {
    const row = this.db.prepare(SELECT_ROW).get(prKey) as PrMessageRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  insertPrMessage(input: NewPrMessage): void {
    try {
      this.db
        .prepare(INSERT_ROW)
        .run(
          input.prKey,
          input.channelId,
          input.messageTs,
          input.renderFingerprint,
          input.at,
          input.at,
        );
    } catch (e) {
      // 조용히 덮어쓰지 않는다. 덮어쓰면 앞서 게시한 Slack 루트를 잃어버린다.
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${input.prKey}의 루트 메시지를 기록할 수 없다 ` +
          `(channel ${input.channelId}, ts ${input.messageTs}): ${detail}`,
        { cause: e },
      );
    }
  }

  updateRenderFingerprint(prKey: PullRequestKey, renderFingerprint: string, at: string): void {
    const result = this.db.prepare(UPDATE_FINGERPRINT).run(renderFingerprint, at, prKey);
    if (Number(result.changes) === 0) {
      // 갱신할 행이 없다는 것은 호출 순서가 깨졌다는 뜻이다. 새 행을 만들어 덮지 않는다.
      throw new Error(`${prKey}의 매핑 행이 없어 지문을 갱신할 수 없다`);
    }
  }

  close(): void {
    // WAL과 shm을 본 파일에 접고 지운다. 다음 실행이 남은 조각을 복구하지 않아도 되게 한다.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}

/**
 * 스키마 버전을 확인하고, 비어 있으면 DDL을 적용한다.
 *
 * 버전을 먼저 읽는 이유는 모르는 버전의 파일에 아무것도 쓰지 않기 위해서다. DDL이 전부
 * `IF NOT EXISTS`라 실행 자체는 무해하지만, 판정 전에 write를 시작하지 않는 편이 계약에 맞다.
 *
 * DDL과 버전 기록을 한 트랜잭션에 묶는다. 둘 사이에서 죽으면 다음 실행이 "테이블은 있는데
 * 버전은 모르는" 파일을 만나 판정할 근거를 잃는다.
 */
function prepareSchema(db: DatabaseSync, path: string): void {
  const versioned = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();

  if (versioned === undefined) {
    db.exec('BEGIN');
    try {
      db.exec(SCHEMA_DDL);
      db.prepare('INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)').run(
        SCHEMA_VERSION,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return;
  }

  const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as
    | { readonly version: number }
    | undefined;
  if (row === undefined) {
    throw new Error(
      `store 파일에 schema_version 테이블은 있는데 버전 행이 없다: ${path}\n` +
        'Bridge가 만든 파일이 아니거나 손상됐다.',
    );
  }
  if (row.version !== SCHEMA_VERSION) {
    throw new SchemaVersionError(path, row.version, SCHEMA_VERSION);
  }
}
