/**
 * Slack write 경계.
 *
 * digest가 Slack에 하는 일은 두 가지뿐이다. 루트 메시지를 만들고, 같은 메시지를 갱신한다.
 * `chat.postMessage`와 `chat.update`에 대응한다. 삭제·thread reply·reaction은 C1에 없다.
 *
 * 구현은 T4가 한다. 이 파일은 렌더러와 store가 의존할 시그니처만 고정한다.
 */

/**
 * Block Kit block 하나.
 *
 * 구조를 여기서 다시 정의하지 않는다. 렌더러가 만드는 값이고 Slack이 검증하며, 부분적으로
 * 베낀 타입은 실제 스키마와 어긋나기만 한다.
 */
export type SlackBlock = Readonly<Record<string, unknown>>;

export type PostMessageInput = {
  /** 채널 ID. 이름이 아니다. 설정의 `slack.channels.prDigest`에서 온다. */
  readonly channel: string;
  /** blocks를 그리지 못하는 자리(알림, 검색 결과)용 대체 텍스트. 비우지 않는다. */
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
};

export type UpdateMessageInput = {
  readonly channel: string;
  /** 갱신할 메시지의 ts. store가 기록해 둔 값이다. */
  readonly ts: string;
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
};

/**
 * 게시 결과.
 *
 * Slack 메시지는 channel과 ts 쌍으로만 식별된다. 둘을 함께 반환해 store가 그대로 기록한다.
 */
export type PostedMessage = {
  readonly channel: string;
  readonly ts: string;
};

/**
 * Slack 메시지 write.
 *
 * 실패는 예외로 던진다. Slack이 준 error code(`channel_not_found`, `not_in_channel`,
 * `message_not_found` 등)를 잃지 않는다. 호출자가 "메시지가 지워져 다시 연결이 필요함"과
 * "채널 접근 권한이 없음"을 구분해야 하기 때문이다(UX §6).
 *
 * Slack이 응답을 준 실패(429, 5xx 등)의 재시도는 구현이 감춘다. 이 인터페이스는 재시도가
 * 끝난 뒤의 결과만 반환한다.
 *
 * **`post`에서 응답을 받지 못한 실패는 다르다.** 메시지가 만들어졌는지 알 수 없으므로
 * 자동 재시도가 루트를 하나 더 만들 수 있다. 그런 실패는 감추지 말고 호출자에게 던진다.
 * 같은 요청임을 Slack이 알아볼 identity를 만들지 않는다 — 스펙 §9와 OD-051이 열어 둔
 * 항목이고 C1에서 닫지 않는다. `update`는 channel과 ts가 이미 정해져 있어 같은 위험이 없다.
 */
export interface SlackPoster {
  post(input: PostMessageInput): Promise<PostedMessage>;
  update(input: UpdateMessageInput): Promise<PostedMessage>;
}
