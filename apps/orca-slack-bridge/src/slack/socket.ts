import { LogLevel, SocketModeClient, type Logger } from '@slack/socket-mode';
import { setTimeout as delay } from 'node:timers/promises';
import type { SlackConfig } from '../project/config.js';
import { APP_TOKEN_VAR, appToken, type Check } from './verify.js';

export type SocketRefreshReason = 'warning' | 'refresh_requested';
export type SocketHello = { readonly appId: string | null };
export type SocketConnectionHooks = {
  readonly refresh: (reason: SocketRefreshReason) => void;
  readonly disconnected: () => void;
};
export interface SocketConnection {
  start(): Promise<SocketHello>;
  close(): Promise<void>;
}
export type SocketConnectionFactory = (hooks: SocketConnectionHooks) => SocketConnection;
export type SocketBackoff = { readonly initialMs: number; readonly maxMs: number };
type Sleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

export type SlackSocketTransportOptions = {
  readonly expectedApiAppId?: string;
  readonly connectionFactory: SocketConnectionFactory;
  readonly backoff?: SocketBackoff;
  readonly sleep?: Sleep;
};

type ErrorCode = 'connect_failed' | 'hello_app_id_missing' | 'hello_app_id_mismatch';

/** SDK error, URL, token, envelope를 cause로 보존하지 않는 고정 오류다. */
export class SocketTransportError extends Error {
  constructor(readonly code: ErrorCode) {
    super(
      code === 'hello_app_id_missing'
        ? 'Socket hello에 App ID가 없다'
        : code === 'hello_app_id_mismatch'
          ? 'Socket hello App ID가 설정과 일치하지 않는다'
          : 'Socket Mode 연결에 실패했다',
    );
    this.name = 'SocketTransportError';
  }
}

const DEFAULT_BACKOFF: SocketBackoff = { initialMs: 500, maxMs: 8_000 };

export function reconnectDelay(attempt: number, backoff: SocketBackoff = DEFAULT_BACKOFF): number {
  const exponent = Math.max(0, Math.min(30, Math.trunc(attempt) - 1));
  return Math.min(backoff.maxMs, backoff.initialMs * 2 ** exponent);
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return delay(delayMs, undefined, { signal });
}

async function closeQuietly(connection: SocketConnection | null): Promise<void> {
  try {
    await connection?.close();
  } catch {
    // SDK error 원문은 shutdown 진단에도 싣지 않는다.
  }
}

/** warning/refresh는 old/new를 overlap하고, 단절은 bounded exponential backoff로 복구한다. */
export class SlackSocketTransport {
  private current: SocketConnection | null = null;
  private candidate: SocketConnection | null = null;
  private reconnectTask: Promise<void> | null = null;
  private stopped = true;
  private abort = new AbortController();

  constructor(private readonly options: SlackSocketTransportOptions) {}

  async start(): Promise<void> {
    if (!this.stopped || this.current !== null) throw new SocketTransportError('connect_failed');
    this.stopped = false;
    this.abort = new AbortController();
    try {
      const connection = await this.openConnection();
      if (this.stopped) {
        await closeQuietly(connection);
        throw new SocketTransportError('connect_failed');
      }
      this.current = connection;
    } catch (error) {
      this.stopped = true;
      this.abort.abort();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped && this.current === null && this.candidate === null) return;
    this.stopped = true;
    this.abort.abort();
    const connections = new Set([this.current, this.candidate]);
    this.current = null;
    await Promise.all([...connections].map((connection) => closeQuietly(connection)));
    if (this.reconnectTask !== null) await this.reconnectTask;
  }

  private async openConnection(): Promise<SocketConnection> {
    let ref: SocketConnection | null = null;
    let connection: SocketConnection;
    try {
      connection = this.options.connectionFactory({
        refresh: (reason) => ref !== null && this.handleRefresh(ref, reason),
        disconnected: () => ref !== null && this.handleDisconnected(ref),
      });
      ref = connection;
    } catch {
      throw new SocketTransportError('connect_failed');
    }
    this.candidate = connection;
    try {
      const { appId } = await connection.start();
      if (!appId) throw new SocketTransportError('hello_app_id_missing');
      if (this.options.expectedApiAppId !== undefined && appId !== this.options.expectedApiAppId) {
        throw new SocketTransportError('hello_app_id_mismatch');
      }
      return connection;
    } catch (error) {
      await closeQuietly(connection);
      throw error instanceof SocketTransportError
        ? error
        : new SocketTransportError('connect_failed');
    } finally {
      if (this.candidate === connection) this.candidate = null;
    }
  }

  private handleRefresh(connection: SocketConnection, _reason: SocketRefreshReason): void {
    if (!this.stopped && connection === this.current) this.beginReconnect(true);
  }

  private handleDisconnected(connection: SocketConnection): void {
    if (this.stopped || connection !== this.current) return;
    this.current = null;
    this.beginReconnect(false);
  }

  private beginReconnect(immediate: boolean): void {
    if (this.stopped || this.reconnectTask !== null) return;
    let task: Promise<void>;
    task = this.reconnectLoop(immediate).finally(() => {
      if (this.reconnectTask === task) this.reconnectTask = null;
    });
    this.reconnectTask = task;
    void task;
  }

  private async reconnectLoop(immediate: boolean): Promise<void> {
    let attempt = 1;
    let delayMs = immediate ? 0 : reconnectDelay(attempt, this.options.backoff);
    while (!this.stopped) {
      if (delayMs > 0) {
        try {
          await (this.options.sleep ?? defaultSleep)(delayMs, this.abort.signal);
        } catch {
          return;
        }
        if (this.stopped) return;
      }
      const previous = this.current;
      try {
        const replacement = await this.openConnection();
        if (this.stopped) return void (await closeQuietly(replacement));
        this.current = replacement;
        if (previous !== null && previous !== replacement) await closeQuietly(previous);
        return;
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof SocketTransportError && error.code !== 'connect_failed') return;
        delayMs = reconnectDelay(++attempt, this.options.backoff);
      }
    }
  }
}

type LifecycleFrame =
  | { readonly type: 'hello'; readonly appId: string | null }
  | { readonly type: 'refresh'; readonly reason: SocketRefreshReason }
  | { readonly type: 'other' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 원문 frame에서 lifecycle 필드만 고르고 나머지는 즉시 버린다. */
export function parseSocketLifecycle(data: string | ArrayBuffer, binary: boolean): LifecycleFrame {
  if (binary) return { type: 'other' };
  let raw: unknown;
  try {
    raw = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
  } catch {
    return { type: 'other' };
  }
  if (!isRecord(raw)) return { type: 'other' };
  if (raw['type'] === 'hello') {
    const info = raw['connection_info'];
    const appId = isRecord(info) ? info['app_id'] : undefined;
    return { type: 'hello', appId: typeof appId === 'string' && appId !== '' ? appId : null };
  }
  const reason = raw['reason'];
  return raw['type'] === 'disconnect' && (reason === 'warning' || reason === 'refresh_requested')
    ? { type: 'refresh', reason }
    : { type: 'other' };
}

/** SDK debug/error에는 raw frame이나 URL이 들어갈 수 있으므로 모두 폐기한다. */
const SILENT_LOGGER: Logger = {
  debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, setName() {},
  getLevel: () => LogLevel.ERROR,
};

class IdentitySocketModeClient extends SocketModeClient {
  private observedAppId: string | null | undefined;

  constructor(appTokenValue: string, private readonly hooks: SocketConnectionHooks) {
    super({
      appToken: appTokenValue,
      autoReconnectEnabled: false,
      logger: SILENT_LOGGER,
      clientOptions: { retryConfig: { retries: 0 } },
    });
    this.on('disconnected', hooks.disconnected);
  }

  hello(): SocketHello {
    return { appId: this.observedAppId ?? null };
  }

  protected override async onWebSocketMessage(
    data: string | ArrayBuffer,
    binary: boolean,
  ): Promise<void> {
    const frame = parseSocketLifecycle(data, binary);
    if (frame.type === 'hello') this.observedAppId = frame.appId;
    if (frame.type === 'refresh') return this.hooks.refresh(frame.reason);
    await super.onWebSocketMessage(data, binary);
  }
}

/** SDK start가 URL을 발급한 직후 연결하며, adapter 밖에는 hello App ID만 반환한다. */
export function slackSdkConnectionFactory(appTokenValue: string): SocketConnectionFactory {
  return (hooks) => {
    const client = new IdentitySocketModeClient(appTokenValue, hooks);
    return {
      start: async () => {
        try {
          await client.start();
          return client.hello();
        } catch {
          throw new SocketTransportError('connect_failed');
        }
      },
      close: async () => {
        try {
          await client.disconnect();
        } catch {
          throw new SocketTransportError('connect_failed');
        }
      },
    };
  };
}

/** 명시적 CLI preflight는 hello 확인 뒤 항상 clean shutdown한다. */
export async function verifySocketPreflight(
  config: SlackConfig | null,
  env: NodeJS.ProcessEnv,
  connectionFactory?: SocketConnectionFactory,
): Promise<Check> {
  if (config === null) return { name: 'socket.hello', ok: false, detail: '설정에 slack 절이 없다' };
  const token = appToken(env);
  if (token === undefined) {
    return { name: 'socket.hello', ok: false, detail: `${APP_TOKEN_VAR}가 비어 있다` };
  }
  if (!token.startsWith('xapp-')) {
    return { name: 'socket.hello', ok: false, detail: `${APP_TOKEN_VAR} 형식이 올바르지 않다` };
  }
  const transport = new SlackSocketTransport({
    ...(config.apiAppId === undefined ? {} : { expectedApiAppId: config.apiAppId }),
    connectionFactory: connectionFactory ?? slackSdkConnectionFactory(token),
  });
  try {
    await transport.start();
    return {
      name: 'socket.hello',
      ok: true,
      detail: config.apiAppId === undefined
        ? 'Socket hello와 App ID 관측 성공 (고정 App ID 미설정)'
        : 'Socket hello와 설정 App ID exact 일치',
    };
  } catch (error) {
    return {
      name: 'socket.hello',
      ok: false,
      detail: error instanceof SocketTransportError ? error.message : 'Socket Mode 연결에 실패했다',
    };
  } finally {
    await transport.shutdown();
  }
}
