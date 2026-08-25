import { describe, expect, it, vi } from 'vitest';
import {
  SlackViewOpenError,
  SlackWebApiViewOpener,
  type SlackModalView,
} from '../src/slack/views.js';

/** Assemble fake credentials so repository secret scanning does not mistake them for live tokens. */
const fakeSecret = (prefix: string, tail: string): string => [prefix, 'FAKE', tail].join('-');

const TOKEN = fakeSecret('xoxb', 'VIEWOPENER-NOT-REAL');
const TRIGGER = fakeSecret('trigger', 'ONE-TIME-CAPABILITY');
const PRIVATE_METADATA = fakeSecret('sidecar', 'PRIVATE-CORRELATION');
const CALLBACK_ID = 'orca_gate_direct_input_v1';

const MODAL: SlackModalView = {
  type: 'modal',
  callback_id: CALLBACK_ID,
  private_metadata: PRIVATE_METADATA,
  title: { type: 'plain_text', text: '직접 결정' },
  submit: { type: 'plain_text', text: '결정' },
  blocks: [
    {
      type: 'input',
      block_id: 'orca_gate_direct_resolution_v1',
      label: { type: 'plain_text', text: '결정 내용' },
      element: {
        type: 'plain_text_input',
        action_id: 'orca_gate_direct_resolution_value_v1',
        multiline: true,
      },
    },
  ],
};

type Reply = {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

class FakeFetch {
  readonly calls: { readonly url: string; readonly init: RequestInit }[] = [];

  constructor(private readonly reply: Reply | Error) {}

  readonly fn: typeof fetch = async (url, init) => {
    this.calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    if (this.reply instanceof Error) throw this.reply;
    return new Response(JSON.stringify(this.reply.body ?? successfulResponse()), {
      status: this.reply.status ?? 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...(this.reply.headers ?? {}),
      },
    });
  };
}

function successfulResponse(): Record<string, unknown> {
  return {
    ok: true,
    view: {
      id: 'V_OPENED_1',
      team_id: 'T_EXPECTED',
      app_id: 'A_EXPECTED',
      callback_id: CALLBACK_ID,
      private_metadata: PRIVATE_METADATA,
      type: 'modal',
      hash: 'ignored-by-the-seam',
    },
  };
}

function opener(fake: FakeFetch): SlackWebApiViewOpener {
  return new SlackWebApiViewOpener({ token: TOKEN, fetchImpl: fake.fn });
}

async function capturedError(promise: Promise<unknown>): Promise<SlackViewOpenError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SlackViewOpenError);
  return error as SlackViewOpenError;
}

describe('SlackWebApiViewOpener', () => {
  it('uses the installed production SDK request shape and returns only safe view identity', async () => {
    const fake = new FakeFetch({});

    await expect(opener(fake).open({ triggerId: TRIGGER, view: MODAL, timeoutMs: 500 }))
      .resolves.toEqual({
        id: 'V_OPENED_1',
        teamId: 'T_EXPECTED',
        appId: 'A_EXPECTED',
        callbackId: CALLBACK_ID,
        privateMetadata: PRIVATE_METADATA,
      });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe('https://slack.com/api/views.open');
    expect(call.init.method).toBe('POST');
    const headers = new Headers(call.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(call.init.redirect).toBe('error');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);

    const form = new URLSearchParams(String(call.init.body));
    expect([...form.keys()].sort()).toEqual(['trigger_id', 'view']);
    expect(form.get('trigger_id')).toBe(TRIGGER);
    expect(JSON.parse(form.get('view') ?? 'null')).toEqual(MODAL);
  });

  it.each([
    {
      label: 'platform rejection',
      reply: { body: { ok: false, error: 'invalid_trigger' } },
      code: 'platform_rejected',
    },
    {
      label: 'HTTP failure',
      reply: { status: 503, body: 'unavailable' },
      code: 'http_failure',
    },
    {
      label: 'rate limit',
      reply: { status: 429, body: {}, headers: { 'retry-after': '60' } },
      code: 'rate_limited',
    },
    {
      label: 'transport failure',
      reply: new Error('socket closed'),
      code: 'request_failure',
    },
  ] as const)('never retries a $label', async ({ reply, code }) => {
    const fake = new FakeFetch(reply);
    const error = await capturedError(
      opener(fake).open({ triggerId: TRIGGER, view: MODAL, timeoutMs: 500 }),
    );
    expect(error.code).toBe(code);
    expect(fake.calls).toHaveLength(1);
  });

  it('bounds a transport that ignores AbortSignal and does not replay the trigger', async () => {
    let calls = 0;
    let suppliedSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = (_url, init) => {
      calls += 1;
      suppliedSignal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    };
    const began = Date.now();
    const error = await capturedError(
      new SlackWebApiViewOpener({ token: TOKEN, fetchImpl })
        .open({ triggerId: TRIGGER, view: MODAL, timeoutMs: 10 }),
    );
    expect(error.code).toBe('deadline_exceeded');
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(calls).toBe(1);
    expect(suppliedSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { label: 'missing view', body: { ok: true } },
    { label: 'wrong view type', body: { ...successfulResponse(), view: { type: 'home' } } },
    {
      label: 'missing exact identity fields',
      body: { ok: true, view: { id: 'V1', team_id: 'T1', app_id: 'A1', type: 'modal' } },
    },
  ])('rejects a malformed ok:true response: $label', async ({ body }) => {
    const fake = new FakeFetch({ body });
    const error = await capturedError(
      opener(fake).open({ triggerId: TRIGGER, view: MODAL, timeoutMs: 500 }),
    );
    expect(error.code).toBe('malformed_response');
    expect(fake.calls).toHaveLength(1);
  });

  it.each([0, 3_001, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid remaining budget %s without a request',
    async (timeoutMs) => {
      const fake = new FakeFetch({});
      const error = await capturedError(opener(fake).open({ triggerId: TRIGGER, view: MODAL, timeoutMs }));
      expect(error.code).toBe('invalid_request');
      expect(fake.calls).toHaveLength(0);
    },
  );

  it('maps secret-bearing SDK failures to a fixed error with no cause or diagnostics', async () => {
    const platformSecret = [TOKEN, TRIGGER, PRIVATE_METADATA].join(':');
    const fake = new FakeFetch({ body: { ok: false, error: platformSecret } });
    const error = await capturedError(
      opener(fake).open({ triggerId: TRIGGER, view: MODAL, timeoutMs: 500 }),
    );

    expect(error.code).toBe('platform_rejected');
    expect(Object.hasOwn(error, 'cause')).toBe(false);
    expect(Object.hasOwn(error, 'data')).toBe(false);
    const exposed = [error.name, error.message, error.stack, JSON.stringify(error)].join('\n');
    for (const secret of [TOKEN, TRIGGER, PRIVATE_METADATA, platformSecret]) {
      expect(exposed).not.toContain(secret);
    }
    expect(fake.calls).toHaveLength(1);
  });

  it('keeps the SDK logger silent even when a response contains warning diagnostics', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const fake = new FakeFetch({
        body: {
          ...successfulResponse(),
          response_metadata: { warnings: [PRIVATE_METADATA], messages: [`[WARN] ${TRIGGER}`] },
        },
      });
      await opener(fake).open({ triggerId: TRIGGER, view: MODAL, timeoutMs: 500 });
      expect([warn.mock.calls.length, error.mock.calls.length, log.mock.calls.length]).toEqual([0, 0, 0]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});
