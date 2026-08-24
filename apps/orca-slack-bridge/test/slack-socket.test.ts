import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, type SlackConfig } from '../src/project/config.js';
import {
  SlackSocketTransport,
  SocketTransportError,
  parseSocketLifecycle,
  reconnectDelay,
  verifySocketPreflight,
  type SocketConnection,
  type SocketConnectionFactory,
  type SocketConnectionHooks,
  type SocketHello,
  type SocketRefreshReason,
} from '../src/slack/socket.js';
import { APP_TOKEN_VAR } from '../src/slack/verify.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

class FakeConnection implements SocketConnection {
  hooks: SocketConnectionHooks | null = null;
  startCalls = 0;
  closeCalls = 0;
  constructor(
    private readonly result: () => Promise<SocketHello>,
    private readonly closeResult: () => Promise<void> = () => Promise.resolve(),
  ) {}
  start(): Promise<SocketHello> { this.startCalls += 1; return this.result(); }
  close(): Promise<void> { this.closeCalls += 1; return this.closeResult(); }
  refresh(reason: SocketRefreshReason): void { this.hooks?.refresh(reason); }
  disconnected(): void { this.hooks?.disconnected(); }
}

function factory(connections: readonly FakeConnection[], seen: SocketConnectionHooks[] = []): SocketConnectionFactory {
  let index = 0;
  return (hooks) => {
    seen.push(hooks);
    const connection = connections[index++];
    if (connection === undefined) throw new Error('raw factory failure');
    connection.hooks = hooks;
    return connection;
  };
}

const hello = (appId = 'A01BRIDGE') => Promise.resolve({ appId });

describe('Socket hello와 명시적 preflight', () => {
  it('apiAppId는 optional이고 설정되면 App ID 형식이어야 한다', () => {
    const base = { projects: [{ name: 'p', repositories: ['o/r'] }] };
    const slack = { teamId: 'T01', ownerUserIds: ['U01'], channels: { prDigest: 'C01', agentRuns: 'C02' } };
    expect(parseConfig({ ...base, slack }).slack?.apiAppId).toBeUndefined();
    expect(parseConfig({ ...base, slack: { ...slack, apiAppId: 'A01' } }).slack?.apiAppId).toBe('A01');
    expect(() => parseConfig({ ...base, slack: { ...slack, apiAppId: 'T01' } })).toThrow(/A로 시작/);
  });

  it('raw frame에서 App ID/reason만 고르고 payload는 버린다', () => {
    expect(parseSocketLifecycle(JSON.stringify({
      type: 'hello', connection_info: { app_id: 'A01BRIDGE' }, payload: 'DROP',
    }), false)).toEqual({ type: 'hello', appId: 'A01BRIDGE' });
    expect(parseSocketLifecycle(JSON.stringify({
      type: 'disconnect', reason: 'refresh_requested', payload: 'DROP',
    }), false)).toEqual({ type: 'refresh', reason: 'refresh_requested' });
    expect(JSON.stringify(parseSocketLifecycle('{"type":"events_api","payload":"DROP"}', false)))
      .not.toContain('DROP');
  });

  it('생성만으로 연결하지 않고 start에서만 연결한다', async () => {
    const connection = new FakeConnection(() => hello());
    const create = vi.fn(factory([connection]));
    const transport = new SlackSocketTransport({ connectionFactory: create });
    expect(create).not.toHaveBeenCalled();
    await transport.start();
    expect(connection.startCalls).toBe(1);
    await transport.shutdown();
  });

  it('optional apiAppId는 호환되고, exact mismatch/missing hello는 닫고 실패한다', async () => {
    const compatible = new SlackSocketTransport({
      connectionFactory: factory([new FakeConnection(() => hello('A01OBSERVED'))]),
    });
    await expect(compatible.start()).resolves.toBeUndefined();
    await compatible.shutdown();

    for (const [appId, code] of [['A01OTHER', 'hello_app_id_mismatch'], [null, 'hello_app_id_missing']] as const) {
      const connection = new FakeConnection(() => Promise.resolve({ appId }));
      const transport = new SlackSocketTransport({
        expectedApiAppId: 'A01EXPECTED', connectionFactory: factory([connection]),
      });
      await expect(transport.start()).rejects.toMatchObject({ code });
      expect(connection.closeCalls).toBe(1);
    }
  });

  it('끝나지 않는 start/hello를 deadline 뒤 닫고 candidate를 남기지 않는다', async () => {
    vi.useFakeTimers();
    const neverHello = deferred<SocketHello>();
    const hanging = new FakeConnection(() => neverHello.promise);
    const healthy = new FakeConnection(() => hello());
    const create = vi.fn(factory([hanging, healthy]));
    const transport = new SlackSocketTransport({
      connectionFactory: create,
      timeouts: { startMs: 25, closeMs: 10 },
    });

    let settled = false;
    let failure: unknown;
    const firstStart = transport.start().then(
      () => { settled = true; },
      (error: unknown) => { settled = true; failure = error; },
    );
    await vi.advanceTimersByTimeAsync(25);

    expect(settled).toBe(true);
    await firstStart;
    expect(failure).toMatchObject({ code: 'connect_timeout' });
    expect(hanging.closeCalls).toBe(1);

    await transport.start();
    neverHello.resolve({ appId: 'A01LATE' });
    await flushMicrotasks();
    expect(create).toHaveBeenCalledTimes(2);
    expect(healthy.closeCalls).toBe(0);

    await transport.shutdown();
    expect(healthy.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('verifySocketPreflight도 끝나지 않는 hello에서 bounded failure를 반환한다', async () => {
    vi.useFakeTimers();
    const config: SlackConfig = {
      teamId: 'T01TEAM', ownerUserIds: ['U01OWNER'],
      channels: { prDigest: 'C01PR', agentRuns: 'C01RUN' },
    };
    const connection = new FakeConnection(() => deferred<SocketHello>().promise);
    let result: Awaited<ReturnType<typeof verifySocketPreflight>> | undefined;
    const check = verifySocketPreflight(
      config,
      { [APP_TOKEN_VAR]: ['xapp', 'FAKE', 'PRIVATE'].join('-') } as NodeJS.ProcessEnv,
      factory([connection]),
      { startMs: 25, closeMs: 10 },
    ).then((value) => { result = value; });

    await vi.advanceTimersByTimeAsync(25);
    expect(result).toMatchObject({ name: 'socket.hello', ok: false });
    await check;
    expect(result?.detail).toBe('Socket Mode hello 제한 시간을 넘었다');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(connection.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('verifySocketPreflight는 끝나지 않는 close도 bounded failure로 바꾼다', async () => {
    vi.useFakeTimers();
    const config: SlackConfig = {
      teamId: 'T01TEAM', ownerUserIds: ['U01OWNER'],
      channels: { prDigest: 'C01PR', agentRuns: 'C01RUN' },
    };
    const connection = new FakeConnection(
      () => hello(),
      () => deferred<void>().promise,
    );
    let result: Awaited<ReturnType<typeof verifySocketPreflight>> | undefined;
    const check = verifySocketPreflight(
      config,
      { [APP_TOKEN_VAR]: ['xapp', 'FAKE', 'PRIVATE'].join('-') } as NodeJS.ProcessEnv,
      factory([connection]),
      { startMs: 25, closeMs: 20 },
    ).then((value) => { result = value; });
    await flushMicrotasks();
    expect(connection.closeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(20);
    await check;
    expect(result).toEqual({
      name: 'socket.hello',
      ok: false,
      detail: 'Socket Mode 연결 종료 제한 시간을 넘었다',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shutdown은 진행 중인 start deadline을 취소하고 candidate를 한 번만 닫는다', async () => {
    vi.useFakeTimers();
    const connection = new FakeConnection(() => deferred<SocketHello>().promise);
    const create = vi.fn(factory([connection]));
    const transport = new SlackSocketTransport({
      connectionFactory: create,
      timeouts: { startMs: 100, closeMs: 20 },
    });
    let failure: unknown;
    const starting = transport.start().catch((error: unknown) => { failure = error; });
    await flushMicrotasks();

    await transport.shutdown();
    await starting;
    expect(failure).toMatchObject({ code: 'connect_failed' });
    expect(connection.closeCalls).toBe(1);
    expect(create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Socket lifecycle', () => {
  it.each(['warning', 'refresh_requested'] as const)(
    '%s에서 replacement hello 전까지 old connection을 유지한다',
    async (reason) => {
      const nextHello = deferred<SocketHello>();
      const oldConnection = new FakeConnection(() => hello());
      const newConnection = new FakeConnection(() => nextHello.promise);
      const transport = new SlackSocketTransport({
        connectionFactory: factory([oldConnection, newConnection]),
      });
      await transport.start();
      oldConnection.refresh(reason);
      expect(newConnection.startCalls).toBe(1);
      expect(oldConnection.closeCalls).toBe(0);
      nextHello.resolve({ appId: 'A01BRIDGE' });
      await vi.waitFor(() => expect(oldConnection.closeCalls).toBe(1));
      await transport.shutdown();
      expect(newConnection.closeCalls).toBe(1);
    },
  );

  it('disconnect 뒤 capped exponential backoff로 재연결한다', async () => {
    const delays: number[] = [];
    const first = new FakeConnection(() => hello());
    const failures = [
      new FakeConnection(() => Promise.reject(new Error('wss://secret.invalid'))),
      new FakeConnection(() => Promise.reject(new Error('payload=RAWSECRET'))),
    ];
    const recovered = new FakeConnection(() => hello());
    const transport = new SlackSocketTransport({
      connectionFactory: factory([first, ...failures, recovered]),
      backoff: { initialMs: 10, maxMs: 40 },
      sleep: async (delay) => { delays.push(delay); },
    });
    await transport.start();
    first.disconnected();
    await vi.waitFor(() => expect(recovered.startCalls).toBe(1));
    expect(delays).toEqual([10, 20, 40]);
    await transport.shutdown();
  });

  it('refresh handoff의 old close 중 replacement disconnect를 유실하지 않는다', async () => {
    const oldClose = deferred<void>();
    const oldConnection = new FakeConnection(() => hello(), () => oldClose.promise);
    const replacement = new FakeConnection(() => hello());
    const recovered = new FakeConnection(() => hello());
    const delays: number[] = [];
    const create = vi.fn(factory([oldConnection, replacement, recovered]));
    const transport = new SlackSocketTransport({
      connectionFactory: create,
      backoff: { initialMs: 10, maxMs: 40 },
      sleep: async (delay) => { delays.push(delay); },
    });

    await transport.start();
    oldConnection.refresh('refresh_requested');
    await flushMicrotasks();
    expect(oldConnection.closeCalls).toBe(1);

    replacement.disconnected();
    oldClose.resolve();
    await flushMicrotasks();

    expect(delays).toEqual([10]);
    expect(recovered.startCalls).toBe(1);
    expect(create).toHaveBeenCalledTimes(3);
    oldConnection.disconnected();
    replacement.disconnected();
    await flushMicrotasks();
    expect(create).toHaveBeenCalledTimes(3);
    await transport.shutdown();
    expect(recovered.closeCalls).toBe(1);
  });

  it('refresh의 끝나지 않는 old close를 deadline에서 놓고 lifecycle을 계속한다', async () => {
    vi.useFakeTimers();
    const oldClose = deferred<void>();
    const oldConnection = new FakeConnection(() => hello(), () => oldClose.promise);
    const replacement = new FakeConnection(() => hello());
    const recovered = new FakeConnection(() => hello());
    const create = vi.fn(factory([oldConnection, replacement, recovered]));
    const transport = new SlackSocketTransport({
      connectionFactory: create,
      backoff: { initialMs: 10, maxMs: 40 },
      timeouts: { startMs: 25, closeMs: 20 },
    });

    await transport.start();
    oldConnection.refresh('warning');
    await flushMicrotasks();
    expect(oldConnection.closeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(20);

    replacement.disconnected();
    await vi.advanceTimersByTimeAsync(10);
    expect(recovered.startCalls).toBe(1);
    expect(create).toHaveBeenCalledTimes(3);

    await expect(transport.shutdown()).rejects.toMatchObject({ code: 'close_timeout' });
    oldClose.resolve();
    oldConnection.disconnected();
    replacement.disconnected();
    await flushMicrotasks();
    expect(create).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shutdown의 끝나지 않는 close는 bounded fixed error이고 반복 호출해도 한 번만 닫는다', async () => {
    vi.useFakeTimers();
    const neverClose = deferred<void>();
    const connection = new FakeConnection(() => hello(), () => neverClose.promise);
    const create = vi.fn(factory([connection]));
    const transport = new SlackSocketTransport({
      connectionFactory: create,
      timeouts: { startMs: 25, closeMs: 20 },
    });
    await transport.start();

    let settled = false;
    let failure: unknown;
    const firstStop = transport.shutdown().then(
      () => { settled = true; },
      (error: unknown) => { settled = true; failure = error; },
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(settled).toBe(true);
    await firstStop;
    expect(failure).toMatchObject({ code: 'close_timeout' });
    await expect(transport.shutdown()).rejects.toMatchObject({ code: 'close_timeout' });
    expect(connection.closeCalls).toBe(1);
    expect(create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    neverClose.resolve();
    connection.disconnected();
    await flushMicrotasks();
    expect(create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shutdown은 clean close하고 reconnect하지 않는다', async () => {
    const active = new FakeConnection(() => hello());
    const create = vi.fn(factory([active]));
    const transport = new SlackSocketTransport({ connectionFactory: create });
    await transport.start();
    await transport.shutdown();
    await transport.shutdown();
    active.disconnected();
    expect(active.closeCalls).toBe(1);
    expect(create).toHaveBeenCalledOnce();
  });

  it('fake client에는 lifecycle hook만 등록하고 action/message listener는 없다', async () => {
    const seen: SocketConnectionHooks[] = [];
    const transport = new SlackSocketTransport({
      connectionFactory: factory([new FakeConnection(() => hello())], seen),
    });
    await transport.start();
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(['disconnected', 'refresh']);
    expect(Object.keys(seen[0] ?? {})).not.toEqual(
      expect.arrayContaining(['block_actions', 'view_submission', 'events_api', 'message']),
    );
    await transport.shutdown();
  });
});

describe('backoff와 redaction', () => {
  it('delay는 maxMs를 넘지 않는다', () => {
    expect([1, 2, 3, 99].map((n) => reconnectDelay(n, { initialMs: 100, maxMs: 400 })))
      .toEqual([100, 200, 400, 400]);
  });

  it('preflight error에 token, URL, App ID, envelope, payload가 없다', async () => {
    const config: SlackConfig = {
      teamId: 'T01TEAM', apiAppId: 'A01EXPECTED', ownerUserIds: ['U01OWNER'],
      channels: { prDigest: 'C01PR', agentRuns: 'C01RUN' },
    };
    const raw = 'wss://secret.invalid envelope_id=ESECRET payload=RAWSECRET';
    const connection = new FakeConnection(() => Promise.reject(new Error(raw)));
    const result = await verifySocketPreflight(
      config,
      { [APP_TOKEN_VAR]: ['xapp', 'FAKE', 'PRIVATE'].join('-') } as NodeJS.ProcessEnv,
      factory([connection]),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|secret\.invalid|A01EXPECTED|ESECRET|RAWSECRET/);
    expect(new SocketTransportError('connect_failed').message).toBe('Socket Mode 연결에 실패했다');
  });
});
