import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import type { CheckFact } from '../github/pull-request.js';
import { parseGateOptionMetadataArray } from '../gate/register.js';
import type { GateMetadata } from '../gate/types.js';
import { pullRequestNumber } from '../identity/keys.js';
import type { GateKey, PullRequestKey, RunKey, TaskKey } from '../identity/keys.js';
import type { PrTerminal, ReviewerResult } from '../digest/types.js';
import {
  ENABLE_WAL,
  MIGRATIONS,
  SCHEMA_DDL,
  SCHEMA_VERSION,
  STATE_PATH_VAR,
  type DigestStore,
  type GateMessageRecord,
  type GateStore,
  type NewPrMessage,
  type NewPrTask,
  type NewGateMessage,
  type NewRunCollectionMessage,
  type NewRunMessage,
  type NewThreadEvent,
  type ObservationRecord,
  type PrMessageRecord,
  type PrStateRecord,
  type PrStateSnapshot,
  type PrTaskRecord,
  type PrThreadEventRecord,
  type RunCollectionMessageRecord,
  type RunMessageRecord,
  type RunPullRequestRecord,
  type RunStore,
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
 * 상대경로를 두 입력에서 다르게 다룬다. `--state`는 상대경로도 그대로 쓰고,
 * `ORCA_SLACK_BRIDGE_STATE`가 상대경로면 던진다. 값의 수명이 다르기 때문이다. `--state`는
 * 매 실행에서 호출자가 눈으로 보고 넘기는 인자이므로 cwd 기준 상대경로가 통상적인 CLI
 * 의미이고, 어느 cwd에서 무엇을 여는지 그 자리에서 알 수 있다. 환경변수는 한 번 설정되면
 * cwd가 다른 프로세스에 그대로 상속되므로 실행 위치마다 다른 파일이 조용히 열리고, 그러면
 * 기존 `pr_message` 매핑을 잃어 Slack 루트가 중복된다. ambient 값에는 "호출자가 방금 보고
 * 정했다"는 근거가 없다.
 *
 * 상대 `XDG_DATA_HOME`을 무시하는 것과도 다르다. 그쪽은 XDG 명세가 "ignore"로 규정하고
 * 기본값을 정의해 둔 경우이고(`xdgDataBase` 참고), 이쪽은 사용자가 이 도구에만 주는 값이라
 * 잘못됐으면 조용히 대체하지 않고 알린다.
 *
 * **구현자에게**: "일관성"을 이유로 두 입력의 판정을 통일하지 마라. 잃는 것이 다르다.
 *
 * `platform`을 인자로 받는 이유는 하나다. 한 OS에서만 실행해도 나머지 분기가 검증돼야 한다.
 * 그래서 절대성 판정도 호스트가 아니라 `platform`을 따른다(`isAbsoluteOn` 참고).
 */
export function resolveStatePath(
  explicit: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (explicit !== null && explicit.trim() !== '') return explicit;
  const fromEnv = env[STATE_PATH_VAR];
  if (fromEnv && fromEnv.trim() !== '') {
    if (!isAbsoluteOn(fromEnv, platform)) {
      throw new Error(
        `${STATE_PATH_VAR}가 상대경로다: ${fromEnv}\n` +
          '이 값은 cwd가 다른 프로세스에도 그대로 상속되므로 실행 위치마다 다른 파일이 열린다. ' +
          '그러면 기존 카드 매핑을 못 찾아 Slack 루트가 하나 더 생긴다. 절대경로를 지정하거나, ' +
          '실행마다 다른 파일을 쓰려면 --state로 넘긴다.',
      );
    }
    return fromEnv;
  }
  if (platform === 'win32') return join(win32StateBase(env), 'orca-slack-bridge', 'state.db');
  return join(xdgDataBase(env), 'orca-slack-bridge', 'state.db');
}

/**
 * 대상 `platform`의 경로 규칙으로 절대성을 판정한다.
 *
 * `node:path`의 최상위 `isAbsolute`는 인자로 받은 `platform`이 아니라 **실행 호스트**를
 * 따른다. 그대로 쓰면 `resolveStatePath`가 `platform`을 받는 이유(한 OS에서 나머지 분기를
 * 검증한다)가 무너진다. win32 호스트에서 `platform: 'linux'` 분기를 검증하면 `C:\...`나
 * UNC 경로가 유효한 POSIX 절대경로로 통과한다.
 */
function isAbsoluteOn(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value);
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
 *
 * 절대성 판정은 `posix.isAbsolute`로 고정한다. XDG는 이 함수가 담당하는 비win32 경로에만
 * 적용되는 명세이고, 호스트를 따르는 `isAbsolute`를 쓰면 win32 호스트에서 `C:\...`나 UNC
 * 경로가 유효한 XDG base로 통과한다.
 */
function xdgDataBase(env: NodeJS.ProcessEnv): string {
  const xdg = env['XDG_DATA_HOME'];
  if (xdg && xdg.trim() !== '' && posix.isAbsolute(xdg)) return xdg;
  return join(homedir(), '.local', 'share');
}

/**
 * 파일의 버전에서 `SCHEMA_VERSION`까지 올릴 문장이 없을 때 던진다.
 *
 * 두 경우다. 파일이 이 코드보다 **새로우면** 내려갈 문장이 없고, 파일이 `MIGRATIONS`가 아는
 * 가장 낮은 버전보다 **낮으면** 올릴 문장이 없다. 어느 쪽이든 읽는 컬럼이 실제와 어긋날 수
 * 있으므로 추측해서 열지 않는다.
 */
export class SchemaVersionError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
    readonly expected: number,
  ) {
    super(
      `store 파일의 스키마 버전이 ${found}인데 이 코드는 ${expected}까지 안다: ${path}\n` +
        '그 버전에서 올릴 문장이 없으므로 열지 않는다.',
    );
    this.name = 'SchemaVersionError';
  }
}

const SELECT_ROW = `
SELECT pr_key, channel_id, message_ts, render_fingerprint, facts_fingerprint, summary_json,
       created_at, updated_at
  FROM pr_message WHERE pr_key = ?`;

const INSERT_ROW = `
INSERT INTO pr_message
  (pr_key, channel_id, message_ts, render_fingerprint, facts_fingerprint, summary_json,
   created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const UPDATE_OBSERVATION = `
UPDATE pr_message
   SET render_fingerprint = ?, facts_fingerprint = ?, summary_json = ?, updated_at = ?
 WHERE pr_key = ?`;

/**
 * (PR, Task) 쌍을 기록한다. 이미 있으면 `last_seen_at`만 옮긴다.
 *
 * `ON CONFLICT DO UPDATE`를 쓰는 이유는 두 문장으로 나누면 조회와 갱신 사이에 판정이 낡기
 * 때문이다. `run_key`와 `first_seen_at`은 갱신하지 않는다. 처음 관측한 사실이므로 뒤 관찰이
 * 덮을 값이 아니다.
 */
const UPSERT_PR_TASK = `
INSERT INTO pr_task (pr_key, task_key, run_key, first_seen_at, last_seen_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (pr_key, task_key) DO UPDATE SET last_seen_at = excluded.last_seen_at`;

// 순서를 SQL에서 고정한다. 지정하지 않으면 같은 파일이 실행마다 다른 순서를 낼 수 있다.
const SELECT_PR_TASKS = `
SELECT pr_key, task_key, run_key, first_seen_at, last_seen_at
  FROM pr_task WHERE pr_key = ?
 ORDER BY first_seen_at, task_key`;

/**
 * 직전 관측 상태를 덮어쓴다.
 *
 * `ON CONFLICT DO UPDATE`를 쓴다. 조회 후 INSERT/UPDATE를 고르면 두 문장 사이에서 판정이 낡고,
 * 관측마다 덮어쓰는 것이 이 표의 정상 경로다(`schema.ts`).
 */
const UPSERT_PR_STATE = `
INSERT INTO pr_state
  (pr_key, terminal, merged_at, review_verdict, reviewed_head_sha, head_sha, checks_head_sha,
   checks_json, observed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (pr_key) DO UPDATE SET
  terminal = excluded.terminal,
  merged_at = excluded.merged_at,
  review_verdict = excluded.review_verdict,
  reviewed_head_sha = excluded.reviewed_head_sha,
  head_sha = excluded.head_sha,
  checks_head_sha = excluded.checks_head_sha,
  checks_json = excluded.checks_json,
  observed_at = excluded.observed_at`;

const SELECT_PR_STATE = `
SELECT pr_key, terminal, merged_at, review_verdict, reviewed_head_sha, head_sha, checks_head_sha,
       checks_json, observed_at
  FROM pr_state WHERE pr_key = ?`;

const INSERT_THREAD_EVENT = `
INSERT INTO pr_thread_event (pr_key, dedupe_key, kind, message_ts, recorded_at)
VALUES (?, ?, ?, ?, ?)`;

// 순서를 SQL에서 고정한다. 지정하지 않으면 같은 파일이 실행마다 다른 순서를 낼 수 있다.
const SELECT_THREAD_EVENTS = `
SELECT pr_key, dedupe_key, kind, message_ts, recorded_at
  FROM pr_thread_event WHERE pr_key = ?
 ORDER BY recorded_at, dedupe_key`;

const SELECT_RUN_ROW = `
SELECT run_key, channel_id, message_ts, render_fingerprint, created_at, updated_at
  FROM run_message WHERE run_key = ?`;

const INSERT_RUN_ROW = `
INSERT INTO run_message
  (run_key, channel_id, message_ts, render_fingerprint, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)`;

const UPDATE_RUN_OBSERVATION = `
UPDATE run_message SET render_fingerprint = ?, updated_at = ? WHERE run_key = ?`;

/**
 * 컬렉션 루트 세 문장(OD-080). 행이 하나뿐이라 key 파라미터가 없다.
 *
 * `id = 1`을 SQL에 리터럴로 적는다. 호출자가 넘길 값이 아니고, 넘길 수 있게 하면 두 번째 행을
 * 만들려는 호출이 컴파일된다. `CHECK (id = 1)`이 그것을 막지만 막는 자리가 둘일 이유가 없다.
 */
const SELECT_RUN_COLLECTION_ROW = `
SELECT channel_id, message_ts, render_fingerprint, created_at, updated_at
  FROM run_collection_message WHERE id = 1`;

const INSERT_RUN_COLLECTION_ROW = `
INSERT INTO run_collection_message
  (id, channel_id, message_ts, render_fingerprint, created_at, updated_at)
VALUES (1, ?, ?, ?, ?, ?)`;

const UPDATE_RUN_COLLECTION_OBSERVATION = `
UPDATE run_collection_message SET render_fingerprint = ?, updated_at = ? WHERE id = 1`;

const SELECT_GATE_METADATA = `
SELECT gate_key, run_key, task_key, dispatch_key, ask_message_id, question_thread_id,
       options_json, recommendation_option_id, recommendation_reason, impact, registered_at
  FROM gate_metadata WHERE gate_key = ?`;

const SELECT_RUN_GATE_METADATA = `
SELECT gate_key, run_key, task_key, dispatch_key, ask_message_id, question_thread_id,
       options_json, recommendation_option_id, recommendation_reason, impact, registered_at
  FROM gate_metadata WHERE run_key = ?
 ORDER BY gate_key`;

const INSERT_GATE_METADATA = `
INSERT INTO gate_metadata
  (gate_key, run_key, task_key, dispatch_key, ask_message_id, question_thread_id,
   options_json, recommendation_option_id, recommendation_reason, impact, registered_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_GATE_MESSAGE = `
SELECT gate_key, run_key, channel_id, thread_ts, message_ts, render_fingerprint,
       created_at, updated_at
  FROM gate_message WHERE gate_key = ?`;

const INSERT_GATE_MESSAGE = `
INSERT INTO gate_message
  (gate_key, run_key, channel_id, thread_ts, message_ts, render_fingerprint, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const UPDATE_GATE_OBSERVATION = `
UPDATE gate_message SET render_fingerprint = ?, updated_at = ? WHERE gate_key = ?`;

/**
 * 이 Run에 연결된 PR과 저장된 상태를 함께 읽는다.
 *
 * `pr_task`는 (PR, Task) 쌍마다 한 행이므로(OD-076) 한 PR을 여러 Task가 이어서 갱신하면 같은
 * `pr_key`가 여러 행이다. `GROUP BY`로 PR당 한 행으로 접고 관측 시각은 최소/최대를 쓴다.
 *
 * `LEFT JOIN`이다. `pr_state` 행이 없어도 PR을 목록에서 빼지 않는다 — 연관을 관측했다는 사실과
 * 상태를 저장했다는 사실은 다르고, 빼면 카드가 그 PR을 아예 모르는 것처럼 보인다.
 *
 * `ORDER BY`를 지정하지 않으면 같은 파일이 실행마다 다른 순서를 낼 수 있고, 그러면 렌더 지문이
 * 흔들려 사실이 그대로여도 `chat.update`가 발생한다. 번호 정렬은 `pr_key` 사전순으로 되지
 * 않으므로(`#10`이 `#9`보다 앞선다) 여기서는 `pr_key`로만 고정하고 번호 정렬은 호출부가 한다.
 */
const SELECT_RUN_PULL_REQUESTS = `
SELECT t.pr_key AS pr_key,
       MIN(t.first_seen_at) AS first_seen_at,
       MAX(t.last_seen_at)  AS last_seen_at,
       s.terminal           AS terminal,
       s.merged_at          AS merged_at,
       s.review_verdict     AS review_verdict,
       s.observed_at        AS observed_at
  FROM pr_task t
  LEFT JOIN pr_state s ON s.pr_key = t.pr_key
 WHERE t.run_key = ?
 GROUP BY t.pr_key
 ORDER BY t.pr_key`;

/** sqlite가 돌려주는 run_message 한 행. 컬럼명 그대로다. */
type RunMessageRow = {
  readonly run_key: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly render_fingerprint: string;
  readonly created_at: string;
  readonly updated_at: string;
};

/** `SELECT_RUN_PULL_REQUESTS`가 돌려주는 한 행. `pr_state` 쪽 칸은 join이 비면 NULL이다. */
type RunPullRequestRow = {
  readonly pr_key: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly terminal: string | null;
  readonly merged_at: string | null;
  readonly review_verdict: string | null;
  readonly observed_at: string | null;
};

/** sqlite가 돌려주는 run_collection_message 한 행. `id`는 항상 1이므로 읽지 않는다. */
type RunCollectionMessageRow = {
  readonly channel_id: string;
  readonly message_ts: string;
  readonly render_fingerprint: string;
  readonly created_at: string;
  readonly updated_at: string;
};

type GateMetadataRow = {
  readonly gate_key: string;
  readonly run_key: string;
  readonly task_key: string;
  readonly dispatch_key: string;
  readonly ask_message_id: string;
  readonly question_thread_id: string;
  readonly options_json: string;
  readonly recommendation_option_id: string;
  readonly recommendation_reason: string;
  readonly impact: string;
  readonly registered_at: string;
};

type GateMessageRow = {
  readonly gate_key: string;
  readonly run_key: string;
  readonly channel_id: string;
  readonly thread_ts: string;
  readonly message_ts: string;
  readonly render_fingerprint: string;
  readonly created_at: string;
  readonly updated_at: string;
};

function toGateMetadata(row: GateMetadataRow): GateMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.options_json);
  } catch (e) {
    throw new TypeError(
      `${row.gate_key}의 gate_metadata.options_json이 JSON이 아니다: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const options = parseGateOptionMetadataArray(parsed, `${row.gate_key}.options_json`);
  if (!options.some((option) => option.id === row.recommendation_option_id)) {
    throw new TypeError(
      `${row.gate_key}의 recommendation_option_id가 options_json에 없다: ${row.recommendation_option_id}`,
    );
  }
  return {
    gateKey: row.gate_key as GateKey,
    runKey: row.run_key as RunKey,
    taskKey: row.task_key as TaskKey,
    dispatchKey: row.dispatch_key as GateMetadata['dispatchKey'],
    askMessageId: row.ask_message_id,
    questionThreadId: row.question_thread_id,
    options,
    recommendation: {
      optionId: row.recommendation_option_id,
      reason: row.recommendation_reason,
    },
    impact: row.impact,
    registeredAt: row.registered_at,
  };
}

function toGateMessage(row: GateMessageRow): GateMessageRecord {
  return {
    gateKey: row.gate_key as GateKey,
    runKey: row.run_key as RunKey,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    messageTs: row.message_ts,
    renderFingerprint: row.render_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRunCollectionMessageRecord(row: RunCollectionMessageRow): RunCollectionMessageRecord {
  return {
    channelId: row.channel_id,
    messageTs: row.message_ts,
    renderFingerprint: row.render_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRunMessageRecord(row: RunMessageRow): RunMessageRecord {
  return {
    runKey: row.run_key as RunKey,
    channelId: row.channel_id,
    messageTs: row.message_ts,
    renderFingerprint: row.render_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * join 결과 한 행을 record로 옮긴다.
 *
 * `terminal`이 NULL인지로 `pr_state` 행의 유무를 판정한다. 그 칸은 `NOT NULL`이므로 행이
 * 있으면 값이 있고, NULL은 join이 비었다는 뜻뿐이다. `observed_at`으로 판정해도 같지만 판정
 * 근거를 한 칸으로 고정한다.
 *
 * 행이 있는데 `observed_at`이 NULL이면 던진다. 그 칸도 `NOT NULL`이므로 그 조합은 이 코드가
 * 만든 파일에서 나올 수 없고, 빈 문자열로 접으면 카드에 `(관측 )`이 그려진다. 파일이 손상됐다는
 * 사실은 드러나야 한다(`parseChecks`와 같은 판정).
 */
function toRunPullRequestRecord(row: RunPullRequestRow): RunPullRequestRecord {
  const prKey = row.pr_key as PullRequestKey;
  if (row.terminal !== null && row.observed_at === null) {
    throw new TypeError(`${row.pr_key}의 pr_state에 terminal은 있는데 observed_at이 없다`);
  }
  return {
    prKey,
    number: pullRequestNumber(prKey),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    state:
      row.terminal === null || row.observed_at === null
        ? null
        : {
            terminal: row.terminal as PrTerminal,
            mergedAt: row.merged_at,
            reviewVerdict: row.review_verdict as ReviewerResult['verdict'] | null,
            observedAt: row.observed_at,
          },
  };
}

/**
 * PR 번호 오름차순으로 정렬한다. 같으면 `prKey` 사전순이다.
 *
 * SQL이 아니라 여기서 하는 이유는 `pr_key`가 번호를 문자열로 담아 `#10`이 `#9`보다 앞서기
 * 때문이다. 순서를 고정하지 않으면 렌더 지문이 흔들린다.
 */
function byPullRequestNumber(a: RunPullRequestRecord, b: RunPullRequestRecord): number {
  if (a.number !== b.number) return a.number - b.number;
  return a.prKey < b.prKey ? -1 : a.prKey > b.prKey ? 1 : 0;
}

/** sqlite가 돌려주는 pr_state 한 행. 컬럼명 그대로다. */
type PrStateRow = {
  readonly pr_key: string;
  readonly terminal: string;
  readonly merged_at: string | null;
  readonly review_verdict: string | null;
  readonly reviewed_head_sha: string | null;
  readonly head_sha: string;
  readonly checks_head_sha: string;
  readonly checks_json: string;
  readonly observed_at: string;
};

/** sqlite가 돌려주는 pr_thread_event 한 행. 컬럼명 그대로다. */
type PrThreadEventRow = {
  readonly pr_key: string;
  readonly dedupe_key: string;
  readonly kind: string;
  readonly message_ts: string | null;
  readonly recorded_at: string;
};

/**
 * 저장한 `checks_json`을 되읽는다.
 *
 * **JSON 파싱 실패를 빈 목록으로 접지 않는다.** 빈 목록은 "직전 관측에 check가 없었다"는
 * 사실이고, 그렇게 접으면 완료 snapshot 뒤에 도착한 진행 snapshot을 되돌릴 근거가 조용히
 * 사라진다(OD-044). 이 값을 쓰는 쪽은 이 파일이 직접 쓴 것뿐이므로 깨졌다면 파일이 손상된
 * 것이고, 그 사실은 드러나야 한다.
 */
function parseChecks(json: string, prKey: string): readonly CheckFact[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${prKey}의 pr_state.checks_json이 배열이 아니다`);
  }
  return parsed as readonly CheckFact[];
}

function toPrStateRecord(row: PrStateRow): PrStateRecord {
  return {
    prKey: row.pr_key as PullRequestKey,
    terminal: row.terminal as PrTerminal,
    mergedAt: row.merged_at,
    reviewVerdict: row.review_verdict as ReviewerResult['verdict'] | null,
    reviewedHeadSha: row.reviewed_head_sha,
    headSha: row.head_sha,
    checksHeadSha: row.checks_head_sha,
    checks: parseChecks(row.checks_json, row.pr_key),
    observedAt: row.observed_at,
  };
}

function toThreadEventRecord(row: PrThreadEventRow): PrThreadEventRecord {
  return {
    prKey: row.pr_key as PullRequestKey,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    messageTs: row.message_ts,
    recordedAt: row.recorded_at,
  };
}

/** sqlite가 돌려주는 pr_message 한 행. 컬럼명 그대로다. */
type PrMessageRow = {
  readonly pr_key: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly render_fingerprint: string;
  /** v2 이전에 만들어진 행에는 값이 없다. */
  readonly facts_fingerprint: string | null;
  readonly summary_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

/** sqlite가 돌려주는 pr_task 한 행. 컬럼명 그대로다. */
type PrTaskRow = {
  readonly pr_key: string;
  readonly task_key: string;
  readonly run_key: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
};

function toPrTaskRecord(row: PrTaskRow): PrTaskRecord {
  return {
    prKey: row.pr_key as PullRequestKey,
    taskKey: row.task_key as TaskKey,
    runKey: row.run_key as RunKey,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toRecord(row: PrMessageRow): PrMessageRecord {
  return {
    prKey: row.pr_key as PullRequestKey,
    channelId: row.channel_id,
    messageTs: row.message_ts,
    renderFingerprint: row.render_fingerprint,
    factsFingerprint: row.facts_fingerprint,
    summaryJson: row.summary_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteDigestStore implements DigestStore, RunStore, GateStore {
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
          input.factsFingerprint,
          input.summaryJson,
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

  updateObservation(prKey: PullRequestKey, observation: ObservationRecord, at: string): void {
    const result = this.db
      .prepare(UPDATE_OBSERVATION)
      .run(
        observation.renderFingerprint,
        observation.factsFingerprint,
        observation.summaryJson,
        at,
        prKey,
      );
    if (Number(result.changes) === 0) {
      // 갱신할 행이 없다는 것은 호출 순서가 깨졌다는 뜻이다. 새 행을 만들어 덮지 않는다.
      throw new Error(`${prKey}의 매핑 행이 없어 관찰 결과를 갱신할 수 없다`);
    }
  }

  recordPrTask(input: NewPrTask): void {
    this.db
      .prepare(UPSERT_PR_TASK)
      .run(input.prKey, input.taskKey, input.runKey, input.at, input.at);
  }

  listPrTasks(prKey: PullRequestKey): readonly PrTaskRecord[] {
    return (this.db.prepare(SELECT_PR_TASKS).all(prKey) as PrTaskRow[]).map(toPrTaskRecord);
  }

  findPrState(prKey: PullRequestKey): PrStateRecord | null {
    const row = this.db.prepare(SELECT_PR_STATE).get(prKey) as PrStateRow | undefined;
    return row === undefined ? null : toPrStateRecord(row);
  }

  savePrState(prKey: PullRequestKey, state: PrStateSnapshot, at: string): void {
    this.db
      .prepare(UPSERT_PR_STATE)
      .run(
        prKey,
        state.terminal,
        state.mergedAt,
        state.reviewVerdict,
        state.reviewedHeadSha,
        state.headSha,
        state.checksHeadSha,
        JSON.stringify(state.checks),
        at,
      );
  }

  listThreadEvents(prKey: PullRequestKey): readonly PrThreadEventRecord[] {
    return (this.db.prepare(SELECT_THREAD_EVENTS).all(prKey) as PrThreadEventRow[]).map(
      toThreadEventRecord,
    );
  }

  recordThreadEvent(input: NewThreadEvent): void {
    try {
      this.db
        .prepare(INSERT_THREAD_EVENT)
        .run(input.prKey, input.dedupeKey, input.kind, input.messageTs, input.at);
    } catch (e) {
      // 조용히 덮어쓰지 않는다. 덮어쓰면 thread에 중복 reply가 남은 사실이 store에서 사라진다.
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${input.prKey}의 전이 ${input.dedupeKey}를 기록할 수 없다: ${detail}`,
        { cause: e },
      );
    }
  }

  findRunMessage(runKey: RunKey): RunMessageRecord | null {
    const row = this.db.prepare(SELECT_RUN_ROW).get(runKey) as RunMessageRow | undefined;
    return row === undefined ? null : toRunMessageRecord(row);
  }

  insertRunMessage(input: NewRunMessage): void {
    try {
      this.db
        .prepare(INSERT_RUN_ROW)
        .run(
          input.runKey,
          input.channelId,
          input.messageTs,
          input.renderFingerprint,
          input.at,
          input.at,
        );
    } catch (e) {
      // `insertPrMessage`와 같은 이유로 조용히 덮어쓰지 않는다. 덮어쓰면 앞서 게시한 Slack
      // 루트를 잃어버린다.
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${input.runKey}의 루트 메시지를 기록할 수 없다 ` +
          `(channel ${input.channelId}, ts ${input.messageTs}): ${detail}`,
        { cause: e },
      );
    }
  }

  updateRunObservation(runKey: RunKey, renderFingerprint: string, at: string): void {
    const result = this.db.prepare(UPDATE_RUN_OBSERVATION).run(renderFingerprint, at, runKey);
    if (Number(result.changes) === 0) {
      // 갱신할 행이 없다는 것은 호출 순서가 깨졌다는 뜻이다. 새 행을 만들어 덮지 않는다.
      throw new Error(`${runKey}의 매핑 행이 없어 관찰 결과를 갱신할 수 없다`);
    }
  }

  listRunPullRequests(runKey: RunKey): readonly RunPullRequestRecord[] {
    return (this.db.prepare(SELECT_RUN_PULL_REQUESTS).all(runKey) as RunPullRequestRow[])
      .map(toRunPullRequestRecord)
      .sort(byPullRequestNumber);
  }

  findRunCollectionMessage(): RunCollectionMessageRecord | null {
    const row = this.db.prepare(SELECT_RUN_COLLECTION_ROW).get() as
      | RunCollectionMessageRow
      | undefined;
    return row === undefined ? null : toRunCollectionMessageRecord(row);
  }

  insertRunCollectionMessage(input: NewRunCollectionMessage): void {
    try {
      this.db
        .prepare(INSERT_RUN_COLLECTION_ROW)
        .run(input.channelId, input.messageTs, input.renderFingerprint, input.at, input.at);
    } catch (e) {
      // `insertRunMessage`와 같은 이유로 조용히 덮어쓰지 않는다. 덮어쓰면 앞서 게시한 Slack
      // 루트를 잃어버린다.
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `컬렉션 루트 메시지를 기록할 수 없다 (channel ${input.channelId}, ts ${input.messageTs}): ${detail}`,
        { cause: e },
      );
    }
  }

  updateRunCollectionObservation(renderFingerprint: string, at: string): void {
    const result = this.db
      .prepare(UPDATE_RUN_COLLECTION_OBSERVATION)
      .run(renderFingerprint, at);
    if (Number(result.changes) === 0) {
      // 갱신할 행이 없다는 것은 호출 순서가 깨졌다는 뜻이다. 새 행을 만들어 덮지 않는다.
      throw new Error('컬렉션 루트의 매핑 행이 없어 관찰 결과를 갱신할 수 없다');
    }
  }

  findGateMetadata(gateKey: GateKey): GateMetadata | null {
    const row = this.db.prepare(SELECT_GATE_METADATA).get(gateKey) as GateMetadataRow | undefined;
    return row === undefined ? null : toGateMetadata(row);
  }

  listGateMetadata(runKey: RunKey): readonly GateMetadata[] {
    return (this.db.prepare(SELECT_RUN_GATE_METADATA).all(runKey) as GateMetadataRow[]).map(
      toGateMetadata,
    );
  }

  insertGateMetadata(metadata: GateMetadata): void {
    try {
      this.db
        .prepare(INSERT_GATE_METADATA)
        .run(
          metadata.gateKey,
          metadata.runKey,
          metadata.taskKey,
          metadata.dispatchKey,
          metadata.askMessageId,
          metadata.questionThreadId,
          JSON.stringify(metadata.options),
          metadata.recommendation.optionId,
          metadata.recommendation.reason,
          metadata.impact,
          metadata.registeredAt,
        );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`${metadata.gateKey}의 sidecar metadata를 기록할 수 없다: ${detail}`, {
        cause: e,
      });
    }
  }

  findGateMessage(gateKey: GateKey): GateMessageRecord | null {
    const row = this.db.prepare(SELECT_GATE_MESSAGE).get(gateKey) as GateMessageRow | undefined;
    return row === undefined ? null : toGateMessage(row);
  }

  insertGateMessage(message: NewGateMessage): void {
    try {
      this.db
        .prepare(INSERT_GATE_MESSAGE)
        .run(
          message.gateKey,
          message.runKey,
          message.channelId,
          message.threadTs,
          message.messageTs,
          message.renderFingerprint,
          message.at,
          message.at,
        );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${message.gateKey}의 thread 메시지를 기록할 수 없다 ` +
          `(channel ${message.channelId}, ts ${message.messageTs}): ${detail}`,
        { cause: e },
      );
    }
  }

  updateGateObservation(gateKey: GateKey, renderFingerprint: string, at: string): void {
    const result = this.db.prepare(UPDATE_GATE_OBSERVATION).run(renderFingerprint, at, gateKey);
    if (Number(result.changes) === 0) {
      throw new Error(`${gateKey}의 thread 매핑 행이 없어 관찰 결과를 갱신할 수 없다`);
    }
  }

  close(): void {
    // WAL과 shm을 본 파일에 접고 지운다. 다음 실행이 남은 조각을 복구하지 않아도 되게 한다.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}

/** `ReadOnlyDigestStore`가 연 복사본. 원본 파일이 없으면 세 값이 모두 "없음"이다. */
type OpenedCopy = {
  readonly db: DatabaseSync | null;
  /** 복사본을 담은 임시 디렉터리. `close`가 통째로 지운다. */
  readonly scratch: string | null;
  /** 복사본에 `pr_message`가 있는지. 스키마가 없는 파일이면 조회하지 않는다. */
  readonly schemaReady: boolean;
};

/**
 * dry-run이 쓰는 읽기 전용 `DigestStore`.
 *
 * dry-run도 `findPrMessage`는 해야 한다. 기존 루트가 있으면 `update`, 없으면 `create`로
 * 보고하는 것이 dry-run의 쓸모이기 때문이다. 그런데 `SqliteDigestStore`로 읽으면 그 읽기가
 * 파일을 바꾼다. 생성자가 부모 디렉터리와 DB 파일을 만들고 `PRAGMA journal_mode = WAL`과 DDL을
 * 쓰며 `close`가 checkpoint한다.
 *
 * 그래서 **원본을 아예 열지 않는다.** 원본에 하는 일은 `statSync`와 `copyFileSync`뿐이고
 * SQLite 연결은 임시 디렉터리의 복사본에만 연다. 원본에 write handle이 생기지 않으므로 내용이
 * 바뀔 수 없고 `-wal`·`-shm` 같은 곁파일도 원본 옆에 생기지 않는다. 이것이 "아무것도 쓰지
 * 않는다"의 근거다. 파일이 없으면 복사할 것도 없으므로 열지 않고 "행 없음"으로 다룬다.
 *
 * `-wal`도 함께 복사한다. 이전 실행이 죽어 checkpoint되지 않은 `-wal`이 남으면 커밋된 행이 본
 * 파일이 아니라 거기에만 있다. 복사하지 않으면 매핑이 있는 PR을 `create`로 보고한다. `-shm`은
 * 복사하지 않는다. `-wal`의 색인일 뿐이고 SQLite가 복사본에서 다시 만든다. 동시 writer가 없다는
 * 가정(OD-043)이 두 파일의 복사가 서로 어긋나지 않는 근거다.
 *
 * 기각한 대안 둘. `file:...?immutable=1`로 원본을 직접 여는 방법은 곁파일을 만들지 않지만
 * SQLite가 `-wal`을 읽지 않아, `-wal`에만 있는 커밋된 행이 조회 결과에서 빠진다. `readOnly: true`
 * 열기는 그 행을 읽지만 원본 옆에 `-shm`과 빈 `-wal`을 만들고 남긴다.
 *
 * write 메서드는 던진다. dry-run에서 `runDigest`는 Slack 호출 전에 돌아가므로 호출될 일이 없고,
 * 호출된다면 흐름이 깨졌다는 뜻이다. 조용히 무시하면 게시하지 않은 카드의 매핑이 남는다.
 *
 * 복사본에는 쓴다. 원본이 옛 버전이면 `openCopy`가 복사본에만 migration을 건다. 원본은
 * 그대로이므로 "아무것도 쓰지 않는다"는 유지되고, dry-run은 실제 실행과 같은 컬럼을 읽는다.
 */
export class ReadOnlyDigestStore implements DigestStore, RunStore, GateStore {
  private readonly opened: OpenedCopy;

  constructor(private readonly path: string) {
    this.opened = openCopy(path);
  }

  findPrMessage(prKey: PullRequestKey): PrMessageRecord | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_ROW).get(prKey) as PrMessageRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  insertPrMessage(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. 루트 매핑을 기록하려 했다: ${this.path}`);
  }

  updateObservation(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. 관찰 결과를 갱신하려 했다: ${this.path}`);
  }

  recordPrTask(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. PR↔Task 연관을 기록하려 했다: ${this.path}`);
  }

  listPrTasks(prKey: PullRequestKey): readonly PrTaskRecord[] {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return [];
    return (db.prepare(SELECT_PR_TASKS).all(prKey) as PrTaskRow[]).map(toPrTaskRecord);
  }

  findPrState(prKey: PullRequestKey): PrStateRecord | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_PR_STATE).get(prKey) as PrStateRow | undefined;
    return row === undefined ? null : toPrStateRecord(row);
  }

  savePrState(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. 관측 상태를 저장하려 했다: ${this.path}`);
  }

  listThreadEvents(prKey: PullRequestKey): readonly PrThreadEventRecord[] {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return [];
    return (db.prepare(SELECT_THREAD_EVENTS).all(prKey) as PrThreadEventRow[]).map(
      toThreadEventRecord,
    );
  }

  recordThreadEvent(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. thread 전이를 기록하려 했다: ${this.path}`);
  }

  findRunMessage(runKey: RunKey): RunMessageRecord | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_RUN_ROW).get(runKey) as RunMessageRow | undefined;
    return row === undefined ? null : toRunMessageRecord(row);
  }

  insertRunMessage(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. Run 루트 매핑을 기록하려 했다: ${this.path}`);
  }

  updateRunObservation(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. Run 관찰 결과를 갱신하려 했다: ${this.path}`);
  }

  listRunPullRequests(runKey: RunKey): readonly RunPullRequestRecord[] {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return [];
    return (db.prepare(SELECT_RUN_PULL_REQUESTS).all(runKey) as RunPullRequestRow[])
      .map(toRunPullRequestRecord)
      .sort(byPullRequestNumber);
  }

  findRunCollectionMessage(): RunCollectionMessageRecord | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_RUN_COLLECTION_ROW).get() as
      | RunCollectionMessageRow
      | undefined;
    return row === undefined ? null : toRunCollectionMessageRecord(row);
  }

  insertRunCollectionMessage(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. 컬렉션 루트 매핑을 기록하려 했다: ${this.path}`);
  }

  updateRunCollectionObservation(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. 컬렉션 관찰 결과를 갱신하려 했다: ${this.path}`);
  }

  findGateMetadata(gateKey: GateKey): GateMetadata | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_GATE_METADATA).get(gateKey) as GateMetadataRow | undefined;
    return row === undefined ? null : toGateMetadata(row);
  }

  listGateMetadata(runKey: RunKey): readonly GateMetadata[] {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return [];
    return (db.prepare(SELECT_RUN_GATE_METADATA).all(runKey) as GateMetadataRow[]).map(
      toGateMetadata,
    );
  }

  insertGateMetadata(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate metadata를 기록하려 했다: ${this.path}`);
  }

  findGateMessage(gateKey: GateKey): GateMessageRecord | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_GATE_MESSAGE).get(gateKey) as GateMessageRow | undefined;
    return row === undefined ? null : toGateMessage(row);
  }

  insertGateMessage(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate thread 매핑을 기록하려 했다: ${this.path}`);
  }

  updateGateObservation(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate 관찰 결과를 갱신하려 했다: ${this.path}`);
  }

  close(): void {
    // 복사본이므로 checkpoint하지 않는다. 원본에는 애초에 열린 handle이 없다.
    this.opened.db?.close();
    if (this.opened.scratch !== null) {
      rmSync(this.opened.scratch, { recursive: true, force: true });
    }
  }
}

/**
 * 경로에 파일이 있는지 본다. **`ENOENT`만 부재로 접고 나머지 오류는 전파한다.**
 *
 * `existsSync`를 쓰지 않는 이유다. 그 함수는 경로 탐색 중의 `EACCES`·`EPERM`에서도 `false`를
 * 돌려주므로, 읽을 수 없는 기존 store가 "없는 store"가 된다. 그러면 dry-run이 이미 루트가 있는
 * PR을 `create`로 보고하고, 그 보고를 믿고 게시하면 루트가 하나 더 생긴다. 로드맵 §5의 "재관찰로
 * 루트가 중복되지 않음"이 겨냥하는 실패가 이것이다. "판정할 수 없다"는 "없다"가 아니므로 조용히
 * 넘어가지 않고 던진다. 조용한 발산이 시끄러운 실패보다 나쁘다(`win32StateBase`와 같은 이유).
 *
 * `ENOTDIR`도 전파한다. 경로 구성요소가 디렉터리가 아니면 그 자리에 DB가 있을 수 없다고 볼 수도
 * 있지만, 그것은 "아직 만들지 않았다"가 아니라 store 경로 자체가 틀렸다는 뜻이다. 부재로 접으면
 * 열릴 수 없는 경로를 dry-run이 `create`로 보고한다.
 *
 * 오류를 감싸지 않고 그대로 올린다. Node의 errno 오류는 이미 syscall과 경로를 message에 담고,
 * 그 경로는 호출자가 준 store 경로라 채널 ID나 토큰처럼 가릴 값이 아니다.
 */
function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * 원본을 임시 디렉터리에 복사해 연다. 원본이 없으면 아무것도 열지 않는다.
 *
 * 여는 도중 실패하면 임시 디렉터리를 남기지 않는다. 호출자는 생성자에서 던진 store의 `close`를
 * 부르지 않기 때문이다.
 */
function openCopy(path: string): OpenedCopy {
  if (!pathExists(path)) return { db: null, scratch: null, schemaReady: false };

  const scratch = mkdtempSync(join(tmpdir(), 'orca-slack-bridge-ro-'));
  let db: DatabaseSync | null = null;
  try {
    const copy = join(scratch, 'state.db');
    copyFileSync(path, copy);
    if (pathExists(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    db = new DatabaseSync(copy);
    // 버전 판정과 migration은 실제 실행과 같은 함수를 쓴다. 모르는 버전이면 여기서도 던진다.
    // 올리는 대상은 **복사본**이다. 원본은 v1인 채로 남고, 다음 실제 실행이 원본을 올린다.
    // 복사본을 올리지 않으면 dry-run이 v2 컬럼을 읽지 못해 실제 실행과 다른 판정을 낸다.
    const version = readSchemaVersion(db, path);
    if (version !== null) applyMigrations(db, path, version);
    return { db, scratch, schemaReady: version !== null };
  } catch (e) {
    db?.close();
    rmSync(scratch, { recursive: true, force: true });
    throw e;
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
 * 스키마 버전을 확인하고, 비어 있으면 DDL을 적용하고, 낮으면 올린다.
 *
 * 버전을 먼저 읽는 이유는 모르는 버전의 파일에 아무것도 쓰지 않기 위해서다. `pr_task`는
 * `IF NOT EXISTS`가 없으므로(`schema.ts`) DDL 재실행이 기존 테이블 위에서 던진다. 판정 전에
 * write를 시작하지 않아야 이 던짐이 "이 코드가 만들지 않은 파일"의 신호로 남는다.
 *
 * DDL과 버전 기록을 한 트랜잭션에 묶는다. 둘 사이에서 죽으면 다음 실행이 "테이블은 있는데
 * 버전은 모르는" 파일을 만나 판정할 근거를 잃는다.
 */
function prepareSchema(db: DatabaseSync, path: string): void {
  const version = readSchemaVersion(db, path);

  if (version === null) {
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

  applyMigrations(db, path, version);
}

/**
 * 파일 버전 `from`에서 `SCHEMA_VERSION`까지 `MIGRATIONS`를 순서대로 적용한다.
 *
 * 이미 최신이면 아무것도 하지 않는다. 올릴 문장이 없는 버전이면 `SchemaVersionError`를
 * 던진다. 파일이 코드보다 새로운 경우가 그렇고, `MIGRATIONS`가 시작하는 버전(1)보다 낮은
 * 경우도 그렇다.
 *
 * **전체를 한 트랜잭션에 묶고 버전 기록까지 같은 트랜잭션에 넣는다.** 중간에 죽으면 컬럼은
 * 붙었는데 버전은 옛것인 파일이 남고, 다음 실행이 같은 `ALTER TABLE`을 다시 걸어 실패한다.
 * 이 파일에는 실제로 게시된 카드의 매핑이 들어 있어 열지 못하면 루트가 하나 더 생긴다.
 *
 * `ALTER TABLE`은 SQLite에서 트랜잭션 안에서 실행할 수 있고 ROLLBACK으로 되돌아간다.
 * 되돌아간 파일은 적용 전과 같은 v1이므로 옛 코드로도 그대로 열린다. 이것이 `MIGRATIONS`를
 * 덧붙이기로 제한한 이유이기도 하다(`schema.ts`).
 */
function applyMigrations(db: DatabaseSync, path: string, from: number): void {
  if (from === SCHEMA_VERSION) return;
  if (from > SCHEMA_VERSION || from < 1) {
    throw new SchemaVersionError(path, from, SCHEMA_VERSION);
  }

  db.exec('BEGIN');
  try {
    for (let v = from; v < SCHEMA_VERSION; v += 1) {
      const step = MIGRATIONS[v - 1];
      // SCHEMA_VERSION과 MIGRATIONS.length가 어긋나면 여기서 드러난다. 건너뛰지 않는다.
      if (step === undefined) throw new SchemaVersionError(path, from, SCHEMA_VERSION);
      for (const statement of step) db.exec(statement);
    }
    db.prepare('UPDATE schema_version SET version = ?, applied_at = ? WHERE id = 1').run(
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * `schema_version`의 버전을 읽는다. 테이블 자체가 없으면 null이다.
 *
 * null은 "아직 스키마가 없는 파일"이라는 뜻이고, 그 파일에는 `pr_message`도 없다. 두 테이블이
 * 한 DDL·한 트랜잭션에서 만들어지기 때문이다. 테이블은 있는데 버전 행이 없으면 어느 버전의
 * 컬럼을 읽어야 하는지 판정할 근거가 없으므로 던진다.
 *
 * SELECT만 한다. `prepareSchema`와 `ReadOnlyDigestStore`가 같은 판정을 써야 하기 때문이다.
 * 둘이 갈라지면 dry-run이 실제 실행과 다른 버전 판정을 내린다.
 */
function readSchemaVersion(db: DatabaseSync, path: string): number | null {
  const versioned = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (versioned === undefined) return null;

  const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as
    | { readonly version: number }
    | undefined;
  if (row === undefined) {
    throw new Error(
      `store 파일에 schema_version 테이블은 있는데 버전 행이 없다: ${path}\n` +
        'Bridge가 만든 파일이 아니거나 손상됐다.',
    );
  }
  return row.version;
}
