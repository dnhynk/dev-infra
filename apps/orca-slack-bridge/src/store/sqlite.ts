import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import type { CheckFact } from '../github/pull-request.js';
import {
  detectGateResumeEvidence,
  normalizeGateResumeSnapshot,
  parseGateResumeSnapshotJson,
} from '../channel/resume.js';
import { normalizeGithubNameWithOwner } from '../discovery/github-remote.js';
import { parseGateOptionMetadataArray } from '../gate/register.js';
import type { GateMetadata } from '../gate/types.js';
import {
  gateActionId,
  gateBlockId,
  gateDirectActionId,
  gateDirectActionValue,
  gateDirectBlockId,
  gateDirectCallbackId,
  gateDirectInputActionId,
  gateDirectInputBlockId,
} from '../gate/actions.js';
import {
  GATE_DIRECT_OPTION_ID,
  type GateDirectClaimInput,
  type GateDirectModalSession,
  type GateDirectOpenResult,
  type GateDirectPrepareInput,
  type GateDirectPrepareResult,
} from '../gate/direct-input-types.js';
import {
  GATE_AUDIT_LIMIT,
  GATE_FACT_CAP,
  type GateChannelConsumeResult,
  type GateChannelDelivery,
  type GateChannelDeliveryCommitFence,
  type GateChannelDeliveryLeaseResult,
  type GateChannelSeedResult,
  type GateChannelProjectionClaim,
  type GateChannelDeliveryState,
  type GateResumeBaselineState,
  type GateResumeEvidence,
  type GateResumeLeaseResult,
  type GateResumeObservation,
  type GateResumeSnapshot,
  type GateCardState,
  type GateClaimInput,
  type GateClaimResult,
  type GateLocalObservation,
  type GateObservationSaveResult,
  type GateLeaseResult,
  type GateProjectionLeaseResult,
  type GateProgressUpdate,
  type GateResolutionIntent,
  type GateResolutionLifecycle,
  type GateResolutionOutbox,
  type GateResolveResult,
  type GateSnapshot,
} from '../gate/resolution-types.js';
import { pullRequestKey, pullRequestNumber, runKey } from '../identity/keys.js';
import type { GateKey, PullRequestKey, RunKey, TaskKey } from '../identity/keys.js';
import type { PrTerminal, ReviewerResult } from '../digest/types.js';
import {
  ENABLE_WAL,
  GATE_V8_SCHEMA_OBJECTS,
  GATE_V9_SCHEMA_OBJECTS,
  GATE_V10_SCHEMA_OBJECTS,
  GATE_V11_SCHEMA_OBJECTS,
  GATE_V12_SCHEMA_OBJECTS,
  MIGRATIONS,
  OPERATIONAL_V13_SCHEMA_OBJECTS,
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
import type {
  DaemonDesiredState,
  DaemonHealthRecord,
  DaemonStartInput,
  DaemonJobClaim,
  DaemonJobCompletion,
  DaemonJobName,
  DaemonJobOutcomeRecord,
  DaemonJobSuccessCompletion,
  EffectiveDiscoverySnapshot,
  OperationalAggregateCounts,
  OperationalFailureCode,
  OperationalStore,
  OrcaRepositoryBindingRecord,
  PrepareSlackRootIntentInput,
  ReplaceDiscoverySnapshotInput,
  RepositoryDiscoveryIssueCategory,
  RepositoryDiscoveryIssueRecord,
  RepositoryRegistryRecord,
  SlackRootClaim,
  SlackRootClaimResult,
  SlackRootEntity,
  SlackRootIntentRecord,
  SlackRootPostedInput,
} from './operational-types.js';
import { OPERATIONAL_FAILURE_CODES } from './operational-types.js';

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

export type OperationalStoreErrorCode =
  | 'OPERATIONAL_INPUT_INVALID'
  | 'OPERATIONAL_CONFLICT'
  | 'OPERATIONAL_STALE_TRANSITION'
  | 'OPERATIONAL_STORE_CORRUPT';

const OPERATIONAL_ERROR_MESSAGES: Readonly<Record<OperationalStoreErrorCode, string>> = {
  OPERATIONAL_INPUT_INVALID: 'Operational store input is invalid',
  OPERATIONAL_CONFLICT: 'Operational store input conflicts with durable state',
  OPERATIONAL_STALE_TRANSITION: 'Operational store transition is stale',
  OPERATIONAL_STORE_CORRUPT: 'Operational store state is malformed or corrupt',
};

/** Static/redacted public error. Exact repository, daemon, job, and Slack keys stay in typed data. */
export class OperationalStoreError extends Error {
  constructor(readonly code: OperationalStoreErrorCode) {
    super(OPERATIONAL_ERROR_MESSAGES[code]);
    this.name = 'OperationalStoreError';
  }
}

function operationalFail(code: OperationalStoreErrorCode): never {
  throw new OperationalStoreError(code);
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

const UPSERT_GATE_LOCAL_OBSERVATION = `
INSERT INTO gate_local_observation
  (gate_key, run_key, task_key, status, resolution, resolved_at, metadata_state, mapping_state,
   write_owner, write_expires_at, observed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
ON CONFLICT (gate_key) DO UPDATE SET
  run_key = excluded.run_key,
  task_key = excluded.task_key,
  status = excluded.status,
  resolution = excluded.resolution,
  resolved_at = excluded.resolved_at,
  metadata_state = excluded.metadata_state,
  mapping_state = CASE
    WHEN gate_local_observation.write_owner IS NOT NULL THEN 'write_pending'
    WHEN gate_local_observation.mapping_state IN ('missing','mismatched')
         AND excluded.mapping_state = 'matched'
      THEN gate_local_observation.mapping_state
    ELSE excluded.mapping_state
  END,
  write_owner = gate_local_observation.write_owner,
  write_expires_at = gate_local_observation.write_expires_at,
  observed_at = excluded.observed_at`;

const SELECT_GATE_LOCAL_OBSERVATION = `
SELECT gate_key, run_key, task_key, status, resolution, resolved_at, metadata_state, mapping_state,
       write_owner, write_expires_at, observed_at
  FROM gate_local_observation WHERE gate_key = ?`;

const SELECT_GATE_OBSERVATION_GENERATION = `
SELECT gate_key, revision FROM gate_observation_generation WHERE gate_key = ?`;

const UPSERT_GATE_OBSERVATION_GENERATION = `
INSERT INTO gate_observation_generation (gate_key, revision) VALUES (?, ?)
ON CONFLICT (gate_key) DO UPDATE SET revision = excluded.revision`;

const SELECT_GATE_MESSAGE_BY_SLACK = `
SELECT gate_key, run_key, channel_id, thread_ts, message_ts, render_fingerprint,
       created_at, updated_at
  FROM gate_message WHERE channel_id = ? AND message_ts = ?`;

const SELECT_GATE_DIRECT_MODAL = `
SELECT session_id, revision, button_event_key, gate_key,
       team_id, owner_user_id, api_app_id, channel_id, thread_ts, message_ts,
       block_id, action_id, action_value, callback_id, input_block_id, input_action_id,
       state, view_id, failure_code, resolution_text,
       created_at, updated_at, opened_at, accepted_at
  FROM gate_direct_modal WHERE session_id = ?`;

const SELECT_GATE_DIRECT_MODAL_BY_EVENT = `
SELECT session_id, revision, button_event_key, gate_key,
       team_id, owner_user_id, api_app_id, channel_id, thread_ts, message_ts,
       block_id, action_id, action_value, callback_id, input_block_id, input_action_id,
       state, view_id, failure_code, resolution_text,
       created_at, updated_at, opened_at, accepted_at
  FROM gate_direct_modal WHERE button_event_key = ?`;

const SELECT_ALL_GATE_DIRECT_MODALS = `
SELECT session_id, revision, button_event_key, gate_key,
       team_id, owner_user_id, api_app_id, channel_id, thread_ts, message_ts,
       block_id, action_id, action_value, callback_id, input_block_id, input_action_id,
       state, view_id, failure_code, resolution_text,
       created_at, updated_at, opened_at, accepted_at
  FROM gate_direct_modal ORDER BY session_id`;

const INSERT_GATE_DIRECT_MODAL = `
INSERT INTO gate_direct_modal
  (session_id, revision, button_event_key, gate_key,
   team_id, owner_user_id, api_app_id, channel_id, thread_ts, message_ts,
   block_id, action_id, action_value, callback_id, input_block_id, input_action_id,
   state, view_id, failure_code, resolution_text,
   created_at, updated_at, opened_at, accepted_at)
VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'prepared', NULL, NULL, NULL, ?, ?, NULL, NULL)`;

const BEGIN_GATE_DIRECT_MODAL_OPEN = `
UPDATE gate_direct_modal
   SET revision = revision + 1, state = 'opening', updated_at = ?
 WHERE session_id = ? AND revision = ? AND state = 'prepared'`;

const FINISH_GATE_DIRECT_MODAL_OPENED = `
UPDATE gate_direct_modal
   SET revision = revision + 1, state = 'opened', view_id = ?, opened_at = ?, updated_at = ?
 WHERE session_id = ? AND revision = ? AND state = 'opening'`;

const FINISH_GATE_DIRECT_MODAL_FAILED = `
UPDATE gate_direct_modal
   SET revision = revision + 1, state = 'failed', failure_code = ?, updated_at = ?
 WHERE session_id = ? AND revision = ? AND state = 'opening'`;

const ACCEPT_GATE_DIRECT_MODAL = `
UPDATE gate_direct_modal
   SET revision = revision + 1, state = 'accepted', resolution_text = ?,
       accepted_at = ?, updated_at = ?
 WHERE session_id = ? AND revision = ? AND state = 'opened'`;

const INSERT_GATE_RESOLUTION = `
INSERT INTO gate_resolution
  (gate_key, revision, ack_state, lease_owner, lease_expires_at,
   retry_request_id, option_id, option_resolution,
   ask_message_id, question_thread_id, dispatch_id, task_id,
   team_id, owner_user_id, api_app_id, channel_id, thread_ts, message_ts,
   block_id, action_id, action_value, lifecycle, mutation_ownership,
   pre_read_json, resolve_result_json, post_read_json,
   last_error_code, last_error_detail, created_at, updated_at)
VALUES (?, 0, 'pending', NULL, NULL,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        'claimed', 'not_started',
        NULL, NULL, NULL, NULL, NULL, ?, ?)`;

const SELECT_GATE_RESOLUTION = `
SELECT gate_key, revision, ack_state, lease_owner, lease_expires_at,
       retry_request_id, option_id, option_resolution,
       ask_message_id, question_thread_id, dispatch_id, task_id,
       team_id, owner_user_id, api_app_id, channel_id, thread_ts, message_ts,
       block_id, action_id, action_value, lifecycle, mutation_ownership,
       pre_read_json, resolve_result_json, post_read_json,
       last_error_code, last_error_detail, created_at, updated_at
  FROM gate_resolution WHERE gate_key = ?`;

const SELECT_ALL_GATE_RESOLUTIONS = `
SELECT gate_key, revision, ack_state, lease_owner, lease_expires_at,
       retry_request_id, option_id, option_resolution,
       ask_message_id, question_thread_id, dispatch_id, task_id,
       team_id, owner_user_id, api_app_id, channel_id, thread_ts, message_ts,
       block_id, action_id, action_value, lifecycle, mutation_ownership,
       pre_read_json, resolve_result_json, post_read_json,
       last_error_code, last_error_detail, created_at, updated_at
  FROM gate_resolution ORDER BY gate_key`;

const SELECT_NONTERMINAL_GATE_RESOLUTIONS = `
SELECT gate_key, revision, ack_state, lease_owner, lease_expires_at,
       retry_request_id, option_id, option_resolution,
       ask_message_id, question_thread_id, dispatch_id, task_id,
       team_id, owner_user_id, api_app_id, channel_id, thread_ts, message_ts,
       block_id, action_id, action_value, lifecycle, mutation_ownership,
       pre_read_json, resolve_result_json, post_read_json,
       last_error_code, last_error_detail, created_at, updated_at
  FROM gate_resolution
 WHERE ack_state = 'acked' AND lifecycle NOT IN ('resolved','conflict','degraded')
 ORDER BY gate_key`;

const MARK_GATE_RESOLUTION_ACK = `
UPDATE gate_resolution
   SET revision = revision + 1, ack_state = ?, updated_at = ?
 WHERE gate_key = ? AND revision = ? AND lifecycle = 'claimed'
   AND ack_state IN ('pending','failed')`;

const UPDATE_GATE_RESOLUTION_PROGRESS = `
UPDATE gate_resolution
   SET revision = revision + 1,
       lifecycle = ?, mutation_ownership = ?, pre_read_json = ?, resolve_result_json = ?, post_read_json = ?,
       last_error_code = ?, last_error_detail = ?, updated_at = ?
 WHERE gate_key = ? AND revision = ? AND lease_owner = ?
   AND lifecycle NOT IN ('resolved','conflict','degraded')`;

const INSERT_GATE_OUTBOX = `
INSERT INTO gate_resolution_outbox
  (gate_key, revision, card_state, card_pending, notification_state, projected_at,
   projection_owner, projection_expires_at, last_error_code, created_at, updated_at)
VALUES (?, 0, 'resolving', 1, 'pending', NULL, NULL, NULL, NULL, ?, ?)`;

const UPSERT_GATE_OUTBOX_PROGRESS = `
INSERT INTO gate_resolution_outbox
  (gate_key, revision, card_state, card_pending, notification_state, projected_at,
   projection_owner, projection_expires_at, last_error_code, created_at, updated_at)
VALUES (?, 0, ?, 1, 'pending', NULL, NULL, NULL, ?, ?, ?)
ON CONFLICT (gate_key) DO UPDATE SET
  revision = gate_resolution_outbox.revision + 1,
  card_state = excluded.card_state,
  card_pending = 1,
  notification_state = 'pending',
  projected_at = NULL,
  last_error_code = excluded.last_error_code,
  updated_at = excluded.updated_at`;

const SELECT_PENDING_GATE_OUTBOXES = `
SELECT o.gate_key, o.revision, o.card_state, o.card_pending, o.notification_state, o.projected_at,
       o.projection_owner, o.projection_expires_at, o.last_error_code, o.created_at, o.updated_at
  FROM gate_resolution_outbox o
 WHERE o.card_pending = 1
 ORDER BY o.gate_key`;

const SELECT_ACKNOWLEDGED_GATE_OUTBOXES = `
SELECT o.gate_key, o.revision, o.card_state, o.card_pending, o.notification_state, o.projected_at,
       o.projection_owner, o.projection_expires_at, o.last_error_code, o.created_at, o.updated_at
  FROM gate_resolution_outbox o
  JOIN gate_resolution r ON r.gate_key = o.gate_key
 WHERE r.ack_state = 'acked'
 ORDER BY o.gate_key`;

const SELECT_GATE_OUTBOX = `
SELECT gate_key, revision, card_state, card_pending, notification_state, projected_at,
       projection_owner, projection_expires_at, last_error_code, created_at, updated_at
  FROM gate_resolution_outbox WHERE gate_key = ?`;

const SELECT_GATE_CHANNEL_DELIVERY = `
SELECT gate_key, run_key, task_key, source_dispatch_id, revision, deferred_outbox_revision,
       resume_baseline_state, state, attempt_count,
       last_attempt_at, next_attempt_at, receipted_at, consumed_at,
       lease_owner, lease_expires_at, last_error_code, created_at, updated_at
  FROM gate_channel_delivery WHERE gate_key = ?`;

const SELECT_ALL_GATE_CHANNEL_DELIVERIES = `
SELECT gate_key, run_key, task_key, source_dispatch_id, revision, deferred_outbox_revision,
       resume_baseline_state, state, attempt_count,
       last_attempt_at, next_attempt_at, receipted_at, consumed_at,
       lease_owner, lease_expires_at, last_error_code, created_at, updated_at
  FROM gate_channel_delivery ORDER BY gate_key`;

const SELECT_DUE_GATE_CHANNEL_DELIVERIES = `
SELECT gate_key, run_key, task_key, source_dispatch_id, revision, deferred_outbox_revision,
       resume_baseline_state, state, attempt_count,
       last_attempt_at, next_attempt_at, receipted_at, consumed_at,
       lease_owner, lease_expires_at, last_error_code, created_at, updated_at
  FROM gate_channel_delivery
 WHERE state <> 'consumed' AND next_attempt_at <= ?
 ORDER BY next_attempt_at, gate_key
 LIMIT ?`;

const SELECT_GATE_CHANNEL_SEED_KEYS = `
SELECT o.gate_key
  FROM gate_resolution_outbox o
  JOIN gate_resolution r ON r.gate_key = o.gate_key
  LEFT JOIN gate_channel_delivery d ON d.gate_key = o.gate_key
 WHERE o.notification_state = 'pending'
   AND r.ack_state = 'acked'
   AND r.lifecycle = 'resolved'
   AND json_extract(r.pre_read_json, '$.status') = 'pending'
   AND d.gate_key IS NULL
 ORDER BY o.gate_key
 LIMIT ?`;

const SELECT_GATE_CHANNEL_CLOCK_FLOOR = `
SELECT MAX(updated_at) AS updated_at
  FROM (
    SELECT updated_at FROM gate_channel_delivery
    UNION ALL
    SELECT updated_at FROM gate_resume_observation
  )`;

const INSERT_GATE_CHANNEL_DELIVERY = `
INSERT INTO gate_channel_delivery
  (gate_key, run_key, task_key, source_dispatch_id, revision, deferred_outbox_revision,
   resume_baseline_state, state, attempt_count,
   last_attempt_at, next_attempt_at, receipted_at, consumed_at,
   lease_owner, lease_expires_at, last_error_code, created_at, updated_at)
VALUES (?, ?, ?, ?, 0, ?, 'required', 'pending', 0, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`;

const SELECT_GATE_RESUME_OBSERVATION = `
SELECT gate_key, revision, baseline_json, latest_json,
       evidence_kind, evidence_task_id, evidence_dispatch_id,
       evidence_from_status, evidence_to_status,
       next_observation_at, observed_at, lease_owner, lease_expires_at,
       last_error_code, created_at, updated_at
  FROM gate_resume_observation WHERE gate_key = ?`;

const SELECT_ALL_GATE_RESUME_OBSERVATIONS = `
SELECT gate_key, revision, baseline_json, latest_json,
       evidence_kind, evidence_task_id, evidence_dispatch_id,
       evidence_from_status, evidence_to_status,
       next_observation_at, observed_at, lease_owner, lease_expires_at,
       last_error_code, created_at, updated_at
  FROM gate_resume_observation ORDER BY gate_key`;

const SELECT_DUE_GATE_RESUME_OBSERVATIONS = `
SELECT r.gate_key, r.revision, r.baseline_json, r.latest_json,
       r.evidence_kind, r.evidence_task_id, r.evidence_dispatch_id,
       r.evidence_from_status, r.evidence_to_status,
       r.next_observation_at, r.observed_at, r.lease_owner, r.lease_expires_at,
       r.last_error_code, r.created_at, r.updated_at
  FROM gate_resume_observation r
  JOIN gate_channel_delivery d ON d.gate_key = r.gate_key
 WHERE r.evidence_kind IS NULL
   AND r.next_observation_at IS NOT NULL AND r.next_observation_at <= ?
   AND d.resume_baseline_state = 'recorded'
   AND d.state IN ('receipted','consumed')
 ORDER BY r.next_observation_at, r.gate_key
 LIMIT ?`;

const MARK_GATE_OUTBOX_PROJECTED = `
UPDATE gate_resolution_outbox
   SET revision = revision + 1, card_pending = 0, projected_at = ?, projection_owner = NULL,
       projection_expires_at = NULL,
       updated_at = ?
 WHERE gate_key = ? AND revision = ? AND projection_owner = ? AND projection_expires_at > ?`;

const INSERT_GATE_AUDIT_BOUNDED = `
INSERT INTO gate_resolution_audit (gate_key, event, reason, created_at)
SELECT ?, ?, ?, ?
 WHERE (SELECT COUNT(*) FROM gate_resolution_audit WHERE gate_key IS ?) <
       CASE WHEN ? IS NOT NULL AND ? <> 'claimed'
                  AND NOT EXISTS (
                    SELECT 1 FROM gate_resolution_audit
                     WHERE gate_key IS ? AND event = 'claimed'
                  )
            THEN ? - 1 ELSE ? END`;

const INSERT_GATE_ATTEMPT_BOUNDED = `
INSERT INTO gate_resolution_attempt (gate_key, phase, outcome, detail, created_at)
SELECT ?, ?, ?, ?, ?
 WHERE (SELECT COUNT(*) FROM gate_resolution_attempt WHERE gate_key = ?) < ?`;

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

const SELECT_REPOSITORY_REGISTRY = `
SELECT canonical_key, github_repository_id, name_with_owner, project_key, project_origin, active,
       consecutive_missing_passes, first_seen_at, last_seen_at, last_good_at, updated_at
  FROM repository_registry ORDER BY canonical_key`;

const SELECT_ORCA_REPOSITORY_BINDINGS = `
SELECT orca_repository_id, canonical_key, project_key, origin, active,
       consecutive_missing_passes, first_seen_at, last_seen_at, last_good_at, updated_at
  FROM orca_repository_binding ORDER BY orca_repository_id`;

const SELECT_REPOSITORY_DISCOVERY_ISSUES = `
SELECT issue_hash, category, active, occurrence_count, first_seen_at, last_seen_at,
       resolved_at, updated_at
  FROM repository_discovery_issue ORDER BY issue_hash`;

const SELECT_DAEMON_HEALTH = `
SELECT revision, instance_id, build_fingerprint, config_fingerprint, desired_state, state,
       started_at, heartbeat_at, clean_stopped_at, last_error_code, updated_at
  FROM daemon_health WHERE id = 1`;

const SELECT_DAEMON_JOB_OUTCOME = `
SELECT job_name, revision, state, attempt, consecutive_failures, started_at, completed_at,
       last_success_at, last_failure_at, duration_ms, next_run_at, error_code,
       processed_count, deferred_count, checkpoint, updated_at
  FROM daemon_job_outcome WHERE job_name = ?`;

const SELECT_ALL_DAEMON_JOB_OUTCOMES = `
SELECT job_name, revision, state, attempt, consecutive_failures, started_at, completed_at,
       last_success_at, last_failure_at, duration_ms, next_run_at, error_code,
       processed_count, deferred_count, checkpoint, updated_at
  FROM daemon_job_outcome ORDER BY job_name`;

const SELECT_SLACK_ROOT_INTENT = `
SELECT entity_kind, entity_key, revision, channel_id, render_fingerprint, state, attempt_count,
       sending_instance_id, message_ts, prepared_at, last_attempt_at, posted_at, uncertain_at,
       last_error_code, updated_at
  FROM slack_root_intent WHERE entity_kind = ? AND entity_key = ?`;

const SELECT_ALL_SLACK_ROOT_INTENTS = `
SELECT entity_kind, entity_key, revision, channel_id, render_fingerprint, state, attempt_count,
       sending_instance_id, message_ts, prepared_at, last_attempt_at, posted_at, uncertain_at,
       last_error_code, updated_at
  FROM slack_root_intent ORDER BY entity_kind, entity_key`;

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

type GateLocalObservationRow = {
  readonly gate_key: string;
  readonly run_key: string;
  readonly task_key: string;
  readonly status: string;
  readonly resolution: string | null;
  readonly resolved_at: string | null;
  readonly metadata_state: string;
  readonly mapping_state: string;
  readonly write_owner: string | null;
  readonly write_expires_at: string | null;
  readonly observed_at: string;
};

type GateObservationGenerationRow = {
  readonly gate_key: string;
  readonly revision: number;
};

type GateDirectModalRow = {
  readonly session_id: string;
  readonly revision: number;
  readonly button_event_key: string;
  readonly gate_key: string;
  readonly team_id: string;
  readonly owner_user_id: string;
  readonly api_app_id: string;
  readonly channel_id: string;
  readonly thread_ts: string;
  readonly message_ts: string;
  readonly block_id: string;
  readonly action_id: string;
  readonly action_value: string;
  readonly callback_id: string;
  readonly input_block_id: string;
  readonly input_action_id: string;
  readonly state: string;
  readonly view_id: string | null;
  readonly failure_code: string | null;
  readonly resolution_text: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly opened_at: string | null;
  readonly accepted_at: string | null;
};

type GateResolutionRow = {
  readonly gate_key: string;
  readonly revision: number;
  readonly ack_state: string;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly retry_request_id: string;
  readonly option_id: string;
  readonly option_resolution: string;
  readonly ask_message_id: string;
  readonly question_thread_id: string;
  readonly dispatch_id: string;
  readonly task_id: string;
  readonly team_id: string;
  readonly owner_user_id: string;
  readonly api_app_id: string | null;
  readonly channel_id: string;
  readonly thread_ts: string;
  readonly message_ts: string;
  readonly block_id: string;
  readonly action_id: string;
  readonly action_value: string;
  readonly lifecycle: string;
  readonly mutation_ownership: string;
  readonly pre_read_json: string | null;
  readonly resolve_result_json: string | null;
  readonly post_read_json: string | null;
  readonly last_error_code: string | null;
  readonly last_error_detail: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

type GateOutboxRow = {
  readonly gate_key: string;
  readonly revision: number;
  readonly card_state: string;
  readonly card_pending: number;
  readonly notification_state: string;
  readonly projected_at: string | null;
  readonly projection_owner: string | null;
  readonly projection_expires_at: string | null;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

type GateChannelDeliveryRow = {
  readonly gate_key: string;
  readonly run_key: string;
  readonly task_key: string;
  readonly source_dispatch_id: string;
  readonly revision: number;
  readonly deferred_outbox_revision: number;
  readonly resume_baseline_state: string;
  readonly state: string;
  readonly attempt_count: number;
  readonly last_attempt_at: string | null;
  readonly next_attempt_at: string | null;
  readonly receipted_at: string | null;
  readonly consumed_at: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

type GateResumeObservationRow = {
  readonly gate_key: string;
  readonly revision: number;
  readonly baseline_json: string;
  readonly latest_json: string | null;
  readonly evidence_kind: string | null;
  readonly evidence_task_id: string | null;
  readonly evidence_dispatch_id: string | null;
  readonly evidence_from_status: string | null;
  readonly evidence_to_status: string | null;
  readonly next_observation_at: string | null;
  readonly observed_at: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

type RepositoryRegistryRow = {
  readonly canonical_key: string;
  readonly github_repository_id: number | null;
  readonly name_with_owner: string;
  readonly project_key: string;
  readonly project_origin: string;
  readonly active: number;
  readonly consecutive_missing_passes: number;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly last_good_at: string;
  readonly updated_at: string;
};

type OrcaRepositoryBindingRow = {
  readonly orca_repository_id: string;
  readonly canonical_key: string | null;
  readonly project_key: string;
  readonly origin: string;
  readonly active: number;
  readonly consecutive_missing_passes: number;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly last_good_at: string;
  readonly updated_at: string;
};

type RepositoryDiscoveryIssueRow = {
  readonly issue_hash: string;
  readonly category: string;
  readonly active: number;
  readonly occurrence_count: number;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly resolved_at: string | null;
  readonly updated_at: string;
};

type DaemonHealthRow = {
  readonly revision: number;
  readonly instance_id: string;
  readonly build_fingerprint: string;
  readonly config_fingerprint: string;
  readonly desired_state: string;
  readonly state: string;
  readonly started_at: string;
  readonly heartbeat_at: string;
  readonly clean_stopped_at: string | null;
  readonly last_error_code: string | null;
  readonly updated_at: string;
};

type DaemonJobOutcomeRow = {
  readonly job_name: string;
  readonly revision: number;
  readonly state: string;
  readonly attempt: number;
  readonly consecutive_failures: number;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly last_success_at: string | null;
  readonly last_failure_at: string | null;
  readonly duration_ms: number | null;
  readonly next_run_at: string | null;
  readonly error_code: string | null;
  readonly processed_count: number;
  readonly deferred_count: number;
  readonly checkpoint: number;
  readonly updated_at: string;
};

type SlackRootIntentRow = {
  readonly entity_kind: string;
  readonly entity_key: string;
  readonly revision: number;
  readonly channel_id: string;
  readonly render_fingerprint: string;
  readonly state: string;
  readonly attempt_count: number;
  readonly sending_instance_id: string | null;
  readonly message_ts: string | null;
  readonly prepared_at: string;
  readonly last_attempt_at: string | null;
  readonly posted_at: string | null;
  readonly uncertain_at: string | null;
  readonly last_error_code: string | null;
  readonly updated_at: string;
};

function storedRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${at}이(가) object가 아니다`);
  }
  return value as Record<string, unknown>;
}

function storedText(value: unknown, at: string, cap = GATE_FACT_CAP): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > cap) {
    throw new TypeError(`${at}이(가) 1..${cap}자의 string이 아니다`);
  }
  return value;
}

function storedNullableText(value: unknown, at: string, cap = GATE_FACT_CAP): string | null {
  return value === null ? null : storedText(value, at, cap);
}

function storedKey(value: unknown, prefix: string, at: string): string {
  const key = storedText(value, at);
  if (!key.startsWith(prefix) || key.length === prefix.length) {
    throw new TypeError(`${at}이(가) ${prefix} durable key가 아니다`);
  }
  return key;
}

function storedIso(value: unknown, at: string): string {
  const text = storedText(value, at, 40);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== text) {
    throw new TypeError(`${at}이(가) canonical ISO 시각이 아니다`);
  }
  return text;
}

function storedRevision(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${at}이(가) non-negative safe integer가 아니다`);
  }
  return value;
}

function storedAckState(value: unknown, at: string): 'pending' | 'acked' | 'failed' {
  if (value !== 'pending' && value !== 'acked' && value !== 'failed') {
    throw new TypeError(`${at}이(가) 지원하는 ACK state가 아니다`);
  }
  return value;
}

function storedLeaseOwner(value: unknown, at: string): string {
  const owner = storedText(value, at, 80);
  if (!/^(?:p[1-9]\d{0,9}|t)\.[a-z0-9-]{1,64}$/.test(owner)) {
    throw new TypeError(`${at}이(가) code-owned lease owner가 아니다`);
  }
  return owner;
}

/** Process liveness permits early recovery; persisted expiry is always authoritative. */
const LIVE_OBSERVATION_WRITE_OWNERS = new Set<string>();
/** Longer than the bounded production Slack update; expiry wins even if an owner PID is reused. */
const OBSERVATION_WRITE_LEASE_MS = 30_000;

function observationWriteExpiry(at: string): string {
  return new Date(new Date(at).valueOf() + OBSERVATION_WRITE_LEASE_MS).toISOString();
}

function observationOwnerAlive(owner: string): boolean {
  const match = /^p([1-9]\d{0,9})\./.exec(owner);
  if (match === null) return true;
  const pid = Number(match[1]);
  if (pid === process.pid) return LIVE_OBSERVATION_WRITE_OWNERS.has(owner);
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && 'code' in e && e.code !== 'ESRCH';
  }
}

function storedJson(value: string, at: string): unknown {
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new TypeError(`${at}이(가) JSON이 아니다`, { cause: e });
  }
}

function exactStoredKeys(value: Record<string, unknown>, keys: readonly string[], at: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new TypeError(`${at}의 필드가 strict shape와 어긋난다`);
  }
}

function toGateSnapshot(value: unknown, at: string): GateSnapshot {
  const row = storedRecord(value, at);
  exactStoredKeys(
    row,
    ['gateId', 'runId', 'taskId', 'options', 'status', 'resolution', 'resolvedAt'],
    at,
  );
  const status = row['status'];
  if (status !== 'pending' && status !== 'resolved') {
    throw new TypeError(`${at}.status가 pending/resolved가 아니다`);
  }
  if (!Array.isArray(row['options']) || row['options'].length === 0 || row['options'].length > 25) {
    throw new TypeError(`${at}.options가 1..25개 string 배열이 아니다`);
  }
  const options = row['options'].map((option, index) => storedText(option, `${at}.options[${index}]`, 75));
  const resolution = storedNullableText(row['resolution'], `${at}.resolution`, 3000);
  const resolvedAt = row['resolvedAt'] === null ? null : storedIso(row['resolvedAt'], `${at}.resolvedAt`);
  if (status === 'pending' && (resolution !== null || resolvedAt !== null)) {
    throw new TypeError(`${at}의 pending 상태와 resolution/resolvedAt이 모순된다`);
  }
  if (status === 'resolved' && (resolution === null || resolvedAt === null)) {
    throw new TypeError(`${at}의 resolved 상태에 resolution/resolvedAt이 없다`);
  }
  return {
    gateId: storedText(row['gateId'], `${at}.gateId`),
    runId: storedText(row['runId'], `${at}.runId`),
    taskId: storedText(row['taskId'], `${at}.taskId`),
    options,
    status,
    resolution,
    resolvedAt,
  };
}

function toGateResolveResult(value: unknown, at: string): GateResolveResult {
  const row = storedRecord(value, at);
  exactStoredKeys(row, ['gate', 'mutation'], at);
  const mutation = storedRecord(row['mutation'], `${at}.mutation`);
  exactStoredKeys(mutation, ['requestId', 'replayed'], `${at}.mutation`);
  if (typeof mutation['replayed'] !== 'boolean') {
    throw new TypeError(`${at}.mutation.replayed가 boolean이 아니다`);
  }
  return {
    gate: toGateSnapshot(row['gate'], `${at}.gate`),
    mutation: {
      requestId: storedText(mutation['requestId'], `${at}.mutation.requestId`, 80),
      replayed: mutation['replayed'],
    },
  };
}

function parseStoredOptional<T>(
  value: string | null,
  at: string,
  parse: (raw: unknown, at: string) => T,
): T | null {
  return value === null ? null : parse(storedJson(value, at), at);
}

function toGateLocalObservation(row: GateLocalObservationRow): GateLocalObservation {
  if (row.status !== 'pending' && row.status !== 'resolved' && row.status !== 'unsupported') {
    throw new TypeError(`${row.gate_key}의 local observation status가 잘못됐다`);
  }
  if (row.metadata_state !== 'matched' && row.metadata_state !== 'missing' && row.metadata_state !== 'mismatched') {
    throw new TypeError(`${row.gate_key}의 local observation metadata_state가 잘못됐다`);
  }
  if (
    row.mapping_state !== 'matched' &&
    row.mapping_state !== 'missing' &&
    row.mapping_state !== 'mismatched' &&
    row.mapping_state !== 'write_pending'
  ) {
    throw new TypeError(`${row.gate_key}의 local observation mapping_state가 잘못됐다`);
  }
  if (
    (row.mapping_state === 'write_pending') !== (row.write_owner !== null) ||
    (row.write_owner === null) !== (row.write_expires_at === null)
  ) {
    throw new TypeError(`${row.gate_key}의 local observation write owner shape가 잘못됐다`);
  }
  if (row.write_owner !== null) {
    storedLeaseOwner(row.write_owner, `${row.gate_key}.write_owner`);
    storedIso(row.write_expires_at, `${row.gate_key}.write_expires_at`);
    // observed_at is the latest source snapshot, not the lease start. A concurrent observation may
    // legitimately be at/after the old expiry while the durable owner remains as a repair barrier.
  }
  if (row.status === 'pending' && (row.resolution !== null || row.resolved_at !== null)) {
    throw new TypeError(`${row.gate_key}의 pending local observation이 모순된다`);
  }
  if (row.status === 'resolved' && (row.resolution === null || row.resolved_at === null)) {
    throw new TypeError(`${row.gate_key}의 resolved local observation에 resolution/resolved_at이 없다`);
  }
  if (row.status === 'unsupported' && (row.resolution !== null || row.resolved_at !== null)) {
    throw new TypeError(`${row.gate_key}의 unsupported local observation이 모순된다`);
  }
  return {
    gateKey: storedKey(row.gate_key, 'gate:', 'gate_local_observation.gate_key') as GateKey,
    runKey: storedKey(row.run_key, 'run:', 'gate_local_observation.run_key') as RunKey,
    taskKey: storedKey(row.task_key, 'task:', 'gate_local_observation.task_key') as TaskKey,
    status: row.status,
    resolution: storedNullableText(row.resolution, `${row.gate_key}.resolution`, 3000),
    resolvedAt: row.resolved_at === null ? null : storedIso(row.resolved_at, `${row.gate_key}.resolved_at`),
    metadataState: row.metadata_state,
    mappingState: row.mapping_state,
    observedAt: storedIso(row.observed_at, `${row.gate_key}.observed_at`),
  };
}

function reconcileObservationMetadataState(
  observation: Pick<GateLocalObservation, 'runKey' | 'taskKey' | 'metadataState'>,
  metadata: GateMetadataRow | undefined,
): GateLocalObservation['metadataState'] {
  if (metadata === undefined) return 'missing';
  // A stale `missing` or explicit `mismatched` collection result did not validate the sidecar's
  // full immutable option facts. Seeing a row now is not enough evidence to upgrade it. The next
  // production collection must observe and compare those facts before actions become eligible.
  if (observation.metadataState !== 'matched') return 'mismatched';
  return metadata.run_key === observation.runKey && metadata.task_key === observation.taskKey
    ? 'matched'
    : 'mismatched';
}

/** The durable row must still describe the snapshot whose bounded Slack call is completing. */
function observationWriteStillCurrent(
  row: GateLocalObservationRow,
  observation: GateLocalObservation,
  metadataState: GateLocalObservation['metadataState'],
  allowFailClosedMapping = false,
): boolean {
  return (
    (row.mapping_state === 'write_pending' ||
      row.mapping_state === 'matched' ||
      (allowFailClosedMapping &&
        (row.mapping_state === 'missing' || row.mapping_state === 'mismatched'))) &&
    row.run_key === observation.runKey &&
    row.task_key === observation.taskKey &&
    row.status === observation.status &&
    row.resolution === observation.resolution &&
    row.resolved_at === observation.resolvedAt &&
    row.metadata_state === metadataState &&
    row.observed_at === observation.observedAt
  );
}

/** Advance the additive v9 logical generation inside the caller's write transaction. */
function advanceGateObservationGeneration(
  db: DatabaseSync,
  gateKey: GateKey,
  afterRevision = -1,
): number {
  const row = db.prepare(SELECT_GATE_OBSERVATION_GENERATION).get(gateKey) as
    | GateObservationGenerationRow
    | undefined;
  const currentRevision = row === undefined
    ? -1
    : storedRevision(row.revision, `${gateKey}.current observation revision`);
  const revision = storedRevision(
    Math.max(currentRevision, afterRevision) + 1,
    `${gateKey}.next observation revision`,
  );
  db.prepare(UPSERT_GATE_OBSERVATION_GENERATION).run(gateKey, revision);
  return revision;
}

function toGateDirectModal(row: GateDirectModalRow): GateDirectModalSession {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      row.session_id,
    ) ||
    !/^[0-9a-f]{64}$/.test(row.button_event_key) ||
    !/^T[A-Z0-9]+$/.test(row.team_id) ||
    !/^U[A-Z0-9]+$/.test(row.owner_user_id) ||
    !/^A[A-Z0-9]+$/.test(row.api_app_id) ||
    !/^[CG][A-Z0-9]+$/.test(row.channel_id) ||
    !/^\d+\.\d+$/.test(row.thread_ts) ||
    !/^\d+\.\d+$/.test(row.message_ts) ||
    (row.view_id !== null && !/^V[A-Z0-9]+$/.test(row.view_id))
  ) {
    throw new TypeError(`${row.gate_key}의 direct modal identity shape가 잘못됐다`);
  }
  if (!['prepared', 'opening', 'opened', 'failed', 'accepted'].includes(row.state)) {
    throw new TypeError(`${row.gate_key}의 direct modal state가 잘못됐다`);
  }
  const gateKey = storedKey(row.gate_key, 'gate:', 'gate_direct_modal.gate_key') as GateKey;
  const state = row.state as GateDirectModalSession['state'];
  const viewId = storedNullableText(row.view_id, `${row.session_id}.view_id`, 64);
  const failureCode = storedNullableText(row.failure_code, `${row.session_id}.failure_code`, 80);
  const resolutionText = storedNullableText(
    row.resolution_text,
    `${row.session_id}.resolution_text`,
    3000,
  );
  const openedAt = row.opened_at === null
    ? null
    : storedIso(row.opened_at, `${row.session_id}.opened_at`);
  const acceptedAt = row.accepted_at === null
    ? null
    : storedIso(row.accepted_at, `${row.session_id}.accepted_at`);
  const validRevision =
    (state === 'prepared' && row.revision === 0) ||
    (state === 'opening' && row.revision === 1) ||
    ((state === 'opened' || state === 'failed') && row.revision === 2) ||
    (state === 'accepted' && row.revision === 3);
  const validState =
    ((state === 'prepared' || state === 'opening') &&
      viewId === null && failureCode === null && resolutionText === null &&
      openedAt === null && acceptedAt === null) ||
    (state === 'opened' && viewId !== null && failureCode === null && resolutionText === null &&
      openedAt !== null && acceptedAt === null) ||
    (state === 'failed' && viewId === null && failureCode !== null && resolutionText === null &&
      openedAt === null && acceptedAt === null) ||
    (state === 'accepted' && viewId !== null && failureCode === null && resolutionText !== null &&
      resolutionText.trim() !== '' &&
      !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(resolutionText) &&
      openedAt !== null && acceptedAt !== null);
  if (!validRevision || !validState) {
    throw new TypeError(`${gateKey}의 direct modal lifecycle evidence가 불완전하다`);
  }
  return {
    sessionId: storedText(row.session_id, `${gateKey}.session_id`, 36),
    revision: storedRevision(row.revision, `${row.session_id}.revision`),
    buttonEventKey: storedText(row.button_event_key, `${row.session_id}.button_event_key`, 64),
    gateKey,
    teamId: storedText(row.team_id, `${row.session_id}.team_id`, 32),
    ownerUserId: storedText(row.owner_user_id, `${row.session_id}.owner_user_id`, 32),
    apiAppId: storedText(row.api_app_id, `${row.session_id}.api_app_id`, 32),
    channelId: storedText(row.channel_id, `${row.session_id}.channel_id`, 32),
    threadTs: storedText(row.thread_ts, `${row.session_id}.thread_ts`, 32),
    messageTs: storedText(row.message_ts, `${row.session_id}.message_ts`, 32),
    blockId: storedText(row.block_id, `${row.session_id}.block_id`, 255),
    actionId: storedText(row.action_id, `${row.session_id}.action_id`, 255),
    actionValue: storedText(row.action_value, `${row.session_id}.action_value`, 255),
    callbackId: storedText(row.callback_id, `${row.session_id}.callback_id`, 255),
    inputBlockId: storedText(row.input_block_id, `${row.session_id}.input_block_id`, 255),
    inputActionId: storedText(row.input_action_id, `${row.session_id}.input_action_id`, 255),
    state,
    viewId,
    failureCode,
    resolutionText,
    createdAt: storedIso(row.created_at, `${row.session_id}.created_at`),
    updatedAt: storedIso(row.updated_at, `${row.session_id}.updated_at`),
    openedAt,
    acceptedAt,
  };
}

const RESOLUTION_LIFECYCLES = new Set<GateResolutionLifecycle>([
  'claimed', 'pre_read', 'resolving', 'uncertain', 'post_read', 'resolved', 'conflict', 'degraded',
]);

function validateGateLifecycleEvidence(intent: GateResolutionIntent, at: string): void {
  const nonterminal = ['claimed', 'pre_read', 'resolving', 'uncertain', 'post_read'].includes(
    intent.lifecycle,
  );
  const quietLifecycle = ['claimed', 'pre_read', 'resolving', 'post_read', 'resolved'].includes(
    intent.lifecycle,
  );
  if (
    (intent.ackState !== 'acked' && intent.lifecycle !== 'claimed') ||
    ((intent.resolveResult !== null) !== (intent.mutationOwnership === 'structured')) ||
    (intent.lifecycle === 'claimed' && intent.mutationOwnership !== 'not_started') ||
    (intent.lifecycle === 'resolving' && intent.mutationOwnership !== 'unknown') ||
    (nonterminal && intent.postRead !== null) ||
    (quietLifecycle && (intent.lastErrorCode !== null || intent.lastErrorDetail !== null)) ||
    (intent.lastErrorDetail !== null && intent.lastErrorCode === null) ||
    (intent.leaseOwner !== null &&
      (intent.ackState !== 'acked' ||
        intent.leaseExpiresAt === null ||
        intent.leaseExpiresAt <= intent.createdAt ||
        ['resolved', 'conflict', 'degraded'].includes(intent.lifecycle))) ||
    (intent.lifecycle === 'claimed' &&
      (intent.preRead !== null || intent.resolveResult !== null || intent.postRead !== null)) ||
    (['pre_read', 'resolving', 'post_read', 'resolved', 'conflict'].includes(intent.lifecycle) &&
      intent.preRead === null) ||
    (intent.lifecycle === 'post_read' && intent.resolveResult === null) ||
    (intent.lifecycle === 'conflict' && intent.postRead === null) ||
    (intent.lifecycle === 'uncertain' && intent.lastErrorCode === null) ||
    (intent.lifecycle === 'resolved' && intent.lastErrorCode !== null) ||
    (['conflict', 'degraded'].includes(intent.lifecycle) && intent.lastErrorCode === null) ||
    (intent.lifecycle === 'resolved' &&
      (intent.resolveResult === null ||
        intent.mutationOwnership !== 'structured' ||
        intent.postRead?.status !== 'resolved' ||
        intent.postRead.resolution !== intent.optionResolution ||
        intent.postRead.resolvedAt !== intent.resolveResult.gate.resolvedAt))
  ) {
    throw new TypeError(`${at}의 lifecycle evidence가 불완전하다`);
  }
}

function toGateResolution(row: GateResolutionRow): GateResolutionIntent {
  if (!RESOLUTION_LIFECYCLES.has(row.lifecycle as GateResolutionLifecycle)) {
    throw new TypeError(`${row.gate_key}의 resolution lifecycle이 잘못됐다`);
  }
  if (
    row.mutation_ownership !== 'not_started' &&
    row.mutation_ownership !== 'unknown' &&
    row.mutation_ownership !== 'structured'
  ) {
    throw new TypeError(`${row.gate_key}의 mutation ownership provenance가 잘못됐다`);
  }
  if (
    !row.gate_key.startsWith('gate:') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.retry_request_id) ||
    !/^T[A-Z0-9]+$/.test(row.team_id) ||
    !/^U[A-Z0-9]+$/.test(row.owner_user_id) ||
    (row.api_app_id !== null && !/^A[A-Z0-9]+$/.test(row.api_app_id)) ||
    !/^[CG][A-Z0-9]+$/.test(row.channel_id) ||
    !/^\d+\.\d+$/.test(row.thread_ts) ||
    !/^\d+\.\d+$/.test(row.message_ts)
  ) {
    throw new TypeError(`${row.gate_key}의 resolution identity shape가 잘못됐다`);
  }
  if ((row.lease_owner === null) !== (row.lease_expires_at === null)) {
    throw new TypeError(`${row.gate_key}의 resolution lease shape가 잘못됐다`);
  }
  const intent: GateResolutionIntent = {
    gateKey: storedKey(row.gate_key, 'gate:', 'gate_resolution.gate_key') as GateKey,
    revision: storedRevision(row.revision, `${row.gate_key}.revision`),
    ackState: storedAckState(row.ack_state, `${row.gate_key}.ack_state`),
    leaseOwner:
      row.lease_owner === null
        ? null
        : storedLeaseOwner(row.lease_owner, `${row.gate_key}.lease_owner`),
    leaseExpiresAt:
      row.lease_expires_at === null
        ? null
        : storedIso(row.lease_expires_at, `${row.gate_key}.lease_expires_at`),
    retryRequestId: storedText(row.retry_request_id, `${row.gate_key}.retry_request_id`, 80),
    optionId: storedText(row.option_id, `${row.gate_key}.option_id`, 64),
    optionResolution: storedText(row.option_resolution, `${row.gate_key}.option_resolution`, 3000),
    askMessageId: storedText(row.ask_message_id, `${row.gate_key}.ask_message_id`),
    questionThreadId: storedText(row.question_thread_id, `${row.gate_key}.question_thread_id`),
    dispatchId: storedText(row.dispatch_id, `${row.gate_key}.dispatch_id`),
    taskId: storedText(row.task_id, `${row.gate_key}.task_id`),
    teamId: storedText(row.team_id, `${row.gate_key}.team_id`, 32),
    ownerUserId: storedText(row.owner_user_id, `${row.gate_key}.owner_user_id`, 32),
    apiAppId: storedNullableText(row.api_app_id, `${row.gate_key}.api_app_id`, 32),
    channelId: storedText(row.channel_id, `${row.gate_key}.channel_id`, 32),
    threadTs: storedText(row.thread_ts, `${row.gate_key}.thread_ts`, 32),
    messageTs: storedText(row.message_ts, `${row.gate_key}.message_ts`, 32),
    blockId: storedText(row.block_id, `${row.gate_key}.block_id`, 255),
    actionId: storedText(row.action_id, `${row.gate_key}.action_id`, 255),
    actionValue: storedText(row.action_value, `${row.gate_key}.action_value`, 64),
    lifecycle: row.lifecycle as GateResolutionLifecycle,
    mutationOwnership: row.mutation_ownership,
    preRead: parseStoredOptional(row.pre_read_json, `${row.gate_key}.pre_read_json`, toGateSnapshot),
    resolveResult: parseStoredOptional(row.resolve_result_json, `${row.gate_key}.resolve_result_json`, toGateResolveResult),
    postRead: parseStoredOptional(row.post_read_json, `${row.gate_key}.post_read_json`, toGateSnapshot),
    lastErrorCode: storedNullableText(row.last_error_code, `${row.gate_key}.last_error_code`, 80),
    lastErrorDetail: storedNullableText(row.last_error_detail, `${row.gate_key}.last_error_detail`, GATE_FACT_CAP),
    createdAt: storedIso(row.created_at, `${row.gate_key}.created_at`),
    updatedAt: storedIso(row.updated_at, `${row.gate_key}.updated_at`),
  };
  validateGateLifecycleEvidence(intent, row.gate_key);
  return intent;
}

function toGateOutbox(row: GateOutboxRow): GateResolutionOutbox {
  const states = new Set<GateCardState>(['resolving', 'resolved', 'conflict', 'degraded']);
  if (!states.has(row.card_state as GateCardState) || (row.card_pending !== 0 && row.card_pending !== 1)) {
    throw new TypeError(`${row.gate_key}의 Gate outbox shape가 잘못됐다`);
  }
  if (row.notification_state !== 'pending') {
    throw new TypeError(`${row.gate_key}의 D2 notification state가 pending이 아니다`);
  }
  if ((row.projection_owner === null) !== (row.projection_expires_at === null)) {
    throw new TypeError(`${row.gate_key}의 projection owner expiry shape가 잘못됐다`);
  }
  if (row.projection_owner !== null) {
    storedLeaseOwner(row.projection_owner, `${row.gate_key}.projection_owner`);
    storedIso(
      row.projection_expires_at,
      `${row.gate_key}.projection_expires_at`,
    );
    if (row.card_pending !== 1) {
      throw new TypeError(`${row.gate_key}의 projected outbox에 projection owner가 남아 있다`);
    }
  }
  return {
    gateKey: storedKey(row.gate_key, 'gate:', 'gate_resolution_outbox.gate_key') as GateKey,
    revision: storedRevision(row.revision, `${row.gate_key}.outbox revision`),
    cardState: row.card_state as GateCardState,
    cardPending: row.card_pending === 1,
    notificationState: 'pending',
    projectedAt: row.projected_at === null ? null : storedIso(row.projected_at, `${row.gate_key}.projected_at`),
    lastErrorCode: storedNullableText(row.last_error_code, `${row.gate_key}.last_error_code`, 80),
    createdAt: storedIso(row.created_at, `${row.gate_key}.created_at`),
    updatedAt: storedIso(row.updated_at, `${row.gate_key}.updated_at`),
  };
}

const GATE_CHANNEL_DELIVERY_STATES = new Set<GateChannelDeliveryState>([
  'pending', 'attempted', 'receipted', 'consumed',
]);

const GATE_RESUME_BASELINE_STATES = new Set<GateResumeBaselineState>([
  'unavailable', 'required', 'recorded',
]);

function toGateChannelDelivery(row: GateChannelDeliveryRow): GateChannelDelivery {
  if (!GATE_CHANNEL_DELIVERY_STATES.has(row.state as GateChannelDeliveryState)) {
    throw new TypeError(`${row.gate_key}의 Channel delivery state가 잘못됐다`);
  }
  if (!GATE_RESUME_BASELINE_STATES.has(row.resume_baseline_state as GateResumeBaselineState)) {
    throw new TypeError(`${row.gate_key}의 resume baseline state가 잘못됐다`);
  }
  if (
    !Number.isSafeInteger(row.attempt_count) ||
    row.attempt_count < 0 ||
    row.attempt_count > 1_000_000
  ) {
    throw new TypeError(`${row.gate_key}의 Channel delivery attempt_count가 잘못됐다`);
  }
  if ((row.lease_owner === null) !== (row.lease_expires_at === null)) {
    throw new TypeError(`${row.gate_key}의 Channel delivery lease shape가 잘못됐다`);
  }
  const state = row.state as GateChannelDeliveryState;
  const createdAt = storedIso(row.created_at, `${row.gate_key}.delivery created_at`);
  const updatedAt = storedIso(row.updated_at, `${row.gate_key}.delivery updated_at`);
  const lastAttemptAt = row.last_attempt_at === null
    ? null
    : storedIso(row.last_attempt_at, `${row.gate_key}.delivery last_attempt_at`);
  const nextAttemptAt = row.next_attempt_at === null
    ? null
    : storedIso(row.next_attempt_at, `${row.gate_key}.delivery next_attempt_at`);
  const receiptedAt = row.receipted_at === null
    ? null
    : storedIso(row.receipted_at, `${row.gate_key}.delivery receipted_at`);
  const consumedAt = row.consumed_at === null
    ? null
    : storedIso(row.consumed_at, `${row.gate_key}.delivery consumed_at`);
  const leaseOwner = row.lease_owner === null
    ? null
    : storedLeaseOwner(row.lease_owner, `${row.gate_key}.delivery lease_owner`);
  const leaseExpiresAt = row.lease_expires_at === null
    ? null
    : storedIso(row.lease_expires_at, `${row.gate_key}.delivery lease_expires_at`);
  const lastErrorCode = row.last_error_code === null
    ? null
    : gateCode(row.last_error_code, 80);
  const validLifecycle =
    (state === 'pending' && row.attempt_count === 0 && lastAttemptAt === null &&
      nextAttemptAt !== null && receiptedAt === null && consumedAt === null) ||
    (state === 'attempted' && row.attempt_count >= 1 && lastAttemptAt !== null &&
      nextAttemptAt !== null && receiptedAt === null && consumedAt === null) ||
    (state === 'receipted' && row.attempt_count >= 1 && lastAttemptAt !== null &&
      nextAttemptAt !== null && receiptedAt !== null && consumedAt === null) ||
    (state === 'consumed' && row.attempt_count >= 1 && lastAttemptAt !== null &&
      nextAttemptAt === null && receiptedAt !== null && consumedAt !== null &&
      leaseOwner === null && leaseExpiresAt === null && lastErrorCode === null);
  if (
    !validLifecycle ||
    updatedAt < createdAt ||
    (lastAttemptAt !== null && updatedAt < lastAttemptAt) ||
    (receiptedAt !== null && updatedAt < receiptedAt) ||
    (consumedAt !== null && updatedAt < consumedAt) ||
    (leaseExpiresAt !== null && leaseExpiresAt <= updatedAt) ||
    (lastAttemptAt !== null && lastAttemptAt < createdAt) ||
    (receiptedAt !== null && (lastAttemptAt === null || receiptedAt < lastAttemptAt)) ||
    (consumedAt !== null && (receiptedAt === null || consumedAt < receiptedAt))
  ) {
    throw new TypeError(`${row.gate_key}의 Channel delivery lifecycle evidence가 불완전하다`);
  }
  return {
    gateKey: storedKey(row.gate_key, 'gate:', 'gate_channel_delivery.gate_key') as GateKey,
    runKey: storedKey(row.run_key, 'run:', `${row.gate_key}.delivery run_key`) as RunKey,
    taskKey: storedKey(row.task_key, 'task:', `${row.gate_key}.delivery task_key`) as TaskKey,
    sourceDispatchId: storedText(
      row.source_dispatch_id,
      `${row.gate_key}.delivery source_dispatch_id`,
      500,
    ),
    revision: storedRevision(row.revision, `${row.gate_key}.delivery revision`),
    deferredOutboxRevision: storedRevision(
      row.deferred_outbox_revision,
      `${row.gate_key}.delivery deferred outbox revision`,
    ),
    resumeBaselineState: row.resume_baseline_state as GateResumeBaselineState,
    state,
    attemptCount: row.attempt_count,
    lastAttemptAt,
    nextAttemptAt,
    receiptedAt,
    consumedAt,
    leaseOwner,
    leaseExpiresAt,
    lastErrorCode,
    createdAt,
    updatedAt,
  };
}

function toGateResumeObservation(row: GateResumeObservationRow): GateResumeObservation {
  const baseline = parseGateResumeSnapshotJson(
    storedText(row.baseline_json, `${row.gate_key}.resume baseline_json`, 200_000),
    `${row.gate_key}.resume baseline_json`,
  );
  const latest = row.latest_json === null
    ? null
    : parseGateResumeSnapshotJson(
        storedText(row.latest_json, `${row.gate_key}.resume latest_json`, 200_000),
        `${row.gate_key}.resume latest_json`,
      );
  const evidenceEmpty = row.evidence_kind === null && row.evidence_task_id === null &&
    row.evidence_dispatch_id === null && row.evidence_from_status === null &&
    row.evidence_to_status === null;
  let evidence: GateResumeEvidence | null = null;
  if (!evidenceEmpty) {
    if (
      (row.evidence_kind !== 'new_dispatch' && row.evidence_kind !== 'status_transition') ||
      row.evidence_task_id === null || row.evidence_dispatch_id === null ||
      (row.evidence_to_status !== 'dispatched' && row.evidence_to_status !== 'completed') ||
      latest === null
    ) {
      throw new TypeError(`${row.gate_key}의 resume evidence shape가 잘못됐다`);
    }
    evidence = {
      kind: row.evidence_kind,
      taskId: storedText(row.evidence_task_id, `${row.gate_key}.resume evidence_task_id`),
      dispatchId: storedText(
        row.evidence_dispatch_id,
        `${row.gate_key}.resume evidence_dispatch_id`,
      ),
      fromStatus: row.evidence_from_status === null
        ? null
        : storedText(row.evidence_from_status, `${row.gate_key}.resume evidence_from_status`, 80),
      toStatus: row.evidence_to_status,
    };
    const task = latest.candidates.find((candidate) => candidate.taskId === evidence?.taskId);
    const taskIsRunning = task?.status === 'dispatched' || task?.status === 'completed';
    const exactCurrent = task?.currentDispatchId === evidence.dispatchId;
    const completedWithoutCurrent = task?.status === 'completed' && task.currentDispatchId === null;
    if (
      task === undefined || !taskIsRunning || (!exactCurrent && !completedWithoutCurrent) ||
      (evidence.kind === 'status_transition' && task.status !== evidence.toStatus) ||
      !task.dispatches.some(
        (dispatch) => dispatch.dispatchId === evidence?.dispatchId && dispatch.status === evidence?.toStatus,
      )
    ) {
      throw new TypeError(`${row.gate_key}의 resume evidence가 latest snapshot과 어긋난다`);
    }
    const detected = detectGateResumeEvidence(baseline, latest);
    if (detected === null || JSON.stringify(detected) !== JSON.stringify(evidence)) {
      throw new TypeError(`${row.gate_key}의 resume evidence가 baseline transition과 어긋난다`);
    }
  }
  if ((row.lease_owner === null) !== (row.lease_expires_at === null)) {
    throw new TypeError(`${row.gate_key}의 resume lease shape가 잘못됐다`);
  }
  const createdAt = storedIso(row.created_at, `${row.gate_key}.resume created_at`);
  const updatedAt = storedIso(row.updated_at, `${row.gate_key}.resume updated_at`);
  const observedAt = row.observed_at === null
    ? null
    : storedIso(row.observed_at, `${row.gate_key}.resume observed_at`);
  const nextObservationAt = row.next_observation_at === null
    ? null
    : storedIso(row.next_observation_at, `${row.gate_key}.resume next_observation_at`);
  const leaseOwner = row.lease_owner === null
    ? null
    : storedLeaseOwner(row.lease_owner, `${row.gate_key}.resume lease_owner`);
  const leaseExpiresAt = row.lease_expires_at === null
    ? null
    : storedIso(row.lease_expires_at, `${row.gate_key}.resume lease_expires_at`);
  if (
    updatedAt < createdAt ||
    (observedAt !== null && updatedAt < observedAt) ||
    (leaseExpiresAt !== null && leaseExpiresAt <= updatedAt) ||
    (evidence !== null && nextObservationAt !== null)
  ) {
    throw new TypeError(`${row.gate_key}의 resume lifecycle evidence가 불완전하다`);
  }
  return {
    gateKey: storedKey(row.gate_key, 'gate:', 'gate_resume_observation.gate_key') as GateKey,
    revision: storedRevision(row.revision, `${row.gate_key}.resume revision`),
    baseline,
    latest,
    evidence,
    nextObservationAt,
    observedAt,
    leaseOwner,
    leaseExpiresAt,
    lastErrorCode: row.last_error_code === null
      ? null
      : gateCode(row.last_error_code, 80),
    createdAt,
    updatedAt,
  };
}

const OPERATIONAL_ISSUE_CATEGORIES = new Set<RepositoryDiscoveryIssueCategory>([
  'no_remote', 'unsupported_remote', 'invalid_remote', 'canonical_conflict',
  'duplicate_orca_id', 'manual_remote_conflict', 'capacity_conflict', 'schema_drift',
  'project_conflict', 'query_failed', 'github_identity_unverified', 'capacity_deferred',
]);

const OPERATIONAL_JOB_NAMES = new Set<DaemonJobName>([
  'repository-discovery', 'run-observer', 'pr-digest', 'gate-reconcile', 'channel-delivery',
]);

const OPERATIONAL_FAILURE_CODE_SET = new Set<OperationalFailureCode>(OPERATIONAL_FAILURE_CODES);

const DISCOVERY_MISSING_PASS_LIMIT = 1_000_000;
const DISCOVERY_REMOVAL_GRACE_MS = 24 * 60 * 60 * 1_000;

function operationalText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  return value;
}

function operationalInputText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    operationalFail('OPERATIONAL_INPUT_INVALID');
  }
  return value;
}

function operationalIso(value: unknown, input = false): string {
  const fail = (): never => operationalFail(input ? 'OPERATIONAL_INPUT_INVALID' : 'OPERATIONAL_STORE_CORRUPT');
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail();
  const text = value as string;
  const time = new Date(text).valueOf();
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail();
  return text;
}

function operationalInteger(value: unknown, input = false, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    operationalFail(input ? 'OPERATIONAL_INPUT_INVALID' : 'OPERATIONAL_STORE_CORRUPT');
  }
  return value as number;
}

function operationalBoolean(value: unknown): boolean {
  if (value !== 0 && value !== 1) operationalFail('OPERATIONAL_STORE_CORRUPT');
  return value === 1;
}

function operationalCode(value: unknown, input = false): OperationalFailureCode {
  const code = input ? operationalInputText(value, 80) : operationalText(value, 80);
  if (!OPERATIONAL_FAILURE_CODE_SET.has(code as OperationalFailureCode)) {
    operationalFail(input ? 'OPERATIONAL_INPUT_INVALID' : 'OPERATIONAL_STORE_CORRUPT');
  }
  return code as OperationalFailureCode;
}

function canonicalRepository(value: unknown, input = false): {
  readonly canonicalKey: `github.com/${string}/${string}`;
  readonly nameWithOwner: `${string}/${string}`;
} {
  const text = input ? operationalInputText(value, 250) : operationalText(value, 250);
  if (!text.startsWith('github.com/')) {
    operationalFail(input ? 'OPERATIONAL_INPUT_INVALID' : 'OPERATIONAL_STORE_CORRUPT');
  }
  try {
    const identity = normalizeGithubNameWithOwner(text.slice('github.com/'.length));
    if (identity.canonicalKey !== text) {
      operationalFail(input ? 'OPERATIONAL_INPUT_INVALID' : 'OPERATIONAL_STORE_CORRUPT');
    }
    return identity;
  } catch {
    operationalFail(input ? 'OPERATIONAL_INPUT_INVALID' : 'OPERATIONAL_STORE_CORRUPT');
  }
}

function validateProjectKey(value: unknown, input = false): string {
  return input ? operationalInputText(value, 200) : operationalText(value, 200);
}

function validateFingerprint(value: unknown, input = false): string {
  const result = input ? operationalInputText(value, 128) : operationalText(value, 128);
  if (!/^[A-Za-z0-9_.:-]+$/.test(result)) {
    operationalFail(input ? 'OPERATIONAL_INPUT_INVALID' : 'OPERATIONAL_STORE_CORRUPT');
  }
  return result;
}

function toRepositoryRegistry(row: RepositoryRegistryRow): RepositoryRegistryRecord {
  const identity = canonicalRepository(row.canonical_key);
  if (row.name_with_owner !== identity.nameWithOwner) operationalFail('OPERATIONAL_STORE_CORRUPT');
  const githubRepositoryId = row.github_repository_id === null
    ? null
    : operationalInteger(row.github_repository_id, false, 1);
  if (row.project_origin !== 'explicit' && row.project_origin !== 'auto') {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  const firstSeenAt = operationalIso(row.first_seen_at);
  const lastSeenAt = operationalIso(row.last_seen_at);
  const lastGoodAt = operationalIso(row.last_good_at);
  const updatedAt = operationalIso(row.updated_at);
  const consecutiveMissingPasses = operationalInteger(row.consecutive_missing_passes);
  const active = operationalBoolean(row.active);
  if (lastSeenAt < firstSeenAt || lastGoodAt < firstSeenAt ||
      updatedAt < lastSeenAt || updatedAt < lastGoodAt ||
      (row.project_origin === 'auto' && githubRepositoryId === null) ||
      (!active && (consecutiveMissingPasses < 2 ||
        new Date(updatedAt).valueOf() - new Date(lastSeenAt).valueOf() < DISCOVERY_REMOVAL_GRACE_MS))) {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  return {
    ...identity,
    githubRepositoryId,
    projectKey: validateProjectKey(row.project_key),
    projectOrigin: row.project_origin,
    active,
    consecutiveMissingPasses,
    firstSeenAt,
    lastSeenAt,
    lastGoodAt,
    updatedAt,
  };
}

function toOrcaRepositoryBinding(row: OrcaRepositoryBindingRow): OrcaRepositoryBindingRecord {
  if (row.origin !== 'manual' && row.origin !== 'discovered') operationalFail('OPERATIONAL_STORE_CORRUPT');
  const canonicalKey = row.canonical_key === null ? null : canonicalRepository(row.canonical_key).canonicalKey;
  if (canonicalKey === null && row.origin !== 'manual') operationalFail('OPERATIONAL_STORE_CORRUPT');
  const firstSeenAt = operationalIso(row.first_seen_at);
  const lastSeenAt = operationalIso(row.last_seen_at);
  const lastGoodAt = operationalIso(row.last_good_at);
  const updatedAt = operationalIso(row.updated_at);
  const consecutiveMissingPasses = operationalInteger(row.consecutive_missing_passes);
  const active = operationalBoolean(row.active);
  if (lastSeenAt < firstSeenAt || lastGoodAt < firstSeenAt ||
      updatedAt < lastSeenAt || updatedAt < lastGoodAt ||
      (!active && (consecutiveMissingPasses < 2 ||
        new Date(updatedAt).valueOf() - new Date(lastSeenAt).valueOf() < DISCOVERY_REMOVAL_GRACE_MS))) {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  return {
    orcaRepositoryId: operationalText(row.orca_repository_id, 500),
    canonicalKey,
    projectKey: validateProjectKey(row.project_key),
    origin: row.origin,
    active,
    consecutiveMissingPasses,
    firstSeenAt,
    lastSeenAt,
    lastGoodAt,
    updatedAt,
  };
}

function toRepositoryDiscoveryIssue(row: RepositoryDiscoveryIssueRow): RepositoryDiscoveryIssueRecord {
  if (!/^[0-9a-f]{64}$/.test(row.issue_hash) || !OPERATIONAL_ISSUE_CATEGORIES.has(row.category as RepositoryDiscoveryIssueCategory)) {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  const active = operationalBoolean(row.active);
  const firstSeenAt = operationalIso(row.first_seen_at);
  const lastSeenAt = operationalIso(row.last_seen_at);
  const resolvedAt = row.resolved_at === null ? null : operationalIso(row.resolved_at);
  const updatedAt = operationalIso(row.updated_at);
  if (lastSeenAt < firstSeenAt || updatedAt < firstSeenAt || active === (resolvedAt !== null)) {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  return {
    issueHash: row.issue_hash,
    category: row.category as RepositoryDiscoveryIssueCategory,
    active,
    occurrenceCount: operationalInteger(row.occurrence_count, false, 1),
    firstSeenAt,
    lastSeenAt,
    resolvedAt,
    updatedAt,
  };
}

function toDaemonHealth(row: DaemonHealthRow): DaemonHealthRecord {
  if ((row.desired_state !== 'running' && row.desired_state !== 'stopped') ||
      (row.state !== 'running' && row.state !== 'stopped')) operationalFail('OPERATIONAL_STORE_CORRUPT');
  const startedAt = operationalIso(row.started_at);
  const heartbeatAt = operationalIso(row.heartbeat_at);
  const cleanStoppedAt = row.clean_stopped_at === null ? null : operationalIso(row.clean_stopped_at);
  const updatedAt = operationalIso(row.updated_at);
  if (heartbeatAt < startedAt || updatedAt < heartbeatAt ||
      (row.state === 'running') !== (cleanStoppedAt === null) ||
      (cleanStoppedAt !== null && (cleanStoppedAt < heartbeatAt || updatedAt < cleanStoppedAt))) {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  return {
    revision: operationalInteger(row.revision),
    instanceId: operationalText(row.instance_id, 200),
    buildFingerprint: validateFingerprint(row.build_fingerprint),
    configFingerprint: validateFingerprint(row.config_fingerprint),
    desiredState: row.desired_state,
    state: row.state,
    startedAt,
    heartbeatAt,
    cleanStoppedAt,
    lastErrorCode: row.last_error_code === null ? null : operationalCode(row.last_error_code),
    updatedAt,
  };
}

function toDaemonJobOutcome(row: DaemonJobOutcomeRow): DaemonJobOutcomeRecord {
  if (!OPERATIONAL_JOB_NAMES.has(row.job_name as DaemonJobName) ||
      !['running', 'succeeded', 'failed', 'backoff'].includes(row.state)) {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  const startedAt = operationalIso(row.started_at);
  const completedAt = row.completed_at === null ? null : operationalIso(row.completed_at);
  const lastSuccessAt = row.last_success_at === null ? null : operationalIso(row.last_success_at);
  const lastFailureAt = row.last_failure_at === null ? null : operationalIso(row.last_failure_at);
  const nextRunAt = row.next_run_at === null ? null : operationalIso(row.next_run_at);
  const updatedAt = operationalIso(row.updated_at);
  const durationMs = row.duration_ms === null ? null : operationalInteger(row.duration_ms);
  const consecutiveFailures = operationalInteger(row.consecutive_failures);
  const errorCode = row.error_code === null ? null : operationalCode(row.error_code);
  const validState =
    (row.state === 'running' && completedAt === null && durationMs === null &&
      nextRunAt === null && errorCode === null) ||
    (row.state === 'succeeded' && completedAt !== null && durationMs !== null &&
      lastSuccessAt === completedAt && nextRunAt !== null && nextRunAt >= updatedAt &&
      errorCode === null && consecutiveFailures === 0) ||
    (row.state === 'failed' && completedAt !== null && durationMs !== null &&
      lastFailureAt === completedAt && nextRunAt === null && errorCode !== null &&
      consecutiveFailures >= 1) ||
    (row.state === 'backoff' && completedAt !== null && durationMs !== null &&
      lastFailureAt === completedAt && nextRunAt !== null && nextRunAt >= updatedAt &&
      errorCode !== null && consecutiveFailures >= 1);
  if (updatedAt < startedAt || (completedAt !== null && completedAt < startedAt) ||
      (lastSuccessAt !== null && updatedAt < lastSuccessAt) ||
      (lastFailureAt !== null && updatedAt < lastFailureAt) || !validState) {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  return {
    jobName: row.job_name as DaemonJobName,
    revision: operationalInteger(row.revision),
    state: row.state as DaemonJobOutcomeRecord['state'],
    attempt: operationalInteger(row.attempt, false, 1),
    consecutiveFailures,
    startedAt,
    completedAt,
    lastSuccessAt,
    lastFailureAt,
    durationMs,
    nextRunAt,
    errorCode,
    processedCount: operationalInteger(row.processed_count),
    deferredCount: operationalInteger(row.deferred_count),
    checkpoint: operationalInteger(row.checkpoint),
    updatedAt,
  };
}

function checkedSlackRootEntity(kind: unknown, key: unknown, input = false): SlackRootEntity {
  const fail = (): never => operationalFail(input ? 'OPERATIONAL_INPUT_INVALID' : 'OPERATIONAL_STORE_CORRUPT');
  const text = input ? operationalInputText(key, 500) : operationalText(key, 500);
  if (kind === 'pr') {
    const match = /^pr:([1-9][0-9]*)#([1-9][0-9]*)$/.exec(text);
    if (match !== null) {
      try {
        const repositoryId = Number(match[1]);
        const number = Number(match[2]);
        if (pullRequestKey(repositoryId, number) === text) {
          return { kind, key: text as PullRequestKey };
        }
      } catch {
        return fail();
      }
    }
    return fail();
  }
  if (kind === 'run') {
    try {
      if (runKey(text.slice('run:'.length)) === text) return { kind, key: text as RunKey };
    } catch {
      return fail();
    }
    return fail();
  }
  if (kind === 'run_collection' && text === 'run_collection') return { kind, key: text };
  return fail();
}

function toSlackRootIntent(row: SlackRootIntentRow): SlackRootIntentRecord {
  const entity = checkedSlackRootEntity(row.entity_kind, row.entity_key);
  if (!['pending', 'sending', 'posted', 'uncertain'].includes(row.state)) {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  const preparedAt = operationalIso(row.prepared_at);
  const lastAttemptAt = row.last_attempt_at === null ? null : operationalIso(row.last_attempt_at);
  const postedAt = row.posted_at === null ? null : operationalIso(row.posted_at);
  const uncertainAt = row.uncertain_at === null ? null : operationalIso(row.uncertain_at);
  const updatedAt = operationalIso(row.updated_at);
  const attemptCount = operationalInteger(row.attempt_count);
  const sendingInstanceId = row.sending_instance_id === null
    ? null
    : operationalText(row.sending_instance_id, 200);
  const messageTs = row.message_ts === null ? null : operationalText(row.message_ts, 100);
  const lastErrorCode = row.last_error_code === null ? null : operationalCode(row.last_error_code);
  const validState =
    (row.state === 'pending' && sendingInstanceId === null && messageTs === null &&
      postedAt === null && uncertainAt === null &&
      ((attemptCount === 0 && lastAttemptAt === null && lastErrorCode === null) ||
       (attemptCount >= 1 && lastAttemptAt !== null && lastErrorCode !== null))) ||
    (row.state === 'sending' && attemptCount >= 1 && sendingInstanceId !== null &&
      messageTs === null && lastAttemptAt !== null && postedAt === null &&
      uncertainAt === null && lastErrorCode === null) ||
    (row.state === 'posted' && attemptCount >= 1 && sendingInstanceId === null &&
      messageTs !== null && lastAttemptAt !== null && postedAt !== null &&
      uncertainAt === null && lastErrorCode === null && updatedAt >= postedAt) ||
    (row.state === 'uncertain' && attemptCount >= 1 && sendingInstanceId === null &&
      messageTs === null && lastAttemptAt !== null && postedAt === null &&
      uncertainAt !== null && lastErrorCode !== null && updatedAt >= uncertainAt);
  if (updatedAt < preparedAt ||
      (lastAttemptAt !== null && (lastAttemptAt < preparedAt || updatedAt < lastAttemptAt)) ||
      !validState) {
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
  return {
    ...entity,
    revision: operationalInteger(row.revision),
    channelId: operationalText(row.channel_id, 200),
    renderFingerprint: validateFingerprint(row.render_fingerprint),
    state: row.state as SlackRootIntentRecord['state'],
    attemptCount,
    sendingInstanceId,
    messageTs,
    preparedAt,
    lastAttemptAt,
    postedAt,
    uncertainAt,
    lastErrorCode,
    updatedAt,
  };
}

function operationalEntity(entity: SlackRootEntity, input = true): SlackRootEntity {
  return checkedSlackRootEntity(entity.kind, entity.key, input);
}

function operationalJobName(value: unknown, input = true): DaemonJobName {
  if (!OPERATIONAL_JOB_NAMES.has(value as DaemonJobName)) {
    operationalFail(input ? 'OPERATIONAL_INPUT_INVALID' : 'OPERATIONAL_STORE_CORRUPT');
  }
  return value as DaemonJobName;
}

function readDiscoverySnapshot(db: DatabaseSync, activeOnly: boolean): EffectiveDiscoverySnapshot {
  const suffix = activeOnly ? ' WHERE active = 1' : '';
  const registry = db.prepare(SELECT_REPOSITORY_REGISTRY.replace(
    ' ORDER BY canonical_key', `${suffix} ORDER BY canonical_key`,
  )).all() as RepositoryRegistryRow[];
  const bindings = db.prepare(SELECT_ORCA_REPOSITORY_BINDINGS.replace(
    ' ORDER BY orca_repository_id', `${suffix} ORDER BY orca_repository_id`,
  )).all() as OrcaRepositoryBindingRow[];
  const issues = db.prepare(SELECT_REPOSITORY_DISCOVERY_ISSUES.replace(
    ' ORDER BY issue_hash', `${suffix} ORDER BY issue_hash`,
  )).all() as RepositoryDiscoveryIssueRow[];
  return {
    repositories: registry.map(toRepositoryRegistry),
    bindings: bindings.map(toOrcaRepositoryBinding),
    issues: issues.map(toRepositoryDiscoveryIssue),
  };
}

function toGateMetadata(row: GateMetadataRow): GateMetadata {
  storedText(row.options_json, `${row.gate_key}.options_json`, 200_000);
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
    gateKey: storedKey(row.gate_key, 'gate:', 'gate_metadata.gate_key') as GateKey,
    runKey: storedKey(row.run_key, 'run:', `${row.gate_key}.run_key`) as RunKey,
    taskKey: storedKey(row.task_key, 'task:', `${row.gate_key}.task_key`) as TaskKey,
    dispatchKey: storedKey(
      row.dispatch_key,
      'dispatch:',
      `${row.gate_key}.dispatch_key`,
    ) as GateMetadata['dispatchKey'],
    askMessageId: storedText(row.ask_message_id, `${row.gate_key}.ask_message_id`),
    questionThreadId: storedText(row.question_thread_id, `${row.gate_key}.question_thread_id`),
    options,
    recommendation: {
      optionId: row.recommendation_option_id,
      reason: storedText(row.recommendation_reason, `${row.gate_key}.recommendation_reason`, 3000),
    },
    impact: storedText(row.impact, `${row.gate_key}.impact`, 3000),
    registeredAt: storedIso(row.registered_at, `${row.gate_key}.registered_at`),
  };
}

function toGateMessage(row: GateMessageRow): GateMessageRecord {
  if (
    !/^[CG][A-Z0-9]+$/.test(row.channel_id) ||
    !/^\d+\.\d+$/.test(row.thread_ts) ||
    !/^\d+\.\d+$/.test(row.message_ts)
  ) {
    throw new TypeError(`${row.gate_key}의 Gate Slack mapping identity가 잘못됐다`);
  }
  return {
    gateKey: storedKey(row.gate_key, 'gate:', 'gate_message.gate_key') as GateKey,
    runKey: storedKey(row.run_key, 'run:', `${row.gate_key}.run_key`) as RunKey,
    channelId: storedText(row.channel_id, `${row.gate_key}.channel_id`, 32),
    threadTs: storedText(row.thread_ts, `${row.gate_key}.thread_ts`, 32),
    messageTs: storedText(row.message_ts, `${row.gate_key}.message_ts`, 32),
    renderFingerprint: storedText(row.render_fingerprint, `${row.gate_key}.render_fingerprint`),
    createdAt: storedIso(row.created_at, `${row.gate_key}.created_at`),
    updatedAt: storedIso(row.updated_at, `${row.gate_key}.updated_at`),
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

function gateCode(value: string, cap: number): string {
  if (!/^[a-z0-9_.-]+$/.test(value) || value.length === 0 || value.length > cap) {
    throw new TypeError(`Gate audit code가 허용된 bounded shape가 아니다`);
  }
  return value;
}

/** Never persist tokens, URLs, or unbounded downstream error text. */
function safeGateFact(value: string | null, cap: number): string | null {
  if (value === null) return null;
  const redacted = value
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/(?:xox(?:b|p|a|s|r)|xapp)-\S+/gi, '[redacted-token]')
    .replace(/response_url\s*[:=]\s*\S+/gi, 'response_url=[redacted]');
  const bounded = redacted.slice(0, cap);
  return bounded === '' ? null : bounded;
}

function cardStateForLifecycle(lifecycle: GateResolutionLifecycle): GateCardState {
  if (lifecycle === 'resolved') return 'resolved';
  if (lifecycle === 'conflict') return 'conflict';
  if (lifecycle === 'degraded' || lifecycle === 'uncertain') return 'degraded';
  return 'resolving';
}

/** Supersede any in-flight Slack completion in the same transaction as a D3 state transition. */
function rearmGateOutboxForChannelTransition(
  db: DatabaseSync,
  gateKey: GateKey,
  at: string,
): number {
  const result = db.prepare(
    `UPDATE gate_resolution_outbox
        SET revision = revision + 1, card_pending = 1, projected_at = NULL,
            projection_owner = NULL, projection_expires_at = NULL,
            updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE gate_key = ? AND notification_state = 'pending'`,
  ).run(at, at, gateKey);
  if (Number(result.changes) !== 1) {
    throw new Error(`${gateKey}의 D2 outbox를 Channel transition과 함께 re-arm하지 못했다`);
  }
  const row = db.prepare('SELECT revision FROM gate_resolution_outbox WHERE gate_key = ?')
    .get(gateKey) as { readonly revision: number } | undefined;
  if (row === undefined) throw new Error(`${gateKey}의 re-armed D2 outbox revision을 읽지 못했다`);
  return storedRevision(row.revision, `${gateKey}.Channel deferred outbox revision`);
}

export class SqliteDigestStore implements DigestStore, RunStore, GateStore, OperationalStore {
  private readonly db: DatabaseSync;
  private readonly observationWriteOwner: string;
  private readonly isObservationOwnerAlive: (owner: string) => boolean;
  private readonly channelMonotonicNow: () => number;
  private readonly activeObservationWrites = new Map<GateKey, number>();
  private readonly ownedProjectionWrites = new Set<string>();
  private channelClockMonotonicMs: number;
  private channelClockLogicalMs: number | null = null;
  private readonly operationalFault: ((
    point: 'after_discovery_registry' | 'after_discovery_bindings' | 'after_root_mapping',
  ) => void) | undefined;

  /** 파일을 열고 스키마를 준비한다. 부모 디렉터리가 없으면 만든다. */
  constructor(
    path: string,
    options: {
      readonly validationFault?: (point: 'after_resolution_rows') => void;
      /** Test seam for an abandoned ordinary-write owner from a crashed process. */
      readonly observationWriteOwner?: string;
      readonly observationOwnerAlive?: (owner: string) => boolean;
      /** Test seam for rollback-safe delivery scheduling; production uses the process clock. */
      readonly monotonicNow?: () => number;
      /** Test-only rollback seam for multi-statement operational transactions. */
      readonly operationalFault?: (
        point: 'after_discovery_registry' | 'after_discovery_bindings' | 'after_root_mapping',
      ) => void;
      /** Test-only migration statement fault injection. */
      readonly migrationFault?: (fromVersion: number, statementIndex: number) => void;
    } = {},
  ) {
    this.observationWriteOwner = storedLeaseOwner(
      options.observationWriteOwner ?? `p${process.pid}.${randomUUID()}`,
      'ordinary Gate write owner',
    );
    this.isObservationOwnerAlive = options.observationOwnerAlive ?? observationOwnerAlive;
    this.channelMonotonicNow = options.monotonicNow ??
      (() => Number(process.hrtime.bigint()) / 1_000_000);
    this.operationalFault = options.operationalFault;
    this.channelClockMonotonicMs = this.channelMonotonicNow();
    if (!Number.isFinite(this.channelClockMonotonicMs)) {
      throw new TypeError('Channel delivery monotonic clock이 유한하지 않다');
    }
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      enableWal(this.db, path);
      enableForeignKeys(this.db);
      prepareSchema(this.db, path, options.validationFault, options.migrationFault);
      const clockFloor = this.db.prepare(SELECT_GATE_CHANNEL_CLOCK_FLOOR).get() as
        | { readonly updated_at: string | null }
        | undefined;
      if (clockFloor?.updated_at !== null && clockFloor?.updated_at !== undefined) {
        this.channelClockLogicalMs = new Date(storedIso(
          clockFloor.updated_at,
          'Gate Channel delivery clock floor',
        )).valueOf();
      }
      LIVE_OBSERVATION_WRITE_OWNERS.add(this.observationWriteOwner);
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
    const optionsJson = JSON.stringify(metadata.options);
    toGateMetadata({
      gate_key: metadata.gateKey,
      run_key: metadata.runKey,
      task_key: metadata.taskKey,
      dispatch_key: metadata.dispatchKey,
      ask_message_id: metadata.askMessageId,
      question_thread_id: metadata.questionThreadId,
      options_json: optionsJson,
      recommendation_option_id: metadata.recommendation.optionId,
      recommendation_reason: metadata.recommendation.reason,
      impact: metadata.impact,
      registered_at: metadata.registeredAt,
    });
    this.db.exec('BEGIN IMMEDIATE');
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
          optionsJson,
          metadata.recommendation.optionId,
          metadata.recommendation.reason,
          metadata.impact,
          metadata.registeredAt,
        );
      const observation = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(metadata.gateKey) as
        | GateLocalObservationRow
        | undefined;
      if (observation !== undefined) {
        const metadataState =
          observation.metadata_state === 'matched' &&
          observation.run_key === metadata.runKey &&
          observation.task_key === metadata.taskKey
            ? 'matched'
            : 'mismatched';
        this.db.prepare(
          'UPDATE gate_local_observation SET metadata_state = ? WHERE gate_key = ?',
        ).run(metadataState, metadata.gateKey);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
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

  insertGateMessage(message: NewGateMessage, observation?: GateLocalObservation): void {
    toGateMessage({
      gate_key: message.gateKey,
      run_key: message.runKey,
      channel_id: message.channelId,
      thread_ts: message.threadTs,
      message_ts: message.messageTs,
      render_fingerprint: message.renderFingerprint,
      created_at: message.at,
      updated_at: message.at,
    });
    if (
      observation !== undefined &&
      (observation.gateKey !== message.gateKey ||
        observation.runKey !== message.runKey ||
        observation.mappingState !== 'matched')
    ) {
      throw new TypeError(
        `${message.gateKey}의 첫 Gate message observation correlation이 matched가 아니다`,
      );
    }
    let transactionStarted = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
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
      if (observation !== undefined) {
        // The collection snapshot may have raced sidecar registration. Reconcile metadata inside
        // the same transaction that makes the Slack identity actionable.
        const metadata = this.db.prepare(SELECT_GATE_METADATA).get(message.gateKey) as
          | GateMetadataRow
          | undefined;
        const metadataState = reconcileObservationMetadataState(observation, metadata);
        toGateLocalObservation({
          gate_key: observation.gateKey,
          run_key: observation.runKey,
          task_key: observation.taskKey,
          status: observation.status,
          resolution: observation.resolution,
          resolved_at: observation.resolvedAt,
          metadata_state: metadataState,
          mapping_state: 'matched',
          write_owner: null,
          write_expires_at: null,
          observed_at: observation.observedAt,
        });
        const currentObservation = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(
          observation.gateKey,
        ) as GateLocalObservationRow | undefined;
        const existingMetadataState = currentObservation === undefined
          ? null
          : metadataState === 'matched' &&
              (currentObservation.metadata_state !== 'matched' ||
                currentObservation.run_key !== observation.runKey ||
                currentObservation.task_key !== observation.taskKey)
            ? 'mismatched'
            : metadataState;
        const existingMappingState = currentObservation?.run_key === message.runKey
          ? 'matched'
          : 'mismatched';
        if (currentObservation !== undefined && existingMetadataState !== null) {
          // The existing row may contain newer terminal facts, so update only correlation. Never
          // upgrade a fail-closed metadata row from this mapping-only boundary; a fresh collection
          // must validate the immutable option facts before metadata can become matched again.
          toGateLocalObservation({
            ...currentObservation,
            metadata_state: existingMetadataState,
            mapping_state: existingMappingState,
            write_owner: null,
            write_expires_at: null,
          });
        }
        const mapped = currentObservation === undefined
          ? this.db.prepare(UPSERT_GATE_LOCAL_OBSERVATION).run(
              observation.gateKey,
              observation.runKey,
              observation.taskKey,
              observation.status,
              observation.resolution,
              observation.resolvedAt,
              metadataState,
              'matched',
              observation.observedAt,
            )
          : this.db.prepare(
              `UPDATE gate_local_observation
                  SET metadata_state = ?, mapping_state = ?
                WHERE gate_key = ? AND write_owner IS NULL`,
            ).run(existingMetadataState, existingMappingState, observation.gateKey);
        if (Number(mapped.changes) !== 1) {
          throw new Error(`${message.gateKey}의 첫 Gate message mapping을 원자적으로 확정하지 못했다`);
        }
        advanceGateObservationGeneration(this.db, observation.gateKey);
      }
      this.db.exec('COMMIT');
      transactionStarted = false;
    } catch (e) {
      if (transactionStarted) this.db.exec('ROLLBACK');
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${message.gateKey}의 thread 메시지를 기록할 수 없다 ` +
          `(channel ${message.channelId}, ts ${message.messageTs}): ${detail}`,
        { cause: e },
      );
    }
  }

  updateGateObservation(
    gateKey: GateKey,
    renderFingerprint: string,
    at: string,
    observation?: GateLocalObservation,
    expectedRevision?: number,
  ): void {
    storedIso(at, `${gateKey}.Gate observation at`);
    storedText(renderFingerprint, `${gateKey}.Gate observation fingerprint`, 128);
    if (expectedRevision !== undefined) {
      storedRevision(expectedRevision, `${gateKey}.ordinary Gate completion revision`);
    }
    let transactionStarted = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const rearmResolutionOutbox = (): void => {
        const intent = this.db.prepare(SELECT_GATE_RESOLUTION).get(gateKey) as
          | GateResolutionRow
          | undefined;
        if (intent === undefined) return;
        const outbox = this.db.prepare(SELECT_GATE_OUTBOX).get(gateKey) as
          | GateOutboxRow
          | undefined;
        if (outbox === undefined) {
          throw new Error(`${gateKey}의 D2 intent에 대응하는 outbox가 없다`);
        }
        // Do not release a live D2 projector here. Advancing its revision fences that in-flight
        // completion; retaining the owner lets the projector re-read and renew the new generation.
        const rearmed = this.db.prepare(
          `UPDATE gate_resolution_outbox
              SET revision = revision + 1, card_pending = 1, projected_at = NULL, updated_at = ?
            WHERE gate_key = ? AND revision = ?`,
        ).run(at, gateKey, outbox.revision);
        if (Number(rearmed.changes) !== 1) {
          throw new Error(`${gateKey}의 D2 outbox를 ordinary observation 뒤 재활성화하지 못했다`);
        }
      };
      const local = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(gateKey) as
        | GateLocalObservationRow
        | undefined;
      const generation = this.db.prepare(SELECT_GATE_OBSERVATION_GENERATION).get(gateKey) as
        | GateObservationGenerationRow
        | undefined;
      if (local === undefined && observation !== undefined) {
        throw new Error(`${gateKey}의 local observation이 없어 ordinary write를 확정할 수 없다`);
      }
      const activeRevision = this.activeObservationWrites.get(gateKey);
      const active = activeRevision !== undefined;
      const fenced = local?.write_owner !== null && local?.write_owner !== undefined;
      if (!active && (observation !== undefined || expectedRevision !== undefined)) {
        // A generation-aware completion is single-use and must correspond to the bounded Slack
        // call this store actually started. Replaying it after a repair would re-drift the card.
        throw new Error(`${gateKey}의 active ordinary write가 없어 completion을 확정할 수 없다`);
      }
      if (!active && fenced) {
        // Preserve the pre-generation API behavior: a caller that did not start the local write
        // may never settle (or repair) somebody else's durable owner.
        throw new Error(`${gateKey}의 ordinary write owner가 달라 완료를 확정할 수 없다`);
      }
      let activeObservation: GateLocalObservation | null = null;
      let activeExpectedRevision: number | null = null;
      let settledMetadataState: GateLocalObservation['metadataState'] | null = null;
      if (active) {
        if (
          observation === undefined ||
          expectedRevision === undefined ||
          activeRevision !== expectedRevision ||
          observation.gateKey !== gateKey ||
          observation.mappingState !== 'matched' ||
          observation.metadataState !== 'matched'
        ) {
          throw new Error(`${gateKey}의 ordinary write owner/revision 입력이 달라 완료를 확정할 수 없다`);
        }
        activeObservation = observation;
        activeExpectedRevision = expectedRevision;
        const messageRow = this.db.prepare(SELECT_GATE_MESSAGE).get(gateKey) as
          | GateMessageRow
          | undefined;
        if (messageRow === undefined) {
          throw new Error(`${gateKey}의 Gate message correlation이 없어 ordinary write를 확정할 수 없다`);
        }
        const message = toGateMessage(messageRow);
        if (message.gateKey !== gateKey || message.runKey !== observation.runKey) {
          throw new Error(`${gateKey}의 Gate message/run correlation이 ordinary observation과 어긋난다`);
        }
        const metadata = this.db.prepare(SELECT_GATE_METADATA).get(gateKey) as
          | GateMetadataRow
          | undefined;
        settledMetadataState = reconcileObservationMetadataState(observation, metadata);
        // Validate the exact rows that would be committed before executing either correlated
        // update. Type assertions or future callers cannot persist a shape that fails on restart.
        toGateLocalObservation({
          gate_key: gateKey,
          run_key: observation.runKey,
          task_key: observation.taskKey,
          status: observation.status,
          resolution: observation.resolution,
          resolved_at: observation.resolvedAt,
          metadata_state: settledMetadataState,
          mapping_state: 'matched',
          write_owner: null,
          write_expires_at: null,
          observed_at: observation.observedAt,
        });
      }
      const ownsFence = fenced && local?.write_owner === this.observationWriteOwner;
      const ownsLiveFence =
        ownsFence && local?.write_expires_at !== null && local?.write_expires_at !== undefined &&
        local.write_expires_at > at;
      const invalidatedActiveCompletion =
        activeObservation !== null &&
        activeExpectedRevision !== null &&
        local !== undefined &&
        settledMetadataState !== null &&
        (!ownsLiveFence ||
          generation?.revision !== activeExpectedRevision ||
          !observationWriteStillCurrent(local, activeObservation, settledMetadataState));
      if (invalidatedActiveCompletion) {
        // Slack already accepted this call. Its fingerprint is therefore the best durable
        // description of the remote card even if expiry recovery or a newer completion cleared or
        // replaced our owner while the request was in flight.
        const remote = this.db.prepare(UPDATE_GATE_OBSERVATION).run(renderFingerprint, at, gateKey);
        if (Number(remote.changes) !== 1) {
          throw new Error(`${gateKey}의 무효화된 Slack 결과 fingerprint를 기록하지 못했다`);
        }
        if (fenced) {
          // The present owner, including a replacement owner, remains the exclusive repair
          // barrier. If it is a replacement, its already-rendered generation must lose after this
          // older physical Slack write landed.
          const retained = this.db.prepare(
            `UPDATE gate_local_observation SET mapping_state = 'write_pending'
              WHERE gate_key = ? AND write_owner = ? AND write_expires_at IS NOT NULL`,
          ).run(gateKey, local.write_owner);
          if (Number(retained.changes) !== 1) {
            throw new Error(`${gateKey}의 무효화된 ordinary write repair barrier를 남기지 못했다`);
          }
        } else {
          // A newer ordinary completion may already have cleared its owner before this older Slack
          // response arrived last. The remote card is now uncertain, so matched is unsafe until a
          // fresh exact observation repairs it.
          const failedClosed = this.db.prepare(
            `UPDATE gate_local_observation
                SET mapping_state = 'mismatched', write_owner = NULL, write_expires_at = NULL
              WHERE gate_key = ? AND write_owner IS NULL`,
          ).run(gateKey);
          if (Number(failedClosed.changes) !== 1) {
            throw new Error(`${gateKey}의 무효화된 ordinary write mapping을 차단하지 못했다`);
          }
        }
        if (!ownsFence) {
          // Fence a replacement owner's eventual completion, or force a fresh generation when no
          // owner remains. Advancing beyond our expected revision is also safe under malformed
          // external row deletion and cannot accidentally recreate the stale token.
          if (activeExpectedRevision === null) {
            throw new Error(`${gateKey}의 무효화된 ordinary write generation이 없다`);
          }
          advanceGateObservationGeneration(this.db, gateKey, activeExpectedRevision);
        }
        rearmResolutionOutbox();
        this.db.exec('COMMIT');
        transactionStarted = false;
        this.activeObservationWrites.delete(gateKey);
        throw new Error(`${gateKey}의 ordinary write fence가 더 새 관찰로 무효화되어 완료할 수 없다`);
      }
      const result = this.db.prepare(UPDATE_GATE_OBSERVATION).run(renderFingerprint, at, gateKey);
      if (Number(result.changes) === 0) {
        throw new Error(`${gateKey}의 thread 매핑 행이 없어 관찰 결과를 갱신할 수 없다`);
      }
      if (
        activeObservation !== null &&
        activeExpectedRevision !== null &&
        settledMetadataState !== null
      ) {
        const settled = this.db.prepare(
          `UPDATE gate_local_observation
              SET run_key = ?, task_key = ?, status = ?, resolution = ?, resolved_at = ?,
                   metadata_state = ?, mapping_state = 'matched', write_owner = NULL,
                   write_expires_at = NULL,
                   observed_at = ?
            WHERE gate_key = ? AND write_owner = ?
              AND write_expires_at > ?`,
        ).run(
          activeObservation.runKey,
          activeObservation.taskKey,
          activeObservation.status,
          activeObservation.resolution,
          activeObservation.resolvedAt,
          settledMetadataState,
          activeObservation.observedAt,
          gateKey,
          this.observationWriteOwner,
          at,
        );
        if (Number(settled.changes) !== 1) {
          throw new Error(`${gateKey}의 ordinary write fence를 원자적으로 확정하지 못했다`);
        }
      }
      // An ordinary observer can complete after D2 projected a newer card. Re-arm that durable
      // generation in the same transaction as the static fingerprint so a crash before the
      // in-process repair is always recovered by startup reconciliation.
      rearmResolutionOutbox();
      this.db.exec('COMMIT');
      transactionStarted = false;
      if (active) this.activeObservationWrites.delete(gateKey);
    } catch (e) {
      if (transactionStarted) this.db.exec('ROLLBACK');
      throw e;
    }
  }

  saveGateLocalObservation(
    observation: GateLocalObservation,
    expectedFirstMessage?: { readonly channelId: string; readonly threadTs: string | null },
    expectedRevision?: number,
  ): GateObservationSaveResult {
    if (expectedRevision !== undefined) {
      storedRevision(expectedRevision, `${observation.gateKey}.observation confirmation revision`);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let reconciledObservation = observation;
      if (expectedFirstMessage !== undefined) {
        const currentMessage = this.db.prepare(SELECT_GATE_MESSAGE).get(observation.gateKey) as
          | GateMessageRow
          | undefined;
        if (currentMessage !== undefined) {
          // The caller rendered from an `existing === null` snapshot, but another publisher made
          // the immutable identity durable first. Preserve the caller's current Orca facts while
          // deriving correlation from that now-authoritative message instead of writing `missing`.
          const message = toGateMessage(currentMessage);
          reconciledObservation = {
            ...observation,
            mappingState:
              expectedFirstMessage.threadTs === null
                ? 'missing'
                : message.runKey === observation.runKey &&
                    message.channelId === expectedFirstMessage.channelId &&
                    message.threadTs === expectedFirstMessage.threadTs
                  ? 'matched'
                  : 'mismatched',
          };
        }
      }
      const currentObservation = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(
        reconciledObservation.gateKey,
      ) as GateLocalObservationRow | undefined;
      // Reconcile the caller's earlier collection snapshot against sidecar state in this exact
      // write transaction. A concurrent gate-register may commit between collect and publish;
      // persisting that stale `missing` value would make an otherwise valid store fail on restart.
      const metadata = this.db.prepare(SELECT_GATE_METADATA).get(reconciledObservation.gateKey) as
        | GateMetadataRow
        | undefined;
      const requestedMetadataState = reconcileObservationMetadataState(reconciledObservation, metadata);
      // Validate the caller before any terminal/stale reconciliation can hide a malformed shape.
      toGateLocalObservation({
        gate_key: reconciledObservation.gateKey,
        run_key: reconciledObservation.runKey,
        task_key: reconciledObservation.taskKey,
        status: reconciledObservation.status,
        resolution: reconciledObservation.resolution,
        resolved_at: reconciledObservation.resolvedAt,
        metadata_state: requestedMetadataState,
        mapping_state: reconciledObservation.mappingState,
        write_owner: null,
        write_expires_at: null,
        observed_at: reconciledObservation.observedAt,
      });

      const currentGeneration = this.db.prepare(SELECT_GATE_OBSERVATION_GENERATION).get(
        reconciledObservation.gateKey,
      ) as GateObservationGenerationRow | undefined;
      if (expectedRevision !== undefined && currentGeneration?.revision !== expectedRevision) {
        if (currentObservation === undefined || currentGeneration === undefined) {
          throw new Error(
            `${reconciledObservation.gateKey}의 observation reservation correlation이 불완전하다`,
          );
        }
        // A stale reservation cannot replace current Orca facts. It may only make a newly observed
        // correlation fail closed; exact identity leaves the newer mapping untouched.
        const failClosedMapping = reconciledObservation.mappingState === 'matched'
          ? currentObservation.mapping_state
          : reconciledObservation.mappingState;
        const failClosedMetadata = requestedMetadataState === 'matched'
          ? currentObservation.metadata_state
          : requestedMetadataState;
        const correlationChanged =
          currentObservation.write_owner === null &&
          (currentObservation.mapping_state !== failClosedMapping ||
            currentObservation.metadata_state !== failClosedMetadata);
        let revision = currentGeneration.revision;
        if (correlationChanged) {
          const failedClosed = this.db.prepare(
            `UPDATE gate_local_observation
                SET metadata_state = ?, mapping_state = ?
              WHERE gate_key = ? AND write_owner IS NULL`,
          ).run(
            failClosedMetadata,
            failClosedMapping,
            reconciledObservation.gateKey,
          );
          if (Number(failedClosed.changes) !== 1) {
            throw new Error(
              `${reconciledObservation.gateKey}의 stale observation correlation을 차단하지 못했다`,
            );
          }
          revision = advanceGateObservationGeneration(this.db, reconciledObservation.gateKey);
        }
        const durableRow = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(
          reconciledObservation.gateKey,
        ) as GateLocalObservationRow | undefined;
        if (durableRow === undefined) {
          throw new Error(`${reconciledObservation.gateKey}의 current observation이 사라졌다`);
        }
        this.db.exec('COMMIT');
        return { observation: toGateLocalObservation(durableRow), current: false, revision };
      }

      const sourceIsStale =
        currentObservation !== undefined &&
        reconciledObservation.observedAt < currentObservation.observed_at;
      const terminalAdvance =
        currentObservation !== undefined &&
        currentObservation.status !== 'resolved' &&
        reconciledObservation.status === 'resolved';
      const terminalSuperseded =
        currentObservation?.status === 'resolved' &&
        (reconciledObservation.status !== 'resolved' ||
          reconciledObservation.resolution !== currentObservation.resolution ||
          reconciledObservation.resolvedAt !== currentObservation.resolved_at);
      const callerIsCurrent =
        currentObservation === undefined ||
        terminalAdvance ||
        (!sourceIsStale && !terminalSuperseded);
      const preserveFacts =
        currentObservation !== undefined && !terminalAdvance && (sourceIsStale || terminalSuperseded);
      const durableMappingState =
        currentObservation !== undefined &&
        sourceIsStale &&
        reconciledObservation.mappingState === 'matched'
          ? currentObservation.mapping_state === 'write_pending'
            ? 'matched'
            : currentObservation.mapping_state
          : reconciledObservation.mappingState;
      const durableMetadataState =
        currentObservation !== undefined &&
        sourceIsStale &&
        requestedMetadataState === 'matched'
          ? currentObservation.metadata_state
          : requestedMetadataState;
      const durableObservation: GateLocalObservation = {
        ...reconciledObservation,
        runKey: preserveFacts ? currentObservation.run_key as RunKey : reconciledObservation.runKey,
        taskKey: preserveFacts ? currentObservation.task_key as TaskKey : reconciledObservation.taskKey,
        status: preserveFacts
          ? currentObservation.status as GateLocalObservation['status']
          : reconciledObservation.status,
        resolution: preserveFacts ? currentObservation.resolution : reconciledObservation.resolution,
        resolvedAt: preserveFacts ? currentObservation.resolved_at : reconciledObservation.resolvedAt,
        metadataState: durableMetadataState as GateLocalObservation['metadataState'],
        mappingState: durableMappingState as GateLocalObservation['mappingState'],
        observedAt:
          currentObservation !== undefined && sourceIsStale
            ? currentObservation.observed_at
            : reconciledObservation.observedAt,
      };
      // Revalidate the exact durable candidate before its monotonic generation advances.
      toGateLocalObservation({
        gate_key: durableObservation.gateKey,
        run_key: durableObservation.runKey,
        task_key: durableObservation.taskKey,
        status: durableObservation.status,
        resolution: durableObservation.resolution,
        resolved_at: durableObservation.resolvedAt,
        metadata_state: durableObservation.metadataState,
        mapping_state: durableObservation.mappingState,
        write_owner: null,
        write_expires_at: null,
        observed_at: durableObservation.observedAt,
      });
      // A live/dead/expired owner always remains write_pending here, and an ownerless fail-closed
      // mapping cannot become matched in this save transaction. Only an exact begin CAS may move
      // either state directly to write_pending ownership. The separate generation advances even
      // when the visible v8 row is byte-identical (same timestamp, wrong identity, or render-only
      // change), fencing every older completion.
      this.db.prepare(UPSERT_GATE_LOCAL_OBSERVATION).run(
        durableObservation.gateKey,
        durableObservation.runKey,
        durableObservation.taskKey,
        durableObservation.status,
        durableObservation.resolution,
        durableObservation.resolvedAt,
        durableObservation.metadataState,
        durableObservation.mappingState,
        durableObservation.observedAt,
      );
      const revision = expectedRevision ??
        advanceGateObservationGeneration(this.db, durableObservation.gateKey);
      this.db.exec('COMMIT');
      return { observation: durableObservation, current: callerIsCurrent, revision };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  findGateLocalObservation(gateKey: GateKey): GateLocalObservation | null {
    const row = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(gateKey) as
      | GateLocalObservationRow
      | undefined;
    return row === undefined ? null : toGateLocalObservation(row);
  }

  prepareGateDirectModal(input: GateDirectPrepareInput): GateDirectPrepareResult {
    storedIso(input.at, 'gate direct modal prepare.at');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.sessionId,
      ) ||
      !/^[0-9a-f]{64}$/.test(input.buttonEventKey)
    ) {
      return { kind: 'rejected', reason: 'invalid_modal_correlation' };
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const messageRow = this.db.prepare(SELECT_GATE_MESSAGE_BY_SLACK).get(
        input.channelId,
        input.messageTs,
      ) as GateMessageRow | undefined;
      if (messageRow === undefined) {
        this.insertGateAudit(null, 'rejected', 'unknown_message', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'unknown_message' };
      }
      const message = toGateMessage(messageRow);
      const metadataRow = this.db.prepare(SELECT_GATE_METADATA).get(message.gateKey) as
        | GateMetadataRow
        | undefined;
      const observationRow = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(message.gateKey) as
        | GateLocalObservationRow
        | undefined;
      if (metadataRow === undefined || observationRow === undefined) {
        this.insertGateAudit(message.gateKey, 'rejected', 'missing_sidecar_or_observation', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'missing_sidecar_or_observation' };
      }
      const metadata = toGateMetadata(metadataRow);
      const observation = toGateLocalObservation(observationRow);
      const immutableReason =
        !/^T[A-Z0-9]+$/.test(input.teamId) ||
        !/^U[A-Z0-9]+$/.test(input.ownerUserId) ||
        !/^A[A-Z0-9]+$/.test(input.apiAppId) ||
        !/^[CG][A-Z0-9]+$/.test(input.channelId) ||
        !/^\d+\.\d+$/.test(input.threadTs) ||
        !/^\d+\.\d+$/.test(input.messageTs)
          ? 'invalid_slack_identity'
          : message.channelId !== input.channelId || message.messageTs !== input.messageTs
            ? 'message_identity_mismatch'
            : message.threadTs !== input.threadTs
              ? 'thread_identity_mismatch'
              : message.runKey !== metadata.runKey
                ? 'run_identity_mismatch'
                : input.blockId !== gateDirectBlockId(message.gateKey)
                  ? 'unknown_direct_block'
                  : input.actionId !== gateDirectActionId(message.gateKey)
                    ? 'unknown_direct_action'
                    : input.actionValue !== gateDirectActionValue(message.gateKey)
                      ? 'unknown_direct_value'
                      : null;
      if (immutableReason !== null) {
        this.insertGateAudit(message.gateKey, 'rejected', immutableReason, input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: immutableReason };
      }
      const existingEventRow = this.db.prepare(SELECT_GATE_DIRECT_MODAL_BY_EVENT).get(
        input.buttonEventKey,
      ) as GateDirectModalRow | undefined;
      if (existingEventRow !== undefined) {
        const existing = toGateDirectModal(existingEventRow);
        const exact =
          existing.gateKey === message.gateKey &&
          existing.teamId === input.teamId &&
          existing.ownerUserId === input.ownerUserId &&
          existing.apiAppId === input.apiAppId &&
          existing.channelId === input.channelId &&
          existing.threadTs === input.threadTs &&
          existing.messageTs === input.messageTs &&
          existing.blockId === input.blockId &&
          existing.actionId === input.actionId &&
          existing.actionValue === input.actionValue;
        if (!exact) {
          this.insertGateAudit(message.gateKey, 'rejected', 'button_event_collision', input.at);
          this.db.exec('COMMIT');
          return { kind: 'rejected', reason: 'button_event_collision' };
        }
        this.db.exec('COMMIT');
        return { kind: 'duplicate', session: existing, metadata };
      }
      if (this.db.prepare(SELECT_GATE_RESOLUTION).get(message.gateKey) !== undefined) {
        this.insertGateAudit(message.gateKey, 'rejected', 'resolution_already_claimed', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'resolution_already_claimed' };
      }
      const mutableReason =
        observation.runKey !== metadata.runKey
          ? 'run_identity_mismatch'
          : observation.gateKey !== message.gateKey || observation.taskKey !== metadata.taskKey
            ? 'gate_task_identity_mismatch'
            : observation.metadataState !== 'matched'
              ? 'sidecar_not_matched'
              : observation.mappingState !== 'matched' || observationRow.write_owner !== null
                ? 'card_mapping_not_matched'
                : observation.status !== 'pending'
                  ? 'stale_or_resolved'
                  : null;
      if (mutableReason !== null) {
        this.insertGateAudit(message.gateKey, 'rejected', mutableReason, input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: mutableReason };
      }
      this.db.prepare(INSERT_GATE_DIRECT_MODAL).run(
        input.sessionId,
        input.buttonEventKey,
        message.gateKey,
        input.teamId,
        input.ownerUserId,
        input.apiAppId,
        input.channelId,
        input.threadTs,
        input.messageTs,
        input.blockId,
        input.actionId,
        input.actionValue,
        gateDirectCallbackId(message.gateKey),
        gateDirectInputBlockId(message.gateKey),
        gateDirectInputActionId(message.gateKey),
        input.at,
        input.at,
      );
      const sessionRow = this.db.prepare(SELECT_GATE_DIRECT_MODAL).get(input.sessionId) as
        GateDirectModalRow;
      const session = toGateDirectModal(sessionRow);
      this.db.exec('COMMIT');
      return { kind: 'prepared', session, metadata };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  findGateDirectModal(sessionId: string): GateDirectModalSession | null {
    const row = this.db.prepare(SELECT_GATE_DIRECT_MODAL).get(sessionId) as
      | GateDirectModalRow
      | undefined;
    return row === undefined ? null : toGateDirectModal(row);
  }

  beginGateDirectModalOpen(
    sessionId: string,
    expectedRevision: number,
    at: string,
  ): GateDirectModalSession | null {
    storedRevision(expectedRevision, `${sessionId}.open expected revision`);
    storedIso(at, `${sessionId}.open at`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sessionRow = this.db.prepare(SELECT_GATE_DIRECT_MODAL).get(sessionId) as
        | GateDirectModalRow
        | undefined;
      if (sessionRow === undefined) {
        this.db.exec('COMMIT');
        return null;
      }
      const session = toGateDirectModal(sessionRow);
      if (session.revision !== expectedRevision || session.state !== 'prepared') {
        this.db.exec('COMMIT');
        return null;
      }
      const metadataRow = this.db.prepare(SELECT_GATE_METADATA).get(session.gateKey) as
        | GateMetadataRow
        | undefined;
      const messageRow = this.db.prepare(SELECT_GATE_MESSAGE).get(session.gateKey) as
        | GateMessageRow
        | undefined;
      const observationRow = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(session.gateKey) as
        | GateLocalObservationRow
        | undefined;
      const metadata = metadataRow === undefined ? null : toGateMetadata(metadataRow);
      const message = messageRow === undefined ? null : toGateMessage(messageRow);
      const observation = observationRow === undefined ? null : toGateLocalObservation(observationRow);
      const resolutionExists = this.db.prepare(SELECT_GATE_RESOLUTION).get(session.gateKey) !== undefined;
      const stillCurrent =
        metadata !== null && message !== null && observation !== null && !resolutionExists &&
        message.gateKey === session.gateKey && message.runKey === metadata.runKey &&
        message.channelId === session.channelId && message.threadTs === session.threadTs &&
        message.messageTs === session.messageTs && observation.gateKey === session.gateKey &&
        observation.runKey === metadata.runKey && observation.taskKey === metadata.taskKey &&
        observation.metadataState === 'matched' && observation.mappingState === 'matched' &&
        observationRow?.write_owner === null && observation.status === 'pending';
      if (!stillCurrent) {
        this.insertGateAudit(session.gateKey, 'rejected', 'modal_open_sidecar_stale', at);
        this.db.exec('COMMIT');
        return null;
      }
      const result = this.db.prepare(BEGIN_GATE_DIRECT_MODAL_OPEN).run(
        at,
        sessionId,
        expectedRevision,
      );
      if (Number(result.changes) !== 1) {
        throw new Error(`${session.gateKey}의 direct modal open edge를 원자적으로 기록할 수 없다`);
      }
      const openedRow = this.db.prepare(SELECT_GATE_DIRECT_MODAL).get(sessionId) as GateDirectModalRow;
      const opening = toGateDirectModal(openedRow);
      this.db.exec('COMMIT');
      return opening;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finishGateDirectModalOpen(
    sessionId: string,
    expectedRevision: number,
    result: GateDirectOpenResult,
    at: string,
  ): GateDirectModalSession | null {
    storedRevision(expectedRevision, `${sessionId}.open result expected revision`);
    storedIso(at, `${sessionId}.open result at`);
    const current = this.findGateDirectModal(sessionId);
    if (current === null || current.revision !== expectedRevision || current.state !== 'opening') {
      return null;
    }
    let updated;
    if (result.kind === 'opened') {
      const exactIdentity =
        /^V[A-Z0-9]+$/.test(result.viewId) &&
        result.teamId === current.teamId &&
        result.apiAppId === current.apiAppId &&
        result.callbackId === current.callbackId &&
        result.privateMetadata === current.sessionId;
      if (exactIdentity) {
        updated = this.db.prepare(FINISH_GATE_DIRECT_MODAL_OPENED).run(
          result.viewId,
          at,
          at,
          sessionId,
          expectedRevision,
        );
      } else {
        updated = this.db.prepare(FINISH_GATE_DIRECT_MODAL_FAILED).run(
          'response_identity_mismatch',
          at,
          sessionId,
          expectedRevision,
        );
      }
    } else {
      updated = this.db.prepare(FINISH_GATE_DIRECT_MODAL_FAILED).run(
        gateCode(result.code, 80),
        at,
        sessionId,
        expectedRevision,
      );
    }
    return Number(updated.changes) === 1 ? this.findGateDirectModal(sessionId) : null;
  }

  claimGateDirectResolution(input: GateDirectClaimInput): GateClaimResult {
    storedIso(input.at, 'gate direct resolution claim.at');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sessionRow = this.db.prepare(SELECT_GATE_DIRECT_MODAL).get(input.sessionId) as
        | GateDirectModalRow
        | undefined;
      if (sessionRow === undefined) {
        this.insertGateAudit(null, 'rejected', 'unknown_modal_session', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'unknown_modal_session' };
      }
      const session = toGateDirectModal(sessionRow);
      const metadataRow = this.db.prepare(SELECT_GATE_METADATA).get(session.gateKey) as
        | GateMetadataRow
        | undefined;
      const messageRow = this.db.prepare(SELECT_GATE_MESSAGE).get(session.gateKey) as
        | GateMessageRow
        | undefined;
      const observationRow = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(session.gateKey) as
        | GateLocalObservationRow
        | undefined;
      if (metadataRow === undefined || messageRow === undefined || observationRow === undefined) {
        this.insertGateAudit(session.gateKey, 'rejected', 'missing_sidecar_or_observation', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'missing_sidecar_or_observation' };
      }
      const metadata = toGateMetadata(metadataRow);
      const message = toGateMessage(messageRow);
      const observation = toGateLocalObservation(observationRow);
      const immutableReason =
        input.privateMetadata !== input.sessionId ||
        input.teamId !== session.teamId ||
        input.ownerUserId !== session.ownerUserId ||
        input.apiAppId !== session.apiAppId ||
        input.viewId !== session.viewId ||
        input.callbackId !== session.callbackId ||
        input.inputBlockId !== session.inputBlockId ||
        input.inputActionId !== session.inputActionId
          ? 'modal_identity_mismatch'
          : message.gateKey !== session.gateKey ||
              message.runKey !== metadata.runKey ||
              message.channelId !== session.channelId ||
              message.threadTs !== session.threadTs ||
              message.messageTs !== session.messageTs
            ? 'modal_message_mismatch'
            : metadata.taskKey.slice('task:'.length) === ''
              ? 'modal_metadata_mismatch'
              : null;
      if (immutableReason !== null) {
        this.insertGateAudit(session.gateKey, 'rejected', immutableReason, input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: immutableReason };
      }
      const existingRow = this.db.prepare(SELECT_GATE_RESOLUTION).get(session.gateKey) as
        | GateResolutionRow
        | undefined;
      const existing = existingRow === undefined ? null : toGateResolution(existingRow);
      if (existing !== null) {
        const exact =
          session.state === 'accepted' &&
          session.resolutionText === input.resolutionText &&
          existing.optionId === GATE_DIRECT_OPTION_ID &&
          existing.optionResolution === input.resolutionText &&
          existing.teamId === input.teamId &&
          existing.ownerUserId === input.ownerUserId &&
          existing.apiAppId === input.apiAppId &&
          existing.channelId === session.channelId &&
          existing.threadTs === session.threadTs &&
          existing.messageTs === session.messageTs &&
          existing.blockId === session.inputBlockId &&
          existing.actionId === session.inputActionId &&
          existing.actionValue === session.sessionId;
        if (exact) {
          this.insertGateAudit(session.gateKey, 'duplicate', 'same_transition', input.at);
          this.db.exec('COMMIT');
          return { kind: 'duplicate', intent: existing, metadata };
        }
        this.insertGateAudit(session.gateKey, 'lost', 'different_transition', input.at);
        this.db.exec('COMMIT');
        return { kind: 'lost', intent: existing };
      }
      if (session.state !== 'opened') {
        this.insertGateAudit(session.gateKey, 'rejected', 'modal_not_opened', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'modal_not_opened' };
      }
      const mutableReason =
        observation.runKey !== metadata.runKey || observation.taskKey !== metadata.taskKey
          ? 'gate_task_identity_mismatch'
          : observation.metadataState !== 'matched'
            ? 'sidecar_not_matched'
            : observation.mappingState !== 'matched' || observationRow.write_owner !== null
              ? 'card_mapping_not_matched'
              : observation.status !== 'pending'
                ? 'stale_or_resolved'
                : null;
      if (mutableReason !== null) {
        this.insertGateAudit(session.gateKey, 'rejected', mutableReason, input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: mutableReason };
      }
      if (
        input.resolutionText.length === 0 || input.resolutionText.length > 3000 ||
        input.resolutionText.trim() === '' ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(input.resolutionText) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.retryRequestId,
        )
      ) {
        this.insertGateAudit(session.gateKey, 'rejected', 'invalid_direct_claim', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'invalid_direct_claim' };
      }
      this.db.prepare(INSERT_GATE_RESOLUTION).run(
        session.gateKey,
        input.retryRequestId,
        GATE_DIRECT_OPTION_ID,
        input.resolutionText,
        metadata.askMessageId,
        metadata.questionThreadId,
        metadata.dispatchKey.slice('dispatch:'.length),
        metadata.taskKey.slice('task:'.length),
        input.teamId,
        input.ownerUserId,
        input.apiAppId,
        session.channelId,
        session.threadTs,
        session.messageTs,
        session.inputBlockId,
        session.inputActionId,
        session.sessionId,
        input.at,
        input.at,
      );
      const accepted = this.db.prepare(ACCEPT_GATE_DIRECT_MODAL).run(
        input.resolutionText,
        input.at,
        input.at,
        session.sessionId,
        session.revision,
      );
      if (Number(accepted.changes) !== 1) {
        throw new Error(`${session.gateKey}의 direct modal winner를 원자적으로 기록할 수 없다`);
      }
      this.db.prepare(INSERT_GATE_OUTBOX).run(session.gateKey, input.at, input.at);
      if (!this.insertGateAudit(session.gateKey, 'claimed', 'first_valid_selection', input.at)) {
        throw new Error(`${session.gateKey}의 first-winner audit를 원자적으로 기록할 수 없다`);
      }
      const claimedRow = this.db.prepare(SELECT_GATE_RESOLUTION).get(session.gateKey) as
        GateResolutionRow;
      const claimed = toGateResolution(claimedRow);
      this.db.exec('COMMIT');
      return { kind: 'claimed', intent: claimed, metadata };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimGateResolution(input: GateClaimInput): GateClaimResult {
    storedIso(input.at, 'gate resolution claim.at');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const message = this.db
        .prepare(SELECT_GATE_MESSAGE_BY_SLACK)
        .get(input.channelId, input.messageTs) as GateMessageRow | undefined;
      if (message === undefined) {
        this.insertGateAudit(null, 'rejected', 'unknown_message', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'unknown_message' };
      }
      const gate = toGateMessage(message);
      const metadataRow = this.db.prepare(SELECT_GATE_METADATA).get(gate.gateKey) as
        | GateMetadataRow
        | undefined;
      const observationRow = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(gate.gateKey) as
        | GateLocalObservationRow
        | undefined;
      if (metadataRow === undefined || observationRow === undefined) {
        this.insertGateAudit(gate.gateKey, 'rejected', 'missing_sidecar_or_observation', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'missing_sidecar_or_observation' };
      }
      const metadata = toGateMetadata(metadataRow);
      const observation = toGateLocalObservation(observationRow);
      const optionMatches = metadata.options.filter((option) => option.id === input.actionValue);
      // Validate the immutable Slack envelope and action against the durable Gate/message facts
      // before consulting mutable observer state. An exact redelivery may need to recover a
      // pre-ACK winner after a later ordinary Slack completion fail-closed the mapping.
      const immutableReason =
        !/^T[A-Z0-9]+$/.test(input.teamId) ||
        !/^U[A-Z0-9]+$/.test(input.ownerUserId) ||
        (input.apiAppId !== null && !/^A[A-Z0-9]+$/.test(input.apiAppId)) ||
        !/^[CG][A-Z0-9]+$/.test(input.channelId) ||
        !/^\d+\.\d+$/.test(input.threadTs) ||
        !/^\d+\.\d+$/.test(input.messageTs)
          ? 'invalid_slack_identity'
          : gate.channelId !== input.channelId || gate.messageTs !== input.messageTs
          ? 'message_identity_mismatch'
          : gate.threadTs !== input.threadTs
            ? 'thread_identity_mismatch'
            : gate.runKey !== metadata.runKey
              ? 'run_identity_mismatch'
              : input.blockId !== gateBlockId(gate.gateKey)
                ? 'unknown_block'
                : optionMatches.length !== 1
                  ? 'unknown_or_ambiguous_option'
                  : input.actionId !== gateActionId(gate.gateKey, input.actionValue)
                    ? 'unknown_action'
                    : null;
      if (immutableReason !== null) {
        this.insertGateAudit(gate.gateKey, 'rejected', immutableReason, input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: immutableReason };
      }
      const option = optionMatches[0];
      if (option === undefined) throw new Error('validated Gate option disappeared');
      const existingRow = this.db.prepare(SELECT_GATE_RESOLUTION).get(gate.gateKey) as
        | GateResolutionRow
        | undefined;
      const existing = existingRow === undefined ? null : toGateResolution(existingRow);
      const finishExisting = (intent: GateResolutionIntent): GateClaimResult => {
        const exactStoredWinner =
          intent.optionId === option.id &&
          intent.optionResolution === option.resolution &&
          intent.teamId === input.teamId &&
          intent.apiAppId === input.apiAppId &&
          intent.channelId === input.channelId &&
          intent.threadTs === input.threadTs &&
          intent.messageTs === input.messageTs &&
          intent.blockId === input.blockId &&
          intent.actionId === input.actionId &&
          intent.actionValue === input.actionValue;
        if (exactStoredWinner) {
          this.insertGateAudit(gate.gateKey, 'duplicate', 'same_transition', input.at);
          this.db.exec('COMMIT');
          return { kind: 'duplicate', intent, metadata };
        }
        this.insertGateAudit(gate.gateKey, 'lost', 'different_transition', input.at);
        this.db.exec('COMMIT');
        return { kind: 'lost', intent };
      };
      if (existing !== null && existing.ackState !== 'acked') {
        // pending/failed intents are intentionally absent from startup reconciliation, and an
        // ordinary repair cannot start once the intent exists. Exact Slack redelivery is therefore
        // their only recovery path and must not be blocked by a later mutable observation mismatch.
        return finishExisting(existing);
      }
      const mutableObservationReason =
        observation.runKey !== metadata.runKey
          ? 'run_identity_mismatch'
          : observation.gateKey !== gate.gateKey || observation.taskKey !== metadata.taskKey
            ? 'gate_task_identity_mismatch'
            : observation.metadataState !== 'matched'
              ? 'sidecar_not_matched'
              : observation.mappingState !== 'matched' || observationRow.write_owner !== null
                ? 'card_mapping_not_matched'
                : null;
      if (mutableObservationReason !== null) {
        this.insertGateAudit(gate.gateKey, 'rejected', mutableObservationReason, input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: mutableObservationReason };
      }
      if (existing !== null) return finishExisting(existing);
      if (observation.status !== 'pending') {
        this.insertGateAudit(gate.gateKey, 'rejected', 'stale_or_resolved', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'stale_or_resolved' };
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.retryRequestId)) {
        this.insertGateAudit(gate.gateKey, 'rejected', 'invalid_retry_request', input.at);
        this.db.exec('COMMIT');
        return { kind: 'rejected', reason: 'invalid_retry_request' };
      }
      this.db.prepare(INSERT_GATE_RESOLUTION).run(
        gate.gateKey,
        input.retryRequestId,
        option.id,
        option.resolution,
        metadata.askMessageId,
        metadata.questionThreadId,
        metadata.dispatchKey.slice('dispatch:'.length),
        metadata.taskKey.slice('task:'.length),
        input.teamId,
        input.ownerUserId,
        input.apiAppId,
        input.channelId,
        input.threadTs,
        input.messageTs,
        input.blockId,
        input.actionId,
        input.actionValue,
        input.at,
        input.at,
      );
      this.db.prepare(INSERT_GATE_OUTBOX).run(gate.gateKey, input.at, input.at);
      if (!this.insertGateAudit(gate.gateKey, 'claimed', 'first_valid_selection', input.at)) {
        // The first winner audit is part of the same required local transaction. If bounded
        // evidence is already exhausted, roll the intent/outbox back rather than commit a winner
        // whose initial audit fact is missing.
        throw new Error(`${gate.gateKey}의 first-winner audit를 원자적으로 기록할 수 없다`);
      }
      const claimedRow = this.db.prepare(SELECT_GATE_RESOLUTION).get(gate.gateKey) as GateResolutionRow;
      const claimed = toGateResolution(claimedRow);
      this.db.exec('COMMIT');
      return { kind: 'claimed', intent: claimed, metadata };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  findGateResolution(gateKey: GateKey): GateResolutionIntent | null {
    const row = this.db.prepare(SELECT_GATE_RESOLUTION).get(gateKey) as GateResolutionRow | undefined;
    return row === undefined ? null : toGateResolution(row);
  }

  listNonterminalGateResolutions(): readonly GateResolutionIntent[] {
    return (this.db.prepare(SELECT_NONTERMINAL_GATE_RESOLUTIONS).all() as GateResolutionRow[]).map(
      toGateResolution,
    );
  }

  acquireGateResolutionLease(
    gateKey: GateKey,
    owner: string,
    at: string,
    expiresAt: string,
  ): GateLeaseResult {
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.lease owner`);
    const acquiredAt = storedIso(at, `${gateKey}.lease at`);
    const expiry = storedIso(expiresAt, `${gateKey}.lease expiresAt`);
    if (expiry <= acquiredAt) throw new TypeError(`${gateKey}의 lease expiry가 미래가 아니다`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateResolution(gateKey);
      if (
        current === null ||
        current.ackState !== 'acked' ||
        ['resolved', 'conflict', 'degraded'].includes(current.lifecycle)
      ) {
        this.db.exec('COMMIT');
        return { kind: 'unavailable' };
      }
      if (
        current.leaseOwner !== null &&
        current.leaseOwner !== safeOwner &&
        current.leaseExpiresAt !== null &&
        current.leaseExpiresAt > acquiredAt
      ) {
        this.db.exec('COMMIT');
        return { kind: 'busy', expiresAt: current.leaseExpiresAt };
      }
      const result = this.db.prepare(
        `UPDATE gate_resolution SET lease_owner = ?, lease_expires_at = ?
          WHERE gate_key = ? AND revision = ?`,
      ).run(safeOwner, expiry, gateKey, current.revision);
      if (Number(result.changes) !== 1) {
        this.db.exec('COMMIT');
        return { kind: 'busy', expiresAt: expiry };
      }
      const leased = this.findGateResolution(gateKey);
      if (leased === null) throw new Error(`${gateKey}의 acquired lease를 다시 읽지 못했다`);
      this.db.exec('COMMIT');
      return { kind: 'acquired', intent: leased };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  renewGateResolutionLease(
    gateKey: GateKey,
    owner: string,
    at: string,
    expiresAt: string,
  ): boolean {
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.renewed lease owner`);
    const renewedAt = storedIso(at, `${gateKey}.renewed lease at`);
    const expiry = storedIso(expiresAt, `${gateKey}.renewed lease expiresAt`);
    if (expiry <= renewedAt) throw new TypeError(`${gateKey}의 renewed lease expiry가 미래가 아니다`);
    const result = this.db.prepare(
      `UPDATE gate_resolution SET lease_expires_at = ?
        WHERE gate_key = ? AND lease_owner = ?
          AND lease_expires_at > ?
          AND lifecycle NOT IN ('resolved','conflict','degraded')`,
    ).run(expiry, gateKey, safeOwner, renewedAt);
    return Number(result.changes) === 1;
  }

  releaseGateResolutionLease(gateKey: GateKey, owner: string): void {
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.released lease owner`);
    this.db.prepare(
      `UPDATE gate_resolution SET lease_owner = NULL, lease_expires_at = NULL
        WHERE gate_key = ? AND lease_owner = ?`,
    ).run(gateKey, safeOwner);
  }

  markGateResolutionAck(
    gateKey: GateKey,
    expectedRevision: number,
    ackState: 'acked' | 'failed',
    at: string,
  ): GateResolutionIntent | null {
    storedRevision(expectedRevision, `${gateKey}.ACK expected revision`);
    storedIso(at, `${gateKey}.ACK at`);
    const result = this.db.prepare(MARK_GATE_RESOLUTION_ACK).run(
      ackState,
      at,
      gateKey,
      expectedRevision,
    );
    if (Number(result.changes) !== 1) return null;
    return this.findGateResolution(gateKey);
  }

  updateGateResolution(
    gateKey: GateKey,
    expectedRevision: number,
    leaseOwner: string,
    update: GateProgressUpdate,
  ): GateResolutionIntent | null {
    storedIso(update.at, `${gateKey}.resolution update.at`);
    storedRevision(expectedRevision, `${gateKey}.expected revision`);
    const safeLeaseOwner = storedLeaseOwner(leaseOwner, `${gateKey}.progress lease owner`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateResolution(gateKey);
      if (current === null) throw new Error(`${gateKey}의 resolution intent가 없다`);
      if (
        current.revision !== expectedRevision ||
        current.ackState !== 'acked' ||
        current.leaseOwner !== safeLeaseOwner ||
        current.leaseExpiresAt === null ||
        current.leaseExpiresAt <= update.at ||
        ['resolved', 'conflict', 'degraded'].includes(current.lifecycle)
      ) {
        this.db.exec('COMMIT');
        return null;
      }
      const preRead = Object.hasOwn(update, 'preRead') ? (update.preRead ?? null) : current.preRead;
      const resolveResult = Object.hasOwn(update, 'resolveResult')
        ? (update.resolveResult ?? null)
        : current.resolveResult;
      const postRead = Object.hasOwn(update, 'postRead') ? (update.postRead ?? null) : current.postRead;
      if (preRead !== null) toGateSnapshot(preRead, `${gateKey}.preRead`);
      if (resolveResult !== null) toGateResolveResult(resolveResult, `${gateKey}.resolveResult`);
      if (postRead !== null) toGateSnapshot(postRead, `${gateKey}.postRead`);
      const errorCode = Object.hasOwn(update, 'errorCode')
        ? safeGateFact(update.errorCode ?? null, 80)
        : current.lastErrorCode;
      const errorDetail = Object.hasOwn(update, 'errorDetail')
        ? safeGateFact(update.errorDetail ?? null, GATE_FACT_CAP)
        : current.lastErrorDetail;
      const cardState = cardStateForLifecycle(update.lifecycle);
      const mutationOwnership =
        resolveResult !== null
          ? 'structured'
          : update.lifecycle === 'resolving' || current.mutationOwnership === 'unknown'
            ? 'unknown'
            : current.mutationOwnership;
      if (update.cardState !== undefined && update.cardState !== cardState) {
        throw new TypeError(`${gateKey}의 lifecycle과 card projection state가 어긋난다`);
      }
      if (errorCode !== null) gateCode(errorCode, 80);
      if (
        resolveResult !== null &&
        (resolveResult.mutation.requestId !== current.retryRequestId ||
          resolveResult.gate.status !== 'resolved' ||
          resolveResult.gate.resolution !== current.optionResolution)
      ) {
        throw new TypeError(`${gateKey}의 structured resolve evidence가 winner와 어긋난다`);
      }
      const releasesLease = ['uncertain', 'resolved', 'conflict', 'degraded'].includes(
        update.lifecycle,
      );
      validateGateLifecycleEvidence(
        {
          ...current,
          revision: current.revision + 1,
          leaseOwner: releasesLease ? null : current.leaseOwner,
          leaseExpiresAt: releasesLease ? null : current.leaseExpiresAt,
          lifecycle: update.lifecycle,
          mutationOwnership,
          preRead,
          resolveResult,
          postRead,
          lastErrorCode: errorCode,
          lastErrorDetail: errorDetail,
          updatedAt: update.at,
        },
        `${gateKey}.resolution update`,
      );
      const result = this.db.prepare(UPDATE_GATE_RESOLUTION_PROGRESS).run(
        update.lifecycle,
        mutationOwnership,
        preRead === null ? null : JSON.stringify(preRead),
        resolveResult === null ? null : JSON.stringify(resolveResult),
        postRead === null ? null : JSON.stringify(postRead),
        errorCode,
        errorDetail,
        update.at,
        gateKey,
        expectedRevision,
        safeLeaseOwner,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec('COMMIT');
        return null;
      }
      const existingOutbox = this.db.prepare(SELECT_GATE_OUTBOX).get(gateKey) as GateOutboxRow | undefined;
      const createdAt = existingOutbox?.created_at ?? current.createdAt;
      this.db.prepare(UPSERT_GATE_OUTBOX_PROGRESS).run(
        gateKey,
        cardState,
        errorCode,
        createdAt,
        update.at,
      );
      if (releasesLease) {
        this.db.prepare(
          `UPDATE gate_resolution SET lease_owner = NULL, lease_expires_at = NULL
            WHERE gate_key = ? AND lease_owner = ?`,
        ).run(gateKey, safeLeaseOwner);
      }
      const updatedRow = this.db.prepare(SELECT_GATE_RESOLUTION).get(gateKey) as GateResolutionRow;
      const updated = toGateResolution(updatedRow);
      this.db.exec('COMMIT');
      return updated;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  listPendingGateOutboxes(): readonly GateResolutionOutbox[] {
    return (this.db.prepare(SELECT_PENDING_GATE_OUTBOXES).all() as GateOutboxRow[]).map(toGateOutbox);
  }

  listAcknowledgedGateOutboxes(): readonly GateResolutionOutbox[] {
    return (this.db.prepare(SELECT_ACKNOWLEDGED_GATE_OUTBOXES).all() as GateOutboxRow[]).map(
      toGateOutbox,
    );
  }

  findGateResolutionOutbox(gateKey: GateKey): GateResolutionOutbox | null {
    const row = this.db.prepare(SELECT_GATE_OUTBOX).get(gateKey) as GateOutboxRow | undefined;
    return row === undefined ? null : toGateOutbox(row);
  }

  seedPendingGateChannelDeliveries(
    at: string,
    limit: number,
    commitFence: GateChannelDeliveryCommitFence,
  ): GateChannelSeedResult {
    const seededAt = storedIso(at, 'Gate Channel delivery seed.at');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('Gate Channel delivery seed limit이 1..1000이 아니다');
    }
    if (!commitFence()) return { kind: 'fenced' };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!commitFence()) {
        this.db.exec('ROLLBACK');
        return { kind: 'fenced' };
      }
      const keys = this.db.prepare(SELECT_GATE_CHANNEL_SEED_KEYS).all(limit) as {
        readonly gate_key: string;
      }[];
      const seeded: GateChannelDelivery[] = [];
      for (const row of keys) {
        if (!commitFence()) {
          this.db.exec('ROLLBACK');
          return { kind: 'fenced' };
        }
        const gateKey = storedKey(
          row.gate_key,
          'gate:',
          'gate_channel_delivery seed.gate_key',
        ) as GateKey;
        const intentRow = this.db.prepare(SELECT_GATE_RESOLUTION).get(gateKey) as
          | GateResolutionRow
          | undefined;
        const metadataRow = this.db.prepare(SELECT_GATE_METADATA).get(gateKey) as
          | GateMetadataRow
          | undefined;
        const outboxRow = this.db.prepare(SELECT_GATE_OUTBOX).get(gateKey) as
          | GateOutboxRow
          | undefined;
        if (intentRow === undefined || metadataRow === undefined || outboxRow === undefined) {
          throw new Error(`${gateKey}의 D2 Channel seed correlation row가 불완전하다`);
        }
        const intent = toGateResolution(intentRow);
        const metadata = toGateMetadata(metadataRow);
        const outbox = toGateOutbox(outboxRow);
        if (intent.preRead?.status === 'resolved') {
          // Exact-base v10 could overwrite the original pending baseline while recovering a
          // structured post-mutation result. That terminal row is valid D2 history but cannot
          // prove pending→resolved causality, so v11 must quarantine it by omission rather than
          // poisoning every daemon startup or manufacturing consumable D3 evidence.
          throw new Error(`${gateKey}의 quarantined D2 row가 Channel seed page에 들어왔다`);
        }
        if (
          intent.ackState !== 'acked' ||
          intent.lifecycle !== 'resolved' ||
          intent.preRead?.status !== 'pending' ||
          intent.postRead?.status !== 'resolved' ||
          intent.postRead.resolution !== intent.optionResolution ||
          intent.resolveResult?.gate.resolvedAt !== intent.postRead.resolvedAt ||
          outbox.notificationState !== 'pending' ||
          metadata.runKey !== `run:${intent.postRead.runId}` ||
          metadata.taskKey !== `task:${intent.postRead.taskId}` ||
          metadata.dispatchKey !== `dispatch:${intent.dispatchId}`
        ) {
          throw new Error(`${gateKey}의 D2 pending→resolved evidence가 Channel seed와 어긋난다`);
        }
        const causalAt = [
          seededAt,
          intent.createdAt,
          intent.updatedAt,
          outbox.createdAt,
          outbox.updatedAt,
          metadata.registeredAt,
          intent.resolveResult.gate.resolvedAt!,
          intent.postRead.resolvedAt!,
        ].reduce((latest, candidate) => candidate > latest ? candidate : latest);
        const deliveryAt = this.channelLogicalAt(seededAt, causalAt);
        const deferredOutboxRevision = rearmGateOutboxForChannelTransition(
          this.db,
          gateKey,
          deliveryAt,
        );
        this.db.prepare(INSERT_GATE_CHANNEL_DELIVERY).run(
          gateKey,
          metadata.runKey,
          metadata.taskKey,
          intent.dispatchId,
          deferredOutboxRevision,
          deliveryAt,
          deliveryAt,
          deliveryAt,
        );
        const inserted = this.db.prepare(SELECT_GATE_CHANNEL_DELIVERY).get(gateKey) as
          | GateChannelDeliveryRow
          | undefined;
        if (inserted === undefined) throw new Error(`${gateKey}의 Channel seed를 다시 읽지 못했다`);
        seeded.push(toGateChannelDelivery(inserted));
        if (!commitFence()) {
          this.db.exec('ROLLBACK');
          return { kind: 'fenced' };
        }
      }
      if (!commitFence()) {
        this.db.exec('ROLLBACK');
        return { kind: 'fenced' };
      }
      this.db.exec('COMMIT');
      return { kind: 'committed', deliveries: seeded };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Translate caller wall time into a process-monotonic logical clock. A rollback starts from the
   * persisted causal floor and advances with hrtime, so retry/lease intervals do not wait for the
   * wall clock to catch up and never regress stored evidence.
   */
  private channelLogicalAt(rawAt: string, ...causalFloors: readonly (string | null)[]): string {
    const rawMs = new Date(rawAt).valueOf();
    const monotonicMs = this.channelMonotonicNow();
    if (!Number.isFinite(monotonicMs)) {
      throw new TypeError('Channel delivery monotonic clock이 유한하지 않다');
    }
    const elapsedMs = Math.max(0, monotonicMs - this.channelClockMonotonicMs);
    let logicalMs = rawMs;
    if (this.channelClockLogicalMs !== null) {
      // These are alternative lower bounds, not additive samples: wall time can advance normally,
      // freeze, roll back, or crawl more slowly than the monotonic clock. Taking the maximum of the
      // new wall sample and the prior logical floor plus elapsed monotonic time neither double
      // counts a normal wall advance nor permits retry/lease pacing to lag behind real elapsed time.
      logicalMs = Math.max(rawMs, this.channelClockLogicalMs + elapsedMs);
    }
    for (const floor of causalFloors) {
      if (floor !== null) logicalMs = Math.max(logicalMs, new Date(floor).valueOf());
    }
    this.channelClockMonotonicMs = monotonicMs;
    this.channelClockLogicalMs = logicalMs;
    return new Date(logicalMs).toISOString();
  }

  private channelDeliveryLogicalAt(rawAt: string, delivery: GateChannelDelivery): string {
    return this.channelLogicalAt(
      rawAt,
      delivery.createdAt,
      delivery.updatedAt,
      delivery.lastAttemptAt,
      delivery.receiptedAt,
      delivery.consumedAt,
    );
  }

  findGateChannelDelivery(gateKey: GateKey): GateChannelDelivery | null {
    const row = this.db.prepare(SELECT_GATE_CHANNEL_DELIVERY).get(gateKey) as
      | GateChannelDeliveryRow
      | undefined;
    return row === undefined ? null : toGateChannelDelivery(row);
  }

  listDueGateChannelDeliveries(at: string, limit = 64): readonly GateChannelDelivery[] {
    const dueAt = storedIso(at, 'Gate Channel delivery due.at');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('Gate Channel delivery due limit이 1..1000이 아니다');
    }
    const persistedFloor = this.db.prepare(SELECT_GATE_CHANNEL_CLOCK_FLOOR).get() as
      | { readonly updated_at: string | null }
      | undefined;
    const logicalDueAt = this.channelLogicalAt(
      dueAt,
      persistedFloor?.updated_at ?? null,
    );
    return (this.db.prepare(SELECT_DUE_GATE_CHANNEL_DELIVERIES).all(
      logicalDueAt,
      limit,
    ) as GateChannelDeliveryRow[]).map(toGateChannelDelivery);
  }

  acquireGateChannelDeliveryLease(
    gateKey: GateKey,
    owner: string,
    at: string,
    expiresAt: string,
  ): GateChannelDeliveryLeaseResult {
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.Channel delivery lease owner`);
    const acquiredAt = storedIso(at, `${gateKey}.Channel delivery lease at`);
    const expiry = storedIso(expiresAt, `${gateKey}.Channel delivery lease expiresAt`);
    if (expiry <= acquiredAt) throw new TypeError(`${gateKey}의 Channel lease expiry가 미래가 아니다`);
    const leaseDurationMs = new Date(expiry).valueOf() - new Date(acquiredAt).valueOf();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateChannelDelivery(gateKey);
      const effectiveAt = current === null
        ? this.channelLogicalAt(acquiredAt)
        : this.channelDeliveryLogicalAt(acquiredAt, current);
      const effectiveExpiry = new Date(
        new Date(effectiveAt).valueOf() + leaseDurationMs,
      ).toISOString();
      if (
        current === null ||
        current.state === 'consumed' ||
        current.nextAttemptAt === null ||
        current.nextAttemptAt > effectiveAt
      ) {
        this.db.exec('COMMIT');
        return { kind: 'unavailable' };
      }
      if (
        current.leaseOwner !== null &&
        current.leaseExpiresAt !== null &&
        current.leaseExpiresAt > effectiveAt
      ) {
        this.db.exec('COMMIT');
        return { kind: 'busy', expiresAt: current.leaseExpiresAt };
      }
      const result = this.db.prepare(
        `UPDATE gate_channel_delivery
            SET revision = revision + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE gate_key = ? AND revision = ? AND state <> 'consumed'`,
      ).run(safeOwner, effectiveExpiry, effectiveAt, gateKey, current.revision);
      if (Number(result.changes) !== 1) {
        this.db.exec('COMMIT');
        return { kind: 'unavailable' };
      }
      const leased = this.findGateChannelDelivery(gateKey);
      if (leased === null) throw new Error(`${gateKey}의 acquired Channel lease를 다시 읽지 못했다`);
      this.db.exec('COMMIT');
      return { kind: 'acquired', delivery: leased };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  releaseGateChannelDeliveryLease(gateKey: GateKey, owner: string, at: string): boolean {
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.Channel delivery release owner`);
    const releasedAt = storedIso(at, `${gateKey}.Channel delivery release at`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateChannelDelivery(gateKey);
      if (
        current === null ||
        current.leaseOwner !== safeOwner ||
        current.state === 'consumed'
      ) {
        this.db.exec('COMMIT');
        return false;
      }
      const effectiveAt = this.channelDeliveryLogicalAt(releasedAt, current);
      const result = this.db.prepare(
        `UPDATE gate_channel_delivery
            SET revision = revision + 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE gate_key = ? AND revision = ? AND lease_owner = ? AND state <> 'consumed'`,
      ).run(effectiveAt, gateKey, current.revision, safeOwner);
      this.db.exec('COMMIT');
      return Number(result.changes) === 1;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deferGateChannelDelivery(
    gateKey: GateKey,
    expectedRevision: number,
    owner: string,
    at: string,
    nextAttemptAt: string,
    errorCode: string | null,
  ): GateChannelDelivery | null {
    storedRevision(expectedRevision, `${gateKey}.Channel defer expected revision`);
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.Channel defer owner`);
    const deferredAt = storedIso(at, `${gateKey}.Channel defer at`);
    const next = storedIso(nextAttemptAt, `${gateKey}.Channel defer nextAttemptAt`);
    if (next < deferredAt) throw new TypeError(`${gateKey}의 Channel defer 시각이 역행했다`);
    const safeError = errorCode === null ? null : gateCode(errorCode, 80);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateChannelDelivery(gateKey);
      if (
        current === null ||
        current.revision !== expectedRevision ||
        current.leaseOwner !== safeOwner ||
        current.leaseExpiresAt === null ||
        current.state === 'consumed'
      ) {
        this.db.exec('COMMIT');
        return null;
      }
      const effectiveAt = this.channelDeliveryLogicalAt(deferredAt, current);
      if (current.leaseExpiresAt <= effectiveAt) {
        this.db.exec('COMMIT');
        return null;
      }
      const delayMs = new Date(next).valueOf() - new Date(deferredAt).valueOf();
      const effectiveNext = new Date(new Date(effectiveAt).valueOf() + delayMs).toISOString();
      const result = this.db.prepare(
        `UPDATE gate_channel_delivery
            SET revision = revision + 1, next_attempt_at = ?, lease_owner = NULL,
                lease_expires_at = NULL, last_error_code = ?, updated_at = ?
          WHERE gate_key = ? AND revision = ? AND lease_owner = ?
            AND lease_expires_at > ? AND state <> 'consumed'`,
      ).run(
        effectiveNext,
        safeError,
        effectiveAt,
        gateKey,
        expectedRevision,
        safeOwner,
        effectiveAt,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec('COMMIT');
        return null;
      }
      const deferred = this.findGateChannelDelivery(gateKey);
      this.db.exec('COMMIT');
      return deferred;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markGateChannelAttempted(
    gateKey: GateKey,
    at: string,
    nextAttemptAt: string,
    commitFence?: GateChannelDeliveryCommitFence,
  ): GateChannelDelivery | null {
    const attemptedAt = storedIso(at, `${gateKey}.Channel attempted at`);
    const next = storedIso(nextAttemptAt, `${gateKey}.Channel attempted nextAttemptAt`);
    if (next < attemptedAt) throw new TypeError(`${gateKey}의 Channel attempted retry가 역행했다`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateChannelDelivery(gateKey);
      if (current === null) {
        this.db.exec('COMMIT');
        return null;
      }
      if (current.state === 'receipted' || current.state === 'consumed') {
        this.db.exec('COMMIT');
        return current;
      }
      if (current.resumeBaselineState === 'required') {
        throw new TypeError(`${gateKey}의 Channel attempted 전에 resume baseline이 없다`);
      }
      if (current.attemptCount >= 1_000_000) {
        throw new TypeError(`${gateKey}의 Channel attempted evidence가 현재 row와 어긋난다`);
      }
      const effectiveAt = this.channelDeliveryLogicalAt(attemptedAt, current);
      const delayMs = new Date(next).valueOf() - new Date(attemptedAt).valueOf();
      const effectiveNext = new Date(new Date(effectiveAt).valueOf() + delayMs).toISOString();
      const firstTransition = current.state === 'pending';
      const deferredOutboxRevision = firstTransition
        ? rearmGateOutboxForChannelTransition(this.db, gateKey, effectiveAt)
        : current.deferredOutboxRevision;
      const result = this.db.prepare(
        `UPDATE gate_channel_delivery
            SET revision = revision + 1, state = 'attempted', attempt_count = attempt_count + 1,
                last_attempt_at = ?, next_attempt_at = ?, lease_owner = NULL,
                lease_expires_at = NULL, last_error_code = NULL,
                deferred_outbox_revision = ?, updated_at = ?
          WHERE gate_key = ? AND revision = ? AND state IN ('pending','attempted')`,
      ).run(
        effectiveAt,
        effectiveNext,
        deferredOutboxRevision,
        effectiveAt,
        gateKey,
        current.revision,
      );
      if (Number(result.changes) !== 1) {
        // The outbox was re-armed earlier in this transaction. A lost delivery CAS must unwind
        // both writes so it cannot manufacture an uncorrelated pending card generation.
        this.db.exec('ROLLBACK');
        return this.findGateChannelDelivery(gateKey);
      }
      const updated = this.findGateChannelDelivery(gateKey);
      if (commitFence !== undefined && !commitFence()) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.exec('COMMIT');
      return updated;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  markGateChannelReceipted(
    gateKey: GateKey,
    at: string,
    commitFence?: GateChannelDeliveryCommitFence,
  ): GateChannelDelivery | null {
    const receiptedAt = storedIso(at, `${gateKey}.Channel receipted at`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateChannelDelivery(gateKey);
      if (current === null) {
        this.db.exec('COMMIT');
        return null;
      }
      if (current.state === 'receipted' || current.state === 'consumed') {
        this.db.exec('COMMIT');
        return current;
      }
      if (current.resumeBaselineState === 'required') {
        throw new TypeError(`${gateKey}의 Channel receipt 전에 resume baseline이 없다`);
      }
      const effectiveAt = this.channelDeliveryLogicalAt(receiptedAt, current);
      const deferredOutboxRevision = rearmGateOutboxForChannelTransition(
        this.db,
        gateKey,
        effectiveAt,
      );
      const result = this.db.prepare(
        `UPDATE gate_channel_delivery
            SET revision = revision + 1, state = 'receipted',
                attempt_count = CASE WHEN attempt_count = 0 THEN 1 ELSE attempt_count END,
                last_attempt_at = COALESCE(last_attempt_at, ?), next_attempt_at = ?,
                receipted_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                last_error_code = NULL, deferred_outbox_revision = ?, updated_at = ?
          WHERE gate_key = ? AND revision = ? AND state IN ('pending','attempted')`,
      ).run(
        effectiveAt,
        effectiveAt,
        effectiveAt,
        deferredOutboxRevision,
        effectiveAt,
        gateKey,
        current.revision,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return this.findGateChannelDelivery(gateKey);
      }
      if (current.resumeBaselineState === 'recorded') {
        const scheduled = this.db.prepare(
          `UPDATE gate_resume_observation
              SET revision = revision + 1,
                  next_observation_at = CASE
                    WHEN next_observation_at IS NULL OR next_observation_at > ? THEN ?
                    ELSE next_observation_at
                  END,
                  last_error_code = NULL, updated_at = ?
            WHERE gate_key = ? AND evidence_kind IS NULL`,
        ).run(effectiveAt, effectiveAt, effectiveAt, gateKey);
        if (Number(scheduled.changes) !== 1) {
          throw new Error(`${gateKey}의 recorded baseline resume observation을 예약하지 못했다`);
        }
      }
      const updated = this.findGateChannelDelivery(gateKey);
      if (commitFence !== undefined && !commitFence()) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.exec('COMMIT');
      return updated;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  consumeGateChannelDelivery(
    gateKey: GateKey,
    expectedRevision: number,
    owner: string,
    freshGate: GateSnapshot,
    at: string,
  ): GateChannelConsumeResult {
    storedRevision(expectedRevision, `${gateKey}.Channel consume expected revision`);
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.Channel consume owner`);
    const consumedAt = storedIso(at, `${gateKey}.Channel consume at`);
    const fresh = toGateSnapshot(freshGate, `${gateKey}.fresh Gate effect`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateChannelDelivery(gateKey);
      if (current === null) {
        this.db.exec('COMMIT');
        return { kind: 'superseded' };
      }
      if (current.state === 'consumed') {
        this.db.exec('COMMIT');
        return { kind: 'duplicate', delivery: current };
      }
      const effectiveAt = this.channelDeliveryLogicalAt(consumedAt, current);
      if (
        current.state !== 'receipted' ||
        current.revision !== expectedRevision ||
        current.leaseOwner !== safeOwner ||
        current.leaseExpiresAt === null ||
        current.leaseExpiresAt <= effectiveAt ||
        current.receiptedAt === null ||
        effectiveAt < current.updatedAt
      ) {
        this.db.exec('COMMIT');
        return { kind: 'superseded' };
      }
      const intentRow = this.db.prepare(SELECT_GATE_RESOLUTION).get(gateKey) as
        | GateResolutionRow
        | undefined;
      const metadataRow = this.db.prepare(SELECT_GATE_METADATA).get(gateKey) as
        | GateMetadataRow
        | undefined;
      if (intentRow === undefined || metadataRow === undefined) {
        throw new Error(`${gateKey}의 consumed D2 correlation row가 없다`);
      }
      const intent = toGateResolution(intentRow);
      const metadata = toGateMetadata(metadataRow);
      const pre = intent.preRead;
      const post = intent.postRead;
      const matches =
        intent.ackState === 'acked' &&
        intent.lifecycle === 'resolved' &&
        pre?.status === 'pending' &&
        pre.resolution === null &&
        pre.resolvedAt === null &&
        post?.status === 'resolved' &&
        post.resolution === intent.optionResolution &&
        intent.resolveResult?.gate.resolvedAt === post.resolvedAt &&
        current.runKey === metadata.runKey &&
        current.taskKey === metadata.taskKey &&
        current.sourceDispatchId === intent.dispatchId &&
        fresh.gateId === post.gateId &&
        fresh.runId === post.runId &&
        fresh.taskId === post.taskId &&
        fresh.options.length === post.options.length &&
        fresh.options.every((option, index) => option === post.options[index]) &&
        fresh.status === 'resolved' &&
        fresh.resolution === post.resolution &&
        fresh.resolvedAt === post.resolvedAt;
      if (!matches) {
        this.db.exec('COMMIT');
        return { kind: 'mismatch' };
      }
      const deferredOutboxRevision = rearmGateOutboxForChannelTransition(
        this.db,
        gateKey,
        effectiveAt,
      );
      const result = this.db.prepare(
        `UPDATE gate_channel_delivery
            SET revision = revision + 1, state = 'consumed', next_attempt_at = NULL,
                consumed_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                last_error_code = NULL, deferred_outbox_revision = ?, updated_at = ?
          WHERE gate_key = ? AND revision = ? AND state = 'receipted'
            AND lease_owner = ? AND lease_expires_at > ?`,
      ).run(
        effectiveAt,
        deferredOutboxRevision,
        effectiveAt,
        gateKey,
        expectedRevision,
        safeOwner,
        effectiveAt,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return { kind: 'superseded' };
      }
      const consumed = this.findGateChannelDelivery(gateKey);
      if (consumed === null) throw new Error(`${gateKey}의 consumed Channel row를 다시 읽지 못했다`);
      this.db.exec('COMMIT');
      return { kind: 'consumed', delivery: consumed };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  recordGateResumeBaseline(
    gateKey: GateKey,
    expectedDeliveryRevision: number,
    owner: string,
    baselineValue: GateResumeSnapshot,
    at: string,
  ): GateChannelDelivery | null {
    storedRevision(expectedDeliveryRevision, `${gateKey}.resume baseline delivery revision`);
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.resume baseline owner`);
    const recordedAt = storedIso(at, `${gateKey}.resume baseline at`);
    const baseline = normalizeGateResumeSnapshot(baselineValue, `${gateKey}.resume baseline`);
    const baselineJson = JSON.stringify(baseline);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const delivery = this.findGateChannelDelivery(gateKey);
      if (
        delivery === null || delivery.revision !== expectedDeliveryRevision ||
        delivery.leaseOwner !== safeOwner || delivery.leaseExpiresAt === null ||
        delivery.resumeBaselineState !== 'required' || delivery.state !== 'pending' ||
        delivery.attemptCount !== 0 || baseline.sourceTaskId !== delivery.taskKey.slice('task:'.length) ||
        baseline.sourceDispatchId !== delivery.sourceDispatchId
      ) {
        this.db.exec('COMMIT');
        return null;
      }
      const effectiveAt = this.channelDeliveryLogicalAt(recordedAt, delivery);
      if (delivery.leaseExpiresAt <= effectiveAt) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(
        `INSERT INTO gate_resume_observation
          (gate_key, revision, baseline_json, latest_json,
           evidence_kind, evidence_task_id, evidence_dispatch_id,
           evidence_from_status, evidence_to_status,
           next_observation_at, observed_at, lease_owner, lease_expires_at,
           last_error_code, created_at, updated_at)
         VALUES (?, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(gateKey, baselineJson, effectiveAt, effectiveAt);
      const updated = this.db.prepare(
        `UPDATE gate_channel_delivery
            SET revision = revision + 1, resume_baseline_state = 'recorded', updated_at = ?
          WHERE gate_key = ? AND revision = ? AND lease_owner = ?
            AND lease_expires_at > ? AND resume_baseline_state = 'required'
            AND state = 'pending' AND attempt_count = 0`,
      ).run(effectiveAt, gateKey, expectedDeliveryRevision, safeOwner, effectiveAt);
      if (Number(updated.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const current = this.findGateChannelDelivery(gateKey);
      if (current === null) throw new Error(`${gateKey}의 recorded baseline delivery를 다시 읽지 못했다`);
      this.db.exec('COMMIT');
      return current;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  findGateResumeObservation(gateKey: GateKey): GateResumeObservation | null {
    const row = this.db.prepare(SELECT_GATE_RESUME_OBSERVATION).get(gateKey) as
      | GateResumeObservationRow
      | undefined;
    return row === undefined ? null : toGateResumeObservation(row);
  }

  listDueGateResumeObservations(at: string, limit = 64): readonly GateResumeObservation[] {
    const dueAt = storedIso(at, 'Gate resume observation due.at');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('Gate resume observation due limit이 1..1000이 아니다');
    }
    const effectiveAt = this.channelLogicalAt(dueAt);
    return (this.db.prepare(SELECT_DUE_GATE_RESUME_OBSERVATIONS).all(
      effectiveAt,
      limit,
    ) as GateResumeObservationRow[]).map(toGateResumeObservation);
  }

  acquireGateResumeLease(
    gateKey: GateKey,
    expectedRevision: number,
    owner: string,
    at: string,
    expiresAt: string,
  ): GateResumeLeaseResult {
    storedRevision(expectedRevision, `${gateKey}.resume lease expected revision`);
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.resume lease owner`);
    const acquiredAt = storedIso(at, `${gateKey}.resume lease at`);
    const expiry = storedIso(expiresAt, `${gateKey}.resume lease expiresAt`);
    if (expiry <= acquiredAt) throw new TypeError(`${gateKey}의 resume lease expiry가 미래가 아니다`);
    const duration = new Date(expiry).valueOf() - new Date(acquiredAt).valueOf();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateResumeObservation(gateKey);
      const delivery = this.findGateChannelDelivery(gateKey);
      const effectiveAt = this.channelLogicalAt(
        acquiredAt,
        current?.updatedAt ?? null,
        delivery?.updatedAt ?? null,
      );
      if (
        current === null || delivery === null || current.revision !== expectedRevision ||
        current.evidence !== null || current.nextObservationAt === null ||
        current.nextObservationAt > effectiveAt || delivery.resumeBaselineState !== 'recorded' ||
        (delivery.state !== 'receipted' && delivery.state !== 'consumed')
      ) {
        this.db.exec('COMMIT');
        return { kind: 'unavailable' };
      }
      if (
        current.leaseOwner !== null && current.leaseExpiresAt !== null &&
        current.leaseExpiresAt > effectiveAt
      ) {
        this.db.exec('COMMIT');
        return { kind: 'busy', expiresAt: current.leaseExpiresAt };
      }
      const effectiveExpiry = new Date(new Date(effectiveAt).valueOf() + duration).toISOString();
      const result = this.db.prepare(
        `UPDATE gate_resume_observation
            SET revision = revision + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE gate_key = ? AND revision = ? AND evidence_kind IS NULL
            AND next_observation_at IS NOT NULL AND next_observation_at <= ?`,
      ).run(safeOwner, effectiveExpiry, effectiveAt, gateKey, expectedRevision, effectiveAt);
      if (Number(result.changes) !== 1) {
        this.db.exec('COMMIT');
        return { kind: 'unavailable' };
      }
      const observation = this.findGateResumeObservation(gateKey);
      if (observation === null) throw new Error(`${gateKey}의 acquired resume lease를 다시 읽지 못했다`);
      this.db.exec('COMMIT');
      return { kind: 'acquired', observation };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordGateResumeObservation(
    gateKey: GateKey,
    expectedRevision: number,
    owner: string,
    latestValue: GateResumeSnapshot | null,
    evidenceValue: GateResumeEvidence | null,
    at: string,
    nextObservationAt: string,
    errorCode: string | null,
  ): GateResumeObservation | null {
    storedRevision(expectedRevision, `${gateKey}.resume observation expected revision`);
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.resume observation owner`);
    const observedAt = storedIso(at, `${gateKey}.resume observation at`);
    const nextAt = storedIso(nextObservationAt, `${gateKey}.resume observation next at`);
    if (nextAt < observedAt) throw new TypeError(`${gateKey}의 resume observation retry가 역행했다`);
    const safeError = errorCode === null ? null : gateCode(errorCode, 80);
    const latest = latestValue === null
      ? null
      : normalizeGateResumeSnapshot(latestValue, `${gateKey}.resume latest`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateResumeObservation(gateKey);
      const delivery = this.findGateChannelDelivery(gateKey);
      if (
        current === null || delivery === null || current.revision !== expectedRevision ||
        current.leaseOwner !== safeOwner || current.leaseExpiresAt === null ||
        current.evidence !== null || delivery.resumeBaselineState !== 'recorded' ||
        (delivery.state !== 'receipted' && delivery.state !== 'consumed')
      ) {
        this.db.exec('COMMIT');
        return null;
      }
      if (
        latest !== null &&
        (latest.sourceTaskId !== current.baseline.sourceTaskId ||
          latest.sourceDispatchId !== current.baseline.sourceDispatchId)
      ) {
        throw new TypeError(`${gateKey}의 resume latest source correlation이 어긋난다`);
      }
      const effectiveAt = this.channelLogicalAt(observedAt, current.updatedAt, delivery.updatedAt);
      if (current.leaseExpiresAt <= effectiveAt) {
        this.db.exec('COMMIT');
        return null;
      }
      const detected = latest === null ? null : detectGateResumeEvidence(current.baseline, latest);
      let evidence: GateResumeEvidence | null = null;
      if (evidenceValue !== null) {
        if (detected === null || JSON.stringify(detected) !== JSON.stringify(evidenceValue)) {
          throw new TypeError(`${gateKey}의 resume evidence가 normalized reread와 어긋난다`);
        }
        evidence = detected;
      }
      const delay = new Date(nextAt).valueOf() - new Date(observedAt).valueOf();
      const effectiveNext = new Date(new Date(effectiveAt).valueOf() + delay).toISOString();
      let deferredOutboxRevision: number | null = null;
      if (evidence !== null) {
        deferredOutboxRevision = rearmGateOutboxForChannelTransition(this.db, gateKey, effectiveAt);
        const deliveryUpdate = this.db.prepare(
          `UPDATE gate_channel_delivery
              SET revision = revision + 1, deferred_outbox_revision = ?,
                  lease_owner = CASE
                    WHEN lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN NULL
                    ELSE lease_owner
                  END,
                  lease_expires_at = CASE
                    WHEN lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN NULL
                    ELSE lease_expires_at
                  END,
                  updated_at = ?
            WHERE gate_key = ? AND revision = ? AND resume_baseline_state = 'recorded'
              AND state IN ('receipted','consumed')`,
        ).run(
          deferredOutboxRevision,
          effectiveAt,
          effectiveAt,
          effectiveAt,
          gateKey,
          delivery.revision,
        );
        if (Number(deliveryUpdate.changes) !== 1) {
          this.db.exec('ROLLBACK');
          return null;
        }
      }
      const result = this.db.prepare(
        `UPDATE gate_resume_observation
            SET revision = revision + 1, latest_json = COALESCE(?, latest_json),
                evidence_kind = ?, evidence_task_id = ?, evidence_dispatch_id = ?,
                evidence_from_status = ?, evidence_to_status = ?,
                next_observation_at = ?, observed_at = ?,
                lease_owner = NULL, lease_expires_at = NULL,
                last_error_code = ?, updated_at = ?
          WHERE gate_key = ? AND revision = ? AND lease_owner = ?
            AND lease_expires_at > ? AND evidence_kind IS NULL`,
      ).run(
        latest === null ? null : JSON.stringify(latest),
        evidence?.kind ?? null,
        evidence?.taskId ?? null,
        evidence?.dispatchId ?? null,
        evidence?.fromStatus ?? null,
        evidence?.toStatus ?? null,
        evidence === null ? effectiveNext : null,
        latest === null ? current.observedAt : effectiveAt,
        safeError,
        effectiveAt,
        gateKey,
        expectedRevision,
        safeOwner,
        effectiveAt,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const updated = this.findGateResumeObservation(gateKey);
      if (updated === null) throw new Error(`${gateKey}의 resume observation을 다시 읽지 못했다`);
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  releaseGateResumeLease(gateKey: GateKey, owner: string, at: string): boolean {
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.resume release owner`);
    const releasedAt = storedIso(at, `${gateKey}.resume release at`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findGateResumeObservation(gateKey);
      if (current === null || current.leaseOwner !== safeOwner || current.evidence !== null) {
        this.db.exec('COMMIT');
        return false;
      }
      const effectiveAt = this.channelLogicalAt(releasedAt, current.updatedAt);
      const result = this.db.prepare(
        `UPDATE gate_resume_observation
            SET revision = revision + 1, lease_owner = NULL, lease_expires_at = NULL,
                updated_at = ?
          WHERE gate_key = ? AND revision = ? AND lease_owner = ? AND evidence_kind IS NULL`,
      ).run(effectiveAt, gateKey, current.revision, safeOwner);
      this.db.exec('COMMIT');
      return Number(result.changes) === 1;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  beginGateObservationWrite(
    gateKey: GateKey,
    at: string,
    expectedObservation: GateLocalObservation,
    expectedRevision: number,
    expectedMessageIdentity?: {
      readonly channelId: string;
      readonly threadTs: string | null;
    },
  ): boolean {
    storedIso(at, `${gateKey}.ordinary Gate write fence at`);
    storedRevision(expectedRevision, `${gateKey}.ordinary Gate expected revision`);
    if (
      expectedObservation.gateKey !== gateKey ||
      expectedObservation.mappingState !== 'matched' ||
      expectedObservation.metadataState !== 'matched'
    ) {
      return false;
    }
    const expiresAt = observationWriteExpiry(at);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const intent = this.db.prepare(SELECT_GATE_RESOLUTION).get(gateKey) as
        | GateResolutionRow
        | undefined;
      if (intent !== undefined) {
        this.db.exec('COMMIT');
        return false;
      }
      const observation = this.db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(gateKey) as
        | GateLocalObservationRow
        | undefined;
      if (observation === undefined) {
        this.db.exec('COMMIT');
        return false;
      }
      const generation = this.db.prepare(SELECT_GATE_OBSERVATION_GENERATION).get(gateKey) as
        | GateObservationGenerationRow
        | undefined;
      if (generation === undefined || generation.revision !== expectedRevision) {
        this.db.exec('COMMIT');
        return false;
      }
      const metadata = this.db.prepare(SELECT_GATE_METADATA).get(gateKey) as
        | GateMetadataRow
        | undefined;
      const metadataState = reconcileObservationMetadataState(expectedObservation, metadata);
      if (metadataState !== 'matched') {
        this.db.exec('COMMIT');
        return false;
      }
      const messageRow = this.db.prepare(SELECT_GATE_MESSAGE).get(gateKey) as
        | GateMessageRow
        | undefined;
      const messageIdentityMatched =
        expectedMessageIdentity !== undefined &&
        expectedMessageIdentity.threadTs !== null &&
        messageRow !== undefined &&
        messageRow.run_key === expectedObservation.runKey &&
        messageRow.channel_id === expectedMessageIdentity.channelId &&
        messageRow.thread_ts === expectedMessageIdentity.threadTs;
      if (
        expectedMessageIdentity !== undefined &&
        !messageIdentityMatched
      ) {
        this.db.exec('COMMIT');
        return false;
      }
      if (
        (observation.mapping_state === 'missing' || observation.mapping_state === 'mismatched') &&
        !messageIdentityMatched
      ) {
        // A fail-closed mapping is repairable only when this exact transaction revalidates the
        // publisher's canonical channel/thread identity. It must never become matched in a prior
        // save transaction where another daemon could claim the still-dirty remote card.
        this.db.exec('COMMIT');
        return false;
      }
      // The transaction holds SQLite's writer slot from this exact comparison through the owner
      // write. A publisher collected before a newer observation therefore cannot start Slack from
      // its stale snapshot, even when saveGateLocalObservation latched newer terminal facts.
      if (!observationWriteStillCurrent(
        observation,
        expectedObservation,
        metadataState,
        true,
      )) {
        this.db.exec('COMMIT');
        return false;
      }
      const exactSnapshot = `
        run_key = ? AND task_key = ? AND status = ? AND resolution IS ? AND resolved_at IS ?
        AND metadata_state = ? AND observed_at = ?`;
      const exactValues = [
        expectedObservation.runKey,
        expectedObservation.taskKey,
        expectedObservation.status,
        expectedObservation.resolution,
        expectedObservation.resolvedAt,
        metadataState,
        expectedObservation.observedAt,
      ] as const;
      if (observation.mapping_state === 'write_pending') {
        const previousOwner = observation.write_owner;
        if (
          previousOwner === this.observationWriteOwner &&
          !this.activeObservationWrites.has(gateKey)
        ) {
          const renewed = this.db.prepare(
            `UPDATE gate_local_observation
                SET write_expires_at = ?
              WHERE gate_key = ? AND write_owner = ?
                AND mapping_state = 'write_pending' AND ${exactSnapshot}`,
          ).run(expiresAt, gateKey, previousOwner, ...exactValues);
          if (Number(renewed.changes) !== 1) {
            this.db.exec('COMMIT');
            return false;
          }
          this.activeObservationWrites.set(gateKey, expectedRevision);
          this.db.exec('COMMIT');
          return true;
        }
        const previousExpiry = observation.write_expires_at;
        if (
          previousOwner === null ||
          previousExpiry === null ||
          this.activeObservationWrites.has(gateKey) ||
          (previousExpiry > at && this.isObservationOwnerAlive(previousOwner))
        ) {
          this.db.exec('COMMIT');
          return false;
        }
        const recovered = this.db.prepare(
          `UPDATE gate_local_observation
              SET write_owner = ?, write_expires_at = ?
            WHERE gate_key = ? AND write_owner = ?
              AND mapping_state = 'write_pending' AND ${exactSnapshot}`,
        ).run(this.observationWriteOwner, expiresAt, gateKey, previousOwner, ...exactValues);
        if (Number(recovered.changes) !== 1) {
          this.db.exec('COMMIT');
          return false;
        }
        this.activeObservationWrites.set(gateKey, expectedRevision);
        this.db.exec('COMMIT');
        return true;
      }
      const result = this.db.prepare(
        `UPDATE gate_local_observation
            SET mapping_state = 'write_pending', write_owner = ?, write_expires_at = ?
          WHERE gate_key = ? AND mapping_state = ? AND write_owner IS NULL
            AND ${exactSnapshot}`,
      ).run(
        this.observationWriteOwner,
        expiresAt,
        gateKey,
        observation.mapping_state,
        ...exactValues,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec('COMMIT');
        return false;
      }
      this.activeObservationWrites.set(gateKey, expectedRevision);
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  abandonGateObservationWrite(gateKey: GateKey): void {
    this.activeObservationWrites.delete(gateKey);
  }

  acquireGateOutboxProjection(
    gateKey: GateKey,
    expectedRevision: number,
    owner: string,
    at: string,
    channelClaim?: GateChannelProjectionClaim,
  ): GateProjectionLeaseResult {
    storedRevision(expectedRevision, `${gateKey}.projection expected revision`);
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.projection owner`);
    storedIso(at, `${gateKey}.projection acquire at`);
    const expiresAt = observationWriteExpiry(at);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(SELECT_GATE_OUTBOX).get(gateKey) as GateOutboxRow | undefined;
      if (row === undefined || row.revision !== expectedRevision) {
        this.db.exec('COMMIT');
        return 'superseded';
      }
      // A completed generation is never leasable. The projector must first durably re-arm and
      // advance it, then re-read that pending row before any Slack call.
      if (row.card_pending !== 1) {
        this.db.exec('COMMIT');
        return 'superseded';
      }
      const deliveryRow = this.db.prepare(SELECT_GATE_CHANNEL_DELIVERY).get(gateKey) as
        | GateChannelDeliveryRow
        | undefined;
      const exactDeferred =
        deliveryRow !== undefined &&
        deliveryRow.deferred_outbox_revision === expectedRevision;
      if (exactDeferred) {
        const authorized =
          channelClaim !== undefined &&
          storedRevision(
            channelClaim.expectedDeliveryRevision,
            `${gateKey}.Channel projection claim delivery revision`,
          ) === deliveryRow.revision &&
          storedRevision(
            channelClaim.expectedOutboxRevision,
            `${gateKey}.Channel projection claim outbox revision`,
          ) === expectedRevision;
        if (!authorized) {
          this.db.exec('COMMIT');
          return 'deferred';
        }
      }
      // Keep the future D3 exact-card claim on the same rollback-safe causal clock as the
      // delivery generation that authorized it. Ordinary D2 projection retains its historical
      // wall-clock behavior; only an exact deferred Channel generation opts into this clock.
      const projectionAt = exactDeferred && deliveryRow !== undefined
        ? this.channelDeliveryLogicalAt(
            this.channelLogicalAt(at, row.updated_at),
            toGateChannelDelivery(deliveryRow),
          )
        : at;
      const projectionExpiresAt = exactDeferred
        ? observationWriteExpiry(projectionAt)
        : expiresAt;
      if (
        row.projection_owner === safeOwner &&
        row.projection_expires_at !== null &&
        row.projection_expires_at > projectionAt
      ) {
        const renewed = this.db.prepare(
          `UPDATE gate_resolution_outbox
              SET projection_expires_at = ?, updated_at = ?
            WHERE gate_key = ? AND revision = ? AND card_pending = 1
              AND projection_owner = ? AND projection_expires_at > ?`,
        ).run(
          projectionExpiresAt,
          projectionAt,
          gateKey,
          expectedRevision,
          safeOwner,
          projectionAt,
        );
        if (Number(renewed.changes) !== 1) {
          this.db.exec('COMMIT');
          return 'superseded';
        }
        LIVE_OBSERVATION_WRITE_OWNERS.add(safeOwner);
        this.ownedProjectionWrites.add(safeOwner);
        this.db.exec('COMMIT');
        return 'acquired';
      }
      if (row.projection_owner !== null) {
        if (row.projection_expires_at === null) {
          throw new Error(`${gateKey}의 projection owner expiry가 없다`);
        }
        if (
          row.projection_expires_at > projectionAt &&
          this.isObservationOwnerAlive(row.projection_owner)
        ) {
          this.db.exec('COMMIT');
          return 'busy';
        }
        // A crashed projector may have applied its stale card. Take ownership while advancing the
        // generation and forcing a fresh snapshot; the caller must loop before making Slack calls.
        if (exactDeferred && deliveryRow !== undefined) {
          const nextOutboxRevision = storedRevision(
            expectedRevision + 1,
            `${gateKey}.Channel projection recovery next outbox revision`,
          );
          const recoveredOutbox = this.db.prepare(
            `UPDATE gate_resolution_outbox
                SET revision = revision + 1, card_pending = 1, projected_at = NULL,
                    projection_owner = ?, projection_expires_at = ?, updated_at = ?
              WHERE gate_key = ? AND revision = ? AND projection_owner = ?`,
          ).run(
            safeOwner,
            projectionExpiresAt,
            projectionAt,
            gateKey,
            expectedRevision,
            row.projection_owner,
          );
          // Projection provenance has its own owner, but advancing the shared delivery revision
          // can cross an independently abandoned delivery lease. Preserve a still-live lease and
          // atomically clear one that is expired at this logical boundary, including equality, so
          // the v11 lease/updated_at invariant and stale delivery-owner fence remain exact.
          const recoveredDelivery = this.db.prepare(
            `UPDATE gate_channel_delivery
                SET revision = revision + 1, deferred_outbox_revision = ?,
                    lease_owner = CASE
                      WHEN lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN NULL
                      ELSE lease_owner
                    END,
                    lease_expires_at = CASE
                      WHEN lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN NULL
                      ELSE lease_expires_at
                    END,
                    updated_at = ?
              WHERE gate_key = ? AND revision = ? AND deferred_outbox_revision = ?`,
          ).run(
            nextOutboxRevision,
            projectionAt,
            projectionAt,
            projectionAt,
            gateKey,
            deliveryRow.revision,
            expectedRevision,
          );
          if (
            Number(recoveredOutbox.changes) !== 1 ||
            Number(recoveredDelivery.changes) !== 1
          ) {
            this.db.exec('ROLLBACK');
            return 'superseded';
          }
          LIVE_OBSERVATION_WRITE_OWNERS.add(safeOwner);
          this.ownedProjectionWrites.add(safeOwner);
          this.db.exec('COMMIT');
          return 'recovered';
        }
        const recovered = this.db.prepare(
          `UPDATE gate_resolution_outbox
              SET revision = revision + 1, card_pending = 1, projected_at = NULL,
                  projection_owner = ?, projection_expires_at = ?, updated_at = ?
            WHERE gate_key = ? AND revision = ? AND projection_owner = ?`,
        ).run(safeOwner, expiresAt, at, gateKey, expectedRevision, row.projection_owner);
        if (Number(recovered.changes) !== 1) {
          this.db.exec('COMMIT');
          return 'superseded';
        }
        LIVE_OBSERVATION_WRITE_OWNERS.add(safeOwner);
        this.ownedProjectionWrites.add(safeOwner);
        this.db.exec('COMMIT');
        return 'recovered';
      }
      const acquired = this.db.prepare(
        `UPDATE gate_resolution_outbox
            SET projection_owner = ?, projection_expires_at = ?, updated_at = ?
          WHERE gate_key = ? AND revision = ? AND projection_owner IS NULL`,
      ).run(
        safeOwner,
        projectionExpiresAt,
        projectionAt,
        gateKey,
        expectedRevision,
      );
      if (Number(acquired.changes) !== 1) {
        this.db.exec('COMMIT');
        return 'superseded';
      }
      LIVE_OBSERVATION_WRITE_OWNERS.add(safeOwner);
      this.ownedProjectionWrites.add(safeOwner);
      this.db.exec('COMMIT');
      return 'acquired';
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  rearmGateOutboxProjection(
    gateKey: GateKey,
    expectedRevision: number,
    at: string,
  ): boolean {
    storedRevision(expectedRevision, `${gateKey}.projection rearm expected revision`);
    storedIso(at, `${gateKey}.projection rearm at`);
    const result = this.db.prepare(
      `UPDATE gate_resolution_outbox
          SET revision = revision + 1, card_pending = 1, projected_at = NULL,
              projection_owner = NULL, projection_expires_at = NULL, updated_at = ?
        WHERE gate_key = ? AND revision = ? AND card_pending = 0
          AND projection_owner IS NULL AND projection_expires_at IS NULL`,
    ).run(at, gateKey, expectedRevision);
    return Number(result.changes) === 1;
  }

  markGateOutboxProjected(
    gateKey: GateKey,
    expectedRevision: number,
    renderFingerprint: string,
    owner: string,
    at: string,
    channelClaim?: GateChannelProjectionClaim,
  ): boolean {
    storedIso(at, `${gateKey}.outbox projected_at`);
    storedRevision(expectedRevision, `${gateKey}.outbox expected revision`);
    storedText(renderFingerprint, `${gateKey}.resolution render fingerprint`, 128);
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.projection completion owner`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const outboxRow = this.db.prepare(SELECT_GATE_OUTBOX).get(gateKey) as
        | GateOutboxRow
        | undefined;
      const deliveryRow = this.db.prepare(SELECT_GATE_CHANNEL_DELIVERY).get(gateKey) as
        | GateChannelDeliveryRow
        | undefined;
      const exactDeferred =
        outboxRow !== undefined &&
        deliveryRow !== undefined &&
        deliveryRow.deferred_outbox_revision === expectedRevision &&
        outboxRow.revision === expectedRevision;
      if (exactDeferred) {
        const authorized =
          channelClaim !== undefined &&
          storedRevision(
            channelClaim.expectedDeliveryRevision,
            `${gateKey}.Channel projection completion delivery revision`,
          ) === deliveryRow.revision &&
          storedRevision(
            channelClaim.expectedOutboxRevision,
            `${gateKey}.Channel projection completion outbox revision`,
          ) === expectedRevision &&
          outboxRow.projection_owner === safeOwner;
        if (!authorized) {
          this.db.exec('COMMIT');
          return false;
        }
      }
      const effectiveAt = exactDeferred && deliveryRow !== undefined && outboxRow !== undefined
        ? this.channelDeliveryLogicalAt(
            this.channelLogicalAt(at, outboxRow.updated_at),
            toGateChannelDelivery(deliveryRow),
          )
        : at;
      const result = this.db.prepare(MARK_GATE_OUTBOX_PROJECTED).run(
        effectiveAt,
        effectiveAt,
        gateKey,
        expectedRevision,
        safeOwner,
        effectiveAt,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec('COMMIT');
        return false;
      }
      const message = this.db.prepare(UPDATE_GATE_OBSERVATION).run(
        renderFingerprint,
        effectiveAt,
        gateKey,
      );
      if (Number(message.changes) !== 1) {
        throw new Error(`${gateKey}의 Gate message projection fingerprint를 갱신하지 못했다`);
      }
      this.db.exec('COMMIT');
      LIVE_OBSERVATION_WRITE_OWNERS.delete(safeOwner);
      this.ownedProjectionWrites.delete(safeOwner);
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  releaseGateOutboxProjection(
    gateKey: GateKey,
    owner: string,
    at: string,
    channelClaim?: GateChannelProjectionClaim,
  ): boolean {
    const safeOwner = storedLeaseOwner(owner, `${gateKey}.projection release owner`);
    storedIso(at, `${gateKey}.projection release at`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const outboxRow = this.db.prepare(SELECT_GATE_OUTBOX).get(gateKey) as
        | GateOutboxRow
        | undefined;
      const deliveryRow = this.db.prepare(SELECT_GATE_CHANNEL_DELIVERY).get(gateKey) as
        | GateChannelDeliveryRow
        | undefined;
      if (outboxRow === undefined || outboxRow.projection_owner !== safeOwner) {
        this.db.exec('COMMIT');
        return false;
      }
      const exactDeferred =
        deliveryRow !== undefined &&
        deliveryRow.deferred_outbox_revision === outboxRow.revision;
      if (exactDeferred && deliveryRow !== undefined) {
        const authorized =
          channelClaim !== undefined &&
          storedRevision(
            channelClaim.expectedDeliveryRevision,
            `${gateKey}.Channel projection release delivery revision`,
          ) === deliveryRow.revision &&
          storedRevision(
            channelClaim.expectedOutboxRevision,
            `${gateKey}.Channel projection release outbox revision`,
          ) === outboxRow.revision;
        if (!authorized) {
          this.db.exec('COMMIT');
          return false;
        }
        const delivery = toGateChannelDelivery(deliveryRow);
        const effectiveAt = this.channelDeliveryLogicalAt(
          this.channelLogicalAt(at, outboxRow.updated_at),
          delivery,
        );
        const nextOutboxRevision = storedRevision(
          outboxRow.revision + 1,
          `${gateKey}.Channel projection release next outbox revision`,
        );
        const releasedOutbox = this.db.prepare(
          `UPDATE gate_resolution_outbox
              SET revision = revision + 1, card_pending = 1, projected_at = NULL,
                  projection_owner = NULL, projection_expires_at = NULL, updated_at = ?
            WHERE gate_key = ? AND revision = ? AND projection_owner = ?`,
        ).run(effectiveAt, gateKey, outboxRow.revision, safeOwner);
        // The projection release is also a delivery-generation boundary. Do not carry an expired
        // independent delivery lease across its newer logical updated_at; clearing it in this same
        // dual CAS makes every late old-owner mutation/release a no-op.
        const releasedDelivery = this.db.prepare(
          `UPDATE gate_channel_delivery
              SET revision = revision + 1, deferred_outbox_revision = ?,
                  lease_owner = CASE
                    WHEN lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN NULL
                    ELSE lease_owner
                  END,
                  lease_expires_at = CASE
                    WHEN lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN NULL
                    ELSE lease_expires_at
                  END,
                  updated_at = ?
            WHERE gate_key = ? AND revision = ? AND deferred_outbox_revision = ?`,
        ).run(
          nextOutboxRevision,
          effectiveAt,
          effectiveAt,
          effectiveAt,
          gateKey,
          deliveryRow.revision,
          outboxRow.revision,
        );
        if (
          Number(releasedOutbox.changes) !== 1 ||
          Number(releasedDelivery.changes) !== 1
        ) {
          this.db.exec('ROLLBACK');
          return false;
        }
        this.db.exec('COMMIT');
        LIVE_OBSERVATION_WRITE_OWNERS.delete(safeOwner);
        this.ownedProjectionWrites.delete(safeOwner);
        return true;
      }
      const result = this.db.prepare(
        `UPDATE gate_resolution_outbox
            SET revision = revision + 1, card_pending = 1, projected_at = NULL,
                projection_owner = NULL, projection_expires_at = NULL, updated_at = ?
          WHERE gate_key = ? AND projection_owner = ?`,
      ).run(at, gateKey, safeOwner);
      this.db.exec('COMMIT');
      LIVE_OBSERVATION_WRITE_OWNERS.delete(safeOwner);
      this.ownedProjectionWrites.delete(safeOwner);
      return Number(result.changes) === 1;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordGateAudit(gateKey: GateKey | null, event: string, reason: string, at: string): void {
    storedIso(at, 'gate resolution audit.at');
    if (event === 'claimed' || reason === 'first_valid_selection') {
      throw new TypeError('canonical winner audit은 Gate claim transaction만 기록할 수 있다');
    }
    this.insertGateAudit(gateKey, event, reason, at);
  }

  recordGateAttempt(
    gateKey: GateKey,
    phase: string,
    outcome: string,
    detail: string | null,
    at: string,
  ): void {
    storedIso(at, `${gateKey}.attempt.at`);
    const safePhase = gateCode(phase, 40);
    const safeOutcome = gateCode(outcome, 40);
    this.db.prepare(INSERT_GATE_ATTEMPT_BOUNDED).run(
      gateKey,
      safePhase,
      safeOutcome,
      safeGateFact(detail, GATE_FACT_CAP),
      at,
      gateKey,
      GATE_AUDIT_LIMIT,
    );
  }

  private insertGateAudit(
    gateKey: GateKey | null,
    event: string,
    reason: string,
    at: string,
  ): boolean {
    const safeEvent = gateCode(event, 40);
    const safeReason = gateCode(reason, 80);
    const result = this.db.prepare(INSERT_GATE_AUDIT_BOUNDED).run(
      gateKey,
      safeEvent,
      safeReason,
      at,
      gateKey,
      gateKey,
      safeEvent,
      gateKey,
      GATE_AUDIT_LIMIT,
      GATE_AUDIT_LIMIT,
    );
    return Number(result.changes) === 1;
  }

  replaceDiscoverySnapshot(input: ReplaceDiscoverySnapshotInput): EffectiveDiscoverySnapshot {
    const at = operationalIso(input.at, true);
    if (input.passOutcome !== 'succeeded' && input.passOutcome !== 'failed') {
      operationalFail('OPERATIONAL_INPUT_INVALID');
    }
    if (input.routingMode !== undefined &&
        input.routingMode !== 'reconcile' && input.routingMode !== 'replace') {
      operationalFail('OPERATIONAL_INPUT_INVALID');
    }
    const replaceRouting = input.routingMode === 'replace';
    if (replaceRouting && input.passOutcome !== 'succeeded') {
      operationalFail('OPERATIONAL_INPUT_INVALID');
    }
    const canonicalKeys = new Set<string>();
    const githubIds = new Set<number>();
    const repositoryProjects = new Map<string, string>();
    const submittedAutoProjectOwners = new Map<string, number>();
    for (const repository of input.repositories) {
      const canonical = canonicalRepository(repository.canonicalKey, true);
      if (repository.nameWithOwner !== canonical.nameWithOwner || canonicalKeys.has(canonical.canonicalKey)) {
        operationalFail('OPERATIONAL_INPUT_INVALID');
      }
      canonicalKeys.add(canonical.canonicalKey);
      const projectKey = validateProjectKey(repository.projectKey, true);
      repositoryProjects.set(canonical.canonicalKey, projectKey);
      if (repository.projectOrigin !== 'explicit' && repository.projectOrigin !== 'auto') {
        operationalFail('OPERATIONAL_INPUT_INVALID');
      }
      if (repository.evidence !== 'verified' && repository.evidence !== 'carried_forward') {
        operationalFail('OPERATIONAL_INPUT_INVALID');
      }
      if (repository.githubRepositoryId !== null) {
        const id = operationalInteger(repository.githubRepositoryId, true, 1);
        if (githubIds.has(id)) operationalFail('OPERATIONAL_INPUT_INVALID');
        githubIds.add(id);
        if (repository.projectOrigin === 'auto') {
          const owner = submittedAutoProjectOwners.get(projectKey);
          if (owner !== undefined && owner !== id) operationalFail('OPERATIONAL_INPUT_INVALID');
          submittedAutoProjectOwners.set(projectKey, id);
        }
      } else if (repository.projectOrigin === 'auto' && repository.evidence === 'verified') {
        // Automatically discovered candidates are not strong evidence until GitHub confirms
        // the durable numeric identity.
        operationalFail('OPERATIONAL_INPUT_INVALID');
      }
    }
    const bindingIds = new Set<string>();
    for (const binding of input.bindings) {
      const orcaId = operationalInputText(binding.orcaRepositoryId, 500);
      if (bindingIds.has(orcaId)) operationalFail('OPERATIONAL_INPUT_INVALID');
      bindingIds.add(orcaId);
      if (binding.origin !== 'manual' && binding.origin !== 'discovered') {
        operationalFail('OPERATIONAL_INPUT_INVALID');
      }
      if (binding.evidence !== 'verified' && binding.evidence !== 'carried_forward') {
        operationalFail('OPERATIONAL_INPUT_INVALID');
      }
      const projectKey = validateProjectKey(binding.projectKey, true);
      if (binding.canonicalKey === null) {
        if (binding.origin !== 'manual') operationalFail('OPERATIONAL_INPUT_INVALID');
      } else {
        const canonical = canonicalRepository(binding.canonicalKey, true).canonicalKey;
        const submittedProject = repositoryProjects.get(canonical);
        if ((binding.evidence === 'verified' && submittedProject === undefined) ||
            (binding.evidence === 'verified' && submittedProject !== projectKey)) {
          operationalFail('OPERATIONAL_INPUT_INVALID');
        }
      }
    }
    const issueHashes = new Set<string>();
    for (const issue of input.issues) {
      if (!/^[0-9a-f]{64}$/.test(issue.issueHash) ||
          !OPERATIONAL_ISSUE_CATEGORIES.has(issue.category) || issueHashes.has(issue.issueHash)) {
        operationalFail('OPERATIONAL_INPUT_INVALID');
      }
      issueHashes.add(issue.issueHash);
    }

    let transactionOpen = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const discoveryFloor = this.db.prepare(`
        SELECT MAX(updated_at) AS updated_at FROM (
          SELECT updated_at FROM repository_registry
          UNION ALL SELECT updated_at FROM orca_repository_binding
          UNION ALL SELECT updated_at FROM repository_discovery_issue
        )`).get() as { readonly updated_at: string | null } | undefined;
      if (discoveryFloor?.updated_at !== null && discoveryFloor?.updated_at !== undefined &&
          operationalIso(discoveryFloor.updated_at) > at) {
        operationalFail('OPERATIONAL_STALE_TRANSITION');
      }

      // A config-fingerprint transition starts a new routing generation. Delete only the two
      // routing tables inside this transaction; issue history and every unrelated operational
      // table remain intact, and any later fault restores the complete prior generation.
      if (replaceRouting) {
        this.db.prepare('DELETE FROM orca_repository_binding').run();
        this.db.prepare('DELETE FROM repository_registry').run();
      }

      // Auto Project keys are durable numeric-identity claims. This query deliberately includes
      // inactive rows; compatible generations may retain them, but a different numeric owner may
      // never reuse their key. Incompatible generations were deleted immediately above.
      const findDifferentAutoProjectOwner = this.db.prepare(`
        SELECT 1 FROM repository_registry
         WHERE project_origin = 'auto' AND project_key = ?
           AND github_repository_id IS NOT NULL AND github_repository_id <> ?
         LIMIT 1`);
      for (const repository of input.repositories) {
        if (repository.projectOrigin !== 'auto' || repository.githubRepositoryId === null) continue;
        if (findDifferentAutoProjectOwner.get(
          repository.projectKey, repository.githubRepositoryId,
        ) !== undefined) {
          operationalFail('OPERATIONAL_CONFLICT');
        }
      }

      // GitHub's numeric repository identity survives owner/name changes. Rename the durable PK
      // before upsert; ON UPDATE CASCADE moves every exact Orca binding in this same transaction.
      // If the new canonical spelling already has a tentative null-ID row, merge it into the
      // numeric row first so the verified identity converges instead of deadlocking on two keys.
      const findByGithubId = this.db.prepare(`
        SELECT canonical_key, github_repository_id, project_key, first_seen_at
          FROM repository_registry WHERE github_repository_id = ?`);
      const findCanonical = this.db.prepare(`
        SELECT canonical_key, github_repository_id, project_key, first_seen_at
          FROM repository_registry WHERE canonical_key = ?`);
      const preserveEarliestEvidence = this.db.prepare(`
        UPDATE repository_registry
           SET first_seen_at = CASE WHEN first_seen_at <= ? THEN first_seen_at ELSE ? END
         WHERE canonical_key = ?`);
      const repointTentativeBindings = this.db.prepare(`
        UPDATE orca_repository_binding SET canonical_key = ? WHERE canonical_key = ?`);
      const deleteTentativeCanonical = this.db.prepare(`
        DELETE FROM repository_registry
         WHERE canonical_key = ? AND github_repository_id IS NULL`);
      const renameCanonical = this.db.prepare(`
        UPDATE repository_registry SET canonical_key = ?, updated_at = ?
         WHERE canonical_key = ? AND github_repository_id = ?`);
      for (const repository of input.repositories) {
        if (input.passOutcome !== 'succeeded' || repository.evidence !== 'verified' ||
            repository.githubRepositoryId === null) continue;
        const existing = findByGithubId.get(repository.githubRepositoryId) as
          | { readonly canonical_key: string; readonly github_repository_id: number;
              readonly project_key: string; readonly first_seen_at: string } | undefined;
        if (existing === undefined || existing.canonical_key === repository.canonicalKey) continue;
        if (canonicalKeys.has(existing.canonical_key)) {
          operationalFail('OPERATIONAL_CONFLICT');
        }
        const tentative = findCanonical.get(repository.canonicalKey) as
          | { readonly canonical_key: string; readonly github_repository_id: number | null;
              readonly project_key: string; readonly first_seen_at: string } | undefined;
        if (tentative !== undefined) {
          if (tentative.github_repository_id !== null ||
              tentative.project_key !== existing.project_key) {
            operationalFail('OPERATIONAL_CONFLICT');
          }
          preserveEarliestEvidence.run(
            tentative.first_seen_at, tentative.first_seen_at, existing.canonical_key,
          );
          repointTentativeBindings.run(existing.canonical_key, tentative.canonical_key);
          if (Number(deleteTentativeCanonical.run(tentative.canonical_key).changes) !== 1) {
            operationalFail('OPERATIONAL_CONFLICT');
          }
        }
        if (Number(renameCanonical.run(
          repository.canonicalKey, at, existing.canonical_key, repository.githubRepositoryId,
        ).changes) !== 1) {
          operationalFail('OPERATIONAL_CONFLICT');
        }
      }

      const inactiveCutoff = new Date(
        new Date(at).valueOf() - DISCOVERY_REMOVAL_GRACE_MS,
      ).toISOString();
      if (input.passOutcome === 'succeeded') {
        const retained = input.repositories.map((repository) => repository.canonicalKey);
        const retainedClause = retained.length === 0
          ? ''
          : ` WHERE canonical_key NOT IN (${retained.map(() => '?').join(',')})`;
        this.db.prepare(`
          UPDATE repository_registry
             SET active = CASE
                   WHEN active = 1 AND consecutive_missing_passes >= 1 AND last_seen_at <= ?
                     THEN 0 ELSE active END,
                 consecutive_missing_passes = CASE
                   WHEN consecutive_missing_passes < ? THEN consecutive_missing_passes + 1
                   ELSE consecutive_missing_passes END,
                 updated_at = ?${retainedClause}`)
          .run(inactiveCutoff, DISCOVERY_MISSING_PASS_LIMIT, at, ...retained);
      }
      const upsertRepository = this.db.prepare(`
        INSERT INTO repository_registry
          (canonical_key, github_repository_id, name_with_owner, project_key, project_origin,
           active, consecutive_missing_passes,
           first_seen_at, last_seen_at, last_good_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
        ON CONFLICT (canonical_key) DO UPDATE SET
          github_repository_id = COALESCE(
            excluded.github_repository_id, repository_registry.github_repository_id),
          name_with_owner = excluded.name_with_owner,
          project_key = excluded.project_key,
          project_origin = excluded.project_origin,
          active = 1,
          consecutive_missing_passes = 0,
          last_seen_at = excluded.last_seen_at,
          last_good_at = CASE
            WHEN excluded.github_repository_id IS NULL AND
                 repository_registry.github_repository_id IS NOT NULL
              THEN repository_registry.last_good_at
            ELSE excluded.last_good_at END,
          updated_at = excluded.updated_at`);
      for (const repository of input.repositories) {
        const existing = findCanonical.get(repository.canonicalKey);
        if (repository.evidence === 'carried_forward') {
          if (input.passOutcome === 'succeeded' && existing === undefined) {
            operationalFail('OPERATIONAL_CONFLICT');
          }
          continue;
        }
        if (input.passOutcome !== 'succeeded') continue;
        upsertRepository.run(
          repository.canonicalKey, repository.githubRepositoryId, repository.nameWithOwner,
          repository.projectKey, repository.projectOrigin, at, at, at, at,
        );
      }
      this.operationalFault?.('after_discovery_registry');

      if (input.passOutcome === 'succeeded') {
        const retained = input.bindings.map((binding) => binding.orcaRepositoryId);
        const retainedClause = retained.length === 0
          ? ''
          : ` WHERE orca_repository_id NOT IN (${retained.map(() => '?').join(',')})`;
        this.db.prepare(`
          UPDATE orca_repository_binding
             SET active = CASE
                   WHEN active = 1 AND consecutive_missing_passes >= 1 AND last_seen_at <= ?
                     THEN 0 ELSE active END,
                 consecutive_missing_passes = CASE
                   WHEN consecutive_missing_passes < ? THEN consecutive_missing_passes + 1
                   ELSE consecutive_missing_passes END,
                 updated_at = ?${retainedClause}`)
          .run(inactiveCutoff, DISCOVERY_MISSING_PASS_LIMIT, at, ...retained);
      }
      const upsertBinding = this.db.prepare(`
        INSERT INTO orca_repository_binding
          (orca_repository_id, canonical_key, project_key, origin, active, consecutive_missing_passes,
           first_seen_at, last_seen_at, last_good_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
        ON CONFLICT (orca_repository_id) DO UPDATE SET
          canonical_key = excluded.canonical_key,
          project_key = excluded.project_key,
          origin = excluded.origin,
          active = 1,
          consecutive_missing_passes = 0,
          last_seen_at = excluded.last_seen_at,
          last_good_at = excluded.last_good_at,
          updated_at = excluded.updated_at`);
      for (const binding of input.bindings) {
        if (binding.evidence === 'carried_forward') {
          const existing = this.db.prepare(`
            SELECT orca_repository_id FROM orca_repository_binding WHERE orca_repository_id = ?`)
            .get(binding.orcaRepositoryId);
          if (input.passOutcome === 'succeeded' && existing === undefined) {
            operationalFail('OPERATIONAL_CONFLICT');
          }
          continue;
        }
        if (input.passOutcome !== 'succeeded') continue;
        upsertBinding.run(
          binding.orcaRepositoryId, binding.canonicalKey, binding.projectKey, binding.origin,
          at, at, at, at,
        );
      }
      // Project changes are parent facts. Grace-retained bindings follow the parent without
      // pretending that the binding itself was seen or strongly verified in this pass.
      this.db.prepare(`
        UPDATE orca_repository_binding
           SET project_key = (
                 SELECT project_key FROM repository_registry
                  WHERE canonical_key = orca_repository_binding.canonical_key),
               updated_at = ?
         WHERE canonical_key IS NOT NULL
           AND project_key <> (
                 SELECT project_key FROM repository_registry
                  WHERE canonical_key = orca_repository_binding.canonical_key)`)
        .run(at);
      this.operationalFault?.('after_discovery_bindings');

      if (input.passOutcome === 'succeeded') {
        this.db.prepare(`
          UPDATE repository_discovery_issue
             SET active = 0, resolved_at = ?, updated_at = ?
           WHERE active = 1`).run(at, at);
      }
      const upsertIssue = this.db.prepare(`
        INSERT INTO repository_discovery_issue
          (issue_hash, category, active, occurrence_count, first_seen_at, last_seen_at,
           resolved_at, updated_at)
        VALUES (?, ?, 1, 1, ?, ?, NULL, ?)
        ON CONFLICT (issue_hash) DO UPDATE SET
          active = 1,
          occurrence_count = repository_discovery_issue.occurrence_count + 1,
          last_seen_at = excluded.last_seen_at,
          resolved_at = NULL,
          updated_at = excluded.updated_at
        WHERE repository_discovery_issue.category = excluded.category`);
      for (const issue of input.issues) {
        if (Number(upsertIssue.run(issue.issueHash, issue.category, at, at, at).changes) !== 1) {
          operationalFail('OPERATIONAL_CONFLICT');
        }
      }
      const invalidBinding = this.db.prepare(`
        SELECT 1
          FROM orca_repository_binding b
          LEFT JOIN repository_registry r ON r.canonical_key = b.canonical_key
         WHERE b.canonical_key IS NOT NULL
           AND (r.canonical_key IS NULL OR b.project_key <> r.project_key OR
                (b.active = 1 AND r.active <> 1))
         LIMIT 1`).get();
      if (invalidBinding !== undefined) operationalFail('OPERATIONAL_CONFLICT');
      const invalidAutoProjectOwner = this.db.prepare(`
        SELECT 1 FROM repository_registry
         WHERE project_origin = 'auto' AND github_repository_id IS NOT NULL
         GROUP BY project_key HAVING COUNT(DISTINCT github_repository_id) > 1
         LIMIT 1`).get();
      if (invalidAutoProjectOwner !== undefined) operationalFail('OPERATIONAL_CONFLICT');
      const snapshot = readDiscoverySnapshot(this.db, true);
      this.db.exec('COMMIT');
      transactionOpen = false;
      return snapshot;
    } catch (error) {
      if (transactionOpen) {
        try { this.db.exec('ROLLBACK'); } catch { /* preserve the static public error */ }
      }
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_CONFLICT');
    }
  }

  hasDiscoveryRoutingRows(): boolean {
    try {
      const row = this.db.prepare(`
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM repository_registry)
            OR EXISTS (SELECT 1 FROM orca_repository_binding)
          THEN 1 ELSE 0 END AS present`).get() as { readonly present: unknown } | undefined;
      if (row === undefined) operationalFail('OPERATIONAL_STORE_CORRUPT');
      return operationalBoolean(row.present);
    } catch (error) {
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_STORE_CORRUPT');
    }
  }

  readEffectiveDiscoverySnapshot(): EffectiveDiscoverySnapshot {
    let transactionOpen = false;
    try {
      this.db.exec('BEGIN');
      transactionOpen = true;
      const snapshot = readDiscoverySnapshot(this.db, true);
      this.db.exec('COMMIT');
      transactionOpen = false;
      return snapshot;
    } catch (error) {
      if (transactionOpen) {
        try { this.db.exec('ROLLBACK'); } catch { /* preserve the static public error */ }
      }
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_STORE_CORRUPT');
    }
  }

  recordDaemonStart(input: DaemonStartInput): DaemonHealthRecord {
    const instanceId = operationalInputText(input.instanceId, 200);
    const buildFingerprint = validateFingerprint(input.buildFingerprint, true);
    const configFingerprint = validateFingerprint(input.configFingerprint, true);
    const at = operationalIso(input.at, true);
    const record = this.transitionDaemonHealth(() => Number(this.db.prepare(`
        INSERT INTO daemon_health
          (id, revision, instance_id, build_fingerprint, config_fingerprint, desired_state,
           state, started_at, heartbeat_at, clean_stopped_at, last_error_code, updated_at)
        VALUES (1, 0, ?, ?, ?, 'running', 'running', ?, ?, NULL, NULL, ?)
        ON CONFLICT (id) DO UPDATE SET
          revision = daemon_health.revision + 1,
          instance_id = excluded.instance_id,
          build_fingerprint = excluded.build_fingerprint,
          config_fingerprint = excluded.config_fingerprint,
          desired_state = daemon_health.desired_state, state = 'running',
          started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at,
          clean_stopped_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at
        WHERE excluded.updated_at >= daemon_health.updated_at`)
        .run(instanceId, buildFingerprint, configFingerprint, at, at, at).changes));
    if (record === null) operationalFail('OPERATIONAL_STALE_TRANSITION');
    if (record.instanceId !== instanceId || record.startedAt !== at) {
      operationalFail('OPERATIONAL_STORE_CORRUPT');
    }
    return record;
  }

  recordDaemonHeartbeat(instanceId: string, at: string): DaemonHealthRecord | null {
    const safeInstance = operationalInputText(instanceId, 200);
    const safeAt = operationalIso(at, true);
    return this.transitionDaemonHealth(() => Number(this.db.prepare(`
      UPDATE daemon_health
         SET revision = revision + 1, heartbeat_at = ?, updated_at = ?
       WHERE id = 1 AND instance_id = ? AND state = 'running' AND updated_at <= ?`)
      .run(safeAt, safeAt, safeInstance, safeAt).changes));
  }

  recordDaemonCleanStop(instanceId: string, at: string): DaemonHealthRecord | null {
    const safeInstance = operationalInputText(instanceId, 200);
    const safeAt = operationalIso(at, true);
    return this.transitionDaemonHealth(() => Number(this.db.prepare(`
      UPDATE daemon_health
         SET revision = revision + 1, state = 'stopped',
             heartbeat_at = ?, clean_stopped_at = ?, last_error_code = NULL, updated_at = ?
       WHERE id = 1 AND instance_id = ? AND state = 'running' AND updated_at <= ?`)
      .run(safeAt, safeAt, safeAt, safeInstance, safeAt).changes));
  }

  setDaemonDesiredState(state: DaemonDesiredState, at: string): DaemonHealthRecord | null {
    if (state !== 'running' && state !== 'stopped') operationalFail('OPERATIONAL_INPUT_INVALID');
    const safeAt = operationalIso(at, true);
    return this.transitionDaemonHealth(() => Number(this.db.prepare(`
      UPDATE daemon_health
         SET revision = revision + 1, desired_state = ?, updated_at = ?
       WHERE id = 1 AND updated_at <= ?`).run(state, safeAt, safeAt).changes));
  }

  readDaemonHealth(): DaemonHealthRecord | null {
    return this.readOperationally(() => {
      const row = this.db.prepare(SELECT_DAEMON_HEALTH).get() as DaemonHealthRow | undefined;
      return row === undefined ? null : toDaemonHealth(row);
    });
  }

  private transitionDaemonHealth(write: () => number): DaemonHealthRecord | null {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      if (write() !== 1) {
        this.db.exec('COMMIT');
        return null;
      }
      const record = this.readDaemonHealth();
      if (record === null) operationalFail('OPERATIONAL_STORE_CORRUPT');
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the static public error */ }
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_CONFLICT');
    }
  }

  startDaemonJob(
    jobName: DaemonJobName,
    at: string,
    options: { readonly startupTakeover?: boolean } = {},
  ): DaemonJobClaim | null {
    const safeJob = operationalJobName(jobName);
    const safeAt = operationalIso(at, true);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const existingRow = this.db.prepare(SELECT_DAEMON_JOB_OUTCOME).get(safeJob) as
        | DaemonJobOutcomeRow | undefined;
      if (existingRow !== undefined) {
        const existing = toDaemonJobOutcome(existingRow);
        if (existing.state === 'running' || existing.updatedAt > safeAt ||
            (options.startupTakeover !== true &&
             existing.nextRunAt !== null && existing.nextRunAt > safeAt)) {
          this.db.exec('COMMIT');
          return null;
        }
        const result = this.db.prepare(`
          UPDATE daemon_job_outcome
             SET revision = revision + 1, state = 'running', attempt = attempt + 1,
                 started_at = ?, completed_at = NULL, duration_ms = NULL, next_run_at = NULL,
                 error_code = NULL, processed_count = 0, deferred_count = 0, updated_at = ?
           WHERE job_name = ? AND revision = ? AND state <> 'running' AND updated_at <= ?`)
          .run(safeAt, safeAt, safeJob, existing.revision, safeAt);
        if (Number(result.changes) !== 1) {
          this.db.exec('ROLLBACK');
          return null;
        }
      } else {
        this.db.prepare(`
          INSERT INTO daemon_job_outcome
            (job_name, revision, state, attempt, consecutive_failures, started_at, completed_at,
             last_success_at, last_failure_at, duration_ms, next_run_at, error_code,
             processed_count, deferred_count, checkpoint, updated_at)
          VALUES (?, 0, 'running', 1, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, ?)`)
          .run(safeJob, safeAt, safeAt);
      }
      const row = this.db.prepare(SELECT_DAEMON_JOB_OUTCOME).get(safeJob) as DaemonJobOutcomeRow;
      const current = toDaemonJobOutcome(row);
      this.db.exec('COMMIT');
      return { jobName: current.jobName, revision: current.revision, startedAt: current.startedAt };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the static public error */ }
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_CONFLICT');
    }
  }

  completeDaemonJobSuccess(input: DaemonJobSuccessCompletion): DaemonJobOutcomeRecord | null {
    return this.completeDaemonJob(input, null, operationalIso(input.nextRunAt, true));
  }

  completeDaemonJobFailure(
    input: DaemonJobCompletion & { readonly errorCode: OperationalFailureCode },
  ): DaemonJobOutcomeRecord | null {
    return this.completeDaemonJob(input, operationalCode(input.errorCode, true), null);
  }

  private completeDaemonJob(
    input: DaemonJobCompletion,
    errorCode: OperationalFailureCode | null,
    nextRunAt: string | null,
  ): DaemonJobOutcomeRecord | null {
    const jobName = operationalJobName(input.claim.jobName);
    const revision = operationalInteger(input.claim.revision, true);
    const startedAt = operationalIso(input.claim.startedAt, true);
    const at = operationalIso(input.at, true);
    const durationMs = operationalInteger(input.durationMs, true);
    const processedCount = operationalInteger(input.processedCount ?? 0, true);
    const deferredCount = operationalInteger(input.deferredCount ?? 0, true);
    const checkpoint = input.checkpoint === undefined
      ? null
      : operationalInteger(input.checkpoint, true);
    if (at < startedAt || (nextRunAt !== null && nextRunAt < at) ||
        (errorCode === null) !== (nextRunAt !== null)) {
      operationalFail('OPERATIONAL_INPUT_INVALID');
    }
    const state = errorCode === null ? 'succeeded' : 'failed';
    return this.transitionDaemonJob(jobName, () => Number(this.db.prepare(`
      UPDATE daemon_job_outcome
         SET revision = revision + 1, state = ?, completed_at = ?,
             last_success_at = CASE WHEN ? = 'succeeded' THEN ? ELSE last_success_at END,
             last_failure_at = CASE WHEN ? = 'failed' THEN ? ELSE last_failure_at END,
             duration_ms = ?, next_run_at = ?, error_code = ?,
             consecutive_failures = CASE WHEN ? = 'succeeded' THEN 0 ELSE consecutive_failures + 1 END,
             processed_count = ?, deferred_count = ?,
             checkpoint = CASE WHEN ? IS NULL THEN checkpoint ELSE ? END,
             updated_at = ?
       WHERE job_name = ? AND revision = ? AND state = 'running' AND started_at = ?
         AND updated_at <= ? AND (? IS NULL OR checkpoint <= ?)`)
      .run(
        state, at, state, at, state, at, durationMs, nextRunAt, errorCode, state,
        processedCount, deferredCount, checkpoint, checkpoint, at,
        jobName, revision, startedAt, at, checkpoint, checkpoint,
      ).changes));
  }

  scheduleDaemonJobBackoff(
    jobName: DaemonJobName,
    expectedRevision: number,
    nextRunAt: string,
    at: string,
  ): DaemonJobOutcomeRecord | null {
    const safeJob = operationalJobName(jobName);
    const revision = operationalInteger(expectedRevision, true);
    const safeNext = operationalIso(nextRunAt, true);
    const safeAt = operationalIso(at, true);
    if (safeNext < safeAt) operationalFail('OPERATIONAL_INPUT_INVALID');
    return this.transitionDaemonJob(safeJob, () => Number(this.db.prepare(`
      UPDATE daemon_job_outcome
         SET revision = revision + 1, state = 'backoff', next_run_at = ?, updated_at = ?
       WHERE job_name = ? AND revision = ? AND state = 'failed' AND updated_at <= ?`)
      .run(safeNext, safeAt, safeJob, revision, safeAt).changes));
  }

  advanceDaemonJobCheckpoint(
    claim: DaemonJobClaim,
    expectedCheckpoint: number,
    checkpoint: number,
    at: string,
  ): DaemonJobOutcomeRecord | null {
    const safeJob = operationalJobName(claim.jobName);
    const revision = operationalInteger(claim.revision, true);
    const startedAt = operationalIso(claim.startedAt, true);
    const expected = operationalInteger(expectedCheckpoint, true);
    const next = operationalInteger(checkpoint, true);
    const safeAt = operationalIso(at, true);
    if (next < expected) operationalFail('OPERATIONAL_INPUT_INVALID');
    return this.transitionDaemonJob(safeJob, () => Number(this.db.prepare(`
      UPDATE daemon_job_outcome
         SET checkpoint = ?, updated_at = ?
       WHERE job_name = ? AND revision = ? AND state = 'running' AND started_at = ?
         AND checkpoint = ? AND updated_at <= ?`)
      .run(next, safeAt, safeJob, revision, startedAt, expected, safeAt).changes));
  }

  findDaemonJobOutcome(jobName: DaemonJobName): DaemonJobOutcomeRecord | null {
    const safeJob = operationalJobName(jobName);
    return this.readOperationally(() => {
      const row = this.db.prepare(SELECT_DAEMON_JOB_OUTCOME).get(safeJob) as
        | DaemonJobOutcomeRow | undefined;
      return row === undefined ? null : toDaemonJobOutcome(row);
    });
  }

  private transitionDaemonJob(jobName: DaemonJobName, write: () => number): DaemonJobOutcomeRecord | null {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      if (write() !== 1) {
        this.db.exec('COMMIT');
        return null;
      }
      const row = this.db.prepare(SELECT_DAEMON_JOB_OUTCOME).get(jobName) as
        | DaemonJobOutcomeRow | undefined;
      if (row === undefined) operationalFail('OPERATIONAL_STORE_CORRUPT');
      const outcome = toDaemonJobOutcome(row);
      this.db.exec('COMMIT');
      return outcome;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the static public error */ }
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_CONFLICT');
    }
  }

  readOperationalAggregateCounts(): OperationalAggregateCounts {
    return this.readOperationally(() => {
      const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM gate_resolution_outbox o
          WHERE o.card_pending = 1
            AND NOT EXISTS (SELECT 1 FROM gate_channel_delivery d WHERE d.gate_key = o.gate_key))
          AS gate_cards,
        (SELECT COUNT(*) FROM gate_channel_delivery
          WHERE state IN ('pending','attempted','receipted')
            AND resume_baseline_state = 'recorded') AS channel_deliveries,
        (SELECT COUNT(*) FROM gate_channel_delivery
          WHERE state <> 'consumed' AND resume_baseline_state = 'required') AS resume_baselines,
        (SELECT COUNT(*) FROM gate_resolution_outbox o
          WHERE o.notification_state = 'pending' AND o.card_pending = 0
            AND NOT EXISTS (SELECT 1 FROM gate_channel_delivery d WHERE d.gate_key = o.gate_key))
          AS legacy_notifications,
        (SELECT COUNT(*) FROM slack_root_intent WHERE state IN ('pending','sending'))
          AS slack_root_pending,
        (SELECT COUNT(*) FROM slack_root_intent WHERE state = 'uncertain') AS slack_root_uncertain,
        (SELECT COUNT(*) FROM gate_channel_delivery
          WHERE state <> 'consumed' AND resume_baseline_state = 'unavailable') AS unavailable_resume`)
        .get() as Record<string, unknown>;
      const gateCards = operationalInteger(row['gate_cards']);
      const channelDeliveries = operationalInteger(row['channel_deliveries']);
      const resumeBaselines = operationalInteger(row['resume_baselines']);
      const legacyNotifications = operationalInteger(row['legacy_notifications']);
      const slackRootIntents = operationalInteger(row['slack_root_pending']);
      const uncertain = operationalInteger(row['slack_root_uncertain']);
      const dead = operationalInteger(row['unavailable_resume']);
      return {
        pending: {
          gateCards, channelDeliveries, resumeBaselines, legacyNotifications, slackRootIntents,
          total: gateCards + channelDeliveries + resumeBaselines + legacyNotifications + slackRootIntents,
        },
        uncertain: { slackRootIntents: uncertain, total: uncertain },
        dead: { unavailableResumeBaselines: dead, total: dead },
      };
    });
  }

  prepareSlackRootIntent(input: PrepareSlackRootIntentInput): SlackRootIntentRecord {
    const entity = operationalEntity(input);
    const channelId = operationalInputText(input.channelId, 200);
    const renderFingerprint = validateFingerprint(input.renderFingerprint, true);
    const at = operationalIso(input.at, true);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const existingRow = this.db.prepare(SELECT_SLACK_ROOT_INTENT)
        .get(entity.kind, entity.key) as SlackRootIntentRow | undefined;
      if (existingRow !== undefined) {
        const existing = toSlackRootIntent(existingRow);
        if (existing.channelId !== channelId || existing.renderFingerprint !== renderFingerprint) {
          if (existing.state !== 'pending' || existing.updatedAt > at ||
              Number(this.db.prepare(`
                UPDATE slack_root_intent
                   SET revision = revision + 1, channel_id = ?, render_fingerprint = ?, updated_at = ?
                 WHERE entity_kind = ? AND entity_key = ? AND revision = ? AND state = 'pending'`)
                .run(
                  channelId, renderFingerprint, at,
                  existing.kind, existing.key, existing.revision,
                ).changes) !== 1) {
            this.db.exec('ROLLBACK');
            operationalFail('OPERATIONAL_CONFLICT');
          }
          const updatedRow = this.db.prepare(SELECT_SLACK_ROOT_INTENT)
            .get(existing.kind, existing.key) as SlackRootIntentRow;
          this.db.exec('COMMIT');
          return toSlackRootIntent(updatedRow);
        }
        this.db.exec('COMMIT');
        return existing;
      }
      const mappingExists = entity.kind === 'pr'
        ? this.db.prepare(SELECT_ROW).get(entity.key) !== undefined
        : entity.kind === 'run'
          ? this.db.prepare(SELECT_RUN_ROW).get(entity.key) !== undefined
          : this.db.prepare(SELECT_RUN_COLLECTION_ROW).get() !== undefined;
      if (mappingExists) {
        this.db.exec('ROLLBACK');
        operationalFail('OPERATIONAL_CONFLICT');
      }
      this.db.prepare(`
        INSERT INTO slack_root_intent
          (entity_kind, entity_key, revision, channel_id, render_fingerprint, state,
           attempt_count, sending_instance_id, message_ts, prepared_at, last_attempt_at,
           posted_at, uncertain_at, last_error_code, updated_at)
        VALUES (?, ?, 0, ?, ?, 'pending', 0, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?)`)
        .run(entity.kind, entity.key, channelId, renderFingerprint, at, at);
      const row = this.db.prepare(SELECT_SLACK_ROOT_INTENT)
        .get(entity.kind, entity.key) as SlackRootIntentRow;
      this.db.exec('COMMIT');
      return toSlackRootIntent(row);
    } catch (error) {
      // Explicit branches may have rolled back immediately before throwing.
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_CONFLICT');
    }
  }

  claimSlackRootIntent(
    entityInput: SlackRootEntity,
    instanceId: string,
    at: string,
  ): SlackRootClaimResult | null {
    const entity = operationalEntity(entityInput);
    const safeInstance = operationalInputText(instanceId, 200);
    const safeAt = operationalIso(at, true);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const row = this.db.prepare(SELECT_SLACK_ROOT_INTENT)
        .get(entity.kind, entity.key) as SlackRootIntentRow | undefined;
      if (row === undefined) {
        this.db.exec('COMMIT');
        return null;
      }
      const intent = toSlackRootIntent(row);
      if (intent.state !== 'pending' || intent.updatedAt > safeAt) {
        this.db.exec('COMMIT');
        return { kind: 'not_claimed', intent };
      }
      const result = this.db.prepare(`
        UPDATE slack_root_intent
           SET revision = revision + 1, state = 'sending', attempt_count = attempt_count + 1,
               sending_instance_id = ?, last_attempt_at = ?, last_error_code = NULL,
               updated_at = ?
         WHERE entity_kind = ? AND entity_key = ? AND revision = ? AND state = 'pending'`)
        .run(safeInstance, safeAt, safeAt, entity.kind, entity.key, intent.revision);
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const claimedRow = this.db.prepare(SELECT_SLACK_ROOT_INTENT)
        .get(entity.kind, entity.key) as SlackRootIntentRow;
      const claimed = toSlackRootIntent(claimedRow);
      this.db.exec('COMMIT');
      return {
        kind: 'claimed',
        claim: {
          ...entity,
          revision: claimed.revision,
          instanceId: safeInstance,
          claimedAt: safeAt,
        },
        intent: claimed,
      };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the static public error */ }
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_CONFLICT');
    }
  }

  markSlackRootIntentSafeRetry(
    claim: SlackRootClaim,
    errorCode: OperationalFailureCode,
    at: string,
  ): SlackRootIntentRecord | null {
    return this.finishSlackRootClaim(claim, 'pending', errorCode, at);
  }

  markSlackRootIntentUncertain(
    claim: SlackRootClaim,
    errorCode: OperationalFailureCode,
    at: string,
  ): SlackRootIntentRecord | null {
    return this.finishSlackRootClaim(claim, 'uncertain', errorCode, at);
  }

  private finishSlackRootClaim(
    claim: SlackRootClaim,
    state: 'pending' | 'uncertain',
    errorCode: OperationalFailureCode,
    at: string,
  ): SlackRootIntentRecord | null {
    const entity = operationalEntity(claim);
    const revision = operationalInteger(claim.revision, true);
    const instanceId = operationalInputText(claim.instanceId, 200);
    const claimedAt = operationalIso(claim.claimedAt, true);
    const safeAt = operationalIso(at, true);
    const safeError = operationalCode(errorCode, true);
    if (safeAt < claimedAt) operationalFail('OPERATIONAL_INPUT_INVALID');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = this.db.prepare(`
        UPDATE slack_root_intent
           SET revision = revision + 1, state = ?, sending_instance_id = NULL,
               uncertain_at = CASE WHEN ? = 'uncertain' THEN ? ELSE NULL END,
               last_error_code = ?, updated_at = ?
         WHERE entity_kind = ? AND entity_key = ? AND revision = ? AND state = 'sending'
           AND sending_instance_id = ? AND last_attempt_at = ? AND updated_at <= ?`)
        .run(
          state, state, safeAt, safeError, safeAt,
          entity.kind, entity.key, revision, instanceId, claimedAt, safeAt,
        );
      if (Number(result.changes) !== 1) {
        this.db.exec('COMMIT');
        return null;
      }
      const row = this.db.prepare(SELECT_SLACK_ROOT_INTENT)
        .get(entity.kind, entity.key) as SlackRootIntentRow | undefined;
      if (row === undefined) operationalFail('OPERATIONAL_STORE_CORRUPT');
      const intent = toSlackRootIntent(row);
      this.db.exec('COMMIT');
      return intent;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the static public error */ }
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_CONFLICT');
    }
  }

  markSlackRootIntentPosted(input: SlackRootPostedInput): SlackRootIntentRecord | null {
    const entity = operationalEntity(input.claim);
    const revision = operationalInteger(input.claim.revision, true);
    const instanceId = operationalInputText(input.claim.instanceId, 200);
    const claimedAt = operationalIso(input.claim.claimedAt, true);
    const messageTs = operationalInputText(input.messageTs, 100);
    const at = operationalIso(input.at, true);
    if (at < claimedAt || input.mapping.kind !== entity.kind) {
      operationalFail('OPERATIONAL_INPUT_INVALID');
    }
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const row = this.db.prepare(SELECT_SLACK_ROOT_INTENT)
        .get(entity.kind, entity.key) as SlackRootIntentRow | undefined;
      if (row === undefined) {
        this.db.exec('COMMIT');
        return null;
      }
      const intent = toSlackRootIntent(row);
      if (intent.state !== 'sending' || intent.revision !== revision ||
          intent.sendingInstanceId !== instanceId || intent.lastAttemptAt !== claimedAt ||
          intent.updatedAt > at) {
        this.db.exec('COMMIT');
        return null;
      }
      if (entity.kind === 'pr' && input.mapping.kind === 'pr') {
        const facts = validateFingerprint(input.mapping.factsFingerprint, true);
        if (input.mapping.summaryJson !== null &&
            (typeof input.mapping.summaryJson !== 'string' || input.mapping.summaryJson.length > 200_000)) {
          operationalFail('OPERATIONAL_INPUT_INVALID');
        }
        this.db.prepare(INSERT_ROW).run(
          entity.key, intent.channelId, messageTs, intent.renderFingerprint, facts,
          input.mapping.summaryJson, at, at,
        );
      } else if (entity.kind === 'run' && input.mapping.kind === 'run') {
        this.db.prepare(INSERT_RUN_ROW).run(
          entity.key, intent.channelId, messageTs, intent.renderFingerprint, at, at,
        );
      } else if (entity.kind === 'run_collection' && input.mapping.kind === 'run_collection') {
        this.db.prepare(INSERT_RUN_COLLECTION_ROW).run(
          intent.channelId, messageTs, intent.renderFingerprint, at, at,
        );
      } else {
        operationalFail('OPERATIONAL_INPUT_INVALID');
      }
      this.operationalFault?.('after_root_mapping');
      const result = this.db.prepare(`
        UPDATE slack_root_intent
           SET revision = revision + 1, state = 'posted', sending_instance_id = NULL,
               message_ts = ?, posted_at = ?, last_error_code = NULL, updated_at = ?
         WHERE entity_kind = ? AND entity_key = ? AND revision = ? AND state = 'sending'
           AND sending_instance_id = ? AND last_attempt_at = ?`)
        .run(messageTs, at, at, entity.kind, entity.key, revision, instanceId, claimedAt);
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const postedRow = this.db.prepare(SELECT_SLACK_ROOT_INTENT)
        .get(entity.kind, entity.key) as SlackRootIntentRow;
      this.db.exec('COMMIT');
      return toSlackRootIntent(postedRow);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_CONFLICT');
    }
  }

  recoverSlackRootIntents(instanceId: string, at: string): number {
    const safeInstance = operationalInputText(instanceId, 200);
    const safeAt = operationalIso(at, true);
    try {
      const result = this.db.prepare(`
        UPDATE slack_root_intent
           SET revision = revision + 1, state = 'uncertain', sending_instance_id = NULL,
               uncertain_at = ?, last_error_code = 'startup_recovery', updated_at = ?
         WHERE state = 'sending' AND sending_instance_id <> ? AND updated_at <= ?`)
        .run(safeAt, safeAt, safeInstance, safeAt);
      return Number(result.changes);
    } catch {
      operationalFail('OPERATIONAL_CONFLICT');
    }
  }

  findSlackRootIntent(entityInput: SlackRootEntity): SlackRootIntentRecord | null {
    const entity = operationalEntity(entityInput);
    return this.readOperationally(() => {
      const row = this.db.prepare(SELECT_SLACK_ROOT_INTENT)
        .get(entity.kind, entity.key) as SlackRootIntentRow | undefined;
      return row === undefined ? null : toSlackRootIntent(row);
    });
  }

  private readOperationally<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      if (error instanceof OperationalStoreError) throw error;
      operationalFail('OPERATIONAL_STORE_CORRUPT');
    }
  }

  close(): void {
    try {
      // WAL과 shm을 본 파일에 접고 지운다. 다음 실행이 남은 조각을 복구하지 않아도 되게 한다.
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.db.close();
    } finally {
      LIVE_OBSERVATION_WRITE_OWNERS.delete(this.observationWriteOwner);
      for (const owner of this.ownedProjectionWrites) {
        LIVE_OBSERVATION_WRITE_OWNERS.delete(owner);
      }
      this.ownedProjectionWrites.clear();
    }
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

  saveGateLocalObservation(): GateObservationSaveResult {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate local observation을 기록하려 했다: ${this.path}`);
  }

  findGateLocalObservation(gateKey: GateKey): GateLocalObservation | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_GATE_LOCAL_OBSERVATION).get(gateKey) as
      | GateLocalObservationRow
      | undefined;
    return row === undefined ? null : toGateLocalObservation(row);
  }

  prepareGateDirectModal(): GateDirectPrepareResult {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate direct modal을 준비하려 했다: ${this.path}`);
  }

  findGateDirectModal(sessionId: string): GateDirectModalSession | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_GATE_DIRECT_MODAL).get(sessionId) as
      | GateDirectModalRow
      | undefined;
    return row === undefined ? null : toGateDirectModal(row);
  }

  beginGateDirectModalOpen(): GateDirectModalSession | null {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate direct modal open을 시작하려 했다: ${this.path}`);
  }

  finishGateDirectModalOpen(): GateDirectModalSession | null {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate direct modal open을 확정하려 했다: ${this.path}`);
  }

  claimGateDirectResolution(): GateClaimResult {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate direct resolution을 claim하려 했다: ${this.path}`);
  }

  claimGateResolution(): GateClaimResult {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate resolution을 claim하려 했다: ${this.path}`);
  }

  findGateResolution(gateKey: GateKey): GateResolutionIntent | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_GATE_RESOLUTION).get(gateKey) as GateResolutionRow | undefined;
    return row === undefined ? null : toGateResolution(row);
  }

  listNonterminalGateResolutions(): readonly GateResolutionIntent[] {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return [];
    return (db.prepare(SELECT_NONTERMINAL_GATE_RESOLUTIONS).all() as GateResolutionRow[]).map(
      toGateResolution,
    );
  }

  acquireGateResolutionLease(): GateLeaseResult {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate resolution lease를 획득하려 했다: ${this.path}`);
  }

  renewGateResolutionLease(): boolean {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate resolution lease를 갱신하려 했다: ${this.path}`);
  }

  releaseGateResolutionLease(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate resolution lease를 해제하려 했다: ${this.path}`);
  }

  markGateResolutionAck(): GateResolutionIntent | null {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate ACK state를 갱신하려 했다: ${this.path}`);
  }

  updateGateResolution(): GateResolutionIntent | null {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate resolution을 갱신하려 했다: ${this.path}`);
  }

  findGateResolutionOutbox(gateKey: GateKey): GateResolutionOutbox | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_GATE_OUTBOX).get(gateKey) as GateOutboxRow | undefined;
    return row === undefined ? null : toGateOutbox(row);
  }

  listPendingGateOutboxes(): readonly GateResolutionOutbox[] {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return [];
    return (db.prepare(SELECT_PENDING_GATE_OUTBOXES).all() as GateOutboxRow[]).map(toGateOutbox);
  }

  listAcknowledgedGateOutboxes(): readonly GateResolutionOutbox[] {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return [];
    return (db.prepare(SELECT_ACKNOWLEDGED_GATE_OUTBOXES).all() as GateOutboxRow[]).map(
      toGateOutbox,
    );
  }

  seedPendingGateChannelDeliveries(): GateChannelSeedResult {
    throw new Error(`dry-run은 store에 쓰지 않는다. Channel delivery를 seed하려 했다: ${this.path}`);
  }

  findGateChannelDelivery(gateKey: GateKey): GateChannelDelivery | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_GATE_CHANNEL_DELIVERY).get(gateKey) as
      | GateChannelDeliveryRow
      | undefined;
    return row === undefined ? null : toGateChannelDelivery(row);
  }

  listDueGateChannelDeliveries(at: string, limit = 64): readonly GateChannelDelivery[] {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return [];
    const dueAt = storedIso(at, 'dry-run Gate Channel delivery due.at');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('Gate Channel delivery due limit이 1..1000이 아니다');
    }
    return (db.prepare(SELECT_DUE_GATE_CHANNEL_DELIVERIES).all(
      dueAt,
      limit,
    ) as GateChannelDeliveryRow[]).map(toGateChannelDelivery);
  }

  acquireGateChannelDeliveryLease(): GateChannelDeliveryLeaseResult {
    throw new Error(`dry-run은 store에 쓰지 않는다. Channel delivery lease를 획득하려 했다: ${this.path}`);
  }

  releaseGateChannelDeliveryLease(): boolean {
    throw new Error(`dry-run은 store에 쓰지 않는다. Channel delivery lease를 해제하려 했다: ${this.path}`);
  }

  deferGateChannelDelivery(): GateChannelDelivery | null {
    throw new Error(`dry-run은 store에 쓰지 않는다. Channel delivery를 defer하려 했다: ${this.path}`);
  }

  markGateChannelAttempted(): GateChannelDelivery | null {
    throw new Error(`dry-run은 store에 쓰지 않는다. Channel attempted를 기록하려 했다: ${this.path}`);
  }

  markGateChannelReceipted(): GateChannelDelivery | null {
    throw new Error(`dry-run은 store에 쓰지 않는다. Channel receipt를 기록하려 했다: ${this.path}`);
  }

  consumeGateChannelDelivery(): GateChannelConsumeResult {
    throw new Error(`dry-run은 store에 쓰지 않는다. Channel delivery를 consume하려 했다: ${this.path}`);
  }

  recordGateResumeBaseline(): GateChannelDelivery | null {
    throw new Error(`dry-run은 store에 쓰지 않는다. resume baseline을 기록하려 했다: ${this.path}`);
  }

  findGateResumeObservation(gateKey: GateKey): GateResumeObservation | null {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return null;
    const row = db.prepare(SELECT_GATE_RESUME_OBSERVATION).get(gateKey) as
      | GateResumeObservationRow
      | undefined;
    return row === undefined ? null : toGateResumeObservation(row);
  }

  listDueGateResumeObservations(at: string, limit = 64): readonly GateResumeObservation[] {
    const { db, schemaReady } = this.opened;
    if (db === null || !schemaReady) return [];
    const dueAt = storedIso(at, 'dry-run Gate resume observation due.at');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('Gate resume observation due limit이 1..1000이 아니다');
    }
    return (db.prepare(SELECT_DUE_GATE_RESUME_OBSERVATIONS).all(
      dueAt,
      limit,
    ) as GateResumeObservationRow[]).map(toGateResumeObservation);
  }

  acquireGateResumeLease(): GateResumeLeaseResult {
    throw new Error(`dry-run은 store에 쓰지 않는다. resume lease를 획득하려 했다: ${this.path}`);
  }

  recordGateResumeObservation(): GateResumeObservation | null {
    throw new Error(`dry-run은 store에 쓰지 않는다. resume observation을 기록하려 했다: ${this.path}`);
  }

  releaseGateResumeLease(): boolean {
    throw new Error(`dry-run은 store에 쓰지 않는다. resume lease를 해제하려 했다: ${this.path}`);
  }

  beginGateObservationWrite(
    _gateKey: GateKey,
    _at: string,
    _expectedObservation: GateLocalObservation,
    _expectedRevision: number,
  ): boolean {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate ordinary write fence를 세우려 했다: ${this.path}`);
  }

  abandonGateObservationWrite(): void {
    throw new Error(`dry-run은 store의 Gate ordinary write를 포기할 수 없다: ${this.path}`);
  }

  acquireGateOutboxProjection(): GateProjectionLeaseResult {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate projection lease를 얻으려 했다: ${this.path}`);
  }

  rearmGateOutboxProjection(): boolean {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate outbox를 재활성화하려 했다: ${this.path}`);
  }

  markGateOutboxProjected(): boolean {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate outbox를 확정하려 했다: ${this.path}`);
  }

  releaseGateOutboxProjection(): boolean {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate projection lease를 놓으려 했다: ${this.path}`);
  }

  recordGateAudit(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate audit을 기록하려 했다: ${this.path}`);
  }

  recordGateAttempt(): void {
    throw new Error(`dry-run은 store에 쓰지 않는다. Gate attempt를 기록하려 했다: ${this.path}`);
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
    enableForeignKeys(db);
    // 버전 판정과 migration은 실제 실행과 같은 함수를 쓴다. 모르는 버전이면 여기서도 던진다.
    // 올리는 대상은 **복사본**이다. 원본은 v1인 채로 남고, 다음 실제 실행이 원본을 올린다.
    // 복사본을 올리지 않으면 dry-run이 v2 컬럼을 읽지 못해 실제 실행과 다른 판정을 낸다.
    const version = readSchemaVersion(db, path);
    if (version !== null) {
      applyMigrations(db, path, version);
      validateCurrentGateStore(db, path);
    }
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

function enableForeignKeys(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  const row = db.prepare('PRAGMA foreign_keys').get() as { readonly foreign_keys: number } | undefined;
  if (row?.foreign_keys !== 1) operationalFail('OPERATIONAL_STORE_CORRUPT');
}

const CURRENT_GATE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  gate_metadata: [
    'gate_key', 'run_key', 'task_key', 'dispatch_key', 'ask_message_id',
    'question_thread_id', 'options_json', 'recommendation_option_id',
    'recommendation_reason', 'impact', 'registered_at',
  ],
  gate_message: [
    'gate_key', 'run_key', 'channel_id', 'thread_ts', 'message_ts',
    'render_fingerprint', 'created_at', 'updated_at',
  ],
  gate_local_observation: [
    'gate_key', 'run_key', 'task_key', 'status', 'resolution', 'resolved_at',
    'metadata_state', 'mapping_state', 'write_owner', 'write_expires_at', 'observed_at',
  ],
  gate_observation_generation: ['gate_key', 'revision'],
  gate_direct_modal: [
    'session_id', 'revision', 'button_event_key', 'gate_key',
    'team_id', 'owner_user_id', 'api_app_id', 'channel_id', 'thread_ts', 'message_ts',
    'block_id', 'action_id', 'action_value', 'callback_id', 'input_block_id', 'input_action_id',
    'state', 'view_id', 'failure_code', 'resolution_text',
    'created_at', 'updated_at', 'opened_at', 'accepted_at',
  ],
  gate_resolution: [
    'gate_key', 'revision', 'ack_state', 'lease_owner', 'lease_expires_at',
    'retry_request_id', 'option_id', 'option_resolution',
    'ask_message_id', 'question_thread_id', 'dispatch_id', 'task_id',
    'team_id', 'owner_user_id', 'api_app_id', 'channel_id', 'thread_ts', 'message_ts',
    'block_id', 'action_id', 'action_value', 'lifecycle', 'mutation_ownership', 'pre_read_json',
    'resolve_result_json', 'post_read_json', 'last_error_code', 'last_error_detail',
    'created_at', 'updated_at',
  ],
  gate_resolution_outbox: [
    'gate_key', 'revision', 'card_state', 'card_pending', 'notification_state', 'projected_at',
    'projection_owner', 'projection_expires_at', 'last_error_code', 'created_at', 'updated_at',
  ],
  gate_resolution_attempt: ['id', 'gate_key', 'phase', 'outcome', 'detail', 'created_at'],
  gate_resolution_audit: ['id', 'gate_key', 'event', 'reason', 'created_at'],
  gate_channel_delivery: [
    'gate_key', 'run_key', 'task_key', 'source_dispatch_id', 'revision',
    'deferred_outbox_revision', 'state',
    'attempt_count', 'last_attempt_at', 'next_attempt_at', 'receipted_at', 'consumed_at',
    'lease_owner', 'lease_expires_at', 'last_error_code', 'created_at', 'updated_at',
    'resume_baseline_state',
  ],
  gate_resume_observation: [
    'gate_key', 'revision', 'baseline_json', 'latest_json',
    'evidence_kind', 'evidence_task_id', 'evidence_dispatch_id',
    'evidence_from_status', 'evidence_to_status', 'next_observation_at', 'observed_at',
    'lease_owner', 'lease_expires_at', 'last_error_code', 'created_at', 'updated_at',
  ],
};

const CURRENT_OPERATIONAL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  repository_registry: [
    'canonical_key', 'github_repository_id', 'name_with_owner', 'project_key', 'project_origin',
    'active', 'consecutive_missing_passes',
    'first_seen_at', 'last_seen_at', 'last_good_at', 'updated_at',
  ],
  orca_repository_binding: [
    'orca_repository_id', 'canonical_key', 'project_key', 'origin', 'active',
    'consecutive_missing_passes', 'first_seen_at', 'last_seen_at', 'last_good_at', 'updated_at',
  ],
  repository_discovery_issue: [
    'issue_hash', 'category', 'active', 'occurrence_count', 'first_seen_at', 'last_seen_at',
    'resolved_at', 'updated_at',
  ],
  daemon_health: [
    'id', 'revision', 'instance_id', 'build_fingerprint', 'config_fingerprint', 'desired_state',
    'state', 'started_at', 'heartbeat_at', 'clean_stopped_at', 'last_error_code', 'updated_at',
  ],
  daemon_job_outcome: [
    'job_name', 'revision', 'state', 'attempt', 'consecutive_failures', 'started_at',
    'completed_at', 'last_success_at', 'last_failure_at', 'duration_ms', 'next_run_at',
    'error_code', 'processed_count', 'deferred_count', 'checkpoint', 'updated_at',
  ],
  slack_root_intent: [
    'entity_kind', 'entity_key', 'revision', 'channel_id', 'render_fingerprint', 'state',
    'attempt_count', 'sending_instance_id', 'message_ts', 'prepared_at', 'last_attempt_at',
    'posted_at', 'uncertain_at', 'last_error_code', 'updated_at',
  ],
};

function validateCurrentOperationalStore(db: DatabaseSync): void {
  try {
    const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
    for (const [table, expected] of Object.entries(CURRENT_OPERATIONAL_COLUMNS)) {
      const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as { readonly name: string }[])
        .map((row) => row.name);
      if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
        operationalFail('OPERATIONAL_STORE_CORRUPT');
      }
    }
    for (const [name, expected] of Object.entries(OPERATIONAL_V13_SCHEMA_OBJECTS)) {
      const row = db.prepare(
        `SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','index')`,
      ).get(name) as { readonly sql: string | null } | undefined;
      if (row?.sql === null || row === undefined || normalize(row.sql) !== normalize(expected)) {
        operationalFail('OPERATIONAL_STORE_CORRUPT');
      }
    }
    const tableNames = Object.keys(CURRENT_OPERATIONAL_COLUMNS);
    const placeholders = tableNames.map(() => '?').join(',');
    const expectedNames = new Set(Object.keys(OPERATIONAL_V13_SCHEMA_OBJECTS));
    const unexpected = (db.prepare(
      `SELECT type, name FROM sqlite_master
        WHERE (type IN ('index','trigger') AND tbl_name IN (${placeholders}))
           OR (type = 'table' AND
              (name LIKE 'repository_registry%' OR name LIKE 'orca_repository_binding%' OR
               name LIKE 'repository_discovery_issue%' OR name LIKE 'daemon_health%' OR
               name LIKE 'daemon_job_outcome%' OR name LIKE 'slack_root_intent%'))`,
    ).all(...tableNames) as { readonly type: string; readonly name: string }[])
      .filter((row) => !row.name.startsWith('sqlite_autoindex_') && !expectedNames.has(row.name));
    if (unexpected.length > 0) operationalFail('OPERATIONAL_STORE_CORRUPT');

    const snapshot = readDiscoverySnapshot(db, false);
    const registryByKey = new Map(snapshot.repositories.map((record) => [record.canonicalKey, record]));
    for (const binding of snapshot.bindings) {
      if (binding.canonicalKey === null) continue;
      const repository = registryByKey.get(binding.canonicalKey);
      if (repository === undefined || repository.projectKey !== binding.projectKey ||
          (binding.active && !repository.active)) operationalFail('OPERATIONAL_STORE_CORRUPT');
    }
    const healthRows = db.prepare(SELECT_DAEMON_HEALTH.replace(' WHERE id = 1', ''))
      .all() as DaemonHealthRow[];
    if (healthRows.length > 1) operationalFail('OPERATIONAL_STORE_CORRUPT');
    healthRows.map(toDaemonHealth);
    (db.prepare(SELECT_ALL_DAEMON_JOB_OUTCOMES).all() as DaemonJobOutcomeRow[])
      .map(toDaemonJobOutcome);
    const intents = (db.prepare(SELECT_ALL_SLACK_ROOT_INTENTS).all() as SlackRootIntentRow[])
      .map(toSlackRootIntent);
    for (const intent of intents) {
      const mapping = intent.kind === 'pr'
        ? convertOptionalMapping(db.prepare(SELECT_ROW).get(intent.key) as PrMessageRow | undefined, toRecord)
        : intent.kind === 'run'
          ? convertOptionalMapping(db.prepare(SELECT_RUN_ROW).get(intent.key) as RunMessageRow | undefined, toRunMessageRecord)
          : convertOptionalMapping(db.prepare(SELECT_RUN_COLLECTION_ROW).get() as RunCollectionMessageRow | undefined, toRunCollectionMessageRecord);
      if (intent.state === 'posted') {
        if (mapping === null || mapping.channelId !== intent.channelId ||
            mapping.messageTs !== intent.messageTs) {
          operationalFail('OPERATIONAL_STORE_CORRUPT');
        }
      } else if (mapping !== null) {
        operationalFail('OPERATIONAL_STORE_CORRUPT');
      }
    }
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all() as { readonly table: string }[];
    if (foreignKeys.some((row) => tableNames.includes(row.table))) {
      operationalFail('OPERATIONAL_STORE_CORRUPT');
    }
  } catch (error) {
    if (error instanceof OperationalStoreError) throw error;
    operationalFail('OPERATIONAL_STORE_CORRUPT');
  }
}

function convertOptionalMapping<
  Row,
  RecordType extends {
    readonly channelId: string;
    readonly messageTs: string;
    readonly renderFingerprint: string;
  },
>(
  row: Row | undefined,
  convert: (row: Row) => RecordType,
): RecordType | null {
  return row === undefined ? null : convert(row);
}

/** Current Gate schema is a fail-closed boundary: exact shape, SQLite integrity, and every row. */
function validateCurrentGateStore(
  db: DatabaseSync,
  path: string,
  fault?: (point: 'after_resolution_rows') => void,
): void {
  // Cross-table invariants must be evaluated from one WAL read snapshot. Without this transaction,
  // a live daemon can commit intent+outbox between the two SELECTs and make another valid opener
  // reject an internally consistent store as corrupt.
  db.exec('BEGIN');
  try {
  // Operational rows use a static/redacted failure surface even when SQLite quick_check would
  // otherwise expose only a generic integrity failure first.
  validateCurrentOperationalStore(db);
  const integrity = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== 'ok') {
    throw new Error(`store 파일의 SQLite integrity check가 실패했다: ${path}`);
  }
  for (const [table, expected] of Object.entries(CURRENT_GATE_COLUMNS)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { readonly name: string }[];
    const actual = rows.map((row) => row.name);
    if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
      throw new Error(`store 파일의 ${table} persisted shape가 current Gate schema와 어긋난다: ${path}`);
    }
  }
  const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  const gateSchemaObjects = {
    ...GATE_V8_SCHEMA_OBJECTS,
    ...GATE_V9_SCHEMA_OBJECTS,
    ...GATE_V10_SCHEMA_OBJECTS,
    ...GATE_V11_SCHEMA_OBJECTS,
    ...GATE_V12_SCHEMA_OBJECTS,
  };
  for (const [name, expected] of Object.entries(gateSchemaObjects)) {
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'index')`,
    ).get(name) as { readonly sql: string | null } | undefined;
    if (row?.sql === null || row === undefined || normalizeSql(row.sql) !== normalizeSql(expected)) {
      throw new Error(`store 파일의 ${name} persisted DDL이 strict Gate shape와 어긋난다: ${path}`);
    }
  }
  const expectedD2Objects = new Set(Object.keys(gateSchemaObjects));
  const unexpectedD2Objects = (db.prepare(
    `SELECT type, name, tbl_name FROM sqlite_master
      WHERE (type = 'trigger' AND tbl_name IN
              ('gate_metadata','gate_message','gate_local_observation','gate_observation_generation','gate_direct_modal','gate_resolution',
               'gate_resolution_outbox','gate_resolution_attempt','gate_resolution_audit','gate_channel_delivery','gate_resume_observation'))
         OR (type = 'table' AND
              (name LIKE 'gate_metadata%' OR name LIKE 'gate_message%' OR
               name LIKE 'gate_local_observation%' OR name LIKE 'gate_observation_generation%' OR
               name LIKE 'gate_direct_modal%' OR
               name LIKE 'gate_resolution%' OR name LIKE 'gate_channel_delivery%' OR
               name LIKE 'gate_resume_observation%'))
         OR (type = 'index' AND tbl_name IN
              ('gate_metadata','gate_message','gate_local_observation','gate_observation_generation','gate_direct_modal','gate_resolution',
               'gate_resolution_outbox','gate_resolution_attempt','gate_resolution_audit','gate_channel_delivery','gate_resume_observation'))`,
  ).all() as {
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
  }[]).filter((row) =>
    !row.name.startsWith('sqlite_autoindex_') && !expectedD2Objects.has(row.name),
  );
  if (unexpectedD2Objects.length > 0) {
    throw new Error(`store 파일에 current code-owned Gate shape 밖의 schema object가 있다: ${path}`);
  }
  const metadatas = (db.prepare(
    `SELECT gate_key, run_key, task_key, dispatch_key, ask_message_id, question_thread_id,
            options_json, recommendation_option_id, recommendation_reason, impact, registered_at
       FROM gate_metadata ORDER BY gate_key`,
  ).all() as GateMetadataRow[]).map(toGateMetadata);
  const messages = (db.prepare(
    `SELECT gate_key, run_key, channel_id, thread_ts, message_ts, render_fingerprint,
            created_at, updated_at FROM gate_message ORDER BY gate_key`,
  ).all() as GateMessageRow[]).map(toGateMessage);
  const observationRows = db.prepare(
    `SELECT gate_key, run_key, task_key, status, resolution, resolved_at,
            metadata_state, mapping_state, write_owner, write_expires_at, observed_at
       FROM gate_local_observation ORDER BY gate_key`,
  ).all() as GateLocalObservationRow[];
  const observations = observationRows.map(toGateLocalObservation);
  const generations = db.prepare(
    `SELECT gate_key, revision FROM gate_observation_generation ORDER BY gate_key`,
  ).all() as GateObservationGenerationRow[];
  const observationGateKeys = new Set(observationRows.map((observation) => observation.gate_key));
  for (const generation of generations) {
    storedKey(generation.gate_key, 'gate:', 'gate_observation_generation.gate_key');
    storedRevision(generation.revision, `${generation.gate_key}.observation revision`);
    if (!observationGateKeys.has(generation.gate_key)) {
      throw new Error(`store 파일에 local observation 없는 generation이 있다: ${path}`);
    }
  }
  const modalSessions = (db.prepare(SELECT_ALL_GATE_DIRECT_MODALS).all() as GateDirectModalRow[])
    .map(toGateDirectModal);
  const intents = (db.prepare(SELECT_ALL_GATE_RESOLUTIONS).all() as GateResolutionRow[]).map(
    toGateResolution,
  );
  fault?.('after_resolution_rows');
  const outboxes = (db.prepare(
    `SELECT gate_key, revision, card_state, card_pending, notification_state, projected_at,
            projection_owner, projection_expires_at, last_error_code, created_at, updated_at
       FROM gate_resolution_outbox ORDER BY gate_key`,
  ).all() as GateOutboxRow[]).map(toGateOutbox);
  const deliveries = (db.prepare(
    SELECT_ALL_GATE_CHANNEL_DELIVERIES,
  ).all() as GateChannelDeliveryRow[]).map(toGateChannelDelivery);
  const resumeObservations = (db.prepare(
    SELECT_ALL_GATE_RESUME_OBSERVATIONS,
  ).all() as GateResumeObservationRow[]).map(toGateResumeObservation);
  const observationByGate = new Map(observations.map((row) => [row.gateKey, row]));
  const metadataByGate = new Map(metadatas.map((row) => [row.gateKey, row]));
  const messageByGate = new Map(messages.map((row) => [row.gateKey, row]));
  const intentByGate = new Map(intents.map((row) => [row.gateKey, row]));
  const outboxByGate = new Map(outboxes.map((row) => [row.gateKey, row]));
  const deliveryByGate = new Map(deliveries.map((row) => [row.gateKey, row]));
  const resumeByGate = new Map(resumeObservations.map((row) => [row.gateKey, row]));
  const modalBySession = new Map(modalSessions.map((row) => [row.sessionId, row]));

  for (const observation of observations) {
    const metadata = metadataByGate.get(observation.gateKey);
    const message = messageByGate.get(observation.gateKey);
    if (
      (observation.metadataState === 'matched' &&
        (metadata === undefined ||
          metadata.runKey !== observation.runKey ||
          metadata.taskKey !== observation.taskKey)) ||
      (observation.metadataState === 'missing' && metadata !== undefined) ||
      (observation.metadataState === 'mismatched' && metadata === undefined) ||
      ((observation.mappingState === 'matched' || observation.mappingState === 'write_pending') &&
        (message === undefined ||
          message.runKey !== observation.runKey ||
          message.gateKey !== observation.gateKey)) ||
      (observation.mappingState === 'mismatched' && message === undefined)
    ) {
      throw new Error(`store 파일의 ${observation.gateKey} local observation correlation이 어긋난다: ${path}`);
    }
  }

  for (const session of modalSessions) {
    const metadata = metadataByGate.get(session.gateKey);
    const message = messageByGate.get(session.gateKey);
    const intent = intentByGate.get(session.gateKey);
    if (
      metadata === undefined || message === undefined ||
      message.runKey !== metadata.runKey ||
      message.channelId !== session.channelId ||
      message.threadTs !== session.threadTs ||
      message.messageTs !== session.messageTs ||
      session.blockId !== gateDirectBlockId(session.gateKey) ||
      session.actionId !== gateDirectActionId(session.gateKey) ||
      session.actionValue !== gateDirectActionValue(session.gateKey) ||
      session.callbackId !== gateDirectCallbackId(session.gateKey) ||
      session.inputBlockId !== gateDirectInputBlockId(session.gateKey) ||
      session.inputActionId !== gateDirectInputActionId(session.gateKey)
    ) {
      throw new Error(`store 파일의 ${session.gateKey} direct modal correlation이 어긋난다: ${path}`);
    }
    if (session.state === 'accepted') {
      if (
        intent === undefined || intent.optionId !== GATE_DIRECT_OPTION_ID ||
        intent.optionResolution !== session.resolutionText ||
        intent.teamId !== session.teamId || intent.ownerUserId !== session.ownerUserId ||
        intent.apiAppId !== session.apiAppId || intent.channelId !== session.channelId ||
        intent.threadTs !== session.threadTs || intent.messageTs !== session.messageTs ||
        intent.blockId !== session.inputBlockId || intent.actionId !== session.inputActionId ||
        intent.actionValue !== session.sessionId
      ) {
        throw new Error(`store 파일의 ${session.gateKey} accepted modal winner가 어긋난다: ${path}`);
      }
    } else if (intent?.optionId === GATE_DIRECT_OPTION_ID && intent.actionValue === session.sessionId) {
      throw new Error(`store 파일의 ${session.gateKey} direct winner modal이 accepted가 아니다: ${path}`);
    }
  }

  if (outboxes.some((row) => !intentByGate.has(row.gateKey))) {
    throw new Error(`store 파일에 Gate resolution 없는 orphan outbox가 있다: ${path}`);
  }
  if (deliveries.some((row) => !outboxByGate.has(row.gateKey))) {
    throw new Error(`store 파일에 D2 outbox 없는 orphan Channel delivery가 있다: ${path}`);
  }
  if (resumeObservations.some((row) => !deliveryByGate.has(row.gateKey))) {
    throw new Error(`store 파일에 Channel delivery 없는 orphan resume observation이 있다: ${path}`);
  }
  if (
    observations.some(
      (observation) =>
        observation.mappingState === 'write_pending' &&
        (intentByGate.has(observation.gateKey) || outboxByGate.has(observation.gateKey)),
    )
  ) {
    // beginGateObservationWrite and claimGateResolution are serialized BEGIN IMMEDIATE
    // transactions. This combination therefore cannot be produced by this code and would make
    // ordinary/D2 projection precedence unknowable.
    throw new Error(`store 파일에 ordinary write fence와 Gate resolution이 함께 존재한다: ${path}`);
  }
  for (const intent of intents) {
    const metadata = metadataByGate.get(intent.gateKey);
    const message = messageByGate.get(intent.gateKey);
    const observation = observationByGate.get(intent.gateKey);
    const outbox = outboxByGate.get(intent.gateKey);
    if (metadata === undefined || message === undefined || observation === undefined || outbox === undefined) {
      throw new Error(`store 파일의 ${intent.gateKey} resolution correlation row가 불완전하다: ${path}`);
    }
    const directSession = intent.optionId === GATE_DIRECT_OPTION_ID
      ? modalBySession.get(intent.actionValue)
      : undefined;
    const option = metadata.options.filter((candidate) => candidate.id === intent.optionId);
    const sourceCorrelation = directSession === undefined
      ? option.length === 1 &&
        option[0]?.resolution === intent.optionResolution &&
        intent.blockId === gateBlockId(intent.gateKey) &&
        intent.actionId === gateActionId(intent.gateKey, intent.optionId) &&
        intent.actionValue === intent.optionId
      : directSession.state === 'accepted' &&
        directSession.gateKey === intent.gateKey &&
        directSession.resolutionText === intent.optionResolution &&
        directSession.inputBlockId === intent.blockId &&
        directSession.inputActionId === intent.actionId &&
        directSession.sessionId === intent.actionValue;
    if (
      !sourceCorrelation ||
      metadata.askMessageId !== intent.askMessageId ||
      metadata.questionThreadId !== intent.questionThreadId ||
      metadata.dispatchKey !== `dispatch:${intent.dispatchId}` ||
      metadata.taskKey !== `task:${intent.taskId}` ||
      message.runKey !== metadata.runKey || message.channelId !== intent.channelId ||
      message.threadTs !== intent.threadTs || message.messageTs !== intent.messageTs ||
      observation.runKey !== metadata.runKey || observation.taskKey !== metadata.taskKey
    ) {
      throw new Error(`store 파일의 ${intent.gateKey} resolution correlation이 어긋난다: ${path}`);
    }
    for (const snapshot of [intent.preRead, intent.resolveResult?.gate ?? null, intent.postRead]) {
      if (snapshot === null) continue;
      if (
        `gate:${snapshot.gateId}` !== intent.gateKey ||
        `run:${snapshot.runId}` !== metadata.runKey ||
        `task:${snapshot.taskId}` !== metadata.taskKey ||
        snapshot.options.length !== metadata.options.length ||
        !snapshot.options.every((label, index) => label === metadata.options[index]?.label)
      ) {
        throw new Error(`store 파일의 ${intent.gateKey} persisted Orca snapshot이 어긋난다: ${path}`);
      }
    }
    if (
      intent.resolveResult !== null &&
      (intent.resolveResult.mutation.requestId !== intent.retryRequestId ||
        intent.resolveResult.gate.status !== 'resolved' ||
        intent.resolveResult.gate.resolution !== intent.optionResolution)
    ) {
      throw new Error(`store 파일의 ${intent.gateKey} retry request identity가 어긋난다: ${path}`);
    }
    const expectedCard = cardStateForLifecycle(intent.lifecycle);
    if (
      outbox.cardState !== expectedCard ||
      outbox.lastErrorCode !== intent.lastErrorCode ||
      outbox.createdAt !== intent.createdAt ||
      (outbox.cardPending && outbox.projectedAt !== null) ||
      (!outbox.cardPending && outbox.projectedAt === null)
    ) {
      throw new Error(`store 파일의 ${intent.gateKey} lifecycle/outbox projection이 어긋난다: ${path}`);
    }
    // `toGateResolution` already applies the same lifecycle/evidence matrix used before every
    // progress write. The remaining checks in this loop are cross-table correlations only.
  }

  for (const delivery of deliveries) {
    const intent = intentByGate.get(delivery.gateKey);
    const metadata = metadataByGate.get(delivery.gateKey);
    const outbox = outboxByGate.get(delivery.gateKey);
    const pre = intent?.preRead;
    const post = intent?.postRead;
    const resume = resumeByGate.get(delivery.gateKey);
    if (
      intent === undefined || metadata === undefined || outbox === undefined ||
      intent.ackState !== 'acked' || intent.lifecycle !== 'resolved' ||
      pre?.status !== 'pending' || pre.resolution !== null || pre.resolvedAt !== null ||
      post?.status !== 'resolved' || post.resolution !== intent.optionResolution ||
      intent.resolveResult?.gate.resolvedAt !== post.resolvedAt ||
      delivery.runKey !== metadata.runKey || delivery.taskKey !== metadata.taskKey ||
      delivery.sourceDispatchId !== intent.dispatchId ||
      outbox.notificationState !== 'pending' ||
      delivery.deferredOutboxRevision > outbox.revision ||
      (
        delivery.deferredOutboxRevision === outbox.revision &&
        (!outbox.cardPending || outbox.projectedAt !== null)
      ) ||
      delivery.createdAt < intent.createdAt ||
      delivery.createdAt < intent.updatedAt ||
      delivery.createdAt < outbox.createdAt ||
      delivery.createdAt < metadata.registeredAt ||
      (post.resolvedAt !== null && delivery.createdAt < post.resolvedAt) ||
      (
        intent.resolveResult?.gate.resolvedAt !== null &&
        intent.resolveResult?.gate.resolvedAt !== undefined &&
        delivery.createdAt < intent.resolveResult.gate.resolvedAt
      )
    ) {
      throw new Error(`store 파일의 ${delivery.gateKey} Channel/D2 correlation이 어긋난다: ${path}`);
    }
    const baselineCorrelation = resume !== undefined &&
      resume.baseline.sourceTaskId === delivery.taskKey.slice('task:'.length) &&
      resume.baseline.sourceDispatchId === delivery.sourceDispatchId &&
      resume.createdAt >= delivery.createdAt;
    const latestCorrelation = resume?.latest === null || resume?.latest === undefined ||
      (resume.latest.sourceTaskId === resume.baseline.sourceTaskId &&
        resume.latest.sourceDispatchId === resume.baseline.sourceDispatchId);
    if (
      (delivery.resumeBaselineState === 'unavailable' && resume !== undefined) ||
      (delivery.resumeBaselineState === 'required' &&
        (resume !== undefined || delivery.state !== 'pending' || delivery.attemptCount !== 0)) ||
      (delivery.resumeBaselineState === 'recorded' && !baselineCorrelation) ||
      !latestCorrelation ||
      (resume !== undefined && resume.evidence === null &&
        (delivery.state === 'receipted' || delivery.state === 'consumed') &&
        resume.nextObservationAt === null) ||
      (resume !== undefined && resume.evidence === null &&
        (delivery.state === 'pending' || delivery.state === 'attempted') &&
        resume.nextObservationAt !== null)
    ) {
      throw new Error(`store 파일의 ${delivery.gateKey} resume baseline/lifecycle correlation이 어긋난다: ${path}`);
    }
  }
  if (deliveryByGate.size !== deliveries.length) {
    throw new Error(`store 파일에 중복 Channel delivery identity가 있다: ${path}`);
  }
  if (resumeByGate.size !== resumeObservations.length) {
    throw new Error(`store 파일에 중복 resume observation identity가 있다: ${path}`);
  }

  const attempts = db.prepare(
    `SELECT gate_key, phase, outcome, detail, created_at FROM gate_resolution_attempt ORDER BY id`,
  ).all() as {
    readonly gate_key: string;
    readonly phase: string;
    readonly outcome: string;
    readonly detail: string | null;
    readonly created_at: string;
  }[];
  for (const row of attempts) {
    const gateKey = storedKey(row.gate_key, 'gate:', 'gate_resolution_attempt.gate_key') as GateKey;
    if (!intentByGate.has(gateKey)) {
      throw new Error(`store 파일에 resolution intent 없는 Gate attempt가 있다: ${path}`);
    }
    gateCode(row.phase, 40);
    gateCode(row.outcome, 40);
    if (row.detail !== null) storedText(row.detail, 'gate resolution attempt.detail', GATE_FACT_CAP);
    storedIso(row.created_at, 'gate resolution attempt.created_at');
  }
  const audits = db.prepare(
    `SELECT gate_key, event, reason, created_at FROM gate_resolution_audit ORDER BY id`,
  ).all() as {
    readonly gate_key: string | null;
    readonly event: string;
    readonly reason: string;
    readonly created_at: string;
  }[];
  const winnerAuditCounts = new Map<GateKey, number>();
  for (const row of audits) {
    let correlatedGate: GateKey | null = null;
    if (row.gate_key !== null) {
      correlatedGate = storedKey(
        row.gate_key,
        'gate:',
        'gate_resolution_audit.gate_key',
      ) as GateKey;
      if (!messageByGate.has(correlatedGate)) {
        throw new Error(`store 파일에 Gate message 없는 correlated audit가 있다: ${path}`);
      }
    }
    gateCode(row.event, 40);
    gateCode(row.reason, 80);
    const createdAt = storedIso(row.created_at, 'gate resolution audit.created_at');
    if (row.event === 'claimed' || row.reason === 'first_valid_selection') {
      if (
        row.event !== 'claimed' ||
        row.reason !== 'first_valid_selection' ||
        correlatedGate === null
      ) {
        throw new Error(`store 파일의 canonical winner audit shape가 어긋난다: ${path}`);
      }
      const intent = intentByGate.get(correlatedGate);
      if (intent === undefined || createdAt !== intent.createdAt) {
        throw new Error(`store 파일에 resolution intent 없는 orphan claimed audit가 있다: ${path}`);
      }
      winnerAuditCounts.set(correlatedGate, (winnerAuditCounts.get(correlatedGate) ?? 0) + 1);
    }
  }
  for (const intent of intents) {
    if (winnerAuditCounts.get(intent.gateKey) !== 1) {
      throw new Error(`store 파일의 ${intent.gateKey} canonical winner audit가 정확히 하나가 아니다: ${path}`);
    }
  }
  const overLimit = db.prepare(
    `SELECT gate_key FROM gate_resolution_attempt GROUP BY gate_key HAVING COUNT(*) > ?
      UNION ALL
     SELECT gate_key FROM gate_resolution_audit GROUP BY gate_key HAVING COUNT(*) > ?`,
  ).all(GATE_AUDIT_LIMIT, GATE_AUDIT_LIMIT);
  if (overLimit.length > 0) throw new Error(`store 파일의 Gate append-only evidence가 상한을 넘었다: ${path}`);
  db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
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
function prepareSchema(
  db: DatabaseSync,
  path: string,
  validationFault?: (point: 'after_resolution_rows') => void,
  migrationFault?: (fromVersion: number, statementIndex: number) => void,
): void {
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
    validateCurrentGateStore(db, path, validationFault);
    return;
  }

  applyMigrations(db, path, version, migrationFault);
  validateCurrentGateStore(db, path, validationFault);
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
function applyMigrations(
  db: DatabaseSync,
  path: string,
  from: number,
  migrationFault?: (fromVersion: number, statementIndex: number) => void,
): void {
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
      for (const [statementIndex, statement] of step.entries()) {
        db.exec(statement);
        migrationFault?.(v, statementIndex);
      }
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
