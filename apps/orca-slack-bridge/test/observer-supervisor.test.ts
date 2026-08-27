import { describe, expect, it } from 'vitest';
import {
  deterministicObserverDelay,
  ObserverJobFailure,
  ObserverSupervisor,
  type ObserverClock,
  type ObserverCompletion,
  type ObserverJobDefinition,
  type ObserverJobName,
} from '../src/observer/supervisor.js';

class FakeClock implements ObserverClock {
  now = 0;
  wallOffsetMs = 0;
  wallOffsetForRead: ((now: number) => number) | undefined;
  private sequence = 0;
  private readonly timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  readonly monotonicMs = (): number => this.now;
  readonly wallNow = (): Date => new Date(
    Date.UTC(2026, 7, 27) + this.now +
      (this.wallOffsetForRead?.(this.now) ?? this.wallOffsetMs),
  );
  readonly setTimer = (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.now + Math.trunc(milliseconds), callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  readonly clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };
  async advance(milliseconds: number): Promise<void> {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (next === undefined) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function definitions(
  handlers: Partial<Record<ObserverJobName, ObserverJobDefinition['run']>> = {},
): ObserverJobDefinition[] {
  return [
    ['repository-discovery', 300_000, 30_000, 300_000],
    ['run-observer', 120_000, 90_000, 900_000],
    ['pr-digest', 900_000, 300_000, 7_200_000],
  ].map(([name, intervalMs, timeoutMs, backoffCapMs]) => ({
    name: name as ObserverJobName,
    intervalMs: intervalMs as number,
    timeoutMs: timeoutMs as number,
    backoffCapMs: backoffCapMs as number,
    run: handlers[name as ObserverJobName] ?? (async () => ({})),
  }));
}

describe('ObserverSupervisor', () => {
  it('uses one lane, coalesces due bits, and round-robins a digest before repeated work', async () => {
    const clock = new FakeClock();
    const order: ObserverJobName[] = [];
    let active = 0;
    let maximumActive = 0;
    let releaseRun!: () => void;
    let runCalls = 0;
    const supervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock,
      jobs: definitions({
        'repository-discovery': async () => {
          active += 1; maximumActive = Math.max(maximumActive, active);
          order.push('repository-discovery'); active -= 1; return {};
        },
        'run-observer': async () => {
          active += 1; maximumActive = Math.max(maximumActive, active);
          order.push('run-observer'); runCalls += 1;
          if (runCalls === 1) await new Promise<void>((resolve) => { releaseRun = resolve; });
          active -= 1; return {};
        },
        'pr-digest': async () => {
          active += 1; maximumActive = Math.max(maximumActive, active);
          order.push('pr-digest'); active -= 1; return {};
        },
      }),
    });

    await supervisor.runStartupDiscovery();
    supervisor.startAfterSocket(60_000);
    await flush();
    supervisor.markDue('run-observer');
    supervisor.markDue('run-observer');
    supervisor.markDue('repository-discovery');
    supervisor.markDue('pr-digest');
    releaseRun();
    await flush();

    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      'repository-discovery', 'run-observer', 'pr-digest',
      'repository-discovery', 'run-observer',
    ]);
    expect(runCalls).toBe(2);
    expect(await supervisor.stop(100)).toBe(true);
  });

  it('produces deterministic bounded installation jitter', () => {
    const first = deterministicObserverDelay(
      300_000, 0.1, 'installation-a', 'repository-discovery', 7,
    );
    const same = deterministicObserverDelay(
      300_000, 0.1, 'installation-a', 'repository-discovery', 7,
    );
    const other = deterministicObserverDelay(
      300_000, 0.1, 'installation-b', 'repository-discovery', 7,
    );
    expect(first).toBe(same);
    expect(first).toBeGreaterThanOrEqual(270_000);
    expect(first).toBeLessThanOrEqual(330_000);
    expect(other).not.toBe(first);
  });

  it('backs off exponentially, resets after success, and remains completion based', async () => {
    const clock = new FakeClock();
    const completions: ObserverCompletion[] = [];
    let discoveryCalls = 0;
    const supervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock, backoffBaseMs: 30_000,
      jobs: definitions({
        'repository-discovery': async () => {
          discoveryCalls += 1;
          if (discoveryCalls < 3) throw new ObserverJobFailure('discovery.query_failed');
          return { processedCount: 1 };
        },
      }),
      onCompleted: (completion) => { completions.push(completion); },
    });

    await supervisor.runStartupDiscovery();
    supervisor.startAfterSocket(60_000);
    await clock.advance(30_000);
    await clock.advance(60_000);

    expect(completions.filter((row) => row.name === 'repository-discovery')
      .map((row) => [row.status, row.nextDelayMs])).toEqual([
        ['failed', 30_000], ['failed', 60_000], ['succeeded', 300_000],
      ]);
    expect(await supervisor.stop(100)).toBe(true);
  });

  it('anchors deferred startup scheduling to completion, including overdue deadlines', async () => {
    const clock = new FakeClock();
    const completions: ObserverCompletion[] = [];
    let discoveryCalls = 0;
    const discoveryStarts: number[] = [];
    const digestStarts: number[] = [];
    const supervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock,
      jobs: definitions({
        'repository-discovery': async () => {
          discoveryCalls += 1;
          discoveryStarts.push(clock.now);
          return {};
        },
        'pr-digest': async () => {
          digestStarts.push(clock.now);
          return {};
        },
      }),
      onCompleted: (completion) => { completions.push(completion); },
    });

    await supervisor.runStartupDiscovery();
    const firstCompletion = completions[0]!;
    expect(firstCompletion.nextRunAt).toBe(new Date(Date.UTC(2026, 7, 27, 0, 0, 0) + 300_000)
      .toISOString());

    await clock.advance(60_000);
    supervisor.startAfterSocket(60_000);
    await clock.advance(59_999);
    expect(discoveryCalls).toBe(1);
    expect(digestStarts).toEqual([]);
    await clock.advance(1);
    expect(digestStarts).toEqual([120_000]);
    await clock.advance(179_999);
    expect(discoveryCalls).toBe(1);
    await clock.advance(1);
    expect(discoveryCalls).toBe(2);
    expect(discoveryStarts[1]).toBe(300_000);

    await supervisor.stop(100);

    const overdueClock = new FakeClock();
    const overdueStarts: number[] = [];
    const overdueSupervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock: overdueClock,
      jobs: definitions({
        'repository-discovery': async () => {
          overdueStarts.push(overdueClock.now);
          return {};
        },
      }),
    });

    await overdueSupervisor.runStartupDiscovery();
    await overdueClock.advance(300_001);
    overdueSupervisor.startAfterSocket(60_000);
    await flush();
    expect(overdueStarts).toEqual([0, 300_001]);
    await overdueSupervisor.stop(100);
  });

  it('anchors recurring scheduling to completion while onCompleted is slow', async () => {
    const clock = new FakeClock();
    const completions: ObserverCompletion[] = [];
    const runObserverStarts: number[] = [];
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const supervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock,
      jobs: definitions({
        'run-observer': async () => {
          runObserverStarts.push(clock.now);
          return {};
        },
      }),
      onCompleted: (completion) => {
        completions.push(completion);
        if (completion.name === 'run-observer' &&
            completions.filter((row) => row.name === 'run-observer').length === 1) {
          return completionGate;
        }
      },
    });

    await supervisor.runStartupDiscovery();
    supervisor.startAfterSocket(60_000);
    await flush();
    expect(runObserverStarts).toEqual([0]);
    const firstCompletion = completions.find((row) => row.name === 'run-observer')!;

    await clock.advance(60_000);
    releaseCompletion();
    await flush();
    await clock.advance(59_999);
    expect(runObserverStarts).toEqual([0]);
    await clock.advance(1);
    expect(runObserverStarts).toEqual([0, 120_000]);
    expect(firstCompletion.nextRunAt).toBe(new Date(Date.UTC(2026, 7, 27, 0, 0, 0) + 120_000)
      .toISOString());
    expect(runObserverStarts[1]).toBe(Date.parse(firstCompletion.nextRunAt) -
      Date.UTC(2026, 7, 27, 0, 0, 0));

    await supervisor.stop(100);
  });

  it('does not truncate a fractional delay into a one-millisecond-early durable claim', async () => {
    const clock = new FakeClock();
    const discoveryStarts: string[] = [];
    const completions: ObserverCompletion[] = [];
    let delayedFirstCompletion = false;
    const supervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock,
      jobs: definitions({
        'repository-discovery': async () => {
          discoveryStarts.push(clock.wallNow().toISOString());
          return {};
        },
      }),
      onCompleted: (completion) => {
        completions.push(completion);
        if (completion.name === 'repository-discovery' && !delayedFirstCompletion) {
          delayedFirstCompletion = true;
          clock.now += 0.5;
        }
      },
    });

    await supervisor.runStartupDiscovery();
    const durableNextRunAt = completions[0]!.nextRunAt;
    supervisor.startAfterSocket(60_000);

    await clock.advance(299_999);
    expect(discoveryStarts).toEqual([new Date(Date.UTC(2026, 7, 27)).toISOString()]);

    await clock.advance(1);
    expect(discoveryStarts).toEqual([
      new Date(Date.UTC(2026, 7, 27)).toISOString(),
      durableNextRunAt,
    ]);
    await supervisor.stop(100);
  });

  it('waits for the durable wall fence when wall time remains one millisecond behind', async () => {
    const clock = new FakeClock();
    const discoveryStarts: string[] = [];
    const fatals: unknown[] = [];
    let durableNextRunAt: string | undefined;
    const supervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock,
      jobs: definitions(),
      onStarted: (name, at) => {
        if (name !== 'repository-discovery') return;
        if (durableNextRunAt !== undefined && at < durableNextRunAt) {
          throw new Error('daemon_job_claim_rejected');
        }
        discoveryStarts.push(at);
      },
      onCompleted: (completion) => {
        if (completion.name === 'repository-discovery' && durableNextRunAt === undefined) {
          durableNextRunAt = completion.nextRunAt;
        }
      },
      onFatal: (error) => { fatals.push(error); },
    });

    await supervisor.runStartupDiscovery();
    supervisor.startAfterSocket(60_000);
    clock.wallOffsetMs = -1;

    await clock.advance(300_000);
    expect(discoveryStarts).toEqual([new Date(Date.UTC(2026, 7, 27)).toISOString()]);
    expect(fatals).toEqual([]);
    await clock.advance(1);
    expect(discoveryStarts).toEqual([
      new Date(Date.UTC(2026, 7, 27)).toISOString(),
      durableNextRunAt,
    ]);
    expect(fatals).toEqual([]);
    await supervisor.stop(100);
  });

  it('rechecks the exact claim timestamp when wall time falls behind after a timer wake', async () => {
    const clock = new FakeClock();
    const discoveryStarts: string[] = [];
    const fatals: unknown[] = [];
    let durableNextRunAt: string | undefined;
    const supervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock,
      jobs: definitions(),
      onStarted: (name, at) => {
        if (name !== 'repository-discovery') return;
        if (durableNextRunAt !== undefined && at < durableNextRunAt) {
          throw new Error('daemon_job_claim_rejected');
        }
        discoveryStarts.push(at);
      },
      onCompleted: (completion) => {
        if (completion.name === 'repository-discovery' && durableNextRunAt === undefined) {
          durableNextRunAt = completion.nextRunAt;
        }
      },
      onFatal: (error) => { fatals.push(error); },
    });

    await supervisor.runStartupDiscovery();
    supervisor.startAfterSocket(60_000);
    let boundaryReads = 0;
    clock.wallOffsetForRead = (now) => {
      if (now !== 300_000) return 0;
      boundaryReads += 1;
      return boundaryReads === 1 ? 0 : -1;
    };

    await clock.advance(300_000);
    expect(discoveryStarts).toEqual([new Date(Date.UTC(2026, 7, 27)).toISOString()]);
    await clock.advance(1);
    expect(discoveryStarts).toEqual([
      new Date(Date.UTC(2026, 7, 27)).toISOString(),
      new Date(Date.parse(durableNextRunAt!) + 1).toISOString(),
    ]);
    expect(fatals).toEqual([]);
    await supervisor.stop(100);
  });

  it('continues durable failure and jitter buckets after a daemon restart', async () => {
    const clock = new FakeClock();
    const completions: ObserverCompletion[] = [];
    const supervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock, backoffBaseMs: 30_000,
      initialState: {
        'repository-discovery': { consecutiveFailures: 2, executionBucket: 7 },
      },
      jobs: definitions({
        'repository-discovery': async () => {
          throw new ObserverJobFailure('discovery.query_failed');
        },
      }),
      onCompleted: (completion) => { completions.push(completion); },
    });

    await supervisor.runStartupDiscovery();
    expect(completions[0]).toMatchObject({
      name: 'repository-discovery', consecutiveFailures: 3, nextDelayMs: 120_000,
    });
    expect(await supervisor.stop(100)).toBe(true);
  });

  it('aborts a timed-out child and drains an active job during shutdown', async () => {
    const clock = new FakeClock();
    const completions: ObserverCompletion[] = [];
    let aborted = 0;
    const supervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock,
      jobs: definitions({
        'repository-discovery': async (signal) => await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); },
            { once: true });
        }),
      }),
      onCompleted: (completion) => { completions.push(completion); },
    });

    const startup = supervisor.runStartupDiscovery();
    await flush();
    await clock.advance(30_000);
    await startup;
    expect(aborted).toBe(1);
    expect(completions[0]).toMatchObject({
      name: 'repository-discovery', status: 'failed', errorCode: 'scheduler.timeout',
    });

    supervisor.startAfterSocket(60_000);
    await flush();
    expect(await supervisor.stop(100)).toBe(true);
  });

  it('reports a hard drain timeout when an injected child ignores abort', async () => {
    const clock = new FakeClock();
    const observed: { signal?: AbortSignal } = {};
    const supervisor = new ObserverSupervisor({
      installationSeed: 'installation-a', jitterRatio: 0, clock,
      jobs: definitions({
        'repository-discovery': async (received) => {
          observed.signal = received;
          return await new Promise(() => undefined);
        },
      }),
    });

    void supervisor.runStartupDiscovery();
    await flush();
    const stopping = supervisor.stop(100);
    expect(observed.signal?.aborted).toBe(true);
    await clock.advance(100);
    expect(await stopping).toBe(false);
    expect(supervisor.snapshot()).toMatchObject({ accepting: false, due: [] });
  });
});
