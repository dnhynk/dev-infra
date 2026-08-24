import { describe, it, expect } from 'vitest';
import {
  boundedSlackUpdate,
  SlackApiError,
  SlackUpdateTimeoutError,
  SlackWebApiPoster,
  botToken,
  type SlackBlock,
  type SlackPoster,
} from '../src/slack/post.js';
import { BOT_TOKEN_VAR, maskToken } from '../src/slack/verify.js';

/**
 * 가짜 토큰은 리터럴로 두지 않고 조립한다.
 * 실제 토큰 형태를 그대로 적으면 GitHub push protection이 커밋을 막는다.
 */
const fakeToken = (prefix: string, tail: string): string => [prefix, 'FAKE', tail].join('-');

const TOKEN = fakeToken('xoxb', 'NOTAREALBOTTOKENVALUE');
const BLOCKS: readonly SlackBlock[] = [
  { type: 'section', text: { type: 'mrkdwn', text: '카드' } },
];

type Reply = { readonly status?: number; readonly body?: unknown; readonly headers?: Record<string, string> };

/** fetch 대역. 호출을 기록하고 미리 정한 응답을 순서대로 준다. */
class FakeFetch {
  readonly calls: { url: string; init: RequestInit }[] = [];
  constructor(private readonly replies: readonly (Reply | Error)[]) {}
  readonly fn: typeof fetch = async (url, init) => {
    const i = Math.min(this.calls.length, this.replies.length - 1);
    this.calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const reply = this.replies[i]!;
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? { ok: true, channel: 'C1', ts: '1.1' }), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  };
}

function poster(fake: FakeFetch, maxRetries = 3): SlackWebApiPoster {
  return new SlackWebApiPoster({
    token: TOKEN,
    fetchImpl: fake.fn,
    maxRetries,
    sleep: async () => {},
  });
}

const postInput = { channel: 'C1', text: '대체 텍스트', blocks: BLOCKS };
const replyInput = {
  channel: 'C1',
  threadTs: '1700000000.000100',
  text: '전이 대체 텍스트',
  blocks: BLOCKS,
};
const updateInput = { channel: 'C1', ts: '1.1', text: '대체 텍스트', blocks: BLOCKS };

describe('SlackWebApiPoster', () => {
  it('bounds an injected card updater that ignores cancellation and never settles', async () => {
    const hanging: SlackPoster = {
      post: () => Promise.reject(new Error('unused')),
      update: () => new Promise(() => undefined),
    };
    const began = Date.now();
    await expect(boundedSlackUpdate(hanging, updateInput, 10)).rejects.toBeInstanceOf(
      SlackUpdateTimeoutError,
    );
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  it('aborts the production fetch at the card deadline without retrying', async () => {
    let calls = 0;
    let aborted = false;
    let sleeps = 0;
    const fetchImpl: typeof fetch = (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          reject(new Error('missing abort signal'));
          return;
        }
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted by deadline'));
        }, { once: true });
      });
    };
    const raw = new SlackWebApiPoster({
      token: TOKEN,
      fetchImpl,
      sleep: async () => { sleeps += 1; },
    });
    await expect(boundedSlackUpdate(raw, updateInput, 10)).rejects.toBeInstanceOf(
      SlackUpdateTimeoutError,
    );
    expect({ calls, aborted, sleeps }).toEqual({ calls: 1, aborted: true, sleeps: 0 });
  });

  it('a deadline during retry sleep prevents a second Slack request', async () => {
    let calls = 0;
    const raw = new SlackWebApiPoster({
      token: TOKEN,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('delivery unknown before retry sleep');
      },
    });
    await expect(boundedSlackUpdate(raw, updateInput, 10)).rejects.toBeInstanceOf(
      SlackUpdateTimeoutError,
    );
    expect(calls).toBe(1);
  });

  it('post는 chat.postMessage를 호출하고 channel/ts를 돌려준다', async () => {
    const fake = new FakeFetch([{ body: { ok: true, channel: 'C9', ts: '1700000000.000100' } }]);
    const result = await poster(fake).post(postInput);
    expect(result).toEqual({ channel: 'C9', ts: '1700000000.000100' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(String(fake.calls[0]!.init.body))).toEqual({
      channel: 'C1',
      text: '대체 텍스트',
      blocks: BLOCKS,
    });
  });

  it('update는 chat.update를 호출하고 ts를 함께 보낸다', async () => {
    const fake = new FakeFetch([{ body: { ok: true, channel: 'C1', ts: '1.1' } }]);
    await poster(fake).update(updateInput);
    expect(fake.calls[0]!.url).toBe('https://slack.com/api/chat.update');
    expect(JSON.parse(String(fake.calls[0]!.init.body))['ts']).toBe('1.1');
  });

  it('ok:false를 성공으로 처리하지 않고 error 코드를 그대로 올린다', async () => {
    const fake = new FakeFetch([{ body: { ok: false, error: 'channel_not_found' } }]);
    await expect(poster(fake).post(postInput)).rejects.toBeInstanceOf(SlackApiError);
    const err = await poster(new FakeFetch([{ body: { ok: false, error: 'message_not_found' } }]))
      .update(updateInput)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).code).toBe('message_not_found');
    expect((err as SlackApiError).method).toBe('chat.update');
  });

  it('게시 여부를 알 수 없는 오류는 재시도하지 않는다', async () => {
    for (const code of ['internal_error', 'fatal_error', 'not_in_channel']) {
      const fake = new FakeFetch([{ body: { ok: false, error: code } }]);
      await expect(poster(fake).post(postInput)).rejects.toThrow(code);
      expect(fake.calls).toHaveLength(1);
    }
  });

  it('처리되지 않았음이 확실한 rate limit만 재시도한다', async () => {
    const fake = new FakeFetch([
      { body: { ok: false, error: 'ratelimited' }, headers: { 'retry-after': '1' } },
      { body: { ok: false, error: 'rate_limited' } },
      { body: { ok: true, channel: 'C1', ts: '2.2' } },
    ]);
    await expect(poster(fake).post(postInput)).resolves.toEqual({ channel: 'C1', ts: '2.2' });
    expect(fake.calls).toHaveLength(3);
  });

  it('HTTP 429도 rate limit으로 보고 재시도한다', async () => {
    const fake = new FakeFetch([
      { status: 429, body: {}, headers: { 'retry-after': '2' } },
      { body: { ok: true, channel: 'C1', ts: '3.3' } },
    ]);
    await expect(poster(fake).post(postInput)).resolves.toEqual({ channel: 'C1', ts: '3.3' });
    expect(fake.calls).toHaveLength(2);
  });

  it('재시도 상한을 넘으면 마지막 코드를 그대로 던진다', async () => {
    const fake = new FakeFetch([{ body: { ok: false, error: 'ratelimited' } }]);
    await expect(poster(fake, 2).post(postInput)).rejects.toThrow('ratelimited');
    expect(fake.calls).toHaveLength(3);
  });

  it('응답을 받지 못한 실패는 재시도하지 않는다', async () => {
    const fake = new FakeFetch([new Error('socket hang up')]);
    await expect(poster(fake).post(postInput)).rejects.toThrow('socket hang up');
    expect(fake.calls).toHaveLength(1);
  });

  it('2xx가 아닌 응답을 성공으로 처리하지 않는다', async () => {
    const fake = new FakeFetch([{ status: 500, body: { ok: true } }]);
    await expect(poster(fake).post(postInput)).rejects.toThrow('HTTP 500');
  });

  it('ok:true인데 channel/ts가 없으면 빈 값으로 진행하지 않는다', async () => {
    const fake = new FakeFetch([{ body: { ok: true, channel: 'C1' } }]);
    await expect(poster(fake).post(postInput)).rejects.toThrow('channel/ts가 없다');
  });

  it('토큰은 authorization 헤더에만 있고 오류에는 나오지 않는다', async () => {
    const fake = new FakeFetch([
      { body: { ok: false, error: 'invalid_auth' } },
      { status: 503, body: {} },
      new Error('ECONNRESET'),
    ]);
    const p = poster(fake, 0);
    const errors: unknown[] = [];
    for (const call of [
      () => p.post(postInput),
      () => p.post(postInput),
      () => p.post(postInput),
    ]) {
      errors.push(await call().catch((e: unknown) => e));
    }
    expect(errors).toHaveLength(3);
    for (const e of errors) {
      const err = e as Error;
      expect(err).toBeInstanceOf(Error);
      expect(`${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`).not.toContain(TOKEN);
    }
    // 헤더에는 실제로 실려 있었다. 없어서 안 나온 것이 아니다.
    const headers = fake.calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${TOKEN}`);
    // 요청 body에는 토큰을 싣지 않는다.
    expect(String(fake.calls[0]!.init.body)).not.toContain(TOKEN);
  });
});

describe('SlackWebApiPoster · token이 실린 하위 오류', () => {
  /**
   * `fetchImpl`은 `Authorization` 헤더의 실제 token을 본다. wrapper나 하위 오류가 그 값을
   * message에 넣으면 그것을 복사한 예외로 새어 나간다. `ECONNRESET`처럼 token이 없는 오류만
   * 주입하면 이 경로를 못 잡는다.
   */
  const leaking = (): Error => new Error(`connect ECONNREFUSED authorization=Bearer ${TOKEN}`);

  it('요청 실패 오류에서 token을 마스킹한다', async () => {
    const fake = new FakeFetch([leaking()]);
    const err = (await poster(fake, 0)
      .post(postInput)
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(TOKEN);
    // 지우기만 하지 않는다. verify.ts와 같은 마스킹 형식으로 남긴다.
    expect(err.message).toContain(maskToken(TOKEN));
    // 원래 진단 정보는 남는다.
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('응답이 JSON이 아닐 때의 오류에서도 token을 마스킹한다', async () => {
    // `res.json()`이 던진 문구도 그대로 복사되는 자리다. 같은 마스킹을 거친다.
    const leaky = new SlackWebApiPoster({
      token: TOKEN,
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: async () =>
        ({
          status: 200,
          ok: true,
          headers: new Headers(),
          json: async () => {
            throw leaking();
          },
        }) as unknown as Response,
    });
    const err = (await leaky.post(postInput).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('JSON이 아니다');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain(maskToken(TOKEN));
  });

  it('ok:false 응답의 error 코드에서도 token을 마스킹한다', async () => {
    // 응답 body도 `fetchImpl`이 만든 값이다. 여기서 마스킹하지 않으면 `SlackApiError`의
    // message·code·stack 세 곳에 token이 그대로 남는다.
    const fake = new FakeFetch([
      { body: { ok: false, error: `invalid_auth authorization=Bearer ${TOKEN}` } },
    ]);
    const err = (await poster(fake, 0)
      .post(postInput)
      .catch((e: unknown) => e)) as SlackApiError;
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).not.toContain(TOKEN);
    expect(err.message).not.toContain(TOKEN);
    expect(err.stack ?? '').not.toContain(TOKEN);
    // 지우기만 하지 않는다. verify.ts와 같은 마스킹 형식으로 남긴다.
    expect(err.code).toContain(maskToken(TOKEN));
    // 원래 진단 정보는 남는다.
    expect(err.code).toContain('invalid_auth');
  });

  it('update가 재시도를 소진해도 token이 오류에 실리지 않는다', async () => {
    const fake = new FakeFetch([leaking()]);
    const err = (await poster(fake, 1)
      .update(updateInput)
      .catch((e: unknown) => e)) as Error;
    expect(fake.calls).toHaveLength(2);
    expect(`${err.message}
${err.stack ?? ''}`).not.toContain(TOKEN);
  });
});

describe('SlackWebApiPoster · post와 update의 재시도 비대칭', () => {
  /**
   * `post`는 루트를 만든다. delivery-unknown을 재시도하면 루트가 늘고 되돌릴 수 없다.
   * `update`는 channel과 ts가 고정돼 있어 재시도가 같은 메시지를 같은 내용으로 다시 쓸 뿐이다.
   * 재시도하지 않으면 안전하게 다시 쓸 수 있는 갱신이 stale 카드로 남는다.
   */
  const ok = { body: { ok: true, channel: 'C1', ts: '9.9' } } as const;

  it('응답 유실을 update는 재시도하고 post는 재시도하지 않는다', async () => {
    const forUpdate = new FakeFetch([new Error('socket hang up'), ok]);
    await expect(poster(forUpdate).update(updateInput)).resolves.toEqual({
      channel: 'C1',
      ts: '9.9',
    });
    expect(forUpdate.calls).toHaveLength(2);

    const forPost = new FakeFetch([new Error('socket hang up'), ok]);
    await expect(poster(forPost).post(postInput)).rejects.toThrow('socket hang up');
    expect(forPost.calls).toHaveLength(1);
  });

  it('5xx와 internal_error도 update만 재시도한다', async () => {
    for (const first of [{ status: 503, body: {} }, { body: { ok: false, error: 'internal_error' } }]) {
      const forUpdate = new FakeFetch([first, ok]);
      await expect(poster(forUpdate).update(updateInput)).resolves.toEqual({
        channel: 'C1',
        ts: '9.9',
      });
      expect(forUpdate.calls).toHaveLength(2);

      const forPost = new FakeFetch([first, ok]);
      await expect(poster(forPost).post(postInput)).rejects.toThrow();
      expect(forPost.calls).toHaveLength(1);
    }
  });

  it('update 재시도는 maxRetries에서 멈추고 마지막 오류를 그대로 던진다', async () => {
    const fake = new FakeFetch([{ body: { ok: false, error: 'internal_error' } }]);
    const err = (await poster(fake, 2)
      .update(updateInput)
      .catch((e: unknown) => e)) as SlackApiError;
    // 무한 재시도가 아니다. 1회 + 상한 2회.
    expect(fake.calls).toHaveLength(3);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).toBe('internal_error');
    expect(err.method).toBe('chat.update');
  });

  it('재시도해도 결과가 같은 코드를 다른 코드로 바꾸지 않는다', async () => {
    const fake = new FakeFetch([{ body: { ok: false, error: 'message_not_found' } }]);
    const err = (await poster(fake, 1)
      .update(updateInput)
      .catch((e: unknown) => e)) as SlackApiError;
    // 호출자가 "메시지가 지워져 다시 연결해야 함"을 그대로 받는다(UX §6).
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).toBe('message_not_found');
  });

  it('post의 확정 분류는 넓어지지 않았다', async () => {
    for (const code of ['internal_error', 'fatal_error', 'not_in_channel', 'invalid_auth']) {
      const fake = new FakeFetch([{ body: { ok: false, error: code } }]);
      await expect(poster(fake).post(postInput)).rejects.toThrow(code);
      expect(fake.calls).toHaveLength(1);
    }
  });
});

/**
 * thread reply.
 *
 * `chat.postMessage`이고 같은 요청임을 Slack이 알아볼 identity가 없다. 그래서 재시도 규율이
 * `post`와 같아야 한다 — 게시 여부를 알 수 없는 실패를 재시도하면 thread에 같은 전이가 두 번
 * 남고 되돌릴 수 없다. 아래 단언은 `update`가 아니라 `post`와 대조한다.
 */
describe('SlackWebApiPoster.reply', () => {
  it('chat.postMessage를 호출하고 thread_ts를 함께 보낸다', async () => {
    const fake = new FakeFetch([{ body: { ok: true, channel: 'C9', ts: '1700000009.000009' } }]);
    const result = await poster(fake).reply(replyInput);
    // 응답의 channel/ts를 그대로 PostedMessage로 만든다. store가 이 값을 기록한다.
    expect(result).toEqual({ channel: 'C9', ts: '1700000009.000009' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(String(fake.calls[0]!.init.body))).toEqual({
      channel: 'C1',
      // 이 필드가 빠지면 thread reply가 아니라 루트가 하나 더 생긴다.
      thread_ts: '1700000000.000100',
      text: '전이 대체 텍스트',
      blocks: BLOCKS,
    });
  });

  it('ok:false를 성공으로 처리하지 않고 error 코드를 그대로 올린다', async () => {
    const fake = new FakeFetch([{ body: { ok: false, error: 'message_not_found' } }]);
    const err = (await poster(fake)
      .reply(replyInput)
      .catch((e: unknown) => e)) as SlackApiError;
    expect(err).toBeInstanceOf(SlackApiError);
    // 루트가 지워져 다시 연결해야 하는 경우를 호출자가 구분할 수 있어야 한다(UX §6).
    expect(err.code).toBe('message_not_found');
    expect(err.method).toBe('chat.postMessage');
  });

  it('ok:true인데 channel/ts가 없으면 빈 값으로 진행하지 않는다', async () => {
    const fake = new FakeFetch([{ body: { ok: true, channel: 'C1' } }]);
    await expect(poster(fake).reply(replyInput)).rejects.toThrow('channel/ts가 없다');
  });

  it('게시 여부를 알 수 없는 실패를 재시도하지 않는다', async () => {
    const ok = { body: { ok: true, channel: 'C1', ts: '9.9' } } as const;
    const cases = [
      // 응답을 아예 받지 못했다.
      new Error('socket hang up'),
      // Slack 문서가 "some aspect of the operation succeeded" 가능성을 적는 코드들.
      { body: { ok: false, error: 'internal_error' } },
      { body: { ok: false, error: 'fatal_error' } },
      { status: 503, body: {} },
    ];
    for (const first of cases) {
      // 뒤에 성공 응답을 둔다. 재시도했다면 성공으로 끝나 실패를 놓치지 않는다.
      const forReply = new FakeFetch([first, ok]);
      await expect(poster(forReply).reply(replyInput)).rejects.toThrow();
      expect(forReply.calls).toHaveLength(1);

      // `post`와 같은 판정인지 대조한다. 갈라지면 여기서 드러난다.
      const forPost = new FakeFetch([first, ok]);
      await expect(poster(forPost).post(postInput)).rejects.toThrow();
      expect(forPost.calls).toHaveLength(1);
    }
  });

  it('처리되지 않았음이 확실한 rate limit만 재시도한다', async () => {
    const fake = new FakeFetch([
      { body: { ok: false, error: 'ratelimited' }, headers: { 'retry-after': '1' } },
      { body: { ok: true, channel: 'C1', ts: '4.4' } },
    ]);
    await expect(poster(fake).reply(replyInput)).resolves.toEqual({ channel: 'C1', ts: '4.4' });
    expect(fake.calls).toHaveLength(2);
    // 재시도한 요청에도 thread_ts가 그대로 실린다.
    expect(JSON.parse(String(fake.calls[1]!.init.body))['thread_ts']).toBe('1700000000.000100');
  });

  it('토큰이 오류에 실리지 않는다', async () => {
    const fake = new FakeFetch([
      new Error(`connect ECONNREFUSED authorization=Bearer ${TOKEN}`),
    ]);
    const err = (await poster(fake, 0)
      .reply(replyInput)
      .catch((e: unknown) => e)) as Error;
    expect(`${err.message}
${err.stack ?? ''}`).not.toContain(TOKEN);
    expect(err.message).toContain(maskToken(TOKEN));
  });
});

describe('botToken', () => {
  it('ORCA_SLACK_BRIDGE_BOT_TOKEN만 읽는다', () => {
    expect(botToken({ [BOT_TOKEN_VAR]: TOKEN })).toBe(TOKEN);
  });

  it('관례 이름 SLACK_BOT_TOKEN은 읽지 않는다', () => {
    expect(() => botToken({ SLACK_BOT_TOKEN: TOKEN })).toThrow(BOT_TOKEN_VAR);
  });

  it('xoxb-가 아니면 거부하고 값 전체를 남기지 않는다', () => {
    const wrong = fakeToken('xoxp', 'NOTAREALUSERTOKENVALUE');
    const err = (() => {
      try {
        botToken({ [BOT_TOKEN_VAR]: wrong });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain(wrong);
  });
});
