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
 * `post`의 재시도를 가르는 축은 "응답을 받았는가"가 아니라 **"게시되지 않았음이 확실한가"**다.
 * 응답을 받고도 게시 여부를 알 수 없는 오류가 있기 때문이다.
 *
 * - 처리되지 않았음이 확실한 실패만 구현이 감추고 재시도한다. `rate_limited`/`ratelimited`가
 *   그 예다. 두 코드는 부분 성공 가능성을 말하지 않고, `ratelimited`는 `Retry-After` 헤더를
 *   보고 재시도하라고 안내한다. 이때만 인터페이스가 재시도 뒤의 결과만 반환한다.
 * - 게시 여부를 알 수 없는 실패는 재시도하지 않고 그대로 던진다. `internal_error`와
 *   `fatal_error`가 그 예다. Slack 문서가 두 코드에 "It's possible some aspect of the
 *   operation succeeded before the error was raised."라고 적는다. 응답을 아예 받지 못한
 *   경우도 여기 속한다.
 *
 * 위 두 목록은 예시이지 닫힌 분류가 아니다. Slack은 이보다 훨씬 많은 오류 코드를 문서화하고
 * `request_timeout`·`service_unavailable`처럼 문서만으로 게시 여부를 단정할 수 없는 것이
 * 더 있다. **기본값은 delivery-unknown이다.** 처리되지 않았음을 확실히 말할 수 없으면
 * 재시도하지 않는다. 애매한 것을 재시도 쪽으로 넘기면 루트가 늘고, 반대로 넘기면 사람이
 * 한 번 더 볼 뿐이다. 근거는 `https://docs.slack.dev/reference/methods/chat.postMessage`의
 * 오류 목록이며, 새 코드를 분류할 때 그 목록의 문구로 판단한다.
 *
 * 이 위험은 `store/schema.ts`의 창 2(delivery unknown)와 같은 사실이다. 같은 요청임을 Slack이
 * 알아볼 identity를 만들지 않는다 — 스펙 §9와 OD-051이 열어 둔 항목이고 C1에서 닫지 않는다.
 * `update`는 channel과 ts가 이미 정해져 있어 같은 위험이 없다.
 */
export interface SlackPoster {
  post(input: PostMessageInput): Promise<PostedMessage>;
  update(input: UpdateMessageInput): Promise<PostedMessage>;
}
