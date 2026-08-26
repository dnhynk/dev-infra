import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  followOperationalLogs,
  formatOperationalLogRecord,
  readOperationalLogTail,
} from '../src/operational/logs.js';
import {
  MAX_OPERATIONAL_LOG_BACKUPS,
  MAX_OPERATIONAL_LOG_LINE_BYTES,
  OPERATIONAL_LOG_FILE,
  type OperationalLogRecord,
} from '../src/operational/logger.js';

let dir: string;
let current: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-operational-reader-'));
  current = join(dir, OPERATIONAL_LOG_FILE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(index: number, job: 'pr-digest' | 'run-observer' = 'pr-digest'): OperationalLogRecord {
  return {
    ts: new Date(Date.UTC(2026, 7, 26, 0, 0, index)).toISOString(),
    level: 'info',
    service: 'orca-slack-bridge',
    schemaVersion: 13,
    build: 'a'.repeat(12),
    event: 'job.succeeded',
    job,
    outcome: 'succeeded',
    attempt: index + 1,
    durationMs: index,
    counts: { processed: index },
  };
}

function lines(...records: readonly OperationalLogRecord[]): string {
  return records.map((value) => `${JSON.stringify(value)}\n`).join('');
}

function compactRecord(index: number): OperationalLogRecord {
  return {
    ts: new Date(Date.UTC(2026, 7, 26, 1, 0, index)).toISOString(),
    level: 'info',
    service: 'orca-slack-bridge',
    schemaVersion: 13,
    build: 'b'.repeat(12),
    event: 'daemon.heartbeat',
    attempt: index + 1,
  };
}

function rotateCurrent(next: OperationalLogRecord, backupLimit: number): void {
  for (let generation = backupLimit; generation >= 2; generation -= 1) {
    const from = `${current}.${generation - 1}`;
    if (existsSync(from)) renameSync(from, `${current}.${generation}`);
  }
  renameSync(current, `${current}.1`);
  writeFileSync(current, lines(next));
}

async function nextWithin(
  iterator: AsyncGenerator<OperationalLogRecord>,
  milliseconds = 2_000,
): Promise<IteratorResult<OperationalLogRecord>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('follow timeout')), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

describe('rotated read-only tail', () => {
  it('tails current plus numbered backups in chronological order without modifying the chain', async () => {
    writeFileSync(`${current}.2`, lines(record(0), record(1)));
    writeFileSync(`${current}.1`, lines(record(2), record(3)));
    writeFileSync(current, lines(record(4), record(5)));
    const paths = [`${current}.2`, `${current}.1`, current];
    const before = paths.map((path) => ({
      path,
      bytes: readFileSync(path),
      modified: statSync(path).mtimeMs,
    }));

    const result = await readOperationalLogTail({ logDir: dir, tail: 4 });
    expect(result.map((value) => value.attempt)).toEqual([3, 4, 5, 6]);
    for (const snapshot of before) {
      expect(readFileSync(snapshot.path)).toEqual(snapshot.bytes);
      expect(statSync(snapshot.path).mtimeMs).toBe(snapshot.modified);
    }
    expect(existsSync(`${current}.3`)).toBe(false);
  });

  it('filters only from the strictly parsed allowlisted job field across rotations', async () => {
    writeFileSync(`${current}.1`, lines(record(0, 'pr-digest'), record(1, 'run-observer')));
    writeFileSync(current, lines(
      record(2, 'run-observer'),
      record(3, 'pr-digest'),
      record(4, 'run-observer'),
    ));
    const result = await readOperationalLogTail({ logDir: dir, tail: 2, job: 'run-observer' });
    expect(result.map((value) => value.attempt)).toEqual([3, 5]);
    expect(result.every((value) => value.job === 'run-observer')).toBe(true);
  });

  it('returns static diagnostics for corrupt, unknown-field, invalid UTF-8, and oversize lines without echoing raw bytes', async () => {
    const rawSecret = 'SENTINEL_RAW_SECRET_PATH_C:\\private\\worktree';
    const valid = Buffer.from(lines(record(0)));
    const corrupt = Buffer.from(`{"body":"${rawSecret}"}\n`, 'utf8');
    const unknown = Buffer.from(`${JSON.stringify({ ...record(1), token: rawSecret })}\n`, 'utf8');
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x0a]);
    const oversize = Buffer.from(`${rawSecret}${'x'.repeat(MAX_OPERATIONAL_LOG_LINE_BYTES + 100)}\n`, 'utf8');
    writeFileSync(current, Buffer.concat([valid, corrupt, unknown, invalidUtf8, oversize]));
    const original = readFileSync(current);

    const result = await readOperationalLogTail({ logDir: dir, tail: 10 });
    expect(result.map((value) => value.event)).toEqual([
      'job.succeeded',
      'log.corrupt_line',
      'log.corrupt_line',
      'log.corrupt_line',
      'log.oversize_line',
    ]);
    const output = result.map(formatOperationalLogRecord).join('\n');
    expect(output).not.toContain(rawSecret);
    expect(output).not.toContain('token');
    expect(readFileSync(current)).toEqual(original);
    for (const line of output.split('\n')) {
      expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(MAX_OPERATIONAL_LOG_LINE_BYTES);
    }
  });

  it('diagnoses every leading, internal, and trailing blank physical record across rotations', async () => {
    writeFileSync(`${current}.1`, `\n${lines(record(0))}\n`);
    writeFileSync(current, `\n${lines(record(1))}`);
    const original = [readFileSync(`${current}.1`), readFileSync(current)];

    const result = await readOperationalLogTail({ logDir: dir, tail: 10 });
    expect(result.map((value) => value.event)).toEqual([
      'log.corrupt_line',
      'job.succeeded',
      'log.corrupt_line',
      'log.corrupt_line',
      'job.succeeded',
    ]);
    expect(result.filter((value) => value.event === 'log.corrupt_line')).toHaveLength(3);
    expect(readFileSync(`${current}.1`)).toEqual(original[0]);
    expect(readFileSync(current)).toEqual(original[1]);
  });

  it('diagnoses one blank record whose adjacent delimiters straddle a reverse-read chunk', async () => {
    const chunk = 64 * 1024;
    writeFileSync(current, Buffer.concat([
      Buffer.alloc(chunk - 1, 0x78),
      Buffer.from('\n\n'),
      Buffer.alloc(chunk - 1, 0x79),
    ]));
    const result = await readOperationalLogTail({ logDir: dir, tail: 10 });
    expect(result.map((value) => value.event)).toEqual([
      'log.oversize_line', 'log.corrupt_line', 'log.oversize_line',
    ]);
  });

  it('validates bounds and treats an absent chain as an empty successful tail', async () => {
    await expect(readOperationalLogTail({ logDir: dir, tail: 0 })).rejects.toThrow('logs.tail_invalid');
    await expect(readOperationalLogTail({ logDir: dir, tail: 5_001 })).rejects.toThrow('logs.tail_invalid');
    await expect(readOperationalLogTail({
      logDir: dir,
      tail: 1,
      job: 'private-job' as 'pr-digest',
    })).rejects.toThrow('logs.job_invalid');
    expect(await readOperationalLogTail({ logDir: dir })).toEqual([]);
    expect(existsSync(current)).toBe(false);
  });
});

describe('follow rotation, truncation, and signal', () => {
  it('does not emit the initial tail when already aborted', async () => {
    writeFileSync(current, lines(record(0)));
    const controller = new AbortController();
    controller.abort();
    const iterator = followOperationalLogs({
      logDir: dir, tail: 1, signal: controller.signal, pollMilliseconds: 10,
    });
    expect(await nextWithin(iterator)).toMatchObject({ done: true });
  });

  it('hands an append after initial size capture to follow exactly once', async () => {
    writeFileSync(current, lines(record(0)));
    const controller = new AbortController();
    let hookCalls = 0;
    const iterator = followOperationalLogs({
      logDir: dir,
      tail: 1,
      signal: controller.signal,
      pollMilliseconds: 10,
      afterInitialSnapshot: () => {
        hookCalls += 1;
        appendFileSync(current, lines(record(1)));
      },
    });
    try {
      expect((await nextWithin(iterator)).value?.attempt).toBe(1);
      expect((await nextWithin(iterator)).value?.attempt).toBe(2);
      appendFileSync(current, lines(record(2)));
      expect((await nextWithin(iterator)).value?.attempt).toBe(3);
      expect(hookCalls).toBe(1);
      controller.abort();
      expect((await nextWithin(iterator)).done).toBe(true);
    } finally {
      controller.abort();
      await iterator.return(undefined);
    }
  });

  it('drains two rotations between polls in chronological order exactly once', async () => {
    writeFileSync(current, lines(record(0)));
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir, tail: 1, backupLimit: 2, signal: controller.signal, pollMilliseconds: 10,
    });
    try {
      expect((await nextWithin(iterator)).value?.attempt).toBe(1);
      rotateCurrent(record(1), 2);
      rotateCurrent(record(2), 2);
      expect((await nextWithin(iterator)).value?.attempt).toBe(2);
      expect((await nextWithin(iterator)).value?.attempt).toBe(3);
      controller.abort();
      expect((await nextWithin(iterator)).done).toBe(true);
    } finally {
      controller.abort();
      await iterator.return(undefined);
    }
  });

  it('drains the maximum supported retained rotation chain exactly once', async () => {
    writeFileSync(current, lines(record(0)));
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir,
      tail: 1,
      backupLimit: MAX_OPERATIONAL_LOG_BACKUPS,
      signal: controller.signal,
      pollMilliseconds: 10,
    });
    try {
      expect((await nextWithin(iterator)).value?.attempt).toBe(1);
      for (let index = 1; index <= MAX_OPERATIONAL_LOG_BACKUPS; index += 1) {
        rotateCurrent(record(index), MAX_OPERATIONAL_LOG_BACKUPS);
      }
      const followed: number[] = [];
      for (let index = 0; index < MAX_OPERATIONAL_LOG_BACKUPS; index += 1) {
        followed.push((await nextWithin(iterator)).value?.attempt as number);
      }
      expect(followed).toEqual(Array.from(
        { length: MAX_OPERATIONAL_LOG_BACKUPS },
        (_unused, index) => index + 2,
      ));
      controller.abort();
      expect((await nextWithin(iterator)).done).toBe(true);
    } finally {
      controller.abort();
      await iterator.return(undefined);
    }
  });

  it.each([
    ['smaller', [compactRecord(1)]],
    ['equal', [record(1)]],
    ['larger', [record(1), record(2), record(3)]],
  ] as const)('detects same-inode %s truncate/rewrite with controlled timestamps', async (_case, replacement) => {
    writeFileSync(current, lines(record(0)));
    const fixed = new Date('2026-08-26T02:00:00.000Z');
    utimesSync(current, fixed, fixed);
    const initialIdentity = `${String(statSync(current).dev)}:${String(statSync(current).ino)}`;
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir, tail: 1, signal: controller.signal, pollMilliseconds: 10,
    });
    try {
      expect((await nextWithin(iterator)).value?.attempt).toBe(1);
      writeFileSync(current, lines(...replacement));
      utimesSync(current, fixed, fixed);
      expect(`${String(statSync(current).dev)}:${String(statSync(current).ino)}`).toBe(initialIdentity);
      for (const expected of replacement) {
        expect((await nextWithin(iterator)).value?.attempt).toBe(expected.attempt);
      }
      controller.abort();
      expect((await nextWithin(iterator)).done).toBe(true);
    } finally {
      controller.abort();
      await iterator.return(undefined);
    }
  });

  it('does not duplicate a retained prefix when truncate/rewrite grows past the cursor', async () => {
    writeFileSync(current, lines(record(0)));
    const fixed = new Date('2026-08-26T02:00:00.000Z');
    utimesSync(current, fixed, fixed);
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir, tail: 1, signal: controller.signal, pollMilliseconds: 10,
    });
    try {
      expect((await nextWithin(iterator)).value?.attempt).toBe(1);
      writeFileSync(current, lines(record(0), record(1), record(2)));
      utimesSync(current, fixed, fixed);
      expect((await nextWithin(iterator)).value?.attempt).toBe(2);
      expect((await nextWithin(iterator)).value?.attempt).toBe(3);
      controller.abort();
      expect((await nextWithin(iterator)).done).toBe(true);
    } finally {
      controller.abort();
      await iterator.return(undefined);
    }
  });

  it('emits one static diagnostic for each followed blank record across a rotation', async () => {
    writeFileSync(current, lines(record(0)));
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir, tail: 1, signal: controller.signal, pollMilliseconds: 10,
    });
    try {
      expect((await nextWithin(iterator)).value?.attempt).toBe(1);
      rotateCurrent(compactRecord(1), 2);
      writeFileSync(`${current}.1`, '\n\n');
      const first = await nextWithin(iterator);
      const second = await nextWithin(iterator);
      const third = await nextWithin(iterator);
      expect([first.value?.event, second.value?.event, third.value?.event]).toEqual([
        'log.corrupt_line', 'log.corrupt_line', 'daemon.heartbeat',
      ]);
      controller.abort();
      expect((await nextWithin(iterator)).done).toBe(true);
    } finally {
      controller.abort();
      await iterator.return(undefined);
    }
  });

  it('emits initial tail, append, truncation replacement, and rotated current, then exits on abort', async () => {
    writeFileSync(current, lines(record(0)));
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir,
      tail: 1,
      signal: controller.signal,
      pollMilliseconds: 10,
    });
    try {
      expect((await nextWithin(iterator)).value?.attempt).toBe(1);

      appendFileSync(current, lines(record(1)));
      expect((await nextWithin(iterator)).value?.attempt).toBe(2);

      writeFileSync(current, lines(record(2)));
      expect((await nextWithin(iterator)).value?.attempt).toBe(3);

      renameSync(current, `${current}.1`);
      writeFileSync(current, lines(record(3)));
      expect((await nextWithin(iterator)).value?.attempt).toBe(4);

      controller.abort();
      expect((await nextWithin(iterator)).done).toBe(true);
    } finally {
      controller.abort();
      await iterator.return(undefined);
    }
  });

  it('buffers a partial append until LF and applies the job filter during follow', async () => {
    writeFileSync(current, lines(record(0, 'run-observer')));
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir,
      tail: 1,
      job: 'pr-digest',
      signal: controller.signal,
      pollMilliseconds: 10,
    });
    try {
      const encoded = JSON.stringify(record(1, 'pr-digest'));
      appendFileSync(current, encoded.slice(0, Math.floor(encoded.length / 2)));
      await new Promise((resolve) => setTimeout(resolve, 30));
      appendFileSync(current, `${encoded.slice(Math.floor(encoded.length / 2))}\n`);
      const followed = await nextWithin(iterator);
      expect(followed.value).toMatchObject({ job: 'pr-digest', attempt: 2 });
      controller.abort();
      expect((await nextWithin(iterator)).done).toBe(true);
    } finally {
      controller.abort();
      await iterator.return(undefined);
    }
  });
});
