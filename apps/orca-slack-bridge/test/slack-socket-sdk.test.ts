import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { SocketModeClient } from '@slack/socket-mode';
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
  readonly close: () => Promise<void>;
};

/** 실제 SDK/undici WebSocket을 열되 close frame에는 답하지 않는 local protocol seam이다. */
async function startHelloServer(): Promise<HelloServer> {
  const server = createServer();
  const sockets = new Set<Duplex>();
  let upgradeCount = 0;
  server.on('upgrade', (request, socket) => {
    upgradeCount += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
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
    const payload = Buffer.from(JSON.stringify({
      type: 'hello',
      connection_info: { app_id: 'A01BRIDGE' },
    }));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('local server address missing');
  return {
    url: `ws://127.0.0.1:${address.port}/socket`,
    upgrades: () => upgradeCount,
    close: async () => {
      for (const socket of sockets) socket.destroy();
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
  it('close 완료 뒤 late connections.open fulfillment이 WebSocket을 만들지 않는다', async () => {
    const server = await startHelloServer();
    vi.useFakeTimers();
    const request = deferred<Response>();
    const requestSignals: Array<AbortSignal | undefined> = [];
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

      request.resolve(connectionsOpenResponse(server.url));
      await flushMicrotasks();
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(server.upgrades()).toBe(0);
      expect(clients[0]?.websocket).toBeUndefined();
      expect(clients[0]?.listenerCount('disconnected')).toBe(0);
      expect(requestSignals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
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
