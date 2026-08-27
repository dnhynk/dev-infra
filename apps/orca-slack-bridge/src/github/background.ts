import type { GhRunner, GhRunOptions } from './runner.js';

export const BACKGROUND_GITHUB_COMMAND_TIMEOUT_MS = 20_000;
export const BACKGROUND_GITHUB_RESPONSE_BYTES = 8 * 1024 * 1024;
export const BACKGROUND_GITHUB_MAX_PAGES = 100;
export const BACKGROUND_GITHUB_MAX_CONCURRENCY = 2;
export const BACKGROUND_GITHUB_QUOTA_CACHE_MS = 5 * 60_000;

export class GithubBudgetDeferredError extends Error {
  constructor(readonly reason: 'command_budget' | 'rest_quota' | 'graphql_quota') {
    super('background GitHub work deferred');
    this.name = 'GithubBudgetDeferredError';
  }
}

export class GithubDeadlineDeferredError extends Error {
  constructor() {
    super('background GitHub command deadline exceeded');
    this.name = 'GithubDeadlineDeferredError';
  }
}

export type BackgroundGithubOptions = {
  readonly commandBudgetPerHour: number;
  readonly rateLimitFloor: number;
  readonly nowMs?: () => number;
  readonly commandTimeoutMs?: number;
  readonly responseBytes?: number;
  readonly quotaCacheMs?: number;
  readonly maxConcurrency?: number;
};

type QuotaSnapshot = {
  readonly checkedAt: number;
  readonly rest: number;
  readonly graphql: number;
};

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive bounded integer`);
  }
  return value;
}

function remaining(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError('GitHub quota response is invalid');
  }
  return parsed;
}

/** Shared daemon-wide command bucket, quota cache, response bound, and two-command semaphore. */
export class BackgroundGithub implements GhRunner {
  private readonly nowMs: () => number;
  private readonly capacity: number;
  private readonly floor: number;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly quotaCacheMs: number;
  private readonly concurrency: number;
  private tokens: number;
  private refilledAt: number;
  private quota: QuotaSnapshot | null = null;
  private quotaRead: Promise<QuotaSnapshot> | null = null;
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly runner: GhRunner, options: BackgroundGithubOptions) {
    this.capacity = positiveInteger('commandBudgetPerHour', options.commandBudgetPerHour, 100_000);
    this.floor = positiveInteger('rateLimitFloor', options.rateLimitFloor, 100_000_000);
    this.timeoutMs = positiveInteger(
      'commandTimeoutMs',
      options.commandTimeoutMs ?? BACKGROUND_GITHUB_COMMAND_TIMEOUT_MS,
      BACKGROUND_GITHUB_COMMAND_TIMEOUT_MS,
    );
    this.maximumResponseBytes = positiveInteger(
      'responseBytes',
      options.responseBytes ?? BACKGROUND_GITHUB_RESPONSE_BYTES,
      BACKGROUND_GITHUB_RESPONSE_BYTES,
    );
    this.quotaCacheMs = positiveInteger(
      'quotaCacheMs',
      options.quotaCacheMs ?? BACKGROUND_GITHUB_QUOTA_CACHE_MS,
      BACKGROUND_GITHUB_QUOTA_CACHE_MS,
    );
    this.concurrency = positiveInteger(
      'maxConcurrency',
      options.maxConcurrency ?? BACKGROUND_GITHUB_MAX_CONCURRENCY,
      BACKGROUND_GITHUB_MAX_CONCURRENCY,
    );
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.refilledAt = this.nowMs();
    this.tokens = this.capacity;
  }

  /** A job signal is merged into every command without changing repository-layer APIs. */
  scoped(signal: AbortSignal): GhRunner {
    return {
      run: (args, options = {}) => this.run(args, {
        ...options,
        signal: options.signal === undefined
          ? signal
          : AbortSignal.any([signal, options.signal]),
      }),
    };
  }

  snapshot(): { readonly tokens: number; readonly active: number; readonly quota: QuotaSnapshot | null } {
    this.refill();
    return { tokens: this.tokens, active: this.active, quota: this.quota };
  }

  async run(args: readonly string[], options: GhRunOptions = {}): Promise<string> {
    if (options.signal?.aborted === true) throw new GithubDeadlineDeferredError();
    await this.ensureQuota(options.signal);
    this.takeTokens(1);
    return await this.execute(args, options);
  }

  private refill(): void {
    const now = this.nowMs();
    const elapsed = Math.max(0, now - this.refilledAt);
    this.refilledAt = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.capacity / 3_600_000);
  }

  private takeTokens(count: number): void {
    this.refill();
    if (this.tokens + Number.EPSILON < count) {
      throw new GithubBudgetDeferredError('command_budget');
    }
    this.tokens -= count;
  }

  private async ensureQuota(signal?: AbortSignal): Promise<void> {
    const now = this.nowMs();
    if (this.quota === null || now - this.quota.checkedAt >= this.quotaCacheMs) {
      if (this.quotaRead === null) {
        this.takeTokens(2);
        this.quotaRead = this.readQuota(signal).finally(() => { this.quotaRead = null; });
      }
      this.quota = await this.quotaRead;
    }
    if (this.quota.rest < this.floor) throw new GithubBudgetDeferredError('rest_quota');
    if (this.quota.graphql < this.floor) throw new GithubBudgetDeferredError('graphql_quota');
  }

  private async readQuota(signal?: AbortSignal): Promise<QuotaSnapshot> {
    const [rest, graphql] = await Promise.all([
      this.executeRaw(
        ['api', 'rate_limit', '--jq', '.resources.core.remaining'],
        { ...(signal === undefined ? {} : { signal }) },
      ),
      this.executeRaw(
        ['api', 'graphql', '-f', 'query=query { rateLimit { remaining } }',
          '--jq', '.data.rateLimit.remaining'],
        { ...(signal === undefined ? {} : { signal }) },
      ),
    ]);
    return { checkedAt: this.nowMs(), rest: remaining(rest), graphql: remaining(graphql) };
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new GithubDeadlineDeferredError();
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ready = (): void => {
        signal?.removeEventListener('abort', abort);
        this.active += 1;
        resolve();
      };
      const abort = (): void => {
        const index = this.waiters.indexOf(ready);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new GithubDeadlineDeferredError());
      };
      this.waiters.push(ready);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted === true) abort();
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  private async execute(args: readonly string[], options: GhRunOptions): Promise<string> {
    return await this.executeRaw(args, options);
  }

  private async executeRaw(args: readonly string[], options: GhRunOptions): Promise<string> {
    await this.acquire(options.signal);
    const controller = new AbortController();
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
    const requested = options.timeoutMs ?? this.timeoutMs;
    const timeoutMs = Math.min(this.timeoutMs, Math.max(1, Math.trunc(requested)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.resolve().then(() => this.runner.run(args, { signal, timeoutMs }));
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GithubDeadlineDeferredError());
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      const output = await Promise.race([operation, timeout]);
      if (Buffer.byteLength(output, 'utf8') > this.maximumResponseBytes) {
        throw new RangeError('background GitHub response exceeded the byte bound');
      }
      return output;
    } catch (error) {
      if (signal.aborted && !(error instanceof GithubBudgetDeferredError)) {
        throw new GithubDeadlineDeferredError();
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void operation.catch(() => undefined);
      this.release();
    }
  }
}
