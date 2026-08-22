import { describe, it, expect } from 'vitest';
import {
  SlackApiError,
  SlackWebApiPoster,
  botToken,
  type SlackBlock,
} from '../src/slack/post.js';
import { BOT_TOKEN_VAR } from '../src/slack/verify.js';

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
const updateInput = { channel: 'C1', ts: '1.1', text: '대체 텍스트', blocks: BLOCKS };

describe('SlackWebApiPoster', () => {
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
