import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
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
 * `--state` 인자와 `ORCA_SLACK_BRIDGE_STATE`는 상대경로도 그대로 쓴다. 그 경우 실행
 * 디렉터리가 바뀌면 다른 파일이 열린다. 사용자가 직접 준 값이라 의도가 명시적이므로 지금은
 * 손대지 않는다. 아래 XDG 규칙은 XDG 변수에만 적용된다.
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
  if (platform === 'win32') return join(win32StateBase(env), 'orca-slack-bridge', 'state.db');
  return join(xdgDataBase(env), 'orca-slack-bridge', 'state.db');
}

/**
 * win32 기본 경로의 base. `APPDATA`가 없으면 던진다.
 *
 * `config.ts`의 `defaultConfigPath`는 같은 상황에서 XDG로 내려간다. 두 함수가 다르게 행동하는
 * 이유가 있다. 설정 파일을 못 찾으면 그 자리에서 오류가 나지만, DB 경로가 달라지면 **아무 오류
 * 없이 다른 파일이 열린다.** 그러면 기존 `pr_message` 매핑을 못 찾아 이미 게시한 Slack 루트를
 * 잃고 루트를 하나 더 만든다. 로드맵 §5의 "재관찰로 루트가 중복되지 않음"이 겨냥하는 실패가
 * 정확히 이것이다. 조용한 발산이 시끄러운 실패보다 나쁘므로 여기서는 던진다.
 *
 * **구현자에게**: "일관성"을 이유로 이 분기를 `defaultConfigPath`와 통일하지 마라. 두 함수가
 * 잃는 것이 다르다.
 */
function win32StateBase(env: NodeJS.ProcessEnv): string {
  const appData = env['APPDATA'];
  if (appData && appData.trim() !== '') return appData;
  throw new Error(
    'win32인데 APPDATA가 없어 store 기본 경로를 정할 수 없다.\n' +
      `추측한 경로로 열면 다른 파일이 조용히 열려 기존 카드를 잃는다. ${STATE_PATH_VAR}에 ` +
      '절대경로를 직접 지정한다.',
  );
}

/**
 * 비win32 기본 경로의 base.
 *
 * XDG Base Directory 명세가 상대경로를 규정한다.
 *
 * > "All paths set in these environment variables must be absolute. If an implementation
 * > encounters a relative path in any of these variables it should consider the path invalid
 * > and ignore it."
 * > "If `$XDG_DATA_HOME` is either not set or empty, a default equal to `$HOME`/.local/share
 * > should be used."
 *
 * 출처: http://specifications.freedesktop.org/basedir/latest/
 *
 * 따라서 상대 `XDG_DATA_HOME`은 던질 대상이 아니라 무시할 대상이다. 명세가 "ignore"라고
 * 규정했고 기본값이 정의돼 있으므로 이것은 실패가 아니라 명세된 정상 동작이다. 무시하지 않고
 * 그대로 쓰면 `state.db`가 현재 작업 디렉터리에 생겨, 다른 cwd에서 재시작할 때 기존
 * `pr_message` 매핑을 잃는다.
 */
function xdgDataBase(env: NodeJS.ProcessEnv): string {
  const xdg = env['XDG_DATA_HOME'];
  if (xdg && xdg.trim() !== '' && isAbsolute(xdg)) return xdg;
  return join(homedir(), '.local', 'share');
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
      enableWal(this.db, path);
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
 * WAL로 전환하고 실제로 전환됐는지 확인한다.
 *
 * `exec`로 실행하면 결과를 버린다. SQLite는 요청한 journal mode로 갈 수 없을 때 예외 대신
 * 지금의 mode를 돌려주므로, 결과를 보지 않으면 WAL이 아닌 채로 스키마 준비까지 성공한다.
 * OD-043이 정한 것은 "WAL로 연다"이지 "WAL을 시도한다"가 아니다.
 *
 * `:memory:`는 원리적으로 WAL이 될 수 없어 여기서 걸린다. 특례를 두지 않는다.
 * `resolveStatePath`는 `:memory:`를 만들어내지 않으므로, 지원하지 않는 입력이 조용히
 * 통과하는 것보다 던지는 편이 맞다.
 */
function enableWal(db: DatabaseSync, path: string): void {
  const row = db.prepare(ENABLE_WAL).get() as { readonly journal_mode: string } | undefined;
  const mode = row?.journal_mode;
  if (mode !== 'wal') {
    throw new Error(
      `store 파일을 WAL로 열지 못했다. 실제 journal mode는 ${mode ?? '알 수 없음'}이다: ${path}`,
    );
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
