import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { SocketModeClient } from '@slack/socket-mode';
import { Response as UndiciResponse } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SlackSocketTransport,
  slackSdkConnectionFactory,
} from '../src/slack/socket.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

type HelloServer = {
  readonly url: string;
  readonly upgrades: () => number;
  readonly send: (index: number, payload: object) => void;
  readonly disconnect: (index: number) => void;
  readonly close: () => Promise<void>;
};

function textFrame(payload: object): Buffer {
  const encoded = Buffer.from(JSON.stringify(payload));
  if (encoded.length > 125) throw new Error('test WebSocket frame is too large');
  return Buffer.concat([Buffer.from([0x81, encoded.length]), encoded]);
}

const CLOSE_FRAME = Buffer.from([0x88, 0x02, 0x03, 0xe8]);

/** 실제 SDK/undici WebSocket을 열고 필요할 때만 최소 close handshake를 수행하는 seam이다. */
async function startHelloServer(options: {
  readonly autoHello?: boolean;
  readonly replyToClose?: boolean;
} = {}): Promise<HelloServer> {
  const server = createServer();
  const liveSockets = new Set<Duplex>();
  const sockets: Duplex[] = [];
  const serverClosing = new WeakSet<Duplex>();
  let upgradeCount = 0;
  server.on('upgrade', (request, socket) => {
    upgradeCount += 1;
    sockets.push(socket);
    liveSockets.add(socket);
    socket.once('close', () => liveSockets.delete(socket));
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (options.replyToClose === true) {
      socket.on('data', (chunk: Buffer) => {
        if (chunk.length === 0 || (chunk[0]! & 0x0f) !== 0x08) return;
        if (!serverClosing.has(socket) && !socket.destroyed) socket.write(CLOSE_FRAME);
        socket.end();
      });
    }
    if (options.autoHello !== false) {
      socket.write(textFrame({
        type: 'hello',
        connection_info: { app_id: 'A01BRIDGE' },
      }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('local server address missing');
  return {
    url: `ws://127.0.0.1:${address.port}/socket`,
    upgrades: () => upgradeCount,
    send: (index, payload) => {
      const socket = sockets[index];
      if (socket === undefined || socket.destroyed) throw new Error('test WebSocket is not open');
      socket.write(textFrame(payload));
    },
    disconnect: (index) => {
      const socket = sockets[index];
      if (socket === undefined || socket.destroyed) throw new Error('test WebSocket is not open');
      serverClosing.add(socket);
      socket.write(CLOSE_FRAME);
    },
    close: async () => {
      for (const socket of liveSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function connectionsOpenResponse(url: string): Response {
  return new Response(JSON.stringify({ ok: true, url }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('@slack/socket-mode 3.0.0 lifecycle fence', () => {
  it.each([
    ['missing', {}],
    ['mismatch', { app_id: 'A01OTHER' }],
  ] as const)('current disconnect와 candidate App ID %s가 겹쳐도 backoff 뒤 회복하고 restart한다', async (
    _identityFailure,
    candidateInfo,
  ) => {
    const server = await startHelloServer({ autoHello: false, replyToClose: true });
    const retryRelease = deferred<void>();
    const delays: number[] = [];
    const fetchMock = vi.fn(async () => connectionsOpenResponse(server.url));
    vi.stubGlobal('fetch', fetchMock);
    const clients: SocketModeClient[] = [];
    const sdkStart = SocketModeClient.prototype.start;
    vi.spyOn(SocketModeClient.prototype, 'start').mockImplementation(function startSdk(
      this: SocketModeClient,
    ) {
      clients.push(this);
      return sdkStart.call(this);
    });
    const transport = new SlackSocketTransport({
      expectedApiAppId: 'A01BRIDGE',
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      backoff: { initialMs: 10, maxMs: 40 },
      timeouts: { startMs: 500, closeMs: 100 },
      sleep: async (delay) => {
        delays.push(delay);
        await retryRelease.promise;
      },
    });

    try {
      const starting = transport.start();
      await vi.waitFor(() => expect(server.upgrades()).toBe(1));
      server.send(0, { type: 'hello', connection_info: { app_id: 'A01BRIDGE' } });
      await starting;

      server.send(0, { type: 'disconnect', reason: 'refresh_requested' });
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(server.upgrades()).toBe(2);
      });
      let currentDisconnected = false;
      clients[0]?.once('disconnected', () => { currentDisconnected = true; });
      server.disconnect(0);
      await vi.waitFor(() => expect(currentDisconnected).toBe(true));
      server.send(1, { type: 'hello', connection_info: candidateInfo });

      await vi.waitFor(() => expect({
        delays,
        fetches: fetchMock.mock.calls.length,
        upgrades: server.upgrades(),
      }).toEqual({ delays: [20], fetches: 2, upgrades: 2 }));

      retryRelease.resolve();
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(server.upgrades()).toBe(3);
      });
      server.send(2, { type: 'hello', connection_info: { app_id: 'A01BRIDGE' } });
      await vi.waitFor(() => expect(clients[2]?.websocket?.readyState).toBe(1));

      await transport.shutdown();
      const restarting = transport.start();
      await vi.waitFor(() => expect(server.upgrades()).toBe(4));
      server.send(3, { type: 'hello', connection_info: { app_id: 'A01BRIDGE' } });
      await restarting;
      expect(fetchMock).toHaveBeenCalledTimes(4);
      await transport.shutdown();
    } finally {
      retryRelease.resolve();
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it.each([
    ['native', (url: string) => connectionsOpenResponse(url)],
    ['undici', (url: string) => new UndiciResponse(JSON.stringify({ ok: true, url }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })],
  ] as const)('%s Response를 같은 fetch 계약으로 수용한다', async (_implementation, response) => {
    const server = await startHelloServer({ replyToClose: true });
    const fetchMock = vi.fn(async () => response(server.url));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new SlackSocketTransport({
      expectedApiAppId: 'A01BRIDGE',
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
    });

    try {
      await expect(transport.start()).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(server.upgrades()).toBe(1);
      await expect(transport.shutdown()).resolves.toBeUndefined();
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('fetch rejection을 고정 connect_failed로 바꾸고 bounded shutdown한다', async () => {
    const server = await startHelloServer();
    const fetchMock = vi.fn(async () => {
      throw new Error('raw fetch failure');
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
    });

    try {
      await expect(transport.start()).rejects.toMatchObject({ code: 'connect_failed' });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(server.upgrades()).toBe(0);
      await expect(transport.shutdown()).resolves.toBeUndefined();
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('null body Response도 자원 취급 없이 fail closed하고 bounded shutdown한다', async () => {
    const server = await startHelloServer();
    const response = new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    const transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
    });

    try {
      await expect(transport.start()).rejects.toMatchObject({ code: 'connect_failed' });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect({ body: response.body, upgrades: server.upgrades() }).toEqual({
        body: null,
        upgrades: 0,
      });
      await expect(transport.shutdown()).resolves.toBeUndefined();
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('fetch 반환 전 owner abort로 settle 진입 시 already-aborted여도 body를 cancel한다', async () => {
    const server = await startHelloServer();
    let cancelCalls = 0;
    let resourceActive = true;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
        resourceActive = false;
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    let transport!: SlackSocketTransport;
    let shutdown: Promise<void> | undefined;
    const fetchMock = vi.fn(() => {
      shutdown = transport.shutdown();
      return Promise.resolve(response);
    });
    vi.stubGlobal('fetch', fetchMock);
    transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
    });

    try {
      await expect(transport.start()).rejects.toMatchObject({ code: 'connect_failed' });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(shutdown).toBeDefined();
      await expect(shutdown).resolves.toBeUndefined();
      await flushMicrotasks();
      expect({ cancelCalls, resourceActive, locked: body.locked, upgrades: server.upgrades() })
        .toEqual({ cancelCalls: 1, resourceActive: false, locked: false, upgrades: 0 });
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('malformed fetch response는 WebSocket 전에 fail closed한다', async () => {
    const server = await startHelloServer();
    let cancelCalls = 0;
    let resourceActive = true;
    const malformed = {
      body: {
        getReader() {
          return {
            cancel() {
              cancelCalls += 1;
              resourceActive = false;
            },
          };
        },
      },
      headers: new Headers({ 'content-type': 'application/json' }),
      status: 200,
      statusText: 'OK',
    };
    const fetchMock = vi.fn(async () => malformed);
    vi.stubGlobal('fetch', fetchMock);
    const transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
    });

    try {
      await expect(transport.start()).rejects.toMatchObject({ code: 'connect_failed' });
      await flushMicrotasks();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect({ cancelCalls, resourceActive, upgrades: server.upgrades() }).toEqual({
        cancelCalls: 1,
        resourceActive: false,
        upgrades: 0,
      });
      await expect(transport.shutdown()).resolves.toBeUndefined();
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('malformed metadata와 Response reconstruction failure도 body를 cancel한다', async () => {
    const server = await startHelloServer();
    const cases: ReadonlyArray<readonly [
      string,
      (body: ReadableStream<Uint8Array>) => Record<string, unknown>,
    ]> = [
      ['status', (body) => ({
        body,
        headers: new Headers({ 'content-type': 'application/json' }),
        status: 199,
        statusText: 'OK',
      })],
      ['headers', (body) => ({
        body,
        headers: {
          get: () => null,
          entries: () => [[1, 'not-a-header']],
        },
        status: 200,
        statusText: 'OK',
      })],
      ['reconstruction', (body) => ({
        body,
        headers: new Headers({ 'content-type': 'application/json' }),
        status: 204,
        statusText: 'No Content',
      })],
    ];

    try {
      for (const [failure, makeResponse] of cases) {
        let cancelCalls = 0;
        let resourceActive = true;
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelCalls += 1;
            resourceActive = false;
          },
        });
        const fetchMock = vi.fn(async () => makeResponse(body));
        vi.stubGlobal('fetch', fetchMock);
        const transport = new SlackSocketTransport({
          connectionFactory: slackSdkConnectionFactory('xapp-test'),
          timeouts: { startMs: 500, closeMs: 100 },
        });

        try {
          await expect(transport.start()).rejects.toMatchObject({ code: 'connect_failed' });
          await flushMicrotasks();
          expect(fetchMock, failure).toHaveBeenCalledOnce();
          expect({ cancelCalls, resourceActive, upgrades: server.upgrades() }, failure).toEqual({
            cancelCalls: 1,
            resourceActive: false,
            upgrades: 0,
          });
          await expect(transport.shutdown(), failure).resolves.toBeUndefined();
        } finally {
          await transport.shutdown().catch(() => undefined);
        }
      }
    } finally {
      await server.close();
    }
  });

  it('malformed body chunk를 fail closed하고 raw reader를 cancel한다', async () => {
    const server = await startHelloServer();
    let cancelCalls = 0;
    let resourceActive = true;
    const body = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue('not-a-byte-chunk');
      },
      cancel() {
        cancelCalls += 1;
        resourceActive = false;
      },
    });
    const fetchMock = vi.fn(async () => ({
      body,
      headers: new Headers({ 'content-type': 'application/json' }),
      status: 200,
      statusText: 'OK',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
    });

    try {
      await expect(transport.start()).rejects.toMatchObject({ code: 'connect_failed' });
      await flushMicrotasks();
      expect({ cancelCalls, resourceActive, upgrades: server.upgrades() }).toEqual({
        cancelCalls: 1,
        resourceActive: false,
        upgrades: 0,
      });
      await expect(transport.shutdown()).resolves.toBeUndefined();
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('정상 body EOF 뒤 owner abort는 raw reader를 cancel하지 않는다', async () => {
    const server = await startHelloServer({ replyToClose: true });
    let cancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, url: server.url })));
        controller.close();
      },
      cancel() { cancelCalls += 1; },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      body,
      headers: new Headers({ 'content-type': 'application/json' }),
      status: 200,
      statusText: 'OK',
    })));
    const transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
    });

    try {
      await expect(transport.start()).resolves.toBeUndefined();
      expect(server.upgrades()).toBe(1);
      expect(body.locked).toBe(false);
      await expect(transport.shutdown()).resolves.toBeUndefined();
      await flushMicrotasks();
      expect({ cancelCalls, locked: body.locked }).toEqual({ cancelCalls: 0, locked: false });
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('consumer cancel 뒤 owner abort는 raw reader를 중복 cancel하지 않는다', async () => {
    const server = await startHelloServer({ replyToClose: true });
    let cancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelCalls += 1; },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      body,
      headers: new Headers({ 'content-type': 'application/json' }),
      status: 200,
      statusText: 'OK',
    })));
    vi.spyOn(Response.prototype, 'text').mockImplementation(async function text(this: Response) {
      await this.body?.cancel('consumer stopped');
      return JSON.stringify({ ok: true, url: server.url });
    });
    const transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
    });

    try {
      await expect(transport.start()).resolves.toBeUndefined();
      expect({ cancelCalls, upgrades: server.upgrades() }).toEqual({
        cancelCalls: 1,
        upgrades: 1,
      });
      expect(body.locked).toBe(false);
      await expect(transport.shutdown()).resolves.toBeUndefined();
      await flushMicrotasks();
      expect({ cancelCalls, locked: body.locked }).toEqual({ cancelCalls: 1, locked: false });
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('fetch fulfillment과 response fence 사이 shutdown도 body resource를 cancel한다', async () => {
    const server = await startHelloServer();
    const request = deferred<Response>();
    let cancelCalls = 0;
    let resourceActive = true;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
        resourceActive = false;
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const fetchMock = vi.fn(() => request.promise);
    vi.stubGlobal('fetch', fetchMock);
    const transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
    });

    try {
      const starting = transport.start();
      const rejected = expect(starting).rejects.toMatchObject({ code: 'connect_failed' });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

      // fetch 소유권 reaction 뒤, adapter 반환 continuation 앞에서 abort한다.
      const shutdownAfterFulfillment = request.promise.then(() => transport.shutdown());
      request.resolve(response);

      await rejected;
      await expect(shutdownAfterFulfillment).resolves.toBeUndefined();
      await flushMicrotasks();
      expect({ cancelCalls, resourceActive, upgrades: server.upgrades() }).toEqual({
        cancelCalls: 1,
        resourceActive: false,
        upgrades: 0,
      });
      expect(body.locked).toBe(false);
    } finally {
      request.resolve(response);
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it.each([1, 2, 3])(
    'fetch fulfillment observer가 owner abort를 먼저 queue해도 body resource를 cancel한다 (%i/3)',
    async () => {
      const server = await startHelloServer();
      const request = deferred<Response>();
      let cancelCalls = 0;
      let resourceActive = true;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelCalls += 1;
          resourceActive = false;
        },
      });
      const response = new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      let transport!: SlackSocketTransport;
      const liveAbortListeners = new Set<Parameters<AbortSignal['addEventListener']>[1]>();
      // fetch adapter가 reaction을 등록하기 전에 owner abort reaction을 먼저 등록한다.
      const shutdownAfterFulfillment = request.promise.then(() => transport.shutdown());
      const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
        const requestSignal = init?.signal;
        if (requestSignal === undefined || requestSignal === null) {
          throw new Error('request signal missing');
        }
        const addEventListener = requestSignal.addEventListener.bind(requestSignal);
        const removeEventListener = requestSignal.removeEventListener.bind(requestSignal);
        vi.spyOn(requestSignal, 'addEventListener').mockImplementation((type, listener, options) => {
          if (type === 'abort') liveAbortListeners.add(listener);
          addEventListener(type, listener, options);
        });
        vi.spyOn(requestSignal, 'removeEventListener').mockImplementation((type, listener, options) => {
          if (type === 'abort') liveAbortListeners.delete(listener);
          removeEventListener(type, listener, options);
        });
        return request.promise;
      });
      vi.stubGlobal('fetch', fetchMock);
      transport = new SlackSocketTransport({
        connectionFactory: slackSdkConnectionFactory('xapp-test'),
        timeouts: { startMs: 500, closeMs: 100 },
      });

      try {
        const starting = transport.start();
        const rejected = expect(starting).rejects.toMatchObject({ code: 'connect_failed' });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        request.resolve(response);

        await rejected;
        await expect(shutdownAfterFulfillment).resolves.toBeUndefined();
        await flushMicrotasks();
        expect({
          cancelCalls,
          resourceActive,
          locked: body.locked,
          abortListeners: liveAbortListeners.size,
          upgrades: server.upgrades(),
        }).toEqual({
          cancelCalls: 1,
          resourceActive: false,
          locked: false,
          abortListeners: 0,
          upgrades: 0,
        });
      } finally {
        request.resolve(response);
        await transport.shutdown().catch(() => undefined);
        await server.close();
      }
    },
  );

  it('abort 뒤 late connections.open fulfillment을 cancel/release하고 WebSocket을 만들지 않는다', async () => {
    const server = await startHelloServer();
    vi.useFakeTimers();
    const request = deferred<Response>();
    const requestSignals: Array<AbortSignal | undefined> = [];
    let getReaderCalls = 0;
    let readCalls = 0;
    let cancelCalls = 0;
    let releaseCalls = 0;
    let resourceActive = true;
    let locked = false;
    const lateResponse = {
      body: {
        getReader() {
          getReaderCalls += 1;
          locked = true;
          return {
            read() {
              readCalls += 1;
              return new Promise(() => undefined);
            },
            cancel() {
              cancelCalls += 1;
              resourceActive = false;
            },
            releaseLock() {
              releaseCalls += 1;
              locked = false;
            },
          };
        },
      },
      headers: new Headers({ 'content-type': 'application/json' }),
      status: 200,
      statusText: 'OK',
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn((_url: string | URL, init?: RequestInit) => {
      requestSignals.push(init?.signal ?? undefined);
      return request.promise;
    }));
    const clients: SocketModeClient[] = [];
    const sdkStart = SocketModeClient.prototype.start;
    vi.spyOn(SocketModeClient.prototype, 'start').mockImplementation(function startSdk(
      this: SocketModeClient,
    ) {
      clients.push(this);
      return sdkStart.call(this);
    });

    try {
      const transport = new SlackSocketTransport({
        connectionFactory: slackSdkConnectionFactory('xapp-test'),
        timeouts: { startMs: 25, closeMs: 10 },
      });
      const starting = transport.start();
      const rejected = expect(starting).rejects.toMatchObject({ code: 'connect_timeout' });
      await flushMicrotasks();
      expect(requestSignals).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      await expect(transport.shutdown()).resolves.toBeUndefined();

      request.resolve(lateResponse);
      await flushMicrotasks();
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect({
        getReaderCalls,
        readCalls,
        cancelCalls,
        releaseCalls,
        resourceActive,
        locked,
        upgrades: server.upgrades(),
      }).toEqual({
        getReaderCalls: 1,
        readCalls: 0,
        cancelCalls: 1,
        releaseCalls: 1,
        resourceActive: false,
        locked: false,
        upgrades: 0,
      });
      expect(clients[0]?.websocket).toBeUndefined();
      expect(clients[0]?.listenerCount('disconnected')).toBe(0);
      expect(requestSignals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it('shutdown 뒤 delayed response body가 풀려도 URL을 소비하거나 WebSocket을 만들지 않는다', async () => {
    const server = await startHelloServer();
    vi.useFakeTimers();
    const bodyRelease = deferred<void>();
    const requestSignals: Array<AbortSignal | undefined> = [];
    let bodyCancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await bodyRelease.promise;
        if (bodyCancelCalls > 0) return;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, url: server.url })));
        controller.close();
      },
      cancel() { bodyCancelCalls += 1; },
    });
    vi.stubGlobal('fetch', vi.fn((_url: string | URL, init?: RequestInit) => {
      requestSignals.push(init?.signal ?? undefined);
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }));
    const clients: SocketModeClient[] = [];
    const sdkStart = SocketModeClient.prototype.start;
    vi.spyOn(SocketModeClient.prototype, 'start').mockImplementation(function startSdk(
      this: SocketModeClient,
    ) {
      clients.push(this);
      return sdkStart.call(this);
    });

    try {
      const transport = new SlackSocketTransport({
        connectionFactory: slackSdkConnectionFactory('xapp-test'),
        timeouts: { startMs: 25, closeMs: 10 },
      });
      const starting = transport.start();
      const rejected = expect(starting).rejects.toMatchObject({ code: 'connect_timeout' });
      await flushMicrotasks();
      expect(requestSignals).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      await expect(transport.shutdown()).resolves.toBeUndefined();
      expect(requestSignals[0]?.aborted).toBe(true);

      bodyRelease.resolve();
      await flushMicrotasks();
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(server.upgrades()).toBe(0);
      expect(bodyCancelCalls).toBe(1);
      expect(clients[0]?.websocket).toBeUndefined();
      expect(clients[0]?.listenerCount('disconnected')).toBe(0);
    } finally {
      vi.useRealTimers();
      bodyRelease.resolve();
      await server.close();
    }
  });

  it('fence 뒤 underlying fetch의 late rejection도 unhandled로 새지 않는다', async () => {
    vi.useFakeTimers();
    const request = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => request.promise));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      const transport = new SlackSocketTransport({
        connectionFactory: slackSdkConnectionFactory('xapp-test'),
        timeouts: { startMs: 25, closeMs: 10 },
      });
      const starting = transport.start();
      const rejected = expect(starting).rejects.toMatchObject({ code: 'connect_timeout' });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      await transport.shutdown();

      request.reject(new Error('wss://late-secret.invalid payload=RAW'));
      await flushMicrotasks();
      vi.useRealTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stalled SDK disconnect를 bounded하게 재호출하고 listener/timer ownership을 놓는다', async () => {
    const server = await startHelloServer();
    vi.stubGlobal('fetch', vi.fn(async () => connectionsOpenResponse(server.url)));
    const clients: SocketModeClient[] = [];
    const sdkStart = SocketModeClient.prototype.start;
    vi.spyOn(SocketModeClient.prototype, 'start').mockImplementation(function startSdk(
      this: SocketModeClient,
    ) {
      clients.push(this);
      return sdkStart.call(this);
    });
    const disconnect = vi.spyOn(SocketModeClient.prototype, 'disconnect');
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    try {
      const transport = new SlackSocketTransport({
        connectionFactory: slackSdkConnectionFactory('xapp-test'),
        timeouts: { startMs: 100, closeMs: 20 },
      });
      await transport.start();
      const client = clients[0];
      expect(client).toBeDefined();
      expect(client?.listenerCount('disconnected')).toBe(1);

      const stopping = transport.shutdown();
      const repeatedWhileClosing = transport.shutdown();
      expect(repeatedWhileClosing).toBe(stopping);
      await flushMicrotasks();
      expect(disconnect).toHaveBeenCalledTimes(1);

      const rejected = expect(stopping).rejects.toMatchObject({ code: 'close_timeout' });
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(disconnect).toHaveBeenCalledTimes(2);
      expect(client?.listenerCount('disconnected')).toBe(0);
      expect(client?.websocket?.readyState).toBeUndefined();
      const ownedTimeouts = setTimeoutSpy.mock.calls.flatMap((call, index) =>
        call[1] === 100 || call[1] === 20 ? [setTimeoutSpy.mock.results[index]?.value] : []);
      const ownedIntervals = setIntervalSpy.mock.results.map((result) => result.value);
      expect(ownedTimeouts.length).toBeGreaterThanOrEqual(2);
      expect(ownedIntervals.length).toBeGreaterThanOrEqual(1);
      for (const timer of ownedTimeouts) expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
      for (const timer of ownedIntervals) expect(clearIntervalSpy).toHaveBeenCalledWith(timer);

      await expect(transport.shutdown()).rejects.toMatchObject({ code: 'close_timeout' });
      expect(disconnect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });
});
