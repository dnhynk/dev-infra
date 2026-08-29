import { createHash } from 'node:crypto';
import type { DaemonJobName, OperationalFailureCode } from '../store/operational-types.js';

export type ObserverJobName = Extract<
  DaemonJobName,
  'repository-discovery' | 'run-observer' | 'gate-reconcile' | 'pr-digest' | 'terminal-prompt'
>;

export type ObserverTimer = ReturnType<typeof setTimeout>;

type ObserverSchedule = {
  readonly monotonicDeadlineMs: number;
  readonly wallDeadlineMs: number;
};

export type ObserverClock = {
  readonly monotonicMs: () => number;
  readonly wallNow: () => Date;
  readonly setTimer: (callback: () => void, milliseconds: number) => ObserverTimer;
  readonly clearTimer: (timer: ObserverTimer) => void;
};

export const SYSTEM_OBSERVER_CLOCK: ObserverClock = {
  monotonicMs: () => performance.now(),
  wallNow: () => new Date(),
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer: (timer) => clearTimeout(timer),
};

export type ObserverJobResult = {
  readonly processedCount?: number;
  readonly deferredCount?: number;
  readonly checkpoint?: number;
};

export class ObserverJobFailure extends Error {
  constructor(
    readonly errorCode: OperationalFailureCode,
    readonly result: ObserverJobResult = {},
    readonly fatal = false,
  ) {
    super(errorCode);
    this.name = 'ObserverJobFailure';
  }
}

export type ObserverJobDefinition = {
  readonly name: ObserverJobName;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly backoffCapMs: number;
  readonly run: (signal: AbortSignal) => Promise<ObserverJobResult>;
};

export type ObserverCompletion = ObserverJobResult & {
  readonly name: ObserverJobName;
  readonly status: 'succeeded' | 'failed';
  readonly errorCode?: OperationalFailureCode;
  readonly durationMs: number;
  readonly consecutiveFailures: number;
  readonly nextDelayMs: number;
  readonly nextRunAt: string;
  readonly retryable: boolean;
};

export type ObserverSupervisorOptions = {
  readonly installationSeed: string;
  readonly jitterRatio: number;
  readonly jobs: readonly ObserverJobDefinition[];
  readonly clock?: ObserverClock;
  readonly backoffBaseMs?: number;
  readonly initialState?: Partial<Record<ObserverJobName, {
    readonly consecutiveFailures?: number;
    readonly executionBucket?: number;
  }>>;
  readonly onStarted?: (name: ObserverJobName, at: string) => void | Promise<void>;
  readonly onCompleted?: (completion: ObserverCompletion) => void | Promise<void>;
  readonly onFatal?: (error: unknown) => void;
};

/**
 * Round-robin selection order.
 *
 * A name marked due but absent here can never be selected, while `ensurePump` re-arms for as long
 * as anything is due — so omitting a schedulable job spins the lane forever rather than delaying it.
 * Every job this supervisor can schedule must appear.
 */
const FAIR_ORDER: readonly ObserverJobName[] = [
  'repository-discovery', 'run-observer', 'gate-reconcile', 'pr-digest', 'terminal-prompt',
];

/**
 * Jobs a supervisor cannot be constructed without.
 *
 * Deliberately not `FAIR_ORDER`: selection order and the construction invariant are different
 * questions. `gate-reconcile` is schedulable but optional, so callers that never wired the Gate
 * plane still build a valid supervisor.
 */
const REQUIRED_JOBS: readonly ObserverJobName[] = [
  'repository-discovery', 'run-observer', 'pr-digest',
];

function finiteMilliseconds(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 10) throw new TypeError(`${name} must be >= 10ms`);
  return Math.trunc(value);
}

function nonnegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

/** Stable installation+job+bucket jitter in the closed interval [-ratio,+ratio]. */
export function deterministicObserverDelay(
  baseMs: number,
  ratio: number,
  installationSeed: string,
  job: ObserverJobName,
  bucket: number,
): number {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 0.25) {
    throw new TypeError('observer jitter ratio must be between 0 and 0.25');
  }
  const digest = createHash('sha256')
    .update(`${installationSeed}\u0000${job}\u0000${bucket}`)
    .digest();
  const sample = digest.readUInt32BE(0) / 0xffff_ffff;
  const multiplier = 1 + (sample * 2 - 1) * ratio;
  return Math.max(10, Math.round(baseMs * multiplier));
}

/** One serial observer lane with coalesced due bits and completion-based schedules. */
export class ObserverSupervisor {
  private readonly clock: ObserverClock;
  private readonly definitions = new Map<ObserverJobName, ObserverJobDefinition>();
  private readonly timers = new Map<ObserverJobName, ObserverTimer>();
  private readonly due = new Set<ObserverJobName>();
  private readonly dueSchedules = new Map<ObserverJobName, ObserverSchedule>();
  private readonly failures = new Map<ObserverJobName, number>();
  private readonly buckets = new Map<ObserverJobName, number>();
  private readonly deferredSchedules = new Map<ObserverJobName, ObserverSchedule>();
  private readonly backoffBaseMs: number;
  private accepting = false;
  private stopped = false;
  private cursor = 0;
  private active: { readonly name: ObserverJobName; readonly abort: AbortController } | null = null;
  private pumpPromise: Promise<void> | null = null;

  constructor(private readonly options: ObserverSupervisorOptions) {
    this.clock = options.clock ?? SYSTEM_OBSERVER_CLOCK;
    this.backoffBaseMs = finiteMilliseconds('backoffBaseMs', options.backoffBaseMs ?? 30_000);
    if (options.installationSeed.trim() === '') throw new TypeError('installationSeed is required');
    if (!Number.isFinite(options.jitterRatio) || options.jitterRatio < 0 ||
        options.jitterRatio > 0.25) {
      throw new TypeError('jitterRatio must be between 0 and 0.25');
    }
    for (const job of options.jobs) {
      if (this.definitions.has(job.name)) throw new TypeError(`duplicate observer job ${job.name}`);
      this.definitions.set(job.name, {
        ...job,
        intervalMs: finiteMilliseconds(`${job.name}.intervalMs`, job.intervalMs),
        timeoutMs: finiteMilliseconds(`${job.name}.timeoutMs`, job.timeoutMs),
        backoffCapMs: finiteMilliseconds(`${job.name}.backoffCapMs`, job.backoffCapMs),
      });
      const initial = options.initialState?.[job.name];
      this.failures.set(job.name, nonnegativeInteger(
        `${job.name}.consecutiveFailures`, initial?.consecutiveFailures ?? 0,
      ));
      this.buckets.set(job.name, nonnegativeInteger(
        `${job.name}.executionBucket`, initial?.executionBucket ?? 0,
      ));
    }
    for (const name of REQUIRED_JOBS) {
      if (!this.definitions.has(name)) throw new TypeError(`missing observer job ${name}`);
    }
  }

  /** Strict startup discovery uses this same lane before Socket ingress is opened. */
  async runStartupDiscovery(): Promise<void> {
    if (this.accepting || this.stopped || this.active !== null) {
      throw new Error('startup discovery ordering violation');
    }
    const work = this.execute('repository-discovery');
    this.pumpPromise = work;
    try {
      await work;
    } finally {
      if (this.pumpPromise === work) this.pumpPromise = null;
    }
  }

  /** Opens recurring scheduling after Socket start, enqueues Runs, and delays the first digest. */
  startAfterSocket(digestDelayMs = 60_000): void {
    if (this.stopped || this.accepting) throw new Error('observer supervisor already started');
    this.accepting = true;
    for (const [name, schedule] of this.deferredSchedules) {
      this.installTimer(name, schedule);
    }
    this.deferredSchedules.clear();
    this.markDue('run-observer');
    // Sweep the durable Gate outbox immediately. Restart-after-death is exactly the case this job
    // owns: an action whose Orca mutation died mid-flight left an intent behind, and waiting one
    // full interval leaves the owner staring at a pressed button for that whole window.
    this.markDue('gate-reconcile');
    const digestDelay = finiteMilliseconds('digestDelayMs', digestDelayMs);
    this.installTimer('pr-digest', {
      wallDeadlineMs: this.clock.wallNow().getTime() + digestDelay,
      monotonicDeadlineMs: this.clock.monotonicMs() + digestDelay,
    });
  }

  markDue(name: ObserverJobName): void {
    if (!this.accepting || this.stopped || !this.definitions.has(name)) return;
    this.dueSchedules.delete(name);
    this.due.add(name);
    this.ensurePump();
  }

  private markScheduledDue(name: ObserverJobName, schedule: ObserverSchedule): void {
    if (!this.accepting || this.stopped || !this.definitions.has(name)) return;
    if (!this.due.has(name)) this.dueSchedules.set(name, schedule);
    this.due.add(name);
    this.ensurePump();
  }

  snapshot(): {
    readonly active: ObserverJobName | null;
    readonly due: readonly ObserverJobName[];
    readonly accepting: boolean;
  } {
    return {
      active: this.active?.name ?? null,
      due: FAIR_ORDER.filter((name) => this.due.has(name)),
      accepting: this.accepting && !this.stopped,
    };
  }

  private ensurePump(): void {
    if (this.pumpPromise !== null || this.stopped) return;
    const pump = this.pump();
    this.pumpPromise = pump;
    void pump.finally(() => {
      if (this.pumpPromise === pump) this.pumpPromise = null;
      if (!this.stopped && this.due.size > 0) this.ensurePump();
    });
  }

  private nextDue(): ObserverJobName | null {
    for (let offset = 0; offset < FAIR_ORDER.length; offset += 1) {
      const index = (this.cursor + offset) % FAIR_ORDER.length;
      const name = FAIR_ORDER[index]!;
      if (!this.due.has(name)) continue;
      this.cursor = (index + 1) % FAIR_ORDER.length;
      this.due.delete(name);
      return name;
    }
    return null;
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const name = this.nextDue();
      if (name === null) return;
      await this.execute(name);
    }
  }

  private async execute(name: ObserverJobName): Promise<void> {
    const dueSchedule = this.dueSchedules.get(name);
    this.dueSchedules.delete(name);
    const startedMono = this.clock.monotonicMs();
    const startedWall = this.clock.wallNow();
    if (dueSchedule !== undefined &&
        (startedMono < dueSchedule.monotonicDeadlineMs ||
         startedWall.getTime() < dueSchedule.wallDeadlineMs)) {
      if (this.accepting && !this.stopped) this.installTimer(name, dueSchedule);
      else if (!this.stopped) this.deferredSchedules.set(name, dueSchedule);
      return;
    }
    const definition = this.definitions.get(name)!;
    const abort = new AbortController();
    this.active = { name, abort };
    const startedAt = startedWall.toISOString();
    let timeout: ObserverTimer | null = this.clock.setTimer(() => abort.abort(), definition.timeoutMs);
    let status: ObserverCompletion['status'] = 'succeeded';
    let result: ObserverJobResult = {};
    let errorCode: OperationalFailureCode | undefined;
    let fatal = false;
    let fatalCause: unknown;
    try {
      try {
        await this.options.onStarted?.(name, startedAt);
      } catch (error) {
        fatal = true;
        fatalCause = error;
        return;
      }
      if (abort.signal.aborted) throw new ObserverJobFailure('scheduler.timeout');
      result = await definition.run(abort.signal);
      if (abort.signal.aborted) throw new ObserverJobFailure('scheduler.timeout', result);
    } catch (error) {
      status = 'failed';
      if (error instanceof ObserverJobFailure) {
        errorCode = error.errorCode;
        result = error.result;
        fatal = error.fatal;
        if (fatal) fatalCause = error;
      } else {
        errorCode = abort.signal.aborted
          ? (this.stopped ? 'scheduler.aborted' : 'scheduler.timeout')
          : 'validation.failed';
      }
    } finally {
      if (timeout !== null) this.clock.clearTimer(timeout);
      timeout = null;
      if (this.active?.name === name) this.active = null;
      if (fatal && status === 'succeeded') {
        this.stopped = true;
        try { this.options.onFatal?.(fatalCause); } catch { /* already fatal */ }
      }
    }

    if (fatal && status === 'succeeded') return;

    const consecutiveFailures = status === 'succeeded'
      ? 0
      : (this.failures.get(name) ?? 0) + 1;
    this.failures.set(name, consecutiveFailures);
    const bucket = (this.buckets.get(name) ?? 0) + 1;
    this.buckets.set(name, bucket);
    const baseDelay = status === 'succeeded'
      ? definition.intervalMs
      : Math.min(definition.backoffCapMs,
        this.backoffBaseMs * 2 ** Math.min(20, consecutiveFailures - 1));
    const nextDelayMs = deterministicObserverDelay(
      baseDelay,
      this.options.jitterRatio,
      this.options.installationSeed,
      name,
      bucket,
    );
    const completedWall = this.clock.wallNow();
    const completedMono = this.clock.monotonicMs();
    const schedule: ObserverSchedule = {
      monotonicDeadlineMs: completedMono + nextDelayMs,
      wallDeadlineMs: completedWall.getTime() + nextDelayMs,
    };
    const completion: ObserverCompletion = {
      name,
      status,
      ...(errorCode === undefined ? {} : { errorCode }),
      durationMs: Math.max(0, Math.round(this.clock.monotonicMs() - startedMono)),
      consecutiveFailures,
      nextDelayMs,
      nextRunAt: new Date(schedule.wallDeadlineMs).toISOString(),
      retryable: !fatal,
      ...result,
    };
    try {
      await this.options.onCompleted?.(completion);
    } catch (error) {
      this.stopped = true;
      this.options.onFatal?.(error);
      return;
    }
    if (fatal) {
      this.stopped = true;
      try { this.options.onFatal?.(fatalCause); } catch { /* already fatal */ }
      return;
    }
    if (this.stopped) return;
    if (this.accepting) this.installTimer(name, schedule);
    else this.deferredSchedules.set(name, schedule);
  }

  private installTimer(name: ObserverJobName, schedule: ObserverSchedule): void {
    const existing = this.timers.get(name);
    if (existing !== undefined) {
      this.clock.clearTimer(existing);
      this.timers.delete(name);
    }
    const delayMs = Math.ceil(Math.max(
      0,
      schedule.monotonicDeadlineMs - this.clock.monotonicMs(),
      schedule.wallDeadlineMs - this.clock.wallNow().getTime(),
    ));
    if (delayMs === 0) {
      this.markScheduledDue(name, schedule);
      return;
    }
    const timer = this.clock.setTimer(() => {
      this.timers.delete(name);
      if (!this.stopped) this.installTimer(name, schedule);
    }, delayMs);
    this.timers.set(name, timer);
  }

  async stop(drainTimeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 10) {
      throw new TypeError('observer drain timeout must be >= 10ms');
    }
    this.stopped = true;
    this.accepting = false;
    this.due.clear();
    this.dueSchedules.clear();
    for (const timer of this.timers.values()) this.clock.clearTimer(timer);
    this.timers.clear();
    this.deferredSchedules.clear();
    this.active?.abort.abort();
    const work = this.pumpPromise;
    if (work === null) return true;
    let timer: ObserverTimer | null = null;
    const timeout = new Promise<false>((resolve) => {
      timer = this.clock.setTimer(() => resolve(false), Math.trunc(drainTimeoutMs));
    });
    const drained = await Promise.race([work.then(() => true), timeout]);
    if (timer !== null) this.clock.clearTimer(timer);
    return drained;
  }
}
