import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { SocketModeClient } from '@slack/socket-mode';
import { Response as UndiciResponse } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs, runDaemonCommand as runDaemonCommandWithNativeStatus } from '../src/cli.js';
import {
  gateDirectActionId,
  gateDirectActionValue,
  gateDirectBlockId,
  gateDirectInputActionId,
  gateDirectInputBlockId,
} from '../src/gate/actions.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { DEFAULT_CORRELATION_KEYS, type BridgeConfig } from '../src/project/config.js';
import type {
  PostMessageInput,
  PostedMessage,
  SlackPoster,
  UpdateMessageInput,
} from '../src/slack/post.js';
import {
  SlackSocketTransport,
  slackSdkConnectionFactory,
} from '../src/slack/socket.js';
import { SlackWebApiViewOpener } from '../src/slack/views.js';
import { APP_TOKEN_VAR } from '../src/slack/verify.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const TEST_STATUS_OWNER_SERVER = {
  start: () => Promise.resolve(),
  refresh: () => undefined,
  stop: () => Promise.resolve(),
};
const TEST_TELEMETRY = {
  log: async () => ({ ok: true as const }),
  close: async () => undefined,
};

async function runDaemonCommand(
  ...args: Parameters<typeof runDaemonCommandWithNativeStatus>
): Promise<number> {
  const [parsed, config, dependencies] = args;
  return await runDaemonCommandWithNativeStatus(parsed, config, {
    ...(dependencies ?? {}),
    statusOwnerServer: dependencies?.statusOwnerServer ?? TEST_STATUS_OWNER_SERVER,
    telemetry: dependencies?.telemetry ?? TEST_TELEMETRY,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function failureCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'rejected';
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : 'rejected';
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

type HelloServer = {
  readonly url: string;
  readonly upgrades: () => number;
  readonly send: (index: number, payload: object) => void;
  readonly sendBatch: (index: number, payloads: readonly object[]) => void;
  readonly disconnect: (index: number) => void;
  readonly received: (index: number) => readonly unknown[];
  readonly close: () => Promise<void>;
};

function textFrame(payload: object): Buffer {
  const encoded = Buffer.from(JSON.stringify(payload));
  if (encoded.length <= 125) {
    return Buffer.concat([Buffer.from([0x81, encoded.length]), encoded]);
  }
  if (encoded.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(encoded.length, 2);
    return Buffer.concat([header, encoded]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(encoded.length), 2);
  return Buffer.concat([header, encoded]);
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
  const receivedFrames: unknown[][] = [];
  const pendingBytes: Buffer[] = [];
  const serverClosing = new WeakSet<Duplex>();
  let upgradeCount = 0;
  server.on('upgrade', (request, socket) => {
    upgradeCount += 1;
    sockets.push(socket);
    receivedFrames.push([]);
    pendingBytes.push(Buffer.alloc(0));
    const socketIndex = sockets.length - 1;
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
    socket.on('data', (chunk: Buffer) => {
      let pending = Buffer.concat([pendingBytes[socketIndex] ?? Buffer.alloc(0), chunk]);
      for (;;) {
        if (pending.length < 2) break;
        const opcode = pending[0]! & 0x0f;
        const masked = (pending[1]! & 0x80) !== 0;
        let length = pending[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) break;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) break;
          const wide = pending.readBigUInt64BE(2);
          if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('test frame is too large');
          length = Number(wide);
          offset = 10;
        }
        const maskBytes = masked ? 4 : 0;
        if (pending.length < offset + maskBytes + length) break;
        const mask = masked ? pending.subarray(offset, offset + 4) : null;
        const encoded = pending.subarray(offset + maskBytes, offset + maskBytes + length);
        const decoded = Buffer.from(encoded);
        if (mask !== null) {
          for (let index = 0; index < decoded.length; index += 1) {
            decoded[index] = decoded[index]! ^ mask[index % 4]!;
          }
        }
        pending = pending.subarray(offset + maskBytes + length);
        if (opcode === 0x01) {
          try {
            receivedFrames[socketIndex]?.push(JSON.parse(decoded.toString('utf8')));
          } catch {
            receivedFrames[socketIndex]?.push(decoded.toString('utf8'));
          }
        } else if (opcode === 0x08 && options.replyToClose === true) {
          if (!serverClosing.has(socket) && !socket.destroyed) socket.write(CLOSE_FRAME);
          socket.end();
        }
      }
      pendingBytes[socketIndex] = pending;
    });
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
    sendBatch: (index, payloads) => {
      const socket = sockets[index];
      if (socket === undefined || socket.destroyed) throw new Error('test WebSocket is not open');
      socket.write(Buffer.concat(payloads.map((payload) => textFrame(payload))));
    },
    disconnect: (index) => {
      const socket = sockets[index];
      if (socket === undefined || socket.destroyed) throw new Error('test WebSocket is not open');
      serverClosing.add(socket);
      socket.write(CLOSE_FRAME);
    },
    received: (index) => [...(receivedFrames[index] ?? [])],
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

function crossRealmConnectionsOpenResponse(url: string): Response {
  const response = connectionsOpenResponse(url);
  return runInNewContext('({ body, headers, status, statusText })', {
    body: response.body,
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  }) as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('@slack/socket-mode 3.0.0 lifecycle fence', () => {
  it('SDK interactive envelope를 production event hook으로 전달하고 ACK callback을 보존한다', async () => {
    const server = await startHelloServer({ replyToClose: true });
    vi.stubGlobal('fetch', vi.fn(async () => connectionsOpenResponse(server.url)));
    const observed: { readonly type: string; readonly body: unknown }[] = [];
    const transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
      event: async (event) => {
        observed.push({ type: event.type, body: event.body });
        await event.ack();
      },
    });
    try {
      await transport.start();
      server.send(0, {
        envelope_id: 'e1',
        type: 'interactive',
        payload: { type: 'block_actions' },
      });
      await vi.waitFor(() => expect(observed).toEqual([
        { type: 'interactive', body: { type: 'block_actions' } },
      ]));
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('view_submission errors ACK를 installed SDK의 exact envelope payload로 한 번 전송한다', async () => {
    const server = await startHelloServer({ replyToClose: true });
    vi.stubGlobal('fetch', vi.fn(async () => connectionsOpenResponse(server.url)));
    let deliveries = 0;
    const transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 500, closeMs: 100 },
      event: async (event) => {
        deliveries += 1;
        await event.ack({
          response_action: 'errors',
          errors: { orca_gate_direct_input_v1_deadbeef: '결정 내용을 입력하세요.' },
        });
      },
    });
    try {
      await transport.start();
      server.send(0, {
        envelope_id: 'e-errors',
        type: 'interactive',
        accepts_response_payload: true,
        payload: { type: 'view_submission' },
      });
      await vi.waitFor(() => expect(server.received(0)).toEqual([{
        envelope_id: 'e-errors',
        payload: {
          response_action: 'errors',
          errors: { orca_gate_direct_input_v1_deadbeef: '결정 내용을 입력하세요.' },
        },
      }]));
      expect(deliveries).toBe(1);
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('composes runDaemon with real Socket SDK ACKs and real WebClient views.open wire shape', async () => {
    const server = await startHelloServer({ replyToClose: true });
    const dir = mkdtempSync(join(tmpdir(), 'orca-sdk-direct-daemon-'));
    const statePath = join(dir, 'state.db');
    const previousAppToken = process.env[APP_TOKEN_VAR];
    process.env[APP_TOKEN_VAR] = ['xapp', 'FAKE', 'LOCAL', 'ONLY'].join('-');
    vi.stubGlobal('fetch', vi.fn(async () => connectionsOpenResponse(server.url)));

    const gate = gateKey('gate_sdk_direct');
    const run = runKey('run_sdk_direct');
    const task = taskKey('task_sdk_direct');
    const channel = 'C0AGENTRUNS';
    const threadTs = '1787554800.000001';
    const messageTs = '1787554800.000002';
    const at = '2026-08-25T10:00:00.000Z';
    const config: BridgeConfig = {
      slack: {
        teamId: 'T0TEAM',
        apiAppId: 'A01BRIDGE',
        ownerUserIds: ['U0OWNER'],
        channels: { prDigest: 'C0PRDIGEST', agentRuns: channel , decisions: channel },
      },
      projects: [],
      correlationKeys: DEFAULT_CORRELATION_KEYS,
    };
    const seed = new SqliteDigestStore(statePath);
    seed.insertGateMetadata({
      gateKey: gate,
      runKey: run,
      taskKey: task,
      dispatchKey: dispatchKey('ctx_sdk_direct'),
      source: 'registered',
      askMessageId: 'msg_sdk_direct',
      questionThreadId: 'thread_sdk_direct',
      options: [{
        id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지',
      }],
      recommendation: { optionId: 'keep', reason: '호환성' },
      impact: '후속 방향',
      registeredAt: at,
    });
    seed.insertGateMessage({
      gateKey: gate, runKey: run, channelId: channel, threadTs, messageTs,
      renderFingerprint: 'fp-sdk-direct', at,
    });
    seed.saveGateLocalObservation({
      gateKey: gate, runKey: run, taskKey: task, status: 'pending', resolution: null,
      resolvedAt: null, metadataState: 'matched', mappingState: 'matched', observedAt: at,
    });
    seed.close();

    const viewCalls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const viewFetch: typeof fetch = async (url, init) => {
      const request = { url: String(url), init: init ?? {} };
      viewCalls.push(request);
      const form = new URLSearchParams(String(request.init.body));
      const view = JSON.parse(form.get('view') ?? 'null') as Record<string, unknown>;
      return new Response(JSON.stringify({
        ok: true,
        view: {
          ...view,
          id: 'VSDKDIRECT',
          team_id: 'T0TEAM',
          app_id: 'A01BRIDGE',
          type: 'modal',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const opener = new SlackWebApiViewOpener({
      token: ['xoxb', 'FAKE', 'LOCAL', 'ONLY'].join('-'),
      fetchImpl: viewFetch,
    });
    const slack: SlackPoster = {
      post: (_input: PostMessageInput): Promise<PostedMessage> =>
        Promise.reject(new Error('not used')),
      update: (input: UpdateMessageInput): Promise<PostedMessage> =>
        Promise.resolve({ channel: input.channel, ts: input.ts }),
    };
    const orcaCalls: string[][] = [];
    const orca: OrcaRunner = {
      run: (args) => {
        orcaCalls.push([...args]);
        return Promise.reject(new Error('Orca must not run for a local validation error'));
      },
    };

    try {
      const parsed = parseArgs(['daemon', '--state', statePath]);
      if (parsed.kind !== 'run') throw new Error('daemon args failed');
      const code = await runDaemonCommand(parsed, config, {
        orca,
        slack,
        viewOpener: opener,
        connectionFactory: slackSdkConnectionFactory('xapp-test'),
        socketTimeouts: { startMs: 500, closeMs: 100 },
        waitForStop: async () => {
          server.send(0, {
            envelope_id: 'e-direct-button',
            type: 'interactive',
            accepts_response_payload: true,
            payload: {
              type: 'block_actions',
              api_app_id: 'A01BRIDGE',
              trigger_id: 'TRIGGER_LOCAL_ONLY',
              team: { id: 'T0TEAM' },
              user: { id: 'U0OWNER', team_id: 'T0TEAM' },
              channel: { id: channel },
              container: {
                type: 'message', channel_id: channel, message_ts: messageTs,
                thread_ts: threadTs, is_ephemeral: false,
              },
              message: { ts: messageTs, thread_ts: threadTs },
              actions: [{
                type: 'button',
                block_id: gateDirectBlockId(gate),
                action_id: gateDirectActionId(gate),
                value: gateDirectActionValue(gate),
                action_ts: '1787554900.000001',
                text: { type: 'plain_text', text: '직접 입력' },
              }],
            },
          });
          await vi.waitFor(() => expect(server.received(0)).toContainEqual({
            envelope_id: 'e-direct-button',
            payload: {},
          }));
          await vi.waitFor(() => expect(viewCalls).toHaveLength(1));

          const call = viewCalls[0]!;
          expect(call.url).toBe('https://slack.com/api/views.open');
          expect(new Headers(call.init.headers).get('authorization')).toBe(
            `Bearer ${['xoxb', 'FAKE', 'LOCAL', 'ONLY'].join('-')}`,
          );
          const form = new URLSearchParams(String(call.init.body));
          expect([...form.keys()].sort()).toEqual(['trigger_id', 'view']);
          expect(form.get('trigger_id')).toBe('TRIGGER_LOCAL_ONLY');
          const view = JSON.parse(form.get('view') ?? 'null') as Record<string, unknown>;
          expect(view).toMatchObject({
            type: 'modal',
            callback_id: expect.any(String),
            private_metadata: expect.any(String),
          });

          server.send(0, {
            envelope_id: 'e-direct-errors',
            type: 'interactive',
            accepts_response_payload: true,
            payload: {
              type: 'view_submission',
              api_app_id: 'A01BRIDGE',
              team: { id: 'T0TEAM' },
              user: { id: 'U0OWNER', team_id: 'T0TEAM' },
              view: {
                id: 'VSDKDIRECT',
                type: 'modal',
                team_id: 'T0TEAM',
                app_id: 'A01BRIDGE',
                callback_id: view['callback_id'],
                private_metadata: view['private_metadata'],
                state: { values: {
                  [gateDirectInputBlockId(gate)]: {
                    [gateDirectInputActionId(gate)]: {
                      type: 'plain_text_input', value: '  \n\t',
                    },
                  },
                } },
              },
            },
          });
          await vi.waitFor(() => expect(server.received(0)).toContainEqual({
            envelope_id: 'e-direct-errors',
            payload: {
              response_action: 'errors',
              errors: {
                [gateDirectInputBlockId(gate)]: '1~3000자의 유효한 결정 내용을 입력하세요.',
              },
            },
          }));
        },
      });
      expect(code).toBe(0);
      expect(orcaCalls).toEqual([]);
      const reopened = new SqliteDigestStore(statePath);
      expect(reopened.findGateResolution(gate)).toBeNull();
      reopened.close();
    } finally {
      if (previousAppToken === undefined) delete process.env[APP_TOKEN_VAR];
      else process.env[APP_TOKEN_VAR] = previousAppToken;
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('candidate hello+refresh_requested coalesced batch를 promotion 뒤 successor로 이어간다', async () => {
    const server = await startHelloServer({ autoHello: false, replyToClose: true });
    const fetchMock = vi.fn(async () => connectionsOpenResponse(server.url));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new SlackSocketTransport({
      expectedApiAppId: 'A01BRIDGE',
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      backoff: { initialMs: 10, maxMs: 40 },
      timeouts: { startMs: 500, closeMs: 100 },
    });

    try {
      const starting = transport.start();
      await vi.waitFor(() => expect(server.upgrades()).toBe(1));
      server.send(0, { type: 'hello', connection_info: { app_id: 'A01BRIDGE' } });
      await starting;

      server.send(0, { type: 'disconnect', reason: 'refresh_requested' });
      await vi.waitFor(() => expect(server.upgrades()).toBe(2));
      server.sendBatch(1, [
        { type: 'hello', connection_info: { app_id: 'A01BRIDGE' } },
        { type: 'disconnect', reason: 'refresh_requested' },
      ]);

      await vi.waitFor(() => expect(server.upgrades()).toBe(3));
      server.send(2, { type: 'hello', connection_info: { app_id: 'A01BRIDGE' } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect({ fetches: fetchMock.mock.calls.length, upgrades: server.upgrades() }).toEqual({
        fetches: 3,
        upgrades: 3,
      });
      await expect(transport.shutdown()).resolves.toBeUndefined();
    } finally {
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
    ['cross-realm', (url: string) => crossRealmConnectionsOpenResponse(url)],
  ] as const)('%s Response를 같은 fetch 계약으로 수용한다', async (_implementation, response) => {
    const server = await startHelloServer({ replyToClose: true });
    const rawResponse = response(server.url);
    const liveAbortListeners = new Set<Parameters<AbortSignal['addEventListener']>[1]>();
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
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
      return rawResponse;
    });
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
      expect(rawResponse.body?.locked).toBe(false);
      expect(liveAbortListeners.size).toBe(0);
      await expect(transport.shutdown()).resolves.toBeUndefined();
      expect(liveAbortListeners.size).toBe(0);
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

  it('끝나지 않는 raw reader cancel과 무관하게 lock을 놓고 late rejection을 소비한다', async () => {
    const cancelGate = deferred<void>();
    let cancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelCalls += 1;
        return cancelGate.promise;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 20, closeMs: 10 },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(transport.start()).rejects.toMatchObject({ code: 'connect_timeout' });
      await expect(transport.shutdown()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect({ cancelCalls, locked: body.locked }).toEqual({ cancelCalls: 1, locked: false });

      cancelGate.reject(new Error('late raw cancellation failure'));
      await flushMicrotasks();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect({ cancelCalls, locked: body.locked }).toEqual({ cancelCalls: 1, locked: false });
    } finally {
      process.off('unhandledRejection', onUnhandled);
      cancelGate.resolve();
      await transport.shutdown().catch(() => undefined);
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

  it.each([1, 2, 3])(
    'native Response raw EOF 뒤 9-microtask owner abort가 SDK continuation을 막는다 (%i/3)',
    async () => {
      const server = await startHelloServer();
      const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, url: server.url }));
      let transport!: SlackSocketTransport;
      let shutdownPromise: Promise<void> | undefined;
      let upgradesAtAbort = -1;
      let listenersBeforeAbort = -1;
      let listenersAtAbort = -1;
      let pullCalls = 0;
      const liveAbortListeners = new Set<Parameters<AbortSignal['addEventListener']>[1]>();
      const schedule = (remaining: number): void => {
        if (remaining === 0) {
          upgradesAtAbort = server.upgrades();
          listenersBeforeAbort = liveAbortListeners.size;
          shutdownPromise = transport.shutdown();
          listenersAtAbort = liveAbortListeners.size;
        } else {
          queueMicrotask(() => schedule(remaining - 1));
        }
      };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCalls += 1;
          if (pullCalls === 1) controller.enqueue(bytes);
          else {
            controller.close();
            // reviewer probe의 exact EOF ordering mutation을 보존한다.
            schedule(9);
          }
        },
      });
      const response = new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
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
        return response;
      }));
      transport = new SlackSocketTransport({
        expectedApiAppId: 'A01BRIDGE',
        connectionFactory: slackSdkConnectionFactory('xapp-test'),
        timeouts: { startMs: 1_000, closeMs: 100 },
      });

      try {
        let startCode = 'fulfilled';
        try {
          await transport.start();
        } catch (error) {
          startCode = failureCode(error);
        }
        for (let index = 0; index < 200 && shutdownPromise === undefined; index += 1) {
          await Promise.resolve();
        }
        if (shutdownPromise === undefined) throw new Error('shutdown was not scheduled');

        let shutdownOutcome = 'resolved';
        try {
          await shutdownPromise;
        } catch {
          shutdownOutcome = 'rejected';
        }
        const atAbort = {
          upgrades: server.upgrades(),
          listeners: liveAbortListeners.size,
          locked: body.locked,
        };
        await new Promise<void>((resolve) => setTimeout(resolve, 40));

        expect({
          startCode,
          shutdownOutcome,
          upgradesAtAbort,
          listenersBeforeAbort,
          listenersAtAbort,
          atAbort,
          afterWait: {
            upgrades: server.upgrades(),
            listeners: liveAbortListeners.size,
            locked: body.locked,
          },
          pullCalls,
        }).toEqual({
          startCode: 'connect_failed',
          shutdownOutcome: 'resolved',
          upgradesAtAbort: 0,
          listenersBeforeAbort: 1,
          listenersAtAbort: 0,
          atAbort: { upgrades: 0, listeners: 0, locked: false },
          afterWait: { upgrades: 0, listeners: 0, locked: false },
          pullCalls: 2,
        });
      } finally {
        await transport.shutdown().catch(() => undefined);
        await server.close();
      }
    },
  );

  it('raw EOF handoff abort는 turn timer와 reader를 exactly once 정리한다', async () => {
    const server = await startHelloServer();
    const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, url: server.url }));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    let transport!: SlackSocketTransport;
    let shutdownPromise: Promise<void> | undefined;
    let handoffTimer: unknown;
    let getReaderCalls = 0;
    let readCalls = 0;
    let cancelCalls = 0;
    let releaseCalls = 0;
    let locked = false;
    const liveAbortListeners = new Set<Parameters<AbortSignal['addEventListener']>[1]>();
    const schedule = (remaining: number): void => {
      if (remaining === 0) {
        const timerIndex = setTimeoutSpy.mock.calls.findLastIndex((call) => call[1] === 0);
        handoffTimer = timerIndex < 0 ? undefined : setTimeoutSpy.mock.results[timerIndex]?.value;
        shutdownPromise = transport.shutdown();
      } else {
        queueMicrotask(() => schedule(remaining - 1));
      }
    };
    const rawResponse = {
      body: {
        getReader() {
          getReaderCalls += 1;
          locked = true;
          return {
            read() {
              readCalls += 1;
              if (readCalls === 1) return { done: false, value: bytes };
              schedule(9);
              return { done: true, value: undefined };
            },
            cancel() { cancelCalls += 1; },
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
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
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
      return rawResponse;
    }));
    transport = new SlackSocketTransport({
      connectionFactory: slackSdkConnectionFactory('xapp-test'),
      timeouts: { startMs: 1_000, closeMs: 100 },
    });

    try {
      await expect(transport.start()).rejects.toMatchObject({ code: 'connect_failed' });
      if (shutdownPromise === undefined) throw new Error('shutdown was not scheduled');
      await expect(shutdownPromise).resolves.toBeUndefined();
      await flushMicrotasks();
      expect({
        getReaderCalls,
        readCalls,
        cancelCalls,
        releaseCalls,
        locked,
        abortListeners: liveAbortListeners.size,
        upgrades: server.upgrades(),
      }).toEqual({
        getReaderCalls: 1,
        readCalls: 2,
        cancelCalls: 1,
        releaseCalls: 1,
        locked: false,
        abortListeners: 0,
        upgrades: 0,
      });
      expect(handoffTimer).toBeDefined();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(handoffTimer);
    } finally {
      await transport.shutdown().catch(() => undefined);
      await server.close();
    }
  });

  it('consumer cancel은 끝나지 않는 raw cancel을 기다리지 않고 owner abort와 중복되지 않는다', async () => {
    const server = await startHelloServer({ replyToClose: true });
    const cancelGate = deferred<void>();
    let cancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
        return cancelGate.promise;
      },
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
      cancelGate.resolve();
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
      const starting = transport.start();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(0);
      await starting;
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
