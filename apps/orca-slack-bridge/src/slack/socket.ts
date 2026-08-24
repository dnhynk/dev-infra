import { LogLevel, SocketModeClient, type Logger } from '@slack/socket-mode';
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
export type SocketTimeouts = { readonly startMs: number; readonly closeMs: number };
type Sleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

export type SlackSocketTransportOptions = {
  readonly expectedApiAppId?: string;
  readonly connectionFactory: SocketConnectionFactory;
  readonly backoff?: SocketBackoff;
  readonly timeouts?: Partial<SocketTimeouts>;
  readonly sleep?: Sleep;
};

export type SocketTransportErrorCode =
  | 'connect_failed'
  | 'connect_timeout'
  | 'close_timeout'
  | 'hello_app_id_missing'
  | 'hello_app_id_mismatch';

const SOCKET_ERROR_MESSAGES: Readonly<Record<SocketTransportErrorCode, string>> = {
  connect_failed: 'Socket Mode 연결에 실패했다',
  connect_timeout: 'Socket Mode hello 제한 시간을 넘었다',
  close_timeout: 'Socket Mode 연결 종료 제한 시간을 넘었다',
  hello_app_id_missing: 'Socket hello에 App ID가 없다',
  hello_app_id_mismatch: 'Socket hello App ID가 설정과 일치하지 않는다',
};

/** SDK error, URL, token, envelope를 cause로 보존하지 않는 고정 오류다. */
export class SocketTransportError extends Error {
  constructor(readonly code: SocketTransportErrorCode) {
    super(SOCKET_ERROR_MESSAGES[code]);
    this.name = 'SocketTransportError';
  }
}

const DEFAULT_BACKOFF: SocketBackoff = { initialMs: 500, maxMs: 8_000 };
export const DEFAULT_SOCKET_TIMEOUTS: SocketTimeouts = { startMs: 30_000, closeMs: 5_000 };

export function reconnectDelay(attempt: number, backoff: SocketBackoff = DEFAULT_BACKOFF): number {
  const exponent = Math.max(0, Math.min(30, Math.trunc(attempt) - 1));
  return Math.min(backoff.maxMs, backoff.initialMs * 2 ** exponent);
}

type OperationOutcome<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected' | 'timed_out' | 'aborted' };

/** raw rejection을 보존하지 않고 timer/abort listener를 항상 해제한다. */
function settleOperation<T>(
  operation: Promise<T>,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<OperationOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { signal } = options;
    const onAbort = (): void => finish({ status: 'aborted' });
    const finish = (outcome: OperationOutcome<T>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    if (signal?.aborted) {
      finish({ status: 'aborted' });
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => finish({ status: 'timed_out' }), options.timeoutMs);
    }
    operation.then(
      (value) => finish({ status: 'fulfilled', value }),
      () => finish({ status: 'rejected' }),
    );
  });
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SocketTransportError('connect_failed'));
      return;
    }
    const timer = setTimeout(done, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new SocketTransportError('connect_failed'));
    };
    function done(): void {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type CloseOutcome = 'closed' | 'failed' | 'timed_out';
type PendingReconnect = {
  readonly connection: SocketConnection;
  readonly immediate: boolean;
};

/** warning/refresh는 old/new를 overlap하고, 단절은 bounded exponential backoff로 복구한다. */
export class SlackSocketTransport {
  private current: SocketConnection | null = null;
  private candidate: SocketConnection | null = null;
  private reconnectTask: Promise<void> | null = null;
  private pendingReconnect: PendingReconnect | null = null;
  private stopped = true;
  private stopping = false;
  private generation = 0;
  private abort = new AbortController();
  private shutdownTask: Promise<void> | null = null;
  private readonly closeTasks = new WeakMap<SocketConnection, Promise<CloseOutcome>>();
  private closeTimeoutObserved = false;
  private readonly timeouts: SocketTimeouts;

  constructor(private readonly options: SlackSocketTransportOptions) {
    this.timeouts = {
      startMs: this.timeout(options.timeouts?.startMs, DEFAULT_SOCKET_TIMEOUTS.startMs),
      closeMs: this.timeout(options.timeouts?.closeMs, DEFAULT_SOCKET_TIMEOUTS.closeMs),
    };
  }

  async start(): Promise<void> {
    if (!this.stopped || this.stopping || this.current !== null || this.candidate !== null) {
      throw new SocketTransportError('connect_failed');
    }
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.shutdownTask = null;
    this.closeTimeoutObserved = false;
    this.pendingReconnect = null;
    this.stopped = false;
    try {
      const connection = await this.openConnection(abort.signal);
      if (this.stopped || this.generation !== generation) {
        await this.closeConnection(connection);
        throw new SocketTransportError('connect_failed');
      }
      this.current = connection;
    } catch (error) {
      if (this.generation === generation) {
        this.stopped = true;
        abort.abort();
      }
      throw error instanceof SocketTransportError
        ? error
        : new SocketTransportError('connect_failed');
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask !== null) return this.shutdownTask;
    if (this.stopped && this.current === null && this.candidate === null) {
      this.shutdownTask = this.closeTimeoutObserved
        ? Promise.reject(new SocketTransportError('close_timeout'))
        : Promise.resolve();
      return this.shutdownTask;
    }
    this.shutdownTask = this.performShutdown();
    return this.shutdownTask;
  }

  private async performShutdown(): Promise<void> {
    this.stopping = true;
    this.stopped = true;
    this.generation += 1;
    this.abort.abort();
    this.pendingReconnect = null;
    const reconnectTask = this.reconnectTask;
    const connections = [...new Set([this.current, this.candidate])]
      .filter((connection): connection is SocketConnection => connection !== null);
    this.current = null;
    this.candidate = null;
    try {
      await Promise.all(connections.map((connection) => this.closeConnection(connection)));
      if (reconnectTask !== null) await reconnectTask;
    } finally {
      this.stopping = false;
    }
    if (this.closeTimeoutObserved) throw new SocketTransportError('close_timeout');
  }

  private async openConnection(signal: AbortSignal): Promise<SocketConnection> {
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
      let starting: Promise<SocketHello>;
      try {
        starting = Promise.resolve(connection.start());
      } catch {
        throw new SocketTransportError('connect_failed');
      }
      const outcome = await settleOperation(starting, {
        timeoutMs: this.timeouts.startMs,
        signal,
      });
      if (outcome.status === 'timed_out') throw new SocketTransportError('connect_timeout');
      if (outcome.status !== 'fulfilled') throw new SocketTransportError('connect_failed');
      const { appId } = outcome.value;
      if (!appId) throw new SocketTransportError('hello_app_id_missing');
      if (this.options.expectedApiAppId !== undefined && appId !== this.options.expectedApiAppId) {
        throw new SocketTransportError('hello_app_id_mismatch');
      }
      return connection;
    } catch (error) {
      await this.closeConnection(connection);
      throw error instanceof SocketTransportError
        ? error
        : new SocketTransportError('connect_failed');
    } finally {
      if (this.candidate === connection) this.candidate = null;
    }
  }

  private handleRefresh(connection: SocketConnection, _reason: SocketRefreshReason): void {
    if (this.stopped || connection !== this.current) return;
    if (this.reconnectTask !== null) {
      this.pendingReconnect = { connection, immediate: true };
      return;
    }
    this.beginReconnect(true);
  }

  private handleDisconnected(connection: SocketConnection): void {
    if (this.stopped || connection !== this.current) return;
    this.current = null;
    if (this.reconnectTask !== null) {
      this.pendingReconnect = { connection, immediate: false };
      return;
    }
    this.beginReconnect(false);
  }

  private beginReconnect(immediate: boolean): void {
    if (this.stopped || this.reconnectTask !== null) return;
    let task: Promise<void>;
    const generation = this.generation;
    task = this.reconnectLoop(immediate, generation).finally(() => {
      if (this.reconnectTask !== task) return;
      this.reconnectTask = null;
      if (this.stopped || this.generation !== generation) {
        this.pendingReconnect = null;
        return;
      }
      const pending = this.pendingReconnect;
      this.pendingReconnect = null;
      if (pending === null) return;
      const stillApplies = pending.immediate
        ? this.current === pending.connection
        : this.current === null;
      if (stillApplies) this.beginReconnect(pending.immediate);
    });
    this.reconnectTask = task;
    void task;
  }

  private async reconnectLoop(immediate: boolean, generation: number): Promise<void> {
    let attempt = 1;
    let delayMs = immediate ? 0 : reconnectDelay(attempt, this.options.backoff);
    while (!this.stopped && this.generation === generation) {
      if (delayMs > 0) {
        try {
          const sleeping = (this.options.sleep ?? defaultSleep)(delayMs, this.abort.signal);
          const outcome = await settleOperation(sleeping, { signal: this.abort.signal });
          if (outcome.status !== 'fulfilled') return;
        } catch {
          return;
        }
        if (this.stopped || this.generation !== generation) return;
      }
      const previous = this.current;
      try {
        const replacement = await this.openConnection(this.abort.signal);
        if (this.stopped || this.generation !== generation) {
          await this.closeConnection(replacement);
          return;
        }
        this.current = replacement;
        if (this.pendingReconnect?.connection !== replacement) this.pendingReconnect = null;
        if (previous !== null && previous !== replacement) await this.closeConnection(previous);
        return;
      } catch (error) {
        if (this.stopped || this.generation !== generation) return;
        if (
          error instanceof SocketTransportError
          && error.code !== 'connect_failed'
          && error.code !== 'connect_timeout'
        ) {
          this.pendingReconnect = null;
          return;
        }
        delayMs = reconnectDelay(++attempt, this.options.backoff);
      }
    }
  }

  private closeConnection(connection: SocketConnection): Promise<CloseOutcome> {
    const active = this.closeTasks.get(connection);
    if (active !== undefined) return active;
    let closing: Promise<void>;
    try {
      closing = Promise.resolve(connection.close());
    } catch {
      closing = Promise.reject(new SocketTransportError('connect_failed'));
    }
    const task = settleOperation(closing, { timeoutMs: this.timeouts.closeMs }).then((outcome) => {
      if (outcome.status === 'timed_out') {
        this.closeTimeoutObserved = true;
        return 'timed_out' as const;
      }
      return outcome.status === 'fulfilled' ? 'closed' as const : 'failed' as const;
    });
    this.closeTasks.set(connection, task);
    return task;
  }

  private timeout(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : fallback;
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
  private lifecycleHooks: SocketConnectionHooks | null;
  private readonly disconnectedListener = (): void => {
    const hooks = this.lifecycleHooks;
    this.disposeLifecycle();
    hooks?.disconnected();
  };

  constructor(appTokenValue: string, hooks: SocketConnectionHooks) {
    super({
      appToken: appTokenValue,
      autoReconnectEnabled: false,
      logger: SILENT_LOGGER,
      clientOptions: { retryConfig: { retries: 0 } },
    });
    this.lifecycleHooks = hooks;
    this.on('disconnected', this.disconnectedListener);
  }

  hello(): SocketHello {
    return { appId: this.observedAppId ?? null };
  }

  disposeLifecycle(): void {
    this.off('disconnected', this.disconnectedListener);
    this.lifecycleHooks = null;
  }

  protected override async onWebSocketMessage(
    data: string | ArrayBuffer,
    binary: boolean,
  ): Promise<void> {
    const frame = parseSocketLifecycle(data, binary);
    if (frame.type === 'hello') this.observedAppId = frame.appId;
    if (frame.type === 'refresh') {
      this.lifecycleHooks?.refresh(frame.reason);
      return;
    }
    await super.onWebSocketMessage(data, binary);
  }
}

/** SDK start가 URL을 발급한 직후 연결하며, adapter 밖에는 hello App ID만 반환한다. */
export function slackSdkConnectionFactory(appTokenValue: string): SocketConnectionFactory {
  return (hooks) => {
    const client = new IdentitySocketModeClient(appTokenValue, hooks);
    let closed = false;
    let closing: Promise<void> | null = null;
    return {
      start: async () => {
        if (closed) throw new SocketTransportError('connect_failed');
        try {
          await client.start();
          if (closed) throw new SocketTransportError('connect_failed');
          return client.hello();
        } catch {
          throw new SocketTransportError('connect_failed');
        }
      },
      close: () => {
        if (closing !== null) return closing;
        closed = true;
        client.disposeLifecycle();
        closing = (async () => {
          try {
            await client.disconnect();
          } catch {
            throw new SocketTransportError('connect_failed');
          }
        })();
        return closing;
      },
    };
  };
}

/** 명시적 CLI preflight는 hello 확인 뒤 항상 clean shutdown한다. */
export async function verifySocketPreflight(
  config: SlackConfig | null,
  env: NodeJS.ProcessEnv,
  connectionFactory?: SocketConnectionFactory,
  timeouts?: Partial<SocketTimeouts>,
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
    ...(timeouts === undefined ? {} : { timeouts }),
  });
  let check: Check;
  try {
    await transport.start();
    check = {
      name: 'socket.hello',
      ok: true,
      detail: config.apiAppId === undefined
        ? 'Socket hello와 App ID 관측 성공 (고정 App ID 미설정)'
        : 'Socket hello와 설정 App ID exact 일치',
    };
  } catch (error) {
    check = {
      name: 'socket.hello',
      ok: false,
      detail: error instanceof SocketTransportError ? error.message : 'Socket Mode 연결에 실패했다',
    };
  }
  try {
    await transport.shutdown();
  } catch (error) {
    return {
      name: 'socket.hello',
      ok: false,
      detail: error instanceof SocketTransportError
        ? error.message
        : 'Socket Mode 연결에 실패했다',
    };
  }
  return check;
}
