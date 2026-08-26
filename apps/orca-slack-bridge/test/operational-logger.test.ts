import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_OPERATIONAL_LOG_LINE_BYTES,
  OPERATIONAL_COUNT_FIELDS,
  OPERATIONAL_LOG_FILE,
  OperationalNdjsonLogger,
  entityRef,
  parseOperationalLogLine,
  type LoggerFailureNotice,
  type OperationalLogHandle,
  type OperationalLoggerFileSystem,
} from '../src/operational/logger.js';

let dir: string;
const AT = new Date('2026-08-26T00:00:00.000Z');

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orca-operational-log-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function logPath(): string {
  return join(dir, OPERATIONAL_LOG_FILE);
}

function rawLines(path = logPath()): readonly string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '');
}

describe('allowlist-only redacted operational logger', () => {
  it('hashes identities and never serializes secret/path/ID/payload corpus or raw Error objects', async () => {
    const sentinels = [
      ['xoxb', 'SENTINEL', 'TOKEN'].join('-'),
      'Bearer SENTINEL-AUTHORIZATION',
      'cookie=SENTINEL-COOKIE',
      'password=SENTINEL-PASSWORD',
      'C:\\Users\\private\\repo\\secret.txt',
      '/home/private/worktree/secret.txt',
      'https://github.com/private/repository?token=SENTINEL',
      'U012RAWID',
      'T012RAWID',
      'C012RAWID',
      'gate_raw_identifier',
      'dispatch_raw_identifier',
      'raw\nbody\u0000control',
    ];
    const stderr: string[] = [];
    const logger = await OperationalNdjsonLogger.create({
      logDir: dir,
      buildIdentity: `release:${sentinels.join('|')}`,
      clock: () => AT,
      stderr: (code) => stderr.push(code),
    });

    await logger.log({
      level: 'info', event: 'job.succeeded', job: 'pr-digest', outcome: 'succeeded',
      attempt: 2, durationMs: 42, nextRunAt: '2026-08-26T00:15:00Z',
      counts: { processed: 3, deferred: 1 }, entityRef: entityRef(sentinels[7] as string),
    });
    for (const sentinel of sentinels) {
      await logger.log({
        level: 'error', event: 'job.failed', token: sentinel, authorization: sentinel,
        cookie: sentinel, secret: sentinel, password: sentinel, payload: { body: sentinel },
        options: [sentinel], path: sentinel, id: sentinel, error: new Error(sentinel),
      });
    }
    await logger.log(new Error(sentinels[0]));
    await logger.close();

    const raw = readFileSync(logPath(), 'utf8');
    for (const sentinel of sentinels) expect(raw).not.toContain(sentinel);
    expect(raw).not.toContain('Error');
    expect(stderr).toEqual([]);
    const records = rawLines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      event: 'job.succeeded', job: 'pr-digest', counts: { processed: 3, deferred: 1 },
    });
    expect(records[0]?.['entityRef']).toMatch(/^[0-9a-f]{12}$/);
    expect(records.slice(1).every((record) =>
      record['event'] === 'telemetry.rejected' && record['errorCode'] === 'validation.failed')).toBe(true);
    for (const line of rawLines()) {
      expect(Buffer.byteLength(`${line}\n`, 'utf8')).toBeLessThanOrEqual(MAX_OPERATIONAL_LOG_LINE_BYTES);
      expect(parseOperationalLogLine(line)).not.toBeNull();
      expect(Object.keys(JSON.parse(line) as object).every((key) => [
        'ts', 'level', 'service', 'schemaVersion', 'build', 'event', 'job', 'outcome', 'attempt',
        'durationMs', 'nextRunAt', 'errorCode', 'retryable', 'counts', 'entityRef',
      ].includes(key))).toBe(true);
    }
  });

  it('fuzzes hostile key/value shapes into a single bounded static rejection shape', async () => {
    const logger = await OperationalNdjsonLogger.create({ logDir: dir, buildIdentity: 'build', clock: () => AT });
    const hostileKeys = ['token', 'authorization', 'cookie', 'secret', 'password', 'body', 'options', 'url', 'path'];
    for (let index = 0; index < 250; index += 1) {
      const key = hostileKeys[index % hostileKeys.length] as string;
      await logger.log({
        level: index % 2 === 0 ? 'info' : `info\nSENTINEL_${index}`,
        event: 'daemon.heartbeat',
        [key]: `SENTINEL_${index}_${'x'.repeat(index * 80)}`,
        counts: { [key]: index },
      });
    }
    await logger.close();
    const lines = rawLines();
    expect(lines).toHaveLength(250);
    for (const [index, line] of lines.entries()) {
      expect(line).not.toContain(`SENTINEL_${index}`);
      expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(MAX_OPERATIONAL_LOG_LINE_BYTES);
      expect(parseOperationalLogLine(line)).toMatchObject({
        event: 'telemetry.rejected', errorCode: 'validation.failed', retryable: false,
      });
    }
  });

  it('accepts only bounded allowlisted count names and canonical parsed records', async () => {
    const logger = await OperationalNdjsonLogger.create({ logDir: dir, buildIdentity: 'build', clock: () => AT });
    await logger.log({
      level: 'info', event: 'registry.changed', outcome: 'healthy',
      counts: Object.fromEntries(OPERATIONAL_COUNT_FIELDS.map((field, index) => [field, index])),
    });
    await logger.log({
      level: 'info', event: 'registry.changed', counts: { active: 1_000_000_001 },
    });
    await logger.close();
    expect(parseOperationalLogLine(rawLines()[0] as string)?.counts).toEqual({
      active: 0, pending: 1, rejected: 2, deferred: 3, processed: 4,
      succeeded: 5, failed: 6, uncertain: 7, dead: 8, total: 9,
    });
    expect(parseOperationalLogLine(rawLines()[1] as string)?.event).toBe('telemetry.rejected');
  });

  it('flushes already accepted writes on close and rejects later writes without touching the file', async () => {
    const logger = await OperationalNdjsonLogger.create({ logDir: dir, buildIdentity: 'build', clock: () => AT });
    const accepted = Array.from({ length: 20 }, () =>
      logger.log({ level: 'info', event: 'daemon.heartbeat', outcome: 'healthy' }));
    await logger.close();
    expect(await Promise.all(accepted)).toEqual(Array.from({ length: 20 }, () => ({ ok: true })));
    expect(rawLines()).toHaveLength(20);
    const bytes = readFileSync(logPath()).byteLength;
    expect(await logger.log({ level: 'info', event: 'daemon.heartbeat' })).toEqual({
      ok: false, errorCode: 'logger.write_failed',
    });
    expect(readFileSync(logPath()).byteLength).toBe(bytes);
  });
});

describe('rotation, retention, restart, and Windows rename seam', () => {
  it('rotates only when the next complete line crosses 1 MiB, retains two backups, and resumes size on restart', async () => {
    const options = {
      logDir: dir, buildIdentity: 'build', maxFileMiB: 1, backupCount: 2, clock: () => AT,
    } as const;
    let logger = await OperationalNdjsonLogger.create(options);
    const input = { level: 'info', event: 'daemon.heartbeat', outcome: 'healthy' } as const;
    await logger.log(input);
    const lineBytes = Buffer.byteLength(readFileSync(logPath(), 'utf8'));
    const linesAtBoundary = Math.floor((1024 * 1024) / lineBytes);
    for (let index = 1; index < linesAtBoundary; index += 1) await logger.log(input);
    expect(readFileSync(logPath()).byteLength).toBe(linesAtBoundary * lineBytes);
    expect(readFileSync(logPath()).byteLength + lineBytes).toBeGreaterThan(1024 * 1024);

    writeFileSync(`${logPath()}.1`, 'old-one\n');
    writeFileSync(`${logPath()}.2`, 'old-two\n');
    await logger.log(input);
    expect(readFileSync(`${logPath()}.1`).byteLength).toBe(linesAtBoundary * lineBytes);
    expect(readFileSync(`${logPath()}.2`, 'utf8')).toBe('old-one\n');
    expect(readFileSync(logPath()).byteLength).toBe(lineBytes);
    await logger.close();

    writeFileSync(`${logPath()}.3`, 'stale-after-config-reduction\n');
    logger = await OperationalNdjsonLogger.create(options);
    expect(() => readFileSync(`${logPath()}.3`)).toThrow();
    await logger.log(input);
    await logger.close();
    expect(readFileSync(logPath()).byteLength).toBe(lineBytes * 2);
    expect(() => readFileSync(`${logPath()}.3`)).toThrow();
  }, 30_000);

  it('closes the handle before rename and retries bounded Windows sharing errors', async () => {
    let firstHandleClosed = false;
    let renameAttempts = 0;
    const delays: number[] = [];
    const handles: OperationalLogHandle[] = [];
    const fakeFs: OperationalLoggerFileSystem = {
      mkdir: () => Promise.resolve(),
      open: (_path, flags) => {
        const first = flags === 'a';
        const handle: OperationalLogHandle = {
          stat: () => Promise.resolve({ size: first ? 1024 * 1024 : 0 }),
          writeFile: () => Promise.resolve(),
          close: () => { if (first) firstHandleClosed = true; return Promise.resolve(); },
        };
        handles.push(handle);
        return Promise.resolve(handle);
      },
      remove: () => Promise.resolve(),
      rename: () => {
        expect(firstHandleClosed).toBe(true);
        renameAttempts += 1;
        if (renameAttempts < 3) return Promise.reject(Object.assign(new Error('private'), { code: 'EPERM' }));
        return Promise.resolve();
      },
    };
    const logger = await OperationalNdjsonLogger.create({
      logDir: dir, buildIdentity: 'build', maxFileMiB: 1, backupCount: 1,
      fileSystem: fakeFs, delay: (milliseconds) => { delays.push(milliseconds); return Promise.resolve(); },
      stderr: () => { throw new Error('unexpected logger failure'); },
    });
    expect(await logger.log({ level: 'info', event: 'daemon.heartbeat' })).toEqual({ ok: true });
    await logger.close();
    expect(renameAttempts).toBe(3);
    expect(delays).toEqual([10, 20]);
    expect(handles).toHaveLength(2);
  });

  it('never attempts a Windows rename when closing the active handle fails', async () => {
    let renames = 0;
    const stderr: string[] = [];
    const fakeFs: OperationalLoggerFileSystem = {
      mkdir: () => Promise.resolve(),
      open: () => Promise.resolve({
        stat: () => Promise.resolve({ size: 1024 * 1024 }),
        writeFile: () => Promise.resolve(),
        close: () => Promise.reject(new Error('SENTINEL_CLOSE_DETAIL')),
      }),
      remove: () => Promise.resolve(),
      rename: () => { renames += 1; return Promise.resolve(); },
    };
    const logger = await OperationalNdjsonLogger.create({
      logDir: dir, buildIdentity: 'build', maxFileMiB: 1, backupCount: 1,
      fileSystem: fakeFs, stderr: (code) => stderr.push(code),
    });
    expect(await logger.log({ level: 'info', event: 'daemon.heartbeat' })).toEqual({
      ok: false, errorCode: 'logger.write_failed',
    });
    await logger.close();
    expect(renames).toBe(0);
    expect(stderr).toEqual(['logger.write_failed']);
    expect(JSON.stringify(stderr)).not.toContain('SENTINEL');
  });

  it('validates configurable O1 bounds before touching the filesystem', async () => {
    await expect(OperationalNdjsonLogger.create({ logDir: dir, buildIdentity: 'b', maxFileMiB: 0 })).rejects
      .toThrow('validation.failed');
    await expect(OperationalNdjsonLogger.create({ logDir: dir, buildIdentity: 'b', maxFileMiB: 101 })).rejects
      .toThrow('validation.failed');
    await expect(OperationalNdjsonLogger.create({ logDir: dir, buildIdentity: 'b', backupCount: 0 })).rejects
      .toThrow('validation.failed');
    await expect(OperationalNdjsonLogger.create({ logDir: dir, buildIdentity: 'b', backupCount: 21 })).rejects
      .toThrow('validation.failed');
  });
});

describe('logger failure boundary', () => {
  it('uses bounded open recovery, reports only the static code, and marks consecutive failure fatal', async () => {
    const stderr: string[] = [];
    const notices: LoggerFailureNotice[] = [];
    let opens = 0;
    const fs: OperationalLoggerFileSystem = {
      mkdir: () => Promise.resolve(),
      open: () => { opens += 1; return Promise.reject(new Error('SENTINEL_PRIVATE_PATH')); },
      rename: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const logger = await OperationalNdjsonLogger.create({
      logDir: dir,
      buildIdentity: 'SENTINEL_BUILD_SECRET',
      fileSystem: fs,
      delay: () => Promise.resolve(),
      stderr: (code) => stderr.push(code),
      onFailure: (notice) => { notices.push(notice); },
      clock: () => AT,
    });
    const result = await logger.log({
      level: 'error', event: 'daemon.failed', payload: 'SENTINEL_PAYLOAD_SECRET',
    });
    await logger.close();
    expect(result).toEqual({ ok: false, errorCode: 'logger.write_failed' });
    expect(opens).toBe(4);
    expect(stderr).toEqual(['logger.write_failed', 'logger.write_failed']);
    expect(notices).toEqual([
      { at: AT.toISOString(), errorCode: 'logger.write_failed', fatal: false },
      { at: AT.toISOString(), errorCode: 'logger.write_failed', fatal: true },
    ]);
    expect(JSON.stringify({ stderr, notices })).not.toContain('SENTINEL');
  });
});
