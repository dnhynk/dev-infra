import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OperationalHealthTelemetry } from '../src/operational/health.js';
import type { OperationalTelemetrySink } from '../src/operational/logger.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

let dir: string;
let store: SqliteDigestStore;
let observed: unknown[];
const INSTANCE = 'instance-SENTINEL-raw-private-id';
const AT0 = '2026-08-26T00:00:00.000Z';
const AT1 = '2026-08-26T00:00:01.000Z';
const AT2 = '2026-08-26T00:00:02.000Z';
const AT3 = '2026-08-26T00:00:03.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-operational-health-'));
  store = new SqliteDigestStore(join(dir, 'state.db'));
  observed = [];
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function reporter(): OperationalHealthTelemetry {
  const sink: OperationalTelemetrySink = {
    log: (input) => { observed.push(input); return Promise.resolve({ ok: true }); },
    close: () => Promise.resolve(),
  };
  return new OperationalHealthTelemetry(store, sink);
}

describe('O1-5 daemon-facing health/telemetry seam', () => {
  it('pairs explicit O1-2 daemon/job transitions with catalogued redacted events without scheduling', async () => {
    const health = reporter();
    await health.daemonStarted({
      instanceId: INSTANCE, buildFingerprint: 'build-fingerprint',
      configFingerprint: 'config-fingerprint', at: AT0,
    });
    await health.daemonHeartbeat(INSTANCE, AT1);
    const claim = await health.jobStarted('repository-discovery', AT1);
    if (claim === null) throw new Error('expected claim');
    await health.jobSucceeded({
      claim, at: AT2, durationMs: 1_000, processedCount: 4, deferredCount: 1,
      nextRunAt: AT3,
    });
    await health.daemonCleanStopped(INSTANCE, AT3);

    expect(store.readDaemonHealth()).toMatchObject({ state: 'stopped', heartbeatAt: AT3 });
    expect(store.findDaemonJobOutcome('repository-discovery')).toMatchObject({
      state: 'succeeded', processedCount: 4, deferredCount: 1, nextRunAt: AT3,
    });
    expect(observed).toMatchObject([
      { event: 'daemon.started', entityIdentity: expect.any(Object) },
      { event: 'daemon.heartbeat' },
      { event: 'job.started', job: 'repository-discovery' },
      {
        event: 'job.succeeded', job: 'repository-discovery', durationMs: 1_000,
        counts: { processed: 4, deferred: 1 },
      },
      { event: 'daemon.stopped' },
    ]);
    expect(JSON.stringify(observed)).not.toContain(INSTANCE);
    expect(JSON.stringify(observed)).not.toContain('build-fingerprint');
    expect(JSON.stringify(observed)).not.toContain('config-fingerprint');
  });

  it('records failure then backoff with only the finite error code and next-run time', async () => {
    const health = reporter();
    await health.daemonStarted({
      instanceId: INSTANCE, buildFingerprint: 'build', configFingerprint: 'config', at: AT0,
    });
    const claim = await health.jobStarted('pr-digest', AT0);
    if (claim === null) throw new Error('expected claim');
    const failed = await health.jobFailed({
      claim, at: AT1, durationMs: 10, processedCount: 0, deferredCount: 2,
      errorCode: 'github.unavailable',
    }, true);
    if (failed === null) throw new Error('expected failure');
    await health.jobBackoff('pr-digest', failed.revision, AT3, AT2);
    expect(store.findDaemonJobOutcome('pr-digest')).toMatchObject({
      state: 'backoff', errorCode: 'github.unavailable', nextRunAt: AT3,
    });
    expect(observed.slice(-2)).toMatchObject([
      { event: 'job.failed', errorCode: 'github.unavailable', retryable: true },
      { event: 'job.backoff', errorCode: 'github.unavailable', retryable: true, nextRunAt: AT3 },
    ]);
  });
});
