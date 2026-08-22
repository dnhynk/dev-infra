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
 * `update`는 channel과 ts가 이미 정해져 있어 같은 위험이 없다.
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
 * 코드는 게시 여부를 단정할 수 없으므로 재시도하지 않고 그대로 던진다. 기본값이
 * delivery-unknown인 이유는 `SlackPoster`의 설명에 있다.
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

  async post(input: PostMessageInput): Promise<PostedMessage> {
    return this.call('chat.postMessage', {
      channel: input.channel,
      text: input.text,
      blocks: input.blocks,
    });
  }

  async update(input: UpdateMessageInput): Promise<PostedMessage> {
    return this.call('chat.update', {
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      blocks: input.blocks,
    });
  }

  private async call(method: string, body: Record<string, unknown>): Promise<PostedMessage> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.attempt(method, body);
      if (result.kind === 'ok') return result.message;
      if (attempt >= this.maxRetries) throw new SlackApiError(method, result.code);
      await this.sleep(result.afterMs);
    }
  }

  /** 한 번 호출한다. 재시도할 수 없는 실패는 여기서 던진다. */
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
      // 응답을 받지 못했다. 게시 여부를 알 수 없으므로 재시도하지 않는다.
      throw new Error(
        `Slack ${method} 요청 실패: ${e instanceof Error ? e.message : String(e)}`,
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
      throw new Error(`Slack ${method} 응답이 JSON이 아니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;

    if (o['ok'] !== true) {
      const code = typeof o['error'] === 'string' && o['error'] !== '' ? o['error'] : 'unknown_error';
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
