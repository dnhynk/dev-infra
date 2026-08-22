import { BOT_TOKEN_VAR, maskToken } from './verify.js';

/**
 * Slack write 경계.
 *
 * digest가 Slack에 하는 일은 두 가지뿐이다. 루트 메시지를 만들고, 같은 메시지를 갱신한다.
 * `chat.postMessage`와 `chat.update`에 대응한다. 삭제·thread reply·reaction은 C1에 없다.
 *
 * 이 파일은 계약(`SlackPoster`)과 그 구현(`SlackWebApiPoster`)을 함께 담는다. Slack에 write하는
 * 코드는 여기 말고 없다.
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
 *
 * **`update`의 재시도 정책은 `post`와 반대다.** `update`는 `channel`과 `ts`가 이미 정해져 있다.
 * 재시도가 할 수 있는 최악은 같은 메시지를 같은 내용으로 다시 쓰는 것뿐이고, 새 루트를 만들지
 * 않는다. 그래서 delivery-unknown 실패(응답 유실, 5xx, `internal_error` 등)에도 재시도한다.
 * 재시도하지 않으면 안전하게 다시 쓸 수 있는 갱신이 일시적 오류 하나 뒤에 stale 카드로 남는다.
 *
 * 이 비대칭이 핵심이다. `post`에서 애매한 것을 재시도하면 루트가 늘어 되돌릴 수 없고,
 * `update`에서 재시도하지 않으면 카드가 사실과 어긋난 채 남는다. 두 실패의 대가가 다르므로
 * 두 기본값도 다르다.
 *
 * `update`도 무한히 재시도하지 않는다. `post`와 같은 `maxRetries` 상한을 쓰고, 소진되면 마지막
 * 오류를 그대로 던진다. `message_not_found`처럼 다시 시도해도 결과가 같은 코드까지 상한만큼
 * 재시도하지만, 호출자가 받는 오류와 코드는 달라지지 않는다(UX §6).
 */
export interface SlackPoster {
  post(input: PostMessageInput): Promise<PostedMessage>;
  update(input: UpdateMessageInput): Promise<PostedMessage>;
}

/**
 * Slack이 `ok: false`로 준 실패.
 *
 * `error` 코드를 그대로 싣는다. 호출자가 `message_not_found`(메시지가 지워져 다시 연결해야
 * 함)와 `not_in_channel`(채널 접근 권한 없음)을 구분해야 한다(UX §6).
 *
 * 메시지에 토큰을 넣지 않는다. 이 클래스가 아는 값은 method와 코드뿐이다.
 */
export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} 실패: ${code}`);
    this.name = 'SlackApiError';
  }
}

/**
 * 처리되지 않았음이 확실한 오류 코드.
 *
 * 이 목록만 구현이 감추고 재시도한다. 두 코드는 부분 성공 가능성을 말하지 않는다. 그 밖의
 * 코드는 게시 여부를 단정할 수 없으므로 `post`는 재시도하지 않고 그대로 던진다. 기본값이
 * delivery-unknown인 이유는 `SlackPoster`의 설명에 있다.
 *
 * **이 목록을 넓혀 `update`의 재시도를 만들지 않는다.** `update`는 같은 목록을 쓰되 그 밖의
 * 실패까지 `call`이 다시 시도한다. 여기에 코드를 더하면 `post`의 루트 중복 위험이 함께 는다.
 */
const DEFINITELY_NOT_PROCESSED = new Set(['rate_limited', 'ratelimited']);

/** `Retry-After` 헤더가 없을 때 쓰는 대기 시간. */
const DEFAULT_RETRY_AFTER_MS = 1000;

const SLACK_API = 'https://slack.com/api';

export type SlackPosterOptions = {
  /** bot token. `botToken()`으로 읽는다. 이 값은 어떤 오류 메시지에도 들어가지 않는다. */
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  /** rate limit 재시도 상한. 소진되면 마지막 코드를 그대로 던진다. */
  readonly maxRetries?: number;
  /** 테스트가 실제 대기를 없애기 위해 주입한다. */
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * bot token을 환경변수에서 읽는다.
 *
 * `ORCA_SLACK_BRIDGE_BOT_TOKEN`만 읽는다. 관례 이름 `SLACK_BOT_TOKEN`은 읽지 않는다(OD-005).
 * 사용자 환경변수는 같은 사용자의 모든 프로세스가 상속하므로 관례 이름을 쓰면 나중에 만든
 * 다른 Slack 앱의 토큰을 조용히 집어간다.
 */
export function botToken(env: NodeJS.ProcessEnv): string {
  const token = env[BOT_TOKEN_VAR]?.trim();
  if (!token) throw new Error(`${BOT_TOKEN_VAR}가 비어 있다`);
  if (!token.startsWith('xoxb-')) {
    // 값 전체를 남기지 않는다. verify.ts와 같은 마스킹을 쓴다.
    throw new Error(`${BOT_TOKEN_VAR}가 xoxb-로 시작하지 않는다: ${maskToken(token)}`);
  }
  return token;
}

type Attempt =
  | { readonly kind: 'ok'; readonly message: PostedMessage }
  | { readonly kind: 'retry'; readonly code: string; readonly afterMs: number };

/** `chat.postMessage`/`chat.update` 구현. 이 클래스 밖에서 Slack write를 하지 않는다. */
export class SlackWebApiPoster implements SlackPoster {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SlackPosterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 처리되지 않았음이 확실한 실패만 재시도한다. 애매한 것을 재시도하면 루트가 는다. */
  async post(input: PostMessageInput): Promise<PostedMessage> {
    return this.call(
      'chat.postMessage',
      { channel: input.channel, text: input.text, blocks: input.blocks },
      false,
    );
  }

  /**
   * delivery-unknown 실패에도 재시도한다.
   *
   * `channel`과 `ts`가 고정돼 있어 재시도가 같은 메시지를 같은 내용으로 다시 쓸 뿐이고 루트를
   * 늘리지 않는다. 근거 전문은 `SlackPoster`에 있다.
   */
  async update(input: UpdateMessageInput): Promise<PostedMessage> {
    return this.call(
      'chat.update',
      { channel: input.channel, ts: input.ts, text: input.text, blocks: input.blocks },
      true,
    );
  }

  /**
   * 한 method를 상한까지 시도한다.
   *
   * `retryDeliveryUnknown`이 `post`와 `update`의 유일한 차이다. `attempt`가 던지는 실패는
   * 전부 게시 여부를 알 수 없는 것들이다(응답 유실, 5xx, 비-JSON 응답, 확정 분류에 없는 Slack
   * error code). `post`는 그것을 그대로 올리고, `update`는 상한까지 다시 쓴다.
   */
  private async call(
    method: string,
    body: Record<string, unknown>,
    retryDeliveryUnknown: boolean,
  ): Promise<PostedMessage> {
    for (let attempt = 0; ; attempt += 1) {
      let result: Attempt;
      try {
        result = await this.attempt(method, body);
      } catch (e) {
        if (!retryDeliveryUnknown || attempt >= this.maxRetries) throw e;
        // 이 경로에는 Retry-After가 없다. 서버가 대기 시간을 말하지 않았다는 뜻이다.
        await this.sleep(DEFAULT_RETRY_AFTER_MS);
        continue;
      }
      if (result.kind === 'ok') return result.message;
      if (attempt >= this.maxRetries) throw new SlackApiError(method, result.code);
      await this.sleep(result.afterMs);
    }
  }

  /**
   * 하위 오류 문구에서 token 값을 지운다.
   *
   * `fetchImpl`은 `Authorization` 헤더의 실제 token을 본다. wrapper나 하위 오류가 그 값을
   * message에 넣으면, 그 문구를 그대로 복사한 예외가 로그로 나가 token이 샌다(스펙 §10,
   * OD-005). 마스킹은 `verify.ts`의 `maskToken`을 그대로 쓴다. 형식을 새로 만들면 둘이
   * 갈라지고 한쪽만 고쳐진다.
   */
  private redact(message: string): string {
    const { token } = this.options;
    // 빈 문자열로 replaceAll하면 문자 사이마다 끼워 넣는다. 지울 것도 없다.
    if (token === '') return message;
    return message.replaceAll(token, maskToken(token));
  }

  /** 한 번 호출한다. 확정 재시도가 아닌 실패는 여기서 던지고, 재시도 여부는 `call`이 정한다. */
  private async attempt(method: string, body: Record<string, unknown>): Promise<Attempt> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // 응답을 받지 못했다. 게시 여부를 알 수 없다.
      // 하위 오류 문구는 `fetchImpl`이 만든 것이므로 token이 들어 있을 수 있다.
      throw new Error(
        `Slack ${method} 요청 실패: ${this.redact(e instanceof Error ? e.message : String(e))}`,
      );
    }

    if (res.status === 429) {
      return { kind: 'retry', code: 'ratelimited', afterMs: retryAfterMs(res) };
    }
    if (!res.ok) {
      throw new Error(`Slack ${method} HTTP ${res.status}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error(
        `Slack ${method} 응답이 JSON이 아니다: ${this.redact(e instanceof Error ? e.message : String(e))}`,
      );
    }
    const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;

    if (o['ok'] !== true) {
      // 응답 body도 `fetchImpl`이 만든 값이다. wrapper가 token을 error에 넣으면 그대로
      // `SlackApiError`의 message·code·stack에 실린다. 요청 실패 경로와 같은 마스킹을 건다.
      const raw = typeof o['error'] === 'string' && o['error'] !== '' ? o['error'] : 'unknown_error';
      const code = this.redact(raw);
      if (DEFINITELY_NOT_PROCESSED.has(code)) {
        return { kind: 'retry', code, afterMs: retryAfterMs(res) };
      }
      throw new SlackApiError(method, code);
    }

    const channel = o['channel'];
    const ts = o['ts'];
    if (typeof channel !== 'string' || channel === '' || typeof ts !== 'string' || ts === '') {
      // ok:true인데 identity가 없으면 store가 기록할 값이 없다. 빈 값으로 진행하지 않는다.
      throw new Error(`Slack ${method} 응답에 channel/ts가 없다`);
    }
    return { kind: 'ok', message: { channel, ts } };
  }
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.ceil(seconds * 1000);
}
