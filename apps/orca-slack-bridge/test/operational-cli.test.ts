import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { OPERATIONAL_LOG_FILE } from '../src/operational/logger.js';
import {
  fingerprintOperationalBuild,
  fingerprintOperationalConfig,
  OPERATIONAL_JOB_NAMES,
} from '../src/operational/status.js';
import { parseConfig } from '../src/project/config.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

let dir: string;
let stdout: string[];
let stderr: string[];
const BUILD = 'release-private-value';
const config = parseConfig({
  slack: null,
  projects: [{ name: 'Private Project', repositories: ['private-owner/private-repo'] }],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-operational-cli-'));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((value: string | Uint8Array) => {
    stdout.push(String(value));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((value: string | Uint8Array) => {
    stderr.push(String(value));
    return true;
  }) as typeof process.stderr.write);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('status/logs CLI wiring', () => {
  it('runs status before the ordinary config-loading path and returns the projected exit code', async () => {
    const statePath = join(dir, 'state.db');
    const store = new SqliteDigestStore(statePath);
    store.recordDaemonStart({
      instanceId: 'instance-private-id',
      buildFingerprint: fingerprintOperationalBuild(BUILD),
      configFingerprint: fingerprintOperationalConfig(config),
      at: '2026-08-26T00:00:00.000Z',
    });
    for (const job of OPERATIONAL_JOB_NAMES) {
      const claim = store.startDaemonJob(job, '2026-08-26T00:00:00.000Z');
      if (claim === null) throw new Error('expected claim');
      store.completeDaemonJobSuccess({
        claim,
        at: '2026-08-26T00:00:01.000Z',
        durationMs: 1,
        nextRunAt: '2026-08-26T00:15:00.000Z',
      });
    }
    store.close();

    const code = await main([
      'status', '--json', '--state', statePath, '--log-dir', dir,
    ], {
      status: {
        config,
        expectedBuildIdentity: BUILD,
        clock: () => new Date('2026-08-26T00:00:30.000Z'),
      },
    });
    expect(code).toBe(0);
    const output = stdout.join('');
    expect(JSON.parse(output)).toMatchObject({ overall: 'healthy', exitCode: 0 });
    expect(output).not.toContain('instance-private-id');
    expect(output).not.toContain(statePath);
    expect(stderr).toEqual([]);
  });

  it('runs logs without loading config and outputs only reserialized safe records', async () => {
    const safe = {
      ts: '2026-08-26T00:00:00.000Z', level: 'info', service: 'orca-slack-bridge',
      schemaVersion: 16, build: 'a'.repeat(12), event: 'job.succeeded',
      job: 'pr-digest', outcome: 'succeeded', attempt: 1,
    };
    const rawSecret = 'SENTINEL_RAW_BODY';
    writeFileSync(join(dir, OPERATIONAL_LOG_FILE),
      `${JSON.stringify(safe)}\n${JSON.stringify({ ...safe, body: rawSecret })}\n`);

    const code = await main(['logs', '--tail', '2', '--log-dir', dir]);
    expect(code).toBe(0);
    const records = stdout.join('').trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toMatchObject([
      { event: 'job.succeeded', job: 'pr-digest' },
      { event: 'log.corrupt_line', errorCode: 'validation.failed' },
    ]);
    expect(stdout.join('')).not.toContain(rawSecret);
    expect(stderr).toEqual([]);
  });

  it('returns static operational errors rather than private path exceptions', async () => {
    const privatePath = join(dir, 'SENTINEL-private-state.db');
    const code = await main(['status', '--state', privatePath, '--log-dir', dir], {
      status: { config, expectedBuildIdentity: BUILD },
    });
    expect(code).toBe(2);
    expect(stdout.join('')).toContain('schema.absent');
    expect(stdout.join('')).not.toContain('SENTINEL');
    expect(stderr).toEqual([]);
  });

  it('wires follow cancellation to a signal and exits successfully', async () => {
    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), 25);
    try {
      const code = await main(['logs', '--follow', '--tail', '1', '--log-dir', dir], {
        logs: { signal: controller.signal, pollMilliseconds: 10 },
      });
      expect(code).toBe(0);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([]);
    } finally {
      clearTimeout(stop);
      controller.abort();
    }
  });
});
