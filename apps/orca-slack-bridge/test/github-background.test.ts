import { describe, expect, it } from 'vitest';
import {
  BackgroundGithub,
  GithubBudgetDeferredError,
  GithubDeadlineDeferredError,
} from '../src/github/background.js';
import type { GhRunner, GhRunOptions } from '../src/github/runner.js';

function isRestQuota(args: readonly string[]): boolean {
  return args[0] === 'api' && args[1] === 'rate_limit';
}
function isGraphqlQuota(args: readonly string[]): boolean {
  return args.includes('.data.rateLimit.remaining');
}

class FakeGh implements GhRunner {
  readonly calls: readonly string[][] = [] as unknown as string[][];
  active = 0;
  maximumActive = 0;
  rest = 5_000;
  graphql = 5_000;
  body = '{}';
  wait = false;
  ignoreAbort = false;
  delayMs = 0;
  private releases: (() => void)[] = [];

  async run(args: readonly string[], options: GhRunOptions = {}): Promise<string> {
    (this.calls as string[][]).push([...args]);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      if (isRestQuota(args)) return String(this.rest);
      if (isGraphqlQuota(args)) return String(this.graphql);
      if (this.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.wait) {
        await new Promise<void>((resolve, reject) => {
          this.releases.push(resolve);
          if (!this.ignoreAbort) {
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }
        });
      }
      return this.body;
    } finally {
      this.active -= 1;
    }
  }

  releaseAll(): void {
    for (const release of this.releases.splice(0)) release();
  }
}

describe('BackgroundGithub', () => {
  it('caches both quota dimensions for five minutes and charges a shared hourly bucket', async () => {
    const raw = new FakeGh();
    let now = 0;
    const github = new BackgroundGithub(raw, {
      commandBudgetPerHour: 5,
      rateLimitFloor: 1_000,
      nowMs: () => now,
    });

    await github.run(['api', 'repos/a/b']);
    await github.run(['api', 'repos/c/d']);
    expect(raw.calls.filter(isRestQuota)).toHaveLength(1);
    expect(raw.calls.filter(isGraphqlQuota)).toHaveLength(1);
    await github.run(['api', 'repos/e/f']);
    await expect(github.run(['api', 'repos/g/h'])).rejects.toEqual(
      expect.objectContaining({ name: 'GithubBudgetDeferredError', reason: 'command_budget' }),
    );

    now += 5 * 60_000;
    await expect(github.run(['api', 'repos/i/j'])).rejects.toBeInstanceOf(GithubBudgetDeferredError);
  });

  it('defers before repository work when either REST or GraphQL quota is below the floor', async () => {
    const raw = new FakeGh();
    raw.graphql = 999;
    const github = new BackgroundGithub(raw, {
      commandBudgetPerHour: 2_000, rateLimitFloor: 1_000,
    });
    await expect(github.run(['api', 'repos/a/b'])).rejects.toEqual(
      expect.objectContaining({ reason: 'graphql_quota' }),
    );
    expect(raw.calls.some((args) => args.includes('repos/a/b'))).toBe(false);
  });

  it('never runs more than two commands concurrently', async () => {
    const raw = new FakeGh();
    const github = new BackgroundGithub(raw, {
      commandBudgetPerHour: 2_000, rateLimitFloor: 1_000,
    });
    await github.run(['warm']);
    raw.maximumActive = 0;
    raw.delayMs = 10;
    const work = [github.run(['one']), github.run(['two']), github.run(['three'])];
    await Promise.all(work);
    expect(raw.maximumActive).toBe(2);
  });

  it('quarantines timed-out permits until non-cooperative commands actually settle', async () => {
    const raw = new FakeGh();
    const github = new BackgroundGithub(raw, {
      commandBudgetPerHour: 2_000,
      rateLimitFloor: 1_000,
      commandTimeoutMs: 10,
    });
    await github.run(['warm']);
    raw.maximumActive = 0;
    raw.wait = true;
    raw.ignoreAbort = true;

    await Promise.all([
      expect(github.run(['one'])).rejects.toBeInstanceOf(GithubDeadlineDeferredError),
      expect(github.run(['two'])).rejects.toBeInstanceOf(GithubDeadlineDeferredError),
    ]);
    expect(raw.active).toBe(2);
    expect(github.snapshot().active).toBe(2);

    const third = github.run(['three']);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(raw.calls.some((call) => call[0] === 'three')).toBe(false);
    expect(raw.maximumActive).toBe(2);

    raw.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(raw.calls.some((call) => call[0] === 'three')).toBe(true);
    expect(raw.maximumActive).toBe(2);
    raw.releaseAll();
    await expect(third).resolves.toBe('{}');
  });

  it('bounds every command deadline and response size', async () => {
    const raw = new FakeGh();
    const github = new BackgroundGithub(raw, {
      commandBudgetPerHour: 2_000,
      rateLimitFloor: 1_000,
      commandTimeoutMs: 10,
      responseBytes: 10,
    });
    await github.run(['warm']);
    raw.body = '01234567890';
    await expect(github.run(['large'])).rejects.toThrow(/byte bound/);

    raw.body = '{}';
    raw.wait = true;
    await expect(github.run(['hung'])).rejects.toBeInstanceOf(GithubDeadlineDeferredError);
  });
});
