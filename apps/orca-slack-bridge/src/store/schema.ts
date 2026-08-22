import type { PullRequestKey } from '../identity/keys.js';

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
 * 담지 않는 것: thread transition 기록, Gate↔action correlation, coordinator notification
 * pending, 관찰 cursor. 각각 C2/D2/D3의 사실이고, 지금 만들면 쓰이지 않는 스키마가 된다.
 */

/** 현재 스키마 버전. `MIGRATIONS.length + 1`과 반드시 같다. */
export const SCHEMA_VERSION = 2;

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
  /** WAL 파일을 정리하고 열린 handle을 남기지 않는다. */
  close(): void;
}
