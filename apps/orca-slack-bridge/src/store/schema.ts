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

/** 현재 스키마 버전. */
export const SCHEMA_VERSION = 1;

/** durable store 경로를 덮어쓰는 환경변수. */
export const STATE_PATH_VAR = 'ORCA_SLACK_BRIDGE_STATE';

/** 열자마자 실행한다. WAL은 OD-043 결정이다. */
export const ENABLE_WAL = 'PRAGMA journal_mode = WAL';

/**
 * 전체 DDL. `DatabaseSync#exec`로 한 번에 실행한다.
 *
 * 실행 뒤 `schema_version`에 현재 버전을 기록하고, 이미 기록된 버전이 `SCHEMA_VERSION`과
 * 다르면 실패한다. C1은 migration을 만들지 않는다. 조용히 다른 버전의 파일을 열지 않는 것이
 * migration이 생기기 전까지의 계약이다.
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
  updated_at         TEXT NOT NULL
);

-- 두 PR이 같은 Slack 메시지를 가리키면 한 카드가 다른 카드를 덮어쓴다.
CREATE UNIQUE INDEX IF NOT EXISTS pr_message_slack_identity
  ON pr_message (channel_id, message_ts);
`;

/**
 * 카드 하나의 Slack message identity와 마지막 렌더 지문.
 *
 * 시각은 ISO8601 문자열이다. Orca timestamp 파싱 규칙과 달리 이 값은 Bridge가 직접 쓰므로
 * 형식을 하나로 고정한다.
 */
export type PrMessageRecord = {
  readonly prKey: PullRequestKey;
  readonly channelId: string;
  readonly messageTs: string;
  readonly renderFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** 루트 메시지를 처음 기록할 때 넘기는 값. */
export type NewPrMessage = {
  readonly prKey: PullRequestKey;
  readonly channelId: string;
  readonly messageTs: string;
  readonly renderFingerprint: string;
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
 * findPrMessage → row   → 지문이 같으면 아무것도 하지 않음
 *                       → 다르면 chat.update → updateRenderFingerprint
 * ```
 *
 * `chat.postMessage` 성공과 `insertPrMessage` 사이에서 죽으면 다음 실행이 카드를 하나 더
 * 만든다. 게시 결과를 모른 채 끝난 호출도 결과가 같다. 두 창의 설명은 파일 머리에 있고,
 * outbox와 crash 경계 atomicity는 스펙 §9에서 TBD이며 C1 범위 밖이다. C1은 두 창을
 * 없앴다고 주장하지 않는다.
 *
 * 지문은 카드에 실제로 표시하는 값에서만 계산한다. 관찰 시각을 넣으면 사실이 바뀌지 않아도
 * 매 실행이 `chat.update`를 만든다.
 */
export interface DigestStore {
  /** 기록된 루트 메시지를 찾는다. 없으면 null이며 이는 정상 출력이다. */
  findPrMessage(prKey: PullRequestKey): PrMessageRecord | null;
  /** 처음 기록한다. 이미 있으면 던진다. 중복 루트 생성을 조용히 덮어쓰지 않는다. */
  insertPrMessage(input: NewPrMessage): void;
  /** 지문과 `updated_at`만 갱신한다. row가 없으면 던진다. `at`은 ISO8601이다. */
  updateRenderFingerprint(prKey: PullRequestKey, renderFingerprint: string, at: string): void;
  /** WAL 파일을 정리하고 열린 handle을 남기지 않는다. */
  close(): void;
}
