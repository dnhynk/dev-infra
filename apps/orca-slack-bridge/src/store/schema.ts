import type { CheckFact } from '../github/pull-request.js';
import type { GateKey, PullRequestKey, RunKey, TaskKey } from '../identity/keys.js';
import type { PrTerminal, ReviewerResult } from '../digest/types.js';
import type { GateMetadata } from '../gate/types.js';
import type {
  GateChannelDeliveryStore,
  GateLocalObservation,
  GateResolutionStore,
} from '../gate/resolution-types.js';
import type { GateDirectInputStore } from '../gate/direct-input-types.js';

/**
 * durable store 스키마와 접근 경계.
 *
 * 기술은 `node:sqlite`다(OD-043). 새 의존성이 필요 없고 Node 26 런타임에 들어 있다.
 * 기본 경로는 `%APPDATA%\orca-slack-bridge\state.db`이며, 그 외 플랫폼에서는
 * `XDG_DATA_HOME` 또는 `~/.local/share` 아래 같은 이름을 쓴다.
 *
 * 경로 결정 순서: `--state <path>` 인자 → `ORCA_SLACK_BRIDGE_STATE` → 기본 경로.
 * 설정 파일에는 두지 않는다. 설정 파일은 저장소 밖에서 공유하는 값이고 store 경로는
 * 머신마다 다르므로 환경변수가 맞는 자리다.
 *
 * 단일 프로세스 가정이므로 파일 lock을 만들지 않는다. WAL만 켠다.
 *
 * 스키마가 보장하는 것과 보장하지 않는 것을 구분한다.
 *
 * 보장한다.
 *
 * - PR당 매핑 행이 하나다 → `pr_message.pr_key`가 PRIMARY KEY다.
 * - 두 PR이 한 Slack 메시지를 가리키지 않는다 → `UNIQUE(channel_id, message_ts)`다.
 * - 재시작 후 기존 메시지를 찾아 update할 수 있다 → channel/ts를 그 행에 함께 남긴다.
 * - 한 PR을 여러 Task가 이어서 갱신해도 이전 Task와의 연관이 남는다 → `pr_task`가 (PR, Task)
 *   쌍마다 한 행이다(OD-076). PR body는 primary/latest Task 하나만 담으므로 body만으로는
 *   이전 Task를 복원할 수 없다.
 *
 * 보장하지 않는다.
 *
 * - **Slack 루트가 PR당 하나라는 것.** PRIMARY KEY는 매핑 행의 유일성만 강제하고 이미
 *   게시된 Slack 메시지를 되돌리지 못한다. 루트가 하나 더 생길 수 있는 창이 둘이다.
 *
 * 창 1 — crash. `chat.postMessage`가 성공한 뒤 `insertPrMessage` 전에 프로세스가 죽으면
 * 매핑 행이 없으므로 다음 실행이 루트를 하나 더 만든다.
 *
 * 창 2 — delivery unknown. 프로세스가 죽지 않아도 게시 여부를 알 수 없는 실패가 있다.
 * 응답을 받지 못한 경우가 그렇고, 응답을 받았어도 Slack이 부분 성공 가능성을 명시하는
 * 오류(`internal_error`, `fatal_error`)가 그렇다. 판정 기준은 `slack/post.ts`에 적었다.
 * 호출자에게는 실패로 보이므로 매핑 행이 남지 않고, 같은 실행의 재시도나 다음 관찰이 루트를
 * 하나 더 만들 수 있다. 요청을 두 번 보내도 같은 요청임을 Slack이 알아볼 안정적인 identity가
 * 없으면 이 창은 닫히지 않는다.
 *
 * 두 창을 C1에서 닫지 않는다. 스펙 §9가 crash 경계별 atomicity와 outbox를 TBD로 두었고
 * 같은 성격의 미결정 항목이 OD-051이다. 지금 outbox나 2단계 commit이나 요청 idempotency
 * key를 설계하면 미결정 항목을 구현자가 조용히 닫는 것이 된다.
 *
 * **구현자에게**: 이 성질이 보장된 것처럼 쓰지 마라. `SlackPoster.post`가 던진 실패는
 * "메시지가 만들어지지 않았다"는 뜻이 아니다. 결과를 모르는 실패를 자동 재시도로 덮으면
 * 루트가 늘어난다.
 *
 * C1 출구 조건 "재관찰로 루트가 중복되지 않음"(로드맵 §5)이 검증하는 것은 하나다. 매핑
 * 행이 남은 뒤의 재관찰이 `findPrMessage`로 기존 행을 찾아 `chat.update`로 간다는 것.
 * 검증하지 않는 것은 위의 두 창이다. 그 둘에서는 매핑 행이 아예 없으므로 재관찰이 루트를
 * 새로 만든다.
 *
 * - **thread에 이미 기록한 전이가 다시 기록되지 않는다** → `pr_thread_event`의 PRIMARY KEY가
 *   (PR, dedupe key)다. 보장 범위는 `PR_THREAD_EVENT_TABLE`에 적었다.
 * - 이전 관측의 terminal과 check resource를 다음 관측이 읽을 수 있다 → `pr_state`가 PR당 한 행이다.
 *
 * D2-C는 v7 sidecar/thread mapping 위에 local Gate observation, immutable winner intent,
 * bounded evidence와 card/notification outbox를 additive v8로 덧붙인다. v9는 그 v8 행을
 * 재작성하지 않고 ordinary Slack completion을 fence하는 monotonic generation 표만 덧붙인다.
 * D3는 v10 outbox를 재작성하지 않고 additive v11 delivery sidecar를 덧붙인다. v12는 그
 * delivery에 legacy baseline 격리 표지를 붙이고 normalized resume evidence sidecar를 더한다.
 * v10의 `notification_state`는 계속 `pending` 하나만 허용하며 D3 lifecycle은 별도 표가 소유한다.
 */

/** 현재 스키마 버전. `MIGRATIONS.length + 1`과 반드시 같다. */
export const SCHEMA_VERSION = 12;

/** durable store 경로를 덮어쓰는 환경변수. */
export const STATE_PATH_VAR = 'ORCA_SLACK_BRIDGE_STATE';

/**
 * 열자마자 실행한다. WAL은 OD-043 결정이다.
 *
 * 결과 mode를 반드시 읽는다. 전환에 실패해도 예외가 아니라 지금의 mode가 돌아오므로
 * `exec`로 던져놓으면 WAL이 아닌 채로 열린다. 판정은 `sqlite.ts`의 `enableWal`에 있다.
 */
export const ENABLE_WAL = 'PRAGMA journal_mode = WAL';

/**
 * `pr_task` 테이블 DDL. **`SCHEMA_DDL`과 `MIGRATIONS`가 같은 문자열을 쓴다.**
 *
 * 새 파일과 기존 파일이 다른 스키마로 갈라지는 것이 이 파일의 알려진 함정이다. 테이블 추가는
 * 컬럼 추가와 달리 문장 전체를 두 곳에 적게 되므로 상수 하나로 묶어 갈라질 자리를 없앤다.
 *
 * 여기만 `IF NOT EXISTS`가 없다. `MIGRATIONS`가 이 문장을 v2 파일에 거는데, 그 파일에 이미
 * `pr_task`가 있다면 이 코드가 만든 파일이 아니다. 모양을 대조하지 않은 채 v3으로 도장을 찍는
 * 것보다 던지는 편이 맞다(`win32StateBase`와 같은 판정).
 *
 * `PRIMARY KEY (pr_key, task_key)`가 보장하는 것은 같은 (PR, Task) 쌍이 두 행이 되지 않는다는
 * 것뿐이다. 한 PR에 여러 Task 행이 남는 것이 OD-076이 요구하는 모양이다.
 */
const PR_TASK_TABLE = `
CREATE TABLE pr_task (
  -- identity/keys.ts의 PullRequestKey와 TaskKey. 값은 pr_message.pr_key와 같은 형식이다.
  pr_key        TEXT NOT NULL,
  task_key      TEXT NOT NULL,
  -- 이 Task가 속한 Run. resolveCorrelation이 이미 task↔run 일치를 대조한 뒤의 값이다.
  -- Orca live 상태가 사라진 뒤에도 저장된 연관을 그것만으로 읽을 수 있게 함께 남긴다.
  run_key       TEXT NOT NULL,
  -- 이 쌍을 처음 관측한 시각과 마지막으로 관측한 시각. 둘 다 ISO8601이다.
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (pr_key, task_key)
)`;

/**
 * `pr_state` 테이블 DDL. `PR_TASK_TABLE`과 같은 이유로 상수 하나로 묶는다.
 *
 * 이 표가 담는 것은 **직전 관측의 사실**이고 용도는 하나다. 다음 관측을 이 값과 reconcile하는
 * 것(OD-044). 카드에 그릴 값을 여기서 읽지 않는다 — 카드는 reconcile 결과에서 나온다.
 *
 * `terminal`은 **reconcile된 뒤의 값**을 적는다. 관측한 값을 그대로 적으면 오래된 snapshot이
 * `merged`를 지워, 그 다음 관측에는 되돌릴 근거 자체가 남지 않는다. `merged` downgrade 금지는
 * timestamp 비교가 아니라 terminal dominance rule이다(OD-044, `digest/state.ts`).
 *
 * `merged_at`은 `merged` latch의 occurred time이다. 한 번 채워지면 비우지 않는다. 같은 이유로
 * 오래된 snapshot의 `mergedAt: null`이 이 값을 지우지 않는다.
 *
 * `checks_json`은 reconcile된 `CheckFact` 배열이다. 배열을 정규화된 표로 펼치지 않는다. 이
 * 값을 조건으로 조회하는 코드가 없고(읽는 곳은 "이 PR의 직전 check 전부" 하나뿐이다) 표로
 * 펼치면 `CheckFact`가 늘 때마다 파괴적 migration이 필요해진다. 파괴적 변경은 `MIGRATIONS`가
 * 다루지 않는 부류다.
 *
 * `checks_head_sha`가 `checks_json`의 scope다. 이 값이 다르면 두 관측의 check는 서로 다른
 * commit의 사실이라 resource 단위로 합칠 대상이 아니다(OD-044: review/check scope는 headSha다).
 */
const PR_STATE_TABLE = `
CREATE TABLE pr_state (
  -- identity/keys.ts의 PullRequestKey. pr_message.pr_key와 같은 형식이다.
  pr_key            TEXT PRIMARY KEY,
  -- reconcile된 terminal. 관측값이 아니다.
  terminal          TEXT NOT NULL,
  -- merged latch의 occurred time. 한 번 채워지면 비우지 않는다.
  merged_at         TEXT,
  -- 직전 관측의 reviewer verdict와 그 reviewer가 본 commit. 없으면 둘 다 NULL이다.
  review_verdict    TEXT,
  reviewed_head_sha TEXT,
  -- 직전 관측의 현재 head와 checks가 매달린 head. 둘은 다를 수 있다(OD-044).
  head_sha          TEXT NOT NULL,
  checks_head_sha   TEXT NOT NULL,
  -- reconcile된 CheckFact 배열의 JSON. scope는 checks_head_sha다.
  checks_json       TEXT NOT NULL,
  observed_at       TEXT NOT NULL
)`;

/**
 * `pr_thread_event` 테이블 DDL. `PR_TASK_TABLE`과 같은 이유로 상수 하나로 묶는다.
 *
 * **이 표가 보장하는 것과 보장하지 않는 것을 구분한다.** `pr_message`와 같은 규율이다.
 *
 * 보장한다.
 *
 * - 같은 (PR, dedupe key)로 두 행이 생기지 않는다 → PRIMARY KEY가 강제한다.
 * - Bridge가 재시작해도 무엇을 이미 기록했는지 안다 → 판정 근거가 프로세스 메모리가 아니라
 *   이 파일이다. 같은 사실을 다시 관측하면 후보 key가 이미 여기 있으므로 reply가 생기지 않는다.
 * - 첫 관측에서 과거를 재생하지 않는다 → 그때는 현재 참인 후보 전부를 `message_ts` NULL로
 *   적어 둔다(seed). 게시하지 않았다는 사실이 행에 남는다(OD-046).
 *
 * 보장하지 않는다.
 *
 * - **thread reply가 PR당 전이당 하나라는 것.** `pr_message`와 같은 두 창이 그대로 있다.
 *   reply가 게시된 뒤 이 행을 넣기 전에 죽으면(창 1), 그리고 게시 여부를 알 수 없는 실패로
 *   호출자가 실패를 받으면(창 2, `slack/post.ts`의 판정) 행이 남지 않아 다음 관측이 같은
 *   전이를 다시 게시한다. 두 창은 C1에서 닫지 않기로 한 것과 같은 미결정 항목이다(스펙 §9,
 *   OD-051). 여기서 outbox나 요청 idempotency key를 만들지 않는다.
 * - **전이가 빠짐없이 기록된다는 것.** 후보는 지금 참인 사실에서 나온다. 참이었다가 다시
 *   거짓이 된 사실은 다음 관측에서 후보가 아니므로 기록되지 않는다. 이 표는 과소보고 쪽으로
 *   안전하며 "한 번만 기록"(로드맵 §6)이 요구하는 방향과 같다.
 *
 * `message_ts`는 게시된 reply의 ts다. NULL은 seed 행이며 "이 전이는 게시하지 않기로 했다"는
 * 뜻이다. 게시에 실패한 전이는 행 자체가 없다 — 실패를 기록으로 바꾸면 그 전이가 영영 사라진다.
 */
const PR_THREAD_EVENT_TABLE = `
CREATE TABLE pr_thread_event (
  -- identity/keys.ts의 PullRequestKey. pr_message.pr_key와 같은 형식이다.
  pr_key      TEXT NOT NULL,
  -- 전이 하나를 식별하는 값. 관측 순서가 아니라 전이의 내용에서 파생한다(digest/transition.ts).
  dedupe_key  TEXT NOT NULL,
  -- 전이 종류. dedupe_key에 이미 들어 있지만 사람이 이 표를 읽을 수 있어야 한다.
  kind        TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  -- 게시된 thread reply의 ts. NULL은 seed 행이고 게시하지 않았다는 뜻이다.
  message_ts  TEXT,
  PRIMARY KEY (pr_key, dedupe_key)
)`;

/**
 * `run_message` 테이블 DDL. `PR_TASK_TABLE`과 같은 이유로 상수 하나로 묶는다.
 *
 * `pr_message`가 PR에 하는 일을 Run에 한다. Run 하나가 `#agent-runs`의 루트 메시지 하나에
 * 매핑되고, 재관찰과 재시작이 그 매핑을 찾아 `chat.update`로 간다(로드맵 §7 출구 조건).
 *
 * **`pr_message`와 달리 요약 관련 컬럼이 없다.** Run 카드는 LLM을 부르지 않는 결정적
 * renderer의 출력이므로(`run/render.ts`) 재사용할 요약도, 요약 입력의 지문도 없다. 없는
 * 컬럼을 대칭을 위해 만들지 않는다.
 *
 * 보장하는 것.
 *
 * - Run당 매핑 행이 하나다 → `run_key`가 PRIMARY KEY다.
 * - 두 Run이 한 Slack 메시지를 가리키지 않는다 → `RUN_MESSAGE_INDEX`가 강제한다.
 * - 재시작 후 기존 메시지를 찾아 update할 수 있다 → channel/ts를 그 행에 함께 남긴다.
 *
 * 보장하지 않는 것.
 *
 * - **Slack 루트가 Run당 하나라는 것.** `pr_message`와 **같은 두 창**이 그대로 있다. 창 1은
 *   crash다 — `chat.postMessage`가 성공한 뒤 `insertRunMessage` 전에 죽으면 매핑 행이 없으므로
 *   다음 실행이 루트를 하나 더 만든다. 창 2는 delivery unknown이다 — 응답을 받지 못했거나
 *   Slack이 부분 성공 가능성을 명시하는 오류(`internal_error`, `fatal_error`)를 준 경우
 *   호출자에게는 실패로 보이지만 메시지는 이미 있을 수 있다(판정 기준은 `slack/post.ts`).
 *   그 실행에는 매핑 행이 남지 않으므로 다음 관찰이 루트를 하나 더 만든다.
 *
 *   두 창을 D1에서 닫지 않는다. 스펙 §9가 crash 경계별 atomicity와 outbox를 TBD로 두었고 같은
 *   성격의 미결정 항목이 OD-051이다. 여기서 outbox나 요청 idempotency key를 만들면 미결정
 *   항목을 구현자가 조용히 닫는 것이 된다.
 *
 * - **한 Slack 메시지가 Run과 PR에 동시에 매핑되지 않는다는 것.** 두 unique index는 각자의
 *   표 안에서만 유효하다. 실무에서는 두 카드가 다른 채널(`agentRuns`·`prDigest`)로 가므로
 *   겹치지 않지만, 그것은 설정이 만드는 성질이지 스키마가 강제하는 성질이 아니다.
 *
 * D1 출구 조건 "재시작 뒤 같은 Run root를 재사용함"(로드맵 §7)이 검증하는 것은 하나다. 매핑
 * 행이 남은 뒤의 재관찰이 `findRunMessage`로 기존 행을 찾아 `chat.update`로 간다는 것.
 * 검증하지 않는 것은 위의 두 창이다.
 */
const RUN_MESSAGE_TABLE = `
CREATE TABLE run_message (
  -- identity/keys.ts의 RunKey. 형식은 run:<Orca run id>다.
  -- Orca Run ID는 Run마다 새로 발급되므로 이 key가 다른 Run과 겹치지 않는다.
  run_key            TEXT PRIMARY KEY,
  -- chat.update는 channel과 ts를 함께 요구한다. 또한 대상 채널 설정이 바뀌었을 때
  -- 예전 채널의 ts로 update를 시도하는 대신 불일치를 판정할 수 있다.
  channel_id         TEXT NOT NULL,
  message_ts         TEXT NOT NULL,
  -- 마지막으로 게시한 카드의 지문. 같으면 chat.update를 호출하지 않는다.
  render_fingerprint TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
)`;

/** 두 Run이 같은 Slack 메시지를 가리키면 한 카드가 다른 카드를 덮어쓴다. */
const RUN_MESSAGE_INDEX = `
CREATE UNIQUE INDEX run_message_slack_identity ON run_message (channel_id, message_ts)`;

/**
 * `run_collection_message` 테이블 DDL. `PR_TASK_TABLE`과 같은 이유로 상수 하나로 묶는다.
 *
 * **컬렉션 루트는 Run이 아니다.** `run_message`에 끼워 넣지 않는 이유가 그것이다. 그 표의
 * PRIMARY KEY 컬럼 이름은 `run_key`이고 그 옆 주석이 "형식은 run:<Orca run id>다"라고 못박는다.
 * Run이 아닌 값을 그 칸에 넣으면 컬럼 이름이 거짓이 되는데, 컬럼 rename은 파괴적 변경이라 이
 * 파일이 금지한다. 되돌릴 수 없는 잘못된 이름을 남기는 대신 표를 나눈다(OD-080).
 *
 * ## 이 루트가 존재하는 이유
 *
 * 미등록 Run 수와 컬렉션 수준 degraded는 Run 카드에도 실리지만(`run/render.ts`), 등록된 Run이
 * 하나도 없으면 카드가 하나도 없어 그 수가 Slack 어디에도 나타나지 않는다. **그 구간이 정확히
 * OD-078이 감수한 위험 — 등록 열쇠가 통째로 어긋나 Run이 조용히 사라지는 구간 — 이다.** 완화
 * 장치가 바로 그때 보이지 않으면 완화 장치가 아니다. 그래서 이 루트는 **등록 Run 수와 무관하게
 * 항상 게시된다.** 조건부로 만들면 장치가 조건부가 된다.
 *
 * ## 왜 한 행인가
 *
 * 설정의 `slack.channels.agentRuns`가 하나이므로 컬렉션 루트도 하나다. `CHECK (id = 1)`이
 * `schema_version`과 같은 방식으로 그것을 스키마 수준에서 강제한다. 채널 설정이 바뀌면 새 루트를
 * 만들지 않고 `channel_id` 불일치를 드러낸다 — `run_message`와 같은 판정이다.
 *
 * 보장하지 않는 것은 `run_message`와 같다. crash와 delivery unknown 두 창은 그대로 있고 D1에서
 * 닫지 않는다. 근거는 `RUN_MESSAGE_TABLE`에 있고 여기서 다시 적지 않는다.
 *
 * 한 Slack 메시지가 이 루트와 Run 루트에 동시에 매핑되지 않는다는 것도 스키마가 강제하지
 * 않는다. 두 표의 제약은 각자의 표 안에서만 유효하다.
 */
const RUN_COLLECTION_MESSAGE_TABLE = `
CREATE TABLE run_collection_message (
  -- 한 행만 존재한다. 설정의 slack.channels.agentRuns가 하나이므로 컬렉션 루트도 하나다.
  -- 여러 행이 공존하면 어느 것이 현재 루트인지 알 수 없다(schema_version과 같은 판정).
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  -- chat.update는 channel과 ts를 함께 요구한다. 또한 대상 채널 설정이 바뀌었을 때
  -- 예전 채널의 ts로 update를 시도하는 대신 불일치를 판정할 수 있다.
  channel_id         TEXT NOT NULL,
  message_ts         TEXT NOT NULL,
  -- 마지막으로 게시한 카드의 지문. 같으면 chat.update를 호출하지 않는다.
  render_fingerprint TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
)`;

/**
 * Coordinator가 등록한 ask↔Gate mapping과 option metadata. Orca 원문을 복제해 대체하지 않고,
 * Gate ID에 없는 안정적 option identity/recommendation/impact만 보존한다(DL-040).
 */
const GATE_METADATA_TABLE = `
CREATE TABLE gate_metadata (
  gate_key                 TEXT PRIMARY KEY,
  run_key                  TEXT NOT NULL,
  task_key                 TEXT NOT NULL,
  dispatch_key             TEXT NOT NULL,
  ask_message_id           TEXT NOT NULL UNIQUE,
  question_thread_id       TEXT NOT NULL,
  options_json             TEXT NOT NULL,
  recommendation_option_id TEXT NOT NULL,
  recommendation_reason    TEXT NOT NULL,
  impact                    TEXT NOT NULL,
  registered_at             TEXT NOT NULL
)`;

/** 같은 Run의 metadata를 Gate key 순서로 읽는 production projector용 index. */
const GATE_METADATA_RUN_INDEX = `
CREATE INDEX gate_metadata_run_key ON gate_metadata (run_key, gate_key)`;

/**
 * Gate 하나와 Run root 아래 Slack reply 하나의 durable mapping. `run_message`에 Gate를 섞지 않는다.
 */
const GATE_MESSAGE_TABLE = `
CREATE TABLE gate_message (
  gate_key            TEXT PRIMARY KEY,
  run_key             TEXT NOT NULL,
  channel_id          TEXT NOT NULL,
  thread_ts           TEXT NOT NULL,
  message_ts          TEXT NOT NULL,
  render_fingerprint  TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
)`;

/** 두 Gate가 같은 Slack reply를 가리키면 한 카드가 다른 카드를 덮어쓴다. */
const GATE_MESSAGE_INDEX = `
CREATE UNIQUE INDEX gate_message_slack_identity ON gate_message (channel_id, message_ts)`;

/** D2-C local source-of-truth boundary. All tables are additive to the v7 sidecar/card shape. */
const GATE_LOCAL_OBSERVATION_TABLE = `
CREATE TABLE gate_local_observation (
  gate_key       TEXT PRIMARY KEY,
  run_key        TEXT NOT NULL,
  task_key       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'unsupported')),
  resolution     TEXT,
  resolved_at    TEXT,
  metadata_state TEXT NOT NULL CHECK (metadata_state IN ('matched', 'missing', 'mismatched')),
  mapping_state  TEXT NOT NULL CHECK (mapping_state IN ('matched', 'missing', 'mismatched', 'write_pending')),
  write_owner    TEXT CHECK (write_owner IS NULL OR length(write_owner) BETWEEN 1 AND 80),
  write_expires_at TEXT,
  observed_at    TEXT NOT NULL,
  CHECK ((mapping_state = 'write_pending' AND write_owner IS NOT NULL AND write_expires_at IS NOT NULL)
      OR (mapping_state <> 'write_pending' AND write_owner IS NULL AND write_expires_at IS NULL)),
  CHECK ((status = 'pending' AND resolution IS NULL AND resolved_at IS NULL)
      OR (status = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
      OR (status = 'unsupported' AND resolution IS NULL AND resolved_at IS NULL))
)`;

/** Additive v9 CAS token. Existing v8 observations lazily receive a row on their next save. */
const GATE_OBSERVATION_GENERATION_TABLE = `
CREATE TABLE gate_observation_generation (
  gate_key  TEXT PRIMARY KEY,
  revision  INTEGER NOT NULL CHECK (revision >= 0)
)`;

/** D2-D server-side modal correlation. Trigger ids and unaccepted input never enter SQLite. */
const GATE_DIRECT_MODAL_TABLE = `
CREATE TABLE gate_direct_modal (
  session_id          TEXT PRIMARY KEY,
  revision            INTEGER NOT NULL CHECK (revision >= 0),
  button_event_key    TEXT NOT NULL UNIQUE,
  gate_key            TEXT NOT NULL,
  team_id             TEXT NOT NULL,
  owner_user_id       TEXT NOT NULL,
  api_app_id          TEXT NOT NULL,
  channel_id          TEXT NOT NULL,
  thread_ts           TEXT NOT NULL,
  message_ts          TEXT NOT NULL,
  block_id            TEXT NOT NULL,
  action_id           TEXT NOT NULL,
  action_value        TEXT NOT NULL,
  callback_id         TEXT NOT NULL,
  input_block_id      TEXT NOT NULL,
  input_action_id     TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('prepared','opening','opened','failed','accepted')),
  view_id             TEXT UNIQUE,
  failure_code        TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  resolution_text     TEXT CHECK (resolution_text IS NULL OR length(resolution_text) BETWEEN 1 AND 3000),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  opened_at           TEXT,
  accepted_at         TEXT,
  CHECK (
    (state = 'prepared' AND revision = 0)
    OR (state = 'opening' AND revision = 1)
    OR (state IN ('opened','failed') AND revision = 2)
    OR (state = 'accepted' AND revision = 3)
  ),
  CHECK (
    (state IN ('prepared','opening') AND view_id IS NULL AND failure_code IS NULL
      AND resolution_text IS NULL AND opened_at IS NULL AND accepted_at IS NULL)
    OR (state = 'opened' AND view_id IS NOT NULL AND failure_code IS NULL
      AND resolution_text IS NULL AND opened_at IS NOT NULL AND accepted_at IS NULL)
    OR (state = 'failed' AND view_id IS NULL AND failure_code IS NOT NULL
      AND resolution_text IS NULL AND opened_at IS NULL AND accepted_at IS NULL)
    OR (state = 'accepted' AND view_id IS NOT NULL AND failure_code IS NULL
      AND resolution_text IS NOT NULL AND opened_at IS NOT NULL AND accepted_at IS NOT NULL)
  )
)`;

const GATE_DIRECT_MODAL_GATE_INDEX = `
CREATE INDEX gate_direct_modal_gate ON gate_direct_modal (gate_key, state, session_id)`;

const GATE_RESOLUTION_TABLE = `
CREATE TABLE gate_resolution (
  gate_key             TEXT PRIMARY KEY,
  revision             INTEGER NOT NULL CHECK (revision >= 0),
  ack_state            TEXT NOT NULL CHECK (ack_state IN ('pending','acked','failed')),
  lease_owner          TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 80),
  lease_expires_at     TEXT,
  retry_request_id     TEXT NOT NULL UNIQUE,
  option_id            TEXT NOT NULL CHECK (length(option_id) BETWEEN 1 AND 64),
  option_resolution    TEXT NOT NULL CHECK (length(option_resolution) BETWEEN 1 AND 3000),
  ask_message_id       TEXT NOT NULL,
  question_thread_id   TEXT NOT NULL,
  dispatch_id          TEXT NOT NULL,
  task_id              TEXT NOT NULL,
  team_id              TEXT NOT NULL,
  owner_user_id        TEXT NOT NULL,
  api_app_id           TEXT,
  channel_id           TEXT NOT NULL,
  thread_ts            TEXT NOT NULL,
  message_ts           TEXT NOT NULL,
  block_id             TEXT NOT NULL,
  action_id            TEXT NOT NULL,
  action_value         TEXT NOT NULL,
  lifecycle            TEXT NOT NULL CHECK (lifecycle IN
    ('claimed','pre_read','resolving','uncertain','post_read','resolved','conflict','degraded')),
  mutation_ownership   TEXT NOT NULL CHECK (mutation_ownership IN ('not_started','unknown','structured')),
  pre_read_json         TEXT,
  resolve_result_json   TEXT,
  post_read_json        TEXT,
  last_error_code       TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  last_error_detail     TEXT CHECK (last_error_detail IS NULL OR length(last_error_detail) <= 500),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL)
       OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
)`;

const GATE_RESOLUTION_LIFECYCLE_INDEX = `
CREATE INDEX gate_resolution_lifecycle ON gate_resolution (lifecycle, gate_key)`;

const GATE_RESOLUTION_OUTBOX_TABLE = `
CREATE TABLE gate_resolution_outbox (
  gate_key            TEXT PRIMARY KEY,
  revision            INTEGER NOT NULL CHECK (revision >= 0),
  card_state          TEXT NOT NULL CHECK (card_state IN ('resolving','resolved','conflict','degraded')),
  card_pending        INTEGER NOT NULL CHECK (card_pending IN (0, 1)),
  notification_state  TEXT NOT NULL CHECK (notification_state = 'pending'),
  projected_at        TEXT,
  projection_owner    TEXT CHECK (projection_owner IS NULL OR length(projection_owner) BETWEEN 1 AND 80),
  projection_expires_at TEXT,
  last_error_code     TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK ((projection_owner IS NULL AND projection_expires_at IS NULL)
      OR (projection_owner IS NOT NULL AND projection_expires_at IS NOT NULL)),
  CHECK (card_pending = 1 OR (projection_owner IS NULL AND projection_expires_at IS NULL))
)`;

const GATE_RESOLUTION_OUTBOX_INDEX = `
CREATE INDEX gate_resolution_outbox_pending ON gate_resolution_outbox (card_pending, gate_key)`;

const GATE_RESOLUTION_ATTEMPT_TABLE = `
CREATE TABLE gate_resolution_attempt (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_key    TEXT NOT NULL,
  phase       TEXT NOT NULL CHECK (length(phase) BETWEEN 1 AND 40),
  outcome     TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 40),
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  created_at  TEXT NOT NULL
)`;

const GATE_RESOLUTION_ATTEMPT_INDEX = `
CREATE INDEX gate_resolution_attempt_gate ON gate_resolution_attempt (gate_key, id)`;

const GATE_RESOLUTION_AUDIT_TABLE = `
CREATE TABLE gate_resolution_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_key    TEXT,
  event       TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 40),
  reason      TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 80),
  created_at  TEXT NOT NULL
)`;

const GATE_RESOLUTION_AUDIT_INDEX = `
CREATE INDEX gate_resolution_audit_gate ON gate_resolution_audit (gate_key, id)`;

/**
 * Additive v11 Channel lifecycle. The referenced v10 outbox is intentionally unchanged: it stays
 * the D2 source intent while this sidecar owns delivery retries and exact effect consumption.
 * Session/connection claims are never durable trust inputs, so no binding or epoch column exists.
 */
const GATE_RESUME_BASELINE_COLUMN = ` resume_baseline_state TEXT NOT NULL DEFAULT 'unavailable' CHECK (resume_baseline_state IN ('unavailable','required','recorded')),`;

const GATE_CHANNEL_DELIVERY_TABLE = `
CREATE TABLE gate_channel_delivery (
  gate_key            TEXT PRIMARY KEY REFERENCES gate_resolution_outbox(gate_key),
  run_key             TEXT NOT NULL,
  task_key            TEXT NOT NULL,
  source_dispatch_id  TEXT NOT NULL CHECK (length(source_dispatch_id) BETWEEN 1 AND 500),
  revision            INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  deferred_outbox_revision INTEGER NOT NULL
    CHECK (deferred_outbox_revision BETWEEN 0 AND 9007199254740991),
  state               TEXT NOT NULL CHECK (state IN ('pending','attempted','receipted','consumed')),
  attempt_count       INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 1000000),
  last_attempt_at     TEXT,
  next_attempt_at     TEXT,
  receipted_at        TEXT,
  consumed_at         TEXT,
  lease_owner         TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 80),
  lease_expires_at    TEXT,
  last_error_code     TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,${GATE_RESUME_BASELINE_COLUMN}
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (lease_expires_at IS NULL OR lease_expires_at > updated_at),
  CHECK (
    (state = 'pending' AND attempt_count = 0 AND last_attempt_at IS NULL
      AND next_attempt_at IS NOT NULL AND receipted_at IS NULL AND consumed_at IS NULL)
    OR (state = 'attempted' AND attempt_count >= 1 AND last_attempt_at IS NOT NULL
      AND next_attempt_at IS NOT NULL AND receipted_at IS NULL AND consumed_at IS NULL)
    OR (state = 'receipted' AND attempt_count >= 1 AND last_attempt_at IS NOT NULL
      AND next_attempt_at IS NOT NULL AND receipted_at IS NOT NULL AND consumed_at IS NULL)
    OR (state = 'consumed' AND attempt_count >= 1 AND last_attempt_at IS NOT NULL
      AND next_attempt_at IS NULL AND receipted_at IS NOT NULL AND consumed_at IS NOT NULL
      AND lease_owner IS NULL AND lease_expires_at IS NULL AND last_error_code IS NULL)
  ),
  CHECK (last_attempt_at IS NULL OR last_attempt_at >= created_at),
  CHECK (receipted_at IS NULL OR receipted_at >= last_attempt_at),
  CHECK (consumed_at IS NULL OR consumed_at >= receipted_at),
  CHECK (updated_at >= created_at),
  CHECK (last_attempt_at IS NULL OR updated_at >= last_attempt_at),
  CHECK (receipted_at IS NULL OR updated_at >= receipted_at),
  CHECK (consumed_at IS NULL OR updated_at >= consumed_at)
)`;

const GATE_CHANNEL_DELIVERY_DUE_INDEX = `
CREATE INDEX gate_channel_delivery_due
  ON gate_channel_delivery (state, next_attempt_at, gate_key)`;

const GATE_CHANNEL_DELIVERY_RUN_INDEX = `
CREATE INDEX gate_channel_delivery_run
  ON gate_channel_delivery (run_key, state, gate_key)`;

/**
 * Additive v12 normalized Task/Dispatch baseline and observation. JSON contains only sorted Task
 * IDs, statuses, and Dispatch IDs/statuses; raw task results, worker resources, and payloads have
 * no column and are rejected by the strict decoder.
 */
const GATE_RESUME_OBSERVATION_TABLE = `
CREATE TABLE gate_resume_observation (
  gate_key              TEXT PRIMARY KEY REFERENCES gate_channel_delivery(gate_key),
  revision              INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  baseline_json         TEXT NOT NULL CHECK (length(baseline_json) BETWEEN 2 AND 200000),
  latest_json           TEXT CHECK (latest_json IS NULL OR length(latest_json) BETWEEN 2 AND 200000),
  evidence_kind         TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN ('new_dispatch','status_transition')),
  evidence_task_id      TEXT CHECK (evidence_task_id IS NULL OR length(evidence_task_id) BETWEEN 1 AND 500),
  evidence_dispatch_id  TEXT CHECK (evidence_dispatch_id IS NULL OR length(evidence_dispatch_id) BETWEEN 1 AND 500),
  evidence_from_status  TEXT CHECK (evidence_from_status IS NULL OR length(evidence_from_status) BETWEEN 1 AND 80),
  evidence_to_status    TEXT CHECK (evidence_to_status IS NULL OR evidence_to_status IN ('dispatched','completed')),
  next_observation_at   TEXT,
  observed_at           TEXT,
  lease_owner           TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 80),
  lease_expires_at      TEXT,
  last_error_code       TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (lease_expires_at IS NULL OR lease_expires_at > updated_at),
  CHECK (updated_at >= created_at),
  CHECK (observed_at IS NULL OR updated_at >= observed_at),
  CHECK (
    (evidence_kind IS NULL AND evidence_task_id IS NULL AND evidence_dispatch_id IS NULL
      AND evidence_from_status IS NULL AND evidence_to_status IS NULL)
    OR (evidence_kind IS NOT NULL AND evidence_task_id IS NOT NULL
      AND evidence_dispatch_id IS NOT NULL AND evidence_to_status IS NOT NULL
      AND next_observation_at IS NULL)
  )
)`;

/** Exact deployed v11 table used by the v10→v11 step before v12 appends its quarantine column. */
const GATE_CHANNEL_DELIVERY_V11_TABLE = GATE_CHANNEL_DELIVERY_TABLE.replace(
  GATE_RESUME_BASELINE_COLUMN,
  '',
);

const GATE_RESUME_OBSERVATION_DUE_INDEX = `
CREATE INDEX gate_resume_observation_due
  ON gate_resume_observation (next_observation_at, gate_key)`;

/** Exact code-owned v8 objects. Startup compares normalized sqlite_master SQL fail-closed. */
export const GATE_V8_SCHEMA_OBJECTS: Readonly<Record<string, string>> = {
  gate_metadata: GATE_METADATA_TABLE,
  gate_metadata_run_key: GATE_METADATA_RUN_INDEX,
  gate_message: GATE_MESSAGE_TABLE,
  gate_message_slack_identity: GATE_MESSAGE_INDEX,
  gate_local_observation: GATE_LOCAL_OBSERVATION_TABLE,
  gate_resolution: GATE_RESOLUTION_TABLE,
  gate_resolution_lifecycle: GATE_RESOLUTION_LIFECYCLE_INDEX,
  gate_resolution_outbox: GATE_RESOLUTION_OUTBOX_TABLE,
  gate_resolution_outbox_pending: GATE_RESOLUTION_OUTBOX_INDEX,
  gate_resolution_attempt: GATE_RESOLUTION_ATTEMPT_TABLE,
  gate_resolution_attempt_gate: GATE_RESOLUTION_ATTEMPT_INDEX,
  gate_resolution_audit: GATE_RESOLUTION_AUDIT_TABLE,
  gate_resolution_audit_gate: GATE_RESOLUTION_AUDIT_INDEX,
};

/** v9 stays separate so the exact deployed v8 table DDL remains byte-for-byte authoritative. */
export const GATE_V9_SCHEMA_OBJECTS: Readonly<Record<string, string>> = {
  gate_observation_generation: GATE_OBSERVATION_GENERATION_TABLE,
};

/** v10 adds only the durable direct-input modal sidecar. */
export const GATE_V10_SCHEMA_OBJECTS: Readonly<Record<string, string>> = {
  gate_direct_modal: GATE_DIRECT_MODAL_TABLE,
  gate_direct_modal_gate: GATE_DIRECT_MODAL_GATE_INDEX,
};

/** v11 adds only the D3 delivery sidecar and its deterministic scheduling/routing indexes. */
export const GATE_V11_SCHEMA_OBJECTS: Readonly<Record<string, string>> = {
  gate_channel_delivery: GATE_CHANNEL_DELIVERY_V11_TABLE,
  gate_channel_delivery_due: GATE_CHANNEL_DELIVERY_DUE_INDEX,
  gate_channel_delivery_run: GATE_CHANNEL_DELIVERY_RUN_INDEX,
};

/** v12 adds only normalized resume evidence; the existing D2 and D3 lifecycle meanings remain. */
export const GATE_V12_SCHEMA_OBJECTS: Readonly<Record<string, string>> = {
  // Override the deployed v11 table in the merged current-object map after ALTER ADD COLUMN.
  gate_channel_delivery: GATE_CHANNEL_DELIVERY_TABLE,
  gate_resume_observation: GATE_RESUME_OBSERVATION_TABLE,
  gate_resume_observation_due: GATE_RESUME_OBSERVATION_DUE_INDEX,
};

/**
 * 전체 DDL. `DatabaseSync#exec`로 한 번에 실행한다.
 *
 * **비어 있는 파일에만 쓴다.** 이미 버전이 기록된 파일은 `MIGRATIONS`가 올린다. 그래서 이
 * DDL은 항상 `SCHEMA_VERSION`의 최종 모양이고, `MIGRATIONS`를 순서대로 적용한 결과와 같은
 * 스키마여야 한다. 컬럼 하나를 여기에만 넣고 `MIGRATIONS`에 넣지 않으면, 새 파일과 기존
 * 파일이 다른 스키마로 갈라진다.
 */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  -- 한 행만 존재한다. 여러 버전 기록이 공존하면 어느 쪽이 현재인지 알 수 없다.
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    INTEGER NOT NULL,
  applied_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_message (
  -- identity/keys.ts의 PullRequestKey. 형식은 pr:<repo databaseId>#<number>다.
  -- repository rename과 owner 이전에도 같은 key가 나오므로 카드가 갈라지지 않는다.
  -- PRIMARY KEY는 "PR당 매핑 행 하나"만 강제한다. Slack 루트가 하나라는 보장은 아니다.
  pr_key             TEXT PRIMARY KEY,
  -- chat.update는 channel과 ts를 함께 요구한다. 또한 대상 채널 설정이 바뀌었을 때
  -- 예전 채널의 ts로 update를 시도하는 대신 불일치를 판정할 수 있다.
  channel_id         TEXT NOT NULL,
  message_ts         TEXT NOT NULL,
  -- 마지막으로 게시한 카드의 지문. 같으면 chat.update를 호출하지 않는다.
  render_fingerprint TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  -- 아래 둘은 v2에서 붙였다. **순서가 v1 이후에 오는 것이 의도다.** SQLite의
  -- ALTER TABLE ADD COLUMN은 맨 뒤에만 붙일 수 있으므로, 여기서 render_fingerprint 옆에
  -- 두면 새로 만든 파일과 v1에서 올린 파일의 컬럼 순서가 갈라진다. 새 컬럼은 항상 끝에 적는다.
  --
  -- 마지막으로 요약한 SummaryFacts의 지문. 같으면 summarizer를 부르지 않고 summary_json을
  -- 재사용한다(OD-035). NULL은 "기록 전"이고 비교할 수 없다는 뜻이므로 한 번 요약해 채운다.
  facts_fingerprint  TEXT,
  -- 재사용할 요약. SummaryDraft 네 필드와 risk, truncated만 담는다. summarizer 입력
  -- (prBody, changedPaths)은 담지 않는다. 요약이 실패한 관찰에서는 NULL이다.
  summary_json       TEXT
);

-- 두 PR이 같은 Slack 메시지를 가리키면 한 카드가 다른 카드를 덮어쓴다.
CREATE UNIQUE INDEX IF NOT EXISTS pr_message_slack_identity
  ON pr_message (channel_id, message_ts);
${PR_TASK_TABLE};
${PR_STATE_TABLE};
${PR_THREAD_EVENT_TABLE};
${RUN_MESSAGE_TABLE};
${RUN_MESSAGE_INDEX};
${RUN_COLLECTION_MESSAGE_TABLE};
${GATE_METADATA_TABLE};
${GATE_METADATA_RUN_INDEX};
${GATE_MESSAGE_TABLE};
${GATE_MESSAGE_INDEX};
${GATE_LOCAL_OBSERVATION_TABLE};
${GATE_OBSERVATION_GENERATION_TABLE};
${GATE_DIRECT_MODAL_TABLE};
${GATE_DIRECT_MODAL_GATE_INDEX};
${GATE_RESOLUTION_TABLE};
${GATE_RESOLUTION_LIFECYCLE_INDEX};
${GATE_RESOLUTION_OUTBOX_TABLE};
${GATE_RESOLUTION_OUTBOX_INDEX};
${GATE_RESOLUTION_ATTEMPT_TABLE};
${GATE_RESOLUTION_ATTEMPT_INDEX};
${GATE_RESOLUTION_AUDIT_TABLE};
${GATE_RESOLUTION_AUDIT_INDEX};
${GATE_CHANNEL_DELIVERY_TABLE};
${GATE_CHANNEL_DELIVERY_DUE_INDEX};
${GATE_CHANNEL_DELIVERY_RUN_INDEX};
${GATE_RESUME_OBSERVATION_TABLE};
${GATE_RESUME_OBSERVATION_DUE_INDEX};
`;

/**
 * 버전에서 버전으로 가는 문장 목록. `MIGRATIONS[n - 1]`이 파일 버전 `n`을 `n + 1`로 올린다.
 *
 * 프레임워크가 아니다. 파일도, 등록 순서도, 되돌리기도 없다. 배열 하나와 그 배열을 순서대로
 * 실행하는 `applyMigrations`(`sqlite.ts`)가 전부다.
 *
 * **덧붙이기만 한다.** 여기 들어갈 수 있는 것은 컬럼 추가와 테이블 추가뿐이고, 추가하는
 * 컬럼은 NULL을 허용하거나 기본값을 가져야 한다. 기존 행이 그대로 남아야 하기 때문이다.
 *
 * **파괴적 변경은 이 방식으로 다루지 않는다.** 컬럼 삭제, 이름 변경, 타입 변경, 의미 변경,
 * 데이터 재작성은 여기 넣지 마라. 그런 변경은 실패했을 때 잃는 것이 다르다. 이 배열은
 * 실패하면 트랜잭션이 되돌려 파일이 v1로 남지만, 파괴적 변경은 되돌아간 파일이 이미 원본이
 * 아닐 수 있다. 그런 변경이 필요해지면 그때 무엇을 할지 다시 정한다. 그 자리를 OD-043이
 * "버전이 늘어날 때 무엇을 할지는 그때 정한다"로 비워 두었고, 지금 정하는 답은 여기까지다.
 *
 * 파일 버전이 `SCHEMA_VERSION`보다 **높으면** 올릴 문장이 없으므로 던진다. 내려가지 않는다.
 */
export const MIGRATIONS: readonly (readonly string[])[] = [
  // v1 → v2: 요약 재사용에 필요한 두 값을 붙인다(OD-035). 기존 행은 둘 다 NULL이 되고,
  // NULL은 "비교 불가"이므로 그 행은 다음 관찰에서 한 번 요약된 뒤 채워진다.
  [
    'ALTER TABLE pr_message ADD COLUMN facts_fingerprint TEXT',
    'ALTER TABLE pr_message ADD COLUMN summary_json TEXT',
  ],
  // v2 → v3: PR↔Task N 연관 테이블을 붙인다(OD-076). 기존 `pr_message` 행은 건드리지 않는다.
  // 지금 있는 카드에는 body가 가리키는 Task 하나만 알려져 있고, 그 연관은 다음 관찰이 기록한다.
  // 과거 Task를 소급해 채우지 않는다. 그 값을 만들 수 있는 authoritative source가 없다.
  [PR_TASK_TABLE],
  // v3 → v4: 전이 판정에 필요한 두 표를 붙인다(OD-044, OD-046). 기존 행은 건드리지 않는다.
  // 둘 다 비어 있는 채로 시작하고, 그것이 맞다. `pr_state`가 비었다는 것은 "이전 관측을 모른다"는
  // 뜻이고 그 PR의 첫 관측은 전이를 내지 않는다. 과거 상태를 GitHub history로 채우지 않는다 —
  // check는 400일 뒤 archive되고 다시 10일 뒤 삭제되어 완전 재생을 보장할 수 없다(OD-046).
  [PR_STATE_TABLE, PR_THREAD_EVENT_TABLE],
  // v4 → v5: Run당 Slack 루트 매핑 표를 붙인다(로드맵 §7). 기존 행은 건드리지 않는다.
  // 비어 있는 채로 시작하고 그것이 맞다. 행이 없다는 것은 "이 Run의 루트를 아직 만들지
  // 않았다"는 뜻이고, 첫 관찰이 루트를 만들며 채운다. 과거에 게시한 Run 카드는 없다.
  [RUN_MESSAGE_TABLE, RUN_MESSAGE_INDEX],
  // v5 → v6: 컬렉션 루트 매핑 표를 붙인다(OD-080). 기존 행은 건드리지 않는다. 비어 있는 채로
  // 시작하고 그것이 맞다 — 행이 없다는 것은 "컬렉션 루트를 아직 만들지 않았다"는 뜻이고 첫
  // 관찰이 만들며 채운다. 과거에 게시한 컬렉션 카드는 없다.
  [RUN_COLLECTION_MESSAGE_TABLE],
  // v6 → v7: sidecar producer와 정적 Gate thread consumer가 즉시 쓰는 두 표만 붙인다(D2-A).
  // 기존 PR/Run/collection 행은 건드리지 않고, 과거 Gate metadata나 Slack reply를 추측해 채우지 않는다.
  [GATE_METADATA_TABLE, GATE_METADATA_RUN_INDEX, GATE_MESSAGE_TABLE, GATE_MESSAGE_INDEX],
  // v7 → v8: one immutable Gate-local winner, exact observations, bounded append-only evidence,
  // and replayable D2 card/notification projection. No existing row is inferred or rewritten.
  [
    GATE_LOCAL_OBSERVATION_TABLE,
    GATE_RESOLUTION_TABLE,
    GATE_RESOLUTION_LIFECYCLE_INDEX,
    GATE_RESOLUTION_OUTBOX_TABLE,
    GATE_RESOLUTION_OUTBOX_INDEX,
    GATE_RESOLUTION_ATTEMPT_TABLE,
    GATE_RESOLUTION_ATTEMPT_INDEX,
    GATE_RESOLUTION_AUDIT_TABLE,
    GATE_RESOLUTION_AUDIT_INDEX,
  ],
  // v8 → v9: monotonic ordinary-write generations fence identical/same-timestamp observations.
  // Existing v8 rows are not inferred or rewritten; the next observation save creates revision 0.
  [GATE_OBSERVATION_GENERATION_TABLE],
  // v9 → v10: durable server-owned correlation for the D2-D direct-input modal. Existing Gate
  // rows are not inferred and no trigger id or unaccepted resolution text is backfilled.
  [GATE_DIRECT_MODAL_TABLE, GATE_DIRECT_MODAL_GATE_INDEX],
  // v10 → v11: additive D3 delivery state only. Existing v10 rows are deliberately not
  // backfilled here; the production daemon lazily and idempotently seeds exact resolved D2 rows.
  [
    GATE_CHANNEL_DELIVERY_V11_TABLE,
    GATE_CHANNEL_DELIVERY_DUE_INDEX,
    GATE_CHANNEL_DELIVERY_RUN_INDEX,
  ],
  // v11 → v12: existing deliveries are explicitly baseline-unavailable because they may already
  // have crossed the pipe. New inserts opt into `required`; only a strict pre-send read records it.
  [
    "ALTER TABLE gate_channel_delivery ADD COLUMN resume_baseline_state TEXT NOT NULL DEFAULT 'unavailable' CHECK (resume_baseline_state IN ('unavailable','required','recorded'))",
    GATE_RESUME_OBSERVATION_TABLE,
    GATE_RESUME_OBSERVATION_DUE_INDEX,
  ],
];

/**
 * 관찰 한 번이 매핑 행에 남기는 값.
 *
 * Slack message identity(`channel_id`, `message_ts`)는 담지 않는다. 그 둘은 루트를 만들 때
 * 정해지고 이후 관찰이 바꾸지 않는다.
 *
 * 두 지문은 서로 다른 것을 판정한다. 하나로 합치지 마라.
 *
 * - `factsFingerprint`: summarizer를 다시 부를지. 요약의 **입력**이 바뀌었는지만 본다.
 * - `renderFingerprint`: `chat.update`를 부를지. 게시할 **카드**가 바뀌었는지 본다.
 *
 * 사실이 그대로여도 renderer 코드가 바뀌면 카드가 달라지고, 요약 입력이 그대로여도 카드에만
 * 있는 사실(PR state, headMatch 등)이 움직이면 카드가 달라진다. 그래서 두 값이 따로 있다.
 */
export type ObservationRecord = {
  /** 마지막으로 게시한 카드의 지문. */
  readonly renderFingerprint: string;
  /** 마지막으로 요약한 `SummaryFacts`의 지문. */
  readonly factsFingerprint: string;
  /** 재사용할 요약의 직렬화. 요약이 실패했으면 null이다. */
  readonly summaryJson: string | null;
};

/**
 * 카드 하나의 Slack message identity와 마지막 관찰이 남긴 값.
 *
 * 시각은 ISO8601 문자열이다. Orca timestamp 파싱 규칙과 달리 이 값은 Bridge가 직접 쓰므로
 * 형식을 하나로 고정한다.
 *
 * `factsFingerprint`와 `summaryJson`이 null인 행은 v2 이전에 만들어져 값이 없는 행이다.
 * "비교 불가"이므로 요약 재사용 판정에서 항상 miss다. 한 번 요약하고 채우면 그 뒤로는
 * 다른 행과 같다.
 */
export type PrMessageRecord = {
  readonly prKey: PullRequestKey;
  readonly channelId: string;
  readonly messageTs: string;
  readonly renderFingerprint: string;
  readonly factsFingerprint: string | null;
  readonly summaryJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** 루트 메시지를 처음 기록할 때 넘기는 값. */
export type NewPrMessage = ObservationRecord & {
  readonly prKey: PullRequestKey;
  readonly channelId: string;
  readonly messageTs: string;
  /** ISO8601. `created_at`과 `updated_at`에 같은 값을 쓴다. */
  readonly at: string;
};

/**
 * 한 관찰이 관측한 PR↔Task 연관 하나.
 *
 * PR body는 primary/latest Task 하나만 담으므로(OD-021, OD-076) 관찰 한 번이 관측하는 쌍도
 * 하나다. 여러 Task가 한 PR을 이어서 갱신하면 관찰이 거듭되며 쌍이 쌓인다.
 *
 * `runKey`를 함께 받는 이유는 `resolveCorrelation`이 이미 "이 task가 그 run에 속한다"를 대조한
 * 뒤의 값이기 때문이다. 여기서 다시 판정하지 않는다.
 *
 * `dispatchId`는 담지 않는다. OD-021에서 선택 값이고 재dispatch가 있으면 (PR, Task) 하나에
 * 여러 값이 생긴다. 한 컬럼에 담으면 마지막 값이 앞선 값을 조용히 덮는다. OD-076이 요구한 것은
 * PR↔Task N이고 Dispatch cardinality는 그 결정에 없다.
 */
export type NewPrTask = {
  readonly prKey: PullRequestKey;
  readonly taskKey: TaskKey;
  readonly runKey: RunKey;
  /** ISO8601. 처음이면 `first_seen_at`과 `last_seen_at` 둘 다, 아니면 `last_seen_at`만 받는다. */
  readonly at: string;
};

/** 저장된 PR↔Task 연관 한 행. 시각은 ISO8601이다. */
export type PrTaskRecord = {
  readonly prKey: PullRequestKey;
  readonly taskKey: TaskKey;
  readonly runKey: RunKey;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
};

/**
 * 한 PR에 대한 직전 관측 상태.
 *
 * 다음 관측을 reconcile할 때만 쓴다(OD-044). 카드가 읽는 값이 아니다.
 *
 * `terminal`은 reconcile된 값이고 `mergedAt`은 latch의 occurred time이다. 둘 다 내려가지
 * 않는다 — 근거는 `PR_STATE_TABLE`에 있다.
 *
 * `checks`의 scope는 `checksHeadSha`다. 이 값이 다른 두 관측의 check는 서로 다른 commit의
 * 사실이므로 resource 단위로 합치지 않는다.
 */
export type PrStateSnapshot = {
  readonly terminal: PrTerminal;
  readonly mergedAt: string | null;
  readonly reviewVerdict: ReviewerResult['verdict'] | null;
  readonly reviewedHeadSha: string | null;
  readonly headSha: string;
  readonly checksHeadSha: string;
  readonly checks: readonly CheckFact[];
};

/** 저장된 직전 관측 상태 한 행. `observedAt`은 ISO8601이다. */
export type PrStateRecord = PrStateSnapshot & {
  readonly prKey: PullRequestKey;
  readonly observedAt: string;
};

/**
 * thread에 기록한 전이 하나.
 *
 * `messageTs`가 null이면 seed 행이다. 첫 관측에서 "지금 참인 사실"을 게시 없이 기준선으로만
 * 남긴 것이며, 그 전이는 앞으로도 게시되지 않는다(OD-046).
 */
export type NewThreadEvent = {
  readonly prKey: PullRequestKey;
  readonly dedupeKey: string;
  readonly kind: string;
  /** 게시된 reply의 ts. seed 행은 null이다. */
  readonly messageTs: string | null;
  /** ISO8601. */
  readonly at: string;
};

/** 저장된 thread 전이 한 행. 시각은 ISO8601이다. */
export type PrThreadEventRecord = {
  readonly prKey: PullRequestKey;
  readonly dedupeKey: string;
  readonly kind: string;
  readonly messageTs: string | null;
  readonly recordedAt: string;
};

/**
 * digest가 쓰는 durable store.
 *
 * 동기 인터페이스다. `node:sqlite`의 `DatabaseSync`가 동기 API이므로 Promise로 감싸면
 * 실제로 없는 비동기 경계를 만든다.
 *
 * 사용 순서와 crash 경계:
 *
 * ```text
 * findPrMessage → null  → chat.postMessage → insertPrMessage
 * findPrMessage → row   → 렌더 지문이 같으면 Slack을 부르지 않음
 *                       → 다르면 chat.update
 *                       → 어느 쪽이든 사실 지문이 바뀌었으면 updateObservation
 * ```
 *
 * `chat.postMessage` 성공과 `insertPrMessage` 사이에서 죽으면 다음 실행이 카드를 하나 더
 * 만든다. 게시 결과를 모른 채 끝난 호출도 결과가 같다. 두 창의 설명은 파일 머리에 있고,
 * outbox와 crash 경계 atomicity는 스펙 §9에서 TBD이며 C1 범위 밖이다. C1은 두 창을
 * 없앴다고 주장하지 않는다.
 *
 * 렌더 지문은 카드에 실제로 표시하는 값에서만 계산한다. 관찰 시각을 넣으면 사실이 바뀌지
 * 않아도 매 실행이 `chat.update`를 만든다.
 */
export interface DigestStore {
  /** 기록된 루트 메시지를 찾는다. 없으면 null이며 이는 정상 출력이다. */
  findPrMessage(prKey: PullRequestKey): PrMessageRecord | null;
  /** 처음 기록한다. 이미 있으면 던진다. 중복 루트 생성을 조용히 덮어쓰지 않는다. */
  insertPrMessage(input: NewPrMessage): void;
  /**
   * 관찰 결과와 `updated_at`만 갱신한다. row가 없으면 던진다. `at`은 ISO8601이다.
   *
   * message identity는 건드리지 않는다. 그것을 바꾸는 것은 루트를 옮기는 일이고 이 계약에
   * 없다.
   */
  updateObservation(prKey: PullRequestKey, observation: ObservationRecord, at: string): void;
  /**
   * PR↔Task 연관 하나를 기록한다(OD-076). 같은 쌍을 다시 관측하면 `last_seen_at`만 옮긴다.
   *
   * **`insertPrMessage`와 달리 이미 있어도 던지지 않는다.** 그쪽이 던지는 이유는 덮어쓰면 이미
   * 게시한 Slack 루트를 잃기 때문인데, 이 행에는 그런 외부 side effect가 없고 같은 쌍을 반복
   * 관측하는 것이 정상 경로다.
   *
   * `run_key`는 처음 값을 유지한다. 같은 Task가 다른 Run을 가리키는 입력은
   * `resolveCorrelation`이 `conflict`로 막으므로 여기까지 오지 않는다.
   */
  recordPrTask(input: NewPrTask): void;
  /**
   * 이 PR에 기록된 Task 연관 전부. 없으면 빈 배열이며 이는 정상 출력이다.
   *
   * body의 latest Task는 이 목록의 한 원소일 뿐이다. 목록에서 그것을 고르려면 `lastSeenAt`이
   * 가장 늦은 행을 본다. 순서는 `firstSeenAt`, 같으면 `taskKey` 사전순으로 고정한다. 정렬을
   * 지정하지 않으면 같은 파일이 실행마다 다른 순서를 낼 수 있다.
   */
  listPrTasks(prKey: PullRequestKey): readonly PrTaskRecord[];
  /**
   * 직전 관측 상태를 읽는다. 없으면 null이며 **이는 정상 출력이다.**
   *
   * null은 "이 PR을 처음 관측한다"는 뜻이고, 그때 할 일은 정해져 있다. 이전 상태를 모르므로
   * 전이를 만들지 않고 지금 참인 사실을 기준선으로만 남긴다(OD-046). GitHub history로 과거를
   * 채우지 않는다.
   */
  findPrState(prKey: PullRequestKey): PrStateRecord | null;
  /**
   * 직전 관측 상태를 덮어쓴다. 행이 없으면 만든다. `at`은 ISO8601이다.
   *
   * **`insertPrMessage`와 달리 이미 있어도 던지지 않는다.** 그쪽이 던지는 이유는 덮어쓰면 이미
   * 게시한 Slack 루트를 잃기 때문인데, 이 행에는 그런 외부 side effect가 없고 관측마다 덮어쓰는
   * 것이 정상 경로다. 넘기는 값은 reconcile된 상태여야 한다 — 관측한 그대로를 적으면 오래된
   * snapshot이 `merged` latch를 지운다(`PR_STATE_TABLE`).
   */
  savePrState(prKey: PullRequestKey, state: PrStateSnapshot, at: string): void;
  /** 이 PR에 이미 기록한 전이 전부. 없으면 빈 배열이며 이는 정상 출력이다. */
  listThreadEvents(prKey: PullRequestKey): readonly PrThreadEventRecord[];
  /**
   * 전이 하나를 기록한다. **같은 (PR, dedupe key)가 이미 있으면 던진다.**
   *
   * `recordPrTask`와 반대다. 같은 쌍의 반복 관측이 정상인 그쪽과 달리, 여기서 충돌이 났다는
   * 것은 호출자가 이미 기록한 전이를 다시 게시했다는 뜻이다. 조용히 덮으면 thread에 중복
   * reply가 남은 사실이 store에서 사라진다.
   */
  recordThreadEvent(input: NewThreadEvent): void;
  /** WAL 파일을 정리하고 열린 handle을 남기지 않는다. */
  close(): void;
}

/**
 * Run 카드 하나의 Slack message identity와 마지막 관찰이 남긴 값.
 *
 * 시각은 ISO8601 문자열이다. `PrMessageRecord`와 달리 요약 관련 값이 없다 — 근거는
 * `RUN_MESSAGE_TABLE`에 있다.
 */
export type RunMessageRecord = {
  readonly runKey: RunKey;
  readonly channelId: string;
  readonly messageTs: string;
  readonly renderFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Run 루트 메시지를 처음 기록할 때 넘기는 값. */
export type NewRunMessage = {
  readonly runKey: RunKey;
  readonly channelId: string;
  readonly messageTs: string;
  readonly renderFingerprint: string;
  /** ISO8601. `created_at`과 `updated_at`에 같은 값을 쓴다. */
  readonly at: string;
};

/**
 * 컬렉션 루트 메시지의 Slack message identity와 마지막 관찰이 남긴 값(OD-080).
 *
 * `RunMessageRecord`와 달리 key가 없다. 행이 하나뿐이기 때문이고, 그 근거는
 * `RUN_COLLECTION_MESSAGE_TABLE`에 있다.
 */
export type RunCollectionMessageRecord = {
  readonly channelId: string;
  readonly messageTs: string;
  readonly renderFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** 컬렉션 루트 메시지를 처음 기록할 때 넘기는 값. */
export type NewRunCollectionMessage = {
  readonly channelId: string;
  readonly messageTs: string;
  readonly renderFingerprint: string;
  /** ISO8601. `created_at`과 `updated_at`에 같은 값을 쓴다. */
  readonly at: string;
};

/**
 * 이 Run에 연결된 PR 하나와 **직전 관측이 저장한** 그 PR의 상태.
 *
 * 재료는 둘 다 이미 store에 있다. 연결은 `pr_task.run_key`(OD-076)이고 상태는
 * `pr_state`(OD-044)다. **GitHub을 새로 조회하지 않는다.**
 *
 * ## 이 목록의 경계 — 카드가 숨기지 않는다
 *
 * `pr_task`에는 `digest`가 관측하고 correlation에 성공한 PR만 있다. 그래서 이 Run이 만든
 * PR이라도 아직 `digest`가 돌지 않았거나 correlation이 실패했으면 여기 없다. 목록이 비어
 * 있다는 것은 "이 Run에 PR이 없다"가 아니라 **"store에 기록된 PR이 없다"**이고, 카드는 그
 * 차이를 문구로 드러낸다(`run/render.ts`).
 *
 * `state`가 null인 경우도 사실이다. `pr_task` 행은 있는데 `pr_state` 행이 없다는 뜻이며,
 * 연관은 관측했지만 그 PR의 상태를 아직 저장하지 않았다는 것이다. terminal을 `open`으로
 * 추측해 채우지 않는다.
 */
export type RunPullRequestRecord = {
  readonly prKey: PullRequestKey;
  /** 표시용 PR 번호. `prKey`에서 되읽는다(`identity/keys.ts`). */
  readonly number: number;
  /** 이 Run의 Task가 이 PR을 처음/마지막으로 가리킨 시각. ISO8601이다. */
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** `pr_state`에 저장된 직전 관측 상태. 행이 없으면 null이며 이는 정상 출력이다. */
  readonly state: {
    readonly terminal: PrTerminal;
    readonly mergedAt: string | null;
    readonly reviewVerdict: ReviewerResult['verdict'] | null;
    readonly observedAt: string;
  } | null;
};

/** A Gate thread reply and the Run root thread it must remain attached to. */
export type GateMessageRecord = {
  readonly gateKey: GateKey;
  readonly runKey: RunKey;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly renderFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type NewGateMessage = {
  readonly gateKey: GateKey;
  readonly runKey: RunKey;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly renderFingerprint: string;
  /** ISO8601. `created_at`과 `updated_at`에 같은 값을 쓴다. */
  readonly at: string;
};

/**
 * Gate metadata/card mapping plus the D2-C resolution boundary. It remains separate from PR and
 * Run-root interfaces so callers request only the effects they use.
 */
export interface GateStore
  extends GateResolutionStore, GateDirectInputStore, GateChannelDeliveryStore {
  findGateMetadata(gateKey: GateKey): GateMetadata | null;
  /** Gate key order is fixed in SQL so source-row order cannot change render fingerprints. */
  listGateMetadata(runKey: RunKey): readonly GateMetadata[];
  /** First registration only. A conflicting second registration must not overwrite correlation. */
  insertGateMetadata(metadata: GateMetadata): void;
  findGateMessage(gateKey: GateKey): GateMessageRecord | null;
  /**
   * First reply only. A conflicting row must not replace the existing Slack identity. When the
   * first observation is supplied, the message identity and matched mapping become durable in one
   * transaction before any action controls are exposed.
   */
  insertGateMessage(message: NewGateMessage, observation?: GateLocalObservation): void;
  /** Settle an ordinary write fence and atomically record the exact observation it projected. */
  updateGateObservation(
    gateKey: GateKey,
    renderFingerprint: string,
    at: string,
    observation?: GateLocalObservation,
    expectedRevision?: number,
  ): void;
}

/**
 * Run 카드가 쓰는 durable store.
 *
 * `DigestStore`와 **따로 둔다.** 두 카드는 다른 명령이 게시하고, 한쪽만 필요한 호출자(`runs`의
 * dry-run, `digest`의 `ReadOnlyDigestStore`)가 다른 쪽 계약까지 구현해야 하는 이유가 없다. `SqliteDigestStore`는 두 인터페이스를 함께 구현한다 — 파일이 하나이기 때문이지
 * 계약이 하나여서가 아니다.
 *
 * 사용 순서와 crash 경계는 `pr_message`와 같다.
 *
 * ```text
 * findRunMessage → null  → chat.postMessage → insertRunMessage
 * findRunMessage → row   → 렌더 지문이 같으면 Slack을 부르지 않음
 *                        → 다르면 chat.update → updateRunObservation
 * ```
 *
 * `chat.postMessage` 성공과 `insertRunMessage` 사이에서 죽으면 다음 실행이 루트를 하나 더
 * 만든다. 게시 결과를 모른 채 끝난 호출도 결과가 같다. 두 창의 설명은 `RUN_MESSAGE_TABLE`에
 * 있고 D1은 두 창을 없앴다고 주장하지 않는다.
 *
 * 컬렉션 루트(`findRunCollectionMessage` 세 벌)는 같은 순서를 쓰되 key가 없다. Run이 아니므로
 * 표를 나눴고 그 근거는 `RUN_COLLECTION_MESSAGE_TABLE`에 있다(OD-080).
 */
export interface RunStore {
  /** 기록된 Run 루트 메시지를 찾는다. 없으면 null이며 이는 정상 출력이다. */
  findRunMessage(runKey: RunKey): RunMessageRecord | null;
  /** 처음 기록한다. 이미 있으면 던진다. 중복 루트 생성을 조용히 덮어쓰지 않는다. */
  insertRunMessage(input: NewRunMessage): void;
  /**
   * 렌더 지문과 `updated_at`만 갱신한다. row가 없으면 던진다. `at`은 ISO8601이다.
   *
   * message identity는 건드리지 않는다. 그것을 바꾸는 것은 루트를 옮기는 일이고 이 계약에
   * 없다.
   */
  updateRunObservation(runKey: RunKey, renderFingerprint: string, at: string): void;
  /**
   * 이 Run에 연결된 PR과 저장된 상태. 없으면 빈 배열이며 이는 정상 출력이다.
   *
   * 한 PR을 여러 Task가 이어서 갱신해도 PR당 한 원소다(OD-076의 (PR, Task) N행을 PR로 접는다).
   * 순서는 PR 번호 오름차순, 같으면 `prKey` 사전순으로 고정한다. 정렬을 지정하지 않으면 같은
   * 파일이 실행마다 다른 순서를 내고 그때마다 렌더 지문이 달라져 `chat.update`가 발생한다.
   */
  listRunPullRequests(runKey: RunKey): readonly RunPullRequestRecord[];
  /**
   * 기록된 컬렉션 루트 메시지를 찾는다. 없으면 null이며 이는 정상 출력이다(OD-080).
   *
   * null은 "컬렉션 루트를 아직 만들지 않았다"는 뜻이다. 첫 관찰이 만든다.
   */
  findRunCollectionMessage(): RunCollectionMessageRecord | null;
  /** 처음 기록한다. 이미 있으면 던진다. 중복 루트 생성을 조용히 덮어쓰지 않는다. */
  insertRunCollectionMessage(input: NewRunCollectionMessage): void;
  /**
   * 렌더 지문과 `updated_at`만 갱신한다. row가 없으면 던진다. `at`은 ISO8601이다.
   *
   * message identity는 건드리지 않는다. `updateRunObservation`과 같은 이유다.
   */
  updateRunCollectionObservation(renderFingerprint: string, at: string): void;
}
