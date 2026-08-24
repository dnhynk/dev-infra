import {
  LogLevel,
  SocketModeClient,
  type Logger,
  type SocketModeOptions,
} from '@slack/socket-mode';
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
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => finish({ status: 'timed_out' }), options.timeoutMs);
      }
    }
    operation.then(
      (value) => finish({ status: 'fulfilled', value }),
      () => finish({ status: 'rejected' }),
    );
  });
}

/** 이미 caller 경계를 벗어난 cleanup의 late reject까지 소비한다. */
function observeOperation(operation: () => Promise<unknown>): void {
  try {
    void Promise.resolve(operation()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // 동기 SDK 오류도 adapter 경계 밖으로 내보내지 않는다.
  }
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
  private previous: SocketConnection | null = null;
  private reconnectTask: Promise<void> | null = null;
  private pendingReconnect: PendingReconnect | null = null;
  private stopped = true;
  private stopping = false;
  private generation = 0;
  private abort = new AbortController();
  private shutdownTask: Promise<void> | null = null;
  private readonly closeTasks = new WeakMap<SocketConnection, Promise<CloseOutcome>>();
  private candidateDisconnected = false;
  private closeTimeoutObserved = false;
  private readonly timeouts: SocketTimeouts;

  constructor(private readonly options: SlackSocketTransportOptions) {
    this.timeouts = {
      startMs: this.timeout(options.timeouts?.startMs, DEFAULT_SOCKET_TIMEOUTS.startMs),
      closeMs: this.timeout(options.timeouts?.closeMs, DEFAULT_SOCKET_TIMEOUTS.closeMs),
    };
  }

  async start(): Promise<void> {
    if (
      !this.stopped
      || this.stopping
      || this.current !== null
      || this.candidate !== null
      || this.previous !== null
    ) {
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
      if (
        this.stopped
        || this.generation !== generation
        || !this.promoteCandidate(connection, null)
      ) {
        this.clearCandidate(connection);
        await this.closeConnection(connection);
        throw new SocketTransportError('connect_failed');
      }
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
    if (
      this.stopped
      && this.current === null
      && this.candidate === null
      && this.previous === null
    ) {
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
    const connections = [...new Set([this.current, this.candidate, this.previous])]
      .filter((connection): connection is SocketConnection => connection !== null);
    this.current = null;
    this.candidate = null;
    this.candidateDisconnected = false;
    this.previous = null;
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
    let ready = false;
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
    this.candidateDisconnected = false;
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
      if (signal.aborted || this.candidateDisconnected) {
        throw new SocketTransportError('connect_failed');
      }
      ready = true;
      return connection;
    } catch (error) {
      await this.closeConnection(connection);
      throw error instanceof SocketTransportError
        ? error
        : new SocketTransportError('connect_failed');
    } finally {
      // 성공한 candidate는 caller가 current로 원자적으로 promote할 때까지 소유한다.
      // openConnection promise와 caller continuation 사이의 disconnect도 이 role로 관측한다.
      if (!ready) this.clearCandidate(connection);
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
    if (this.stopped) return;
    if (connection === this.candidate) {
      this.candidateDisconnected = true;
      return;
    }
    // previous와 이미 retire된 stale connection은 새 current의 lifecycle을 바꾸지 않는다.
    if (connection === this.previous || connection !== this.current) return;
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
        if (
          this.stopped
          || this.generation !== generation
          || !this.promoteCandidate(replacement, previous)
        ) {
          this.clearCandidate(replacement);
          await this.closeConnection(replacement);
          if (this.stopped || this.generation !== generation) return;
          throw new SocketTransportError('connect_failed');
        }
        if (this.pendingReconnect?.connection !== replacement) this.pendingReconnect = null;
        if (previous !== null && previous !== replacement) {
          try {
            await this.closeConnection(previous);
          } finally {
            if (this.previous === previous) this.previous = null;
          }
        } else if (this.previous === previous) {
          this.previous = null;
        }
        return;
      } catch (error) {
        if (this.stopped || this.generation !== generation) return;
        const nonretryable =
          error instanceof SocketTransportError
          && error.code !== 'connect_failed'
          && error.code !== 'connect_timeout';
        if (nonretryable) {
          const identityFailure =
            error.code === 'hello_app_id_missing'
            || error.code === 'hello_app_id_mismatch';
          const disconnectRecoveryRequired =
            this.current === null
            || this.pendingReconnect?.immediate === false;
          // 살아 있는 current가 identity 실패를 대신할 수 있을 때는 one-shot으로 끝낸다.
          // candidate 동안 current가 끊겼다면 pending을 이 loop로 흡수하고 backoff 복구한다.
          this.pendingReconnect = null;
          if (!identityFailure || !disconnectRecoveryRequired) return;
        }
        delayMs = reconnectDelay(++attempt, this.options.backoff);
      }
    }
  }

  private promoteCandidate(
    connection: SocketConnection,
    previous: SocketConnection | null,
  ): boolean {
    if (
      this.candidate !== connection
      || this.candidateDisconnected
    ) return false;
    this.previous = previous;
    this.current = connection;
    this.clearCandidate(connection);
    return true;
  }

  private clearCandidate(connection: SocketConnection): void {
    if (this.candidate !== connection) return;
    this.candidate = null;
    this.candidateDisconnected = false;
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
        // SDK v3 disconnect는 첫 호출이 close handshake를 기다릴 수 있다. public close를
        // 한 번 더 호출해 SDK가 가진 listener/timer cleanup을 진행하되 caller는 더 기다리지 않는다.
        observeOperation(() => connection.close());
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

type SocketHttpFetch = NonNullable<NonNullable<SocketModeOptions['clientOptions']>['fetch']>;
type SocketHttpResponse = Awaited<ReturnType<SocketHttpFetch>>;
type SocketBodyReader = {
  readonly read: () => unknown;
  readonly cancel: (reason?: unknown) => unknown;
  readonly releaseLock: () => unknown;
};

function observeSocketBodyCancel(target: unknown, reason?: unknown): boolean {
  if (!isRecord(target)) return false;
  let cancel: unknown;
  try {
    cancel = target['cancel'];
  } catch {
    return false;
  }
  if (typeof cancel !== 'function') return false;
  const args = reason === undefined ? [] : [reason];
  observeOperation(() => Promise.resolve(Reflect.apply(cancel, target, args)));
  return true;
}

function releaseSocketBodyReader(reader: unknown): void {
  if (!isRecord(reader)) return;
  try {
    const releaseLock = reader['releaseLock'];
    if (typeof releaseLock === 'function') Reflect.apply(releaseLock, reader, []);
  } catch {
    // malformed readers still fall through to raw body cancellation.
  }
}

async function cancelSocketBodyReader(reader: SocketBodyReader, reason?: unknown): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // raw body cancellation failures never cross the adapter boundary.
  }
  try {
    reader.releaseLock();
  } catch {
    // cancellation is still best-effort if a malformed reader keeps its lock.
  }
}

function socketBodyReader(body: unknown): SocketBodyReader {
  if (!isRecord(body)) {
    throw new SocketTransportError('connect_failed');
  }
  let reader: unknown;
  try {
    const getReader = body['getReader'];
    if (typeof getReader !== 'function') throw new SocketTransportError('connect_failed');
    reader = Reflect.apply(getReader, body, []);
  } catch {
    observeSocketBodyCancel(body);
    throw new SocketTransportError('connect_failed');
  }
  let read: unknown;
  let cancel: unknown;
  let releaseLock: unknown;
  try {
    if (isRecord(reader)) {
      // cancel을 먼저 잡아 read accessor 자체가 malformed여도 획득한 reader를 놓는다.
      cancel = reader['cancel'];
      releaseLock = reader['releaseLock'];
      read = reader['read'];
    }
  } catch {
    // 아래의 public cancellation fallback이 처리한다.
  }
  if (
    !isRecord(reader)
    || typeof read !== 'function'
    || typeof cancel !== 'function'
    || typeof releaseLock !== 'function'
  ) {
    if (typeof cancel === 'function') {
      observeOperation(async () => {
        try {
          await Promise.resolve(Reflect.apply(cancel, reader, []));
        } catch {
          // malformed reader cancellation is best-effort.
        }
        if (typeof releaseLock === 'function') {
          try {
            Reflect.apply(releaseLock, reader, []);
          } catch {
            // malformed reader lock release is best-effort.
          }
        }
      });
    } else {
      releaseSocketBodyReader(reader);
      observeSocketBodyCancel(body);
    }
    throw new SocketTransportError('connect_failed');
  }
  return {
    read: () => Reflect.apply(read, reader, []),
    cancel: (reason?: unknown) => Reflect.apply(
      cancel,
      reader,
      reason === undefined ? [] : [reason],
    ),
    releaseLock: () => Reflect.apply(releaseLock, reader, []),
  };
}

function isUint8ArrayChunk(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function socketHeaders(value: unknown): Headers {
  if (
    !isRecord(value)
    || typeof value['get'] !== 'function'
    || typeof value['entries'] !== 'function'
  ) {
    throw new SocketTransportError('connect_failed');
  }
  try {
    const rawEntries = (value['entries'] as () => Iterable<unknown>).call(value);
    const entries = Array.from(rawEntries);
    if (!entries.every((entry): entry is [string, string] => (
      Array.isArray(entry)
      && entry.length === 2
      && typeof entry[0] === 'string'
      && typeof entry[1] === 'string'
    ))) {
      throw new SocketTransportError('connect_failed');
    }
    return new Headers(entries);
  } catch {
    throw new SocketTransportError('connect_failed');
  }
}

function socketResponseInit(response: Record<string, unknown>): ResponseInit {
  const status = response['status'];
  const statusText = response['statusText'];
  if (
    typeof status !== 'number'
    || !Number.isInteger(status)
    || status < 200
    || status > 599
    || typeof statusText !== 'string'
  ) {
    throw new SocketTransportError('connect_failed');
  }
  return { status, statusText, headers: socketHeaders(response['headers']) };
}

/** Response body reader도 owner abort에 묶어 SDK가 late URL을 파싱하지 못하게 한다. */
function fencedSocketResponse(
  response: SocketHttpResponse,
  signal: AbortSignal,
): SocketHttpResponse {
  if (!isRecord(response)) throw new SocketTransportError('connect_failed');
  let rawBody: unknown;
  try {
    // fulfillment 직후부터 adapter가 body를 소유하므로 metadata보다 먼저 reader를 잡는다.
    rawBody = response['body'];
  } catch {
    throw new SocketTransportError('connect_failed');
  }
  if (rawBody === null) {
    try {
      if (signal.aborted) throw new SocketTransportError('connect_failed');
      return new Response(null, socketResponseInit(response));
    } catch {
      throw new SocketTransportError('connect_failed');
    }
  }
  const reader = socketBodyReader(rawBody);
  let finished = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = (): boolean => {
    if (finished) return false;
    finished = true;
    signal.removeEventListener('abort', abortBody);
    return true;
  };
  const abortBody = (): void => {
    if (!finish()) return;
    try {
      streamController?.error(new SocketTransportError('connect_failed'));
    } catch {
      // cancellation remains mandatory even if the wrapper controller already transitioned.
    }
    observeOperation(() => cancelSocketBodyReader(reader));
  };
  try {
    if (signal.aborted) throw new SocketTransportError('connect_failed');
    const responseInit = socketResponseInit(response);
    const fencedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        if (signal.aborted) abortBody();
        else signal.addEventListener('abort', abortBody, { once: true });
      },
      async pull(controller) {
        if (finished) return;
        let reading: Promise<unknown>;
        try {
          reading = Promise.resolve(reader.read());
        } catch {
          abortBody();
          return;
        }
        const outcome = await settleOperation(reading, { signal });
        if (finished) return;
        if (outcome.status !== 'fulfilled') {
          abortBody();
          return;
        }
        try {
          if (!isRecord(outcome.value) || typeof outcome.value['done'] !== 'boolean') {
            abortBody();
            return;
          }
          if (outcome.value['done']) {
            if (!finish()) return;
            releaseSocketBodyReader(reader);
            controller.close();
            return;
          }
          const chunk = outcome.value['value'];
          if (!isUint8ArrayChunk(chunk)) {
            abortBody();
            return;
          }
          controller.enqueue(chunk);
        } catch {
          abortBody();
        }
      },
      async cancel(reason) {
        if (!finish()) return;
        await cancelSocketBodyReader(reader, reason);
      },
    });
    return new Response(fencedBody, responseInit);
  } catch {
    abortBody();
    throw new SocketTransportError('connect_failed');
  }
}

/**
 * SDK의 documented clientOptions.fetch seam에 owner abort를 결합한다. 실제 fetch promise와
 * 반환된 표준 Response body 모두 owner가 살아 있는 동안에만 SDK가 소비할 수 있다.
 */
function fencedSocketFetch(ownerSignal: AbortSignal): SocketHttpFetch {
  return async (url, init) => {
    const signal = init?.signal === undefined
      ? ownerSignal
      : AbortSignal.any([ownerSignal, init.signal]);
    if (signal.aborted) throw new SocketTransportError('connect_failed');
    let fetching: Promise<SocketHttpResponse>;
    try {
      fetching = globalThis.fetch(url, { ...init, signal });
    } catch {
      throw new SocketTransportError('connect_failed');
    }
    const outcome = await settleOperation(fetching, { signal });
    if (outcome.status !== 'fulfilled') throw new SocketTransportError('connect_failed');
    try {
      return fencedSocketResponse(outcome.value, signal);
    } catch {
      throw new SocketTransportError('connect_failed');
    }
  };
}

class IdentitySocketModeClient extends SocketModeClient {
  private observedAppId: string | null | undefined;
  private lifecycleHooks: SocketConnectionHooks | null;
  private readonly disconnectedListener = (): void => {
    const hooks = this.lifecycleHooks;
    this.disposeLifecycle();
    hooks?.disconnected();
  };

  constructor(
    appTokenValue: string,
    hooks: SocketConnectionHooks,
    requestSignal: AbortSignal,
  ) {
    super({
      appToken: appTokenValue,
      autoReconnectEnabled: false,
      logger: SILENT_LOGGER,
      clientOptions: {
        retryConfig: { retries: 0 },
        fetch: fencedSocketFetch(requestSignal),
      },
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
    const requestAbort = new AbortController();
    const client = new IdentitySocketModeClient(appTokenValue, hooks, requestAbort.signal);
    let closed = false;
    const close = async (): Promise<void> => {
      closed = true;
      requestAbort.abort();
      client.disposeLifecycle();
      try {
        // 반복 호출은 의도적이다. SDK v3는 두 번째 public disconnect에서 stalled
        // close handshake의 listener/timer cleanup을 계속 진행한다.
        await client.disconnect();
      } catch {
        throw new SocketTransportError('connect_failed');
      }
    };
    return {
      start: async () => {
        if (closed) throw new SocketTransportError('connect_failed');
        try {
          await client.start();
          if (closed) {
            observeOperation(close);
            throw new SocketTransportError('connect_failed');
          }
          return client.hello();
        } catch {
          throw new SocketTransportError('connect_failed');
        }
      },
      close,
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
