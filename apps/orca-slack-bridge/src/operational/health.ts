import type {
  DaemonHealthRecord,
  DaemonJobClaim,
  DaemonJobCompletion,
  DaemonJobName,
  DaemonJobOutcomeRecord,
  DaemonJobSuccessCompletion,
  DaemonStartInput,
  OperationalFailureCode,
  OperationalStore,
} from '../store/operational-types.js';
import {
  entityRef,
  type OperationalLogInput,
  type OperationalTelemetrySink,
} from './logger.js';

/**
 * Small daemon-facing boundary for O1-5. It owns no timers, scheduling, retries, or process state;
 * it only keeps each explicit O1-2 state transition paired with a redacted history event.
 */
export interface DaemonOperationalHealthWriter {
  daemonStarted(input: DaemonStartInput): Promise<DaemonHealthRecord>;
  daemonHeartbeat(instanceId: string, at: string): Promise<DaemonHealthRecord | null>;
  daemonCleanStopped(instanceId: string, at: string): Promise<DaemonHealthRecord | null>;
  jobStarted(job: DaemonJobName, at: string): Promise<DaemonJobClaim | null>;
  jobSucceeded(input: DaemonJobSuccessCompletion): Promise<DaemonJobOutcomeRecord | null>;
  jobFailed(
    input: DaemonJobCompletion & { readonly errorCode: OperationalFailureCode },
    retryable: boolean,
  ): Promise<DaemonJobOutcomeRecord | null>;
  jobBackoff(
    job: DaemonJobName,
    expectedRevision: number,
    nextRunAt: string,
    at: string,
  ): Promise<DaemonJobOutcomeRecord | null>;
  event(input: OperationalLogInput): Promise<void>;
}

export class OperationalHealthTelemetry implements DaemonOperationalHealthWriter {
  constructor(
    private readonly store: Pick<OperationalStore,
      'recordDaemonStart' | 'recordDaemonHeartbeat' | 'recordDaemonCleanStop' |
      'startDaemonJob' | 'completeDaemonJobSuccess' | 'completeDaemonJobFailure' |
      'scheduleDaemonJobBackoff'>,
    private readonly telemetry: OperationalTelemetrySink,
  ) {}

  async daemonStarted(input: DaemonStartInput): Promise<DaemonHealthRecord> {
    const record = this.store.recordDaemonStart(input);
    await this.event({
      level: 'info', event: 'daemon.started', outcome: 'started',
      entityRef: entityRef(input.instanceId),
    });
    return record;
  }

  async daemonHeartbeat(instanceId: string, at: string): Promise<DaemonHealthRecord | null> {
    const record = this.store.recordDaemonHeartbeat(instanceId, at);
    await this.event(record === null
      ? { level: 'warn', event: 'daemon.failed', outcome: 'rejected', errorCode: 'validation.failed' }
      : { level: 'debug', event: 'daemon.heartbeat', outcome: 'healthy' });
    return record;
  }

  async daemonCleanStopped(instanceId: string, at: string): Promise<DaemonHealthRecord | null> {
    const record = this.store.recordDaemonCleanStop(instanceId, at);
    await this.event(record === null
      ? { level: 'warn', event: 'daemon.failed', outcome: 'rejected', errorCode: 'validation.failed' }
      : { level: 'info', event: 'daemon.stopped', outcome: 'stopped' });
    return record;
  }

  async jobStarted(job: DaemonJobName, at: string): Promise<DaemonJobClaim | null> {
    const claim = this.store.startDaemonJob(job, at);
    if (claim !== null) await this.event({
      level: 'info', event: 'job.started', job, outcome: 'started',
    });
    return claim;
  }

  async jobSucceeded(input: DaemonJobSuccessCompletion): Promise<DaemonJobOutcomeRecord | null> {
    const record = this.store.completeDaemonJobSuccess(input);
    if (record !== null) await this.event({
      level: 'info', event: 'job.succeeded', job: record.jobName, outcome: 'succeeded',
      attempt: record.attempt,
      ...(record.durationMs === null ? {} : { durationMs: record.durationMs }),
      ...(record.nextRunAt === null ? {} : { nextRunAt: record.nextRunAt }),
      counts: { processed: record.processedCount, deferred: record.deferredCount },
    });
    return record;
  }

  async jobFailed(
    input: DaemonJobCompletion & { readonly errorCode: OperationalFailureCode },
    retryable: boolean,
  ): Promise<DaemonJobOutcomeRecord | null> {
    const record = this.store.completeDaemonJobFailure(input);
    if (record !== null) await this.event({
      level: 'error', event: 'job.failed', job: record.jobName, outcome: 'failed',
      attempt: record.attempt,
      ...(record.durationMs === null ? {} : { durationMs: record.durationMs }),
      errorCode: record.errorCode ?? 'validation.failed', retryable,
      counts: { processed: record.processedCount, deferred: record.deferredCount },
    });
    return record;
  }

  async jobBackoff(
    job: DaemonJobName,
    expectedRevision: number,
    nextRunAt: string,
    at: string,
  ): Promise<DaemonJobOutcomeRecord | null> {
    const record = this.store.scheduleDaemonJobBackoff(job, expectedRevision, nextRunAt, at);
    if (record !== null) await this.event({
      level: 'warn', event: 'job.backoff', job, outcome: 'backoff',
      attempt: record.attempt,
      ...(record.nextRunAt === null ? {} : { nextRunAt: record.nextRunAt }),
      ...(record.errorCode === null ? {} : { errorCode: record.errorCode }),
      retryable: true,
    });
    return record;
  }

  async event(input: OperationalLogInput): Promise<void> {
    await this.telemetry.log(input);
  }
}
