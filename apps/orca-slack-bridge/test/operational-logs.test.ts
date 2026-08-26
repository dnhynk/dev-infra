import { execFileSync } from 'node:child_process';
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
  serializeOperationalLogFileIdentity,
} from '../src/operational/logs.js';
import {
  MAX_OPERATIONAL_LOG_BACKUPS,
  MAX_OPERATIONAL_LOG_LINE_BYTES,
  OPERATIONAL_LOG_FILE,
  type OperationalLogRecord,
} from '../src/operational/logger.js';

let dir: string;
let current: string;

function setExactWindowsBasicTimes(path: string): void {
  const encodedPath = Buffer.from(path, 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ExactBasicTimes {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_BASIC_INFO {
    public long CreationTime;
    public long LastAccessTime;
    public long LastWriteTime;
    public long ChangeTime;
    public uint FileAttributes;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetFileInformationByHandleEx(
    SafeFileHandle file, int informationClass, out FILE_BASIC_INFO information, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetFileInformationByHandle(
    SafeFileHandle file, int informationClass, ref FILE_BASIC_INFO information, uint size);
}
'@
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
$stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, $share)
try {
  $information = New-Object ExactBasicTimes+FILE_BASIC_INFO
  $size = [Runtime.InteropServices.Marshal]::SizeOf($information)
  if (-not [ExactBasicTimes]::GetFileInformationByHandleEx(
      $stream.SafeFileHandle, 0, [ref]$information, $size)) { throw 'get_failed' }
  $fixed = [long]133852608000000000
  $information.CreationTime = $fixed
  $information.LastAccessTime = $fixed
  $information.LastWriteTime = $fixed
  $information.ChangeTime = $fixed
  if (-not [ExactBasicTimes]::SetFileInformationByHandle(
      $stream.SafeFileHandle, 0, [ref]$information, $size)) { throw 'set_failed' }
} finally {
  $stream.Dispose()
}
`;
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { timeout: 5_000, windowsHide: true, stdio: 'pipe' });
}

function setControlledTimes(path: string, fallback: Date): void {
  if (process.platform === 'win32') setExactWindowsBasicTimes(path);
  else utimesSync(path, fallback, fallback);
}

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
      Buffer.from('\n'),
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

  it('serializes exact bigint file identities that collide after Number coercion', () => {
    const first = 9_007_199_255_392_568n;
    const second = first + 1n;
    expect(Number(first)).toBe(Number(second));
    expect(serializeOperationalLogFileIdentity({ dev: 1_315_120_574n, ino: first })).not.toBe(
      serializeOperationalLogFileIdentity({ dev: 1_315_120_574n, ino: second }),
    );
  });

  it.runIf(process.platform === 'win32')(
    'keeps two live NTFS generations whose ordinary numeric identities collide',
    async () => {
      const numeric = new Map<string, { readonly path: string; readonly identity: string }>();
      let collision: {
        readonly first: { readonly path: string; readonly identity: string };
        readonly second: { readonly path: string; readonly identity: string };
      } | null = null;
      for (let index = 0; index < 8_192 && collision === null; index += 1) {
        const path = join(dir, `identity-candidate-${index}`);
        writeFileSync(path, lines(record(index % 10)));
        const info = statSync(path, { bigint: true });
        const numericKey = `${String(Number(info.dev))}:${String(Number(info.ino))}`;
        const exact = serializeOperationalLogFileIdentity(info);
        const prior = numeric.get(numericKey);
        if (prior !== undefined && prior.identity !== exact) {
          collision = { first: prior, second: { path, identity: exact } };
        } else {
          numeric.set(numericKey, { path, identity: exact });
        }
      }
      expect(collision).not.toBeNull();
      const found = collision!;
      writeFileSync(found.first.path, lines(record(0)));
      writeFileSync(found.second.path, lines(record(1)));
      renameSync(found.first.path, `${current}.1`);
      renameSync(found.second.path, current);
      expect((await readOperationalLogTail({ logDir: dir, tail: 2, backupLimit: 1 }))
        .map((value) => value.attempt)).toEqual([1, 2]);
    },
  );

  it('fails closed after bounded retries instead of returning mixed rotation labels', async () => {
    writeFileSync(`${current}.1`, lines(record(0)));
    writeFileSync(current, lines(record(1)));
    let rotations = 0;
    await expect(readOperationalLogTail({
      logDir: dir,
      tail: 2,
      backupLimit: 1,
      afterLogChainCapture: () => {
        rotations += 1;
        rmSync(`${current}.1`, { force: true });
        renameSync(current, `${current}.1`);
        writeFileSync(current, lines(record(rotations + 1)));
      },
    })).rejects.toThrow('logs.read_failed');
    expect(rotations).toBe(3);
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

  it('buffers an initial unterminated physical record until LF and emits it once', async () => {
    writeFileSync(current, JSON.stringify(record(0)));
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir, tail: 1, signal: controller.signal, pollMilliseconds: 10,
    });
    try {
      let settled = false;
      const firstPending = iterator.next().then((value) => {
        settled = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled).toBe(false);

      appendFileSync(current, '\n');
      expect((await firstPending).value).toMatchObject({ event: 'job.succeeded', attempt: 1 });
      appendFileSync(current, lines(record(1)));
      expect((await nextWithin(iterator)).value).toMatchObject({ event: 'job.succeeded', attempt: 2 });
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
    setControlledTimes(current, fixed);
    const initialIdentity = `${String(statSync(current).dev)}:${String(statSync(current).ino)}`;
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir, tail: 1, signal: controller.signal, pollMilliseconds: 10,
    });
    try {
      expect((await nextWithin(iterator)).value?.attempt).toBe(1);
      writeFileSync(current, lines(...replacement));
      setControlledTimes(current, fixed);
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
    setControlledTimes(current, fixed);
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir, tail: 1, signal: controller.signal, pollMilliseconds: 10,
    });
    try {
      expect((await nextWithin(iterator)).value?.attempt).toBe(1);
      writeFileSync(current, lines(record(0), record(1), record(2)));
      setControlledTimes(current, fixed);
      expect((await nextWithin(iterator)).value?.attempt).toBe(2);
      expect((await nextWithin(iterator)).value?.attempt).toBe(3);
      controller.abort();
      expect((await nextWithin(iterator)).done).toBe(true);
    } finally {
      controller.abort();
      await iterator.return(undefined);
    }
  });

  it('hashes the no-growth path so sequential same-size rewrites cannot be skipped', async () => {
    writeFileSync(current, lines(record(0)));
    const fixed = new Date('2026-08-26T02:00:00.000Z');
    setControlledTimes(current, fixed);
    const initial = statSync(current, { bigint: true });
    const controller = new AbortController();
    const iterator = followOperationalLogs({
      logDir: dir, tail: 1, signal: controller.signal, pollMilliseconds: 10,
    });
    try {
      expect((await nextWithin(iterator)).value?.attempt).toBe(1);
      for (const replacement of [record(1), record(2)] as const) {
        writeFileSync(current, lines(replacement));
        setControlledTimes(current, fixed);
        const changed = statSync(current, { bigint: true });
        expect(changed.dev).toBe(initial.dev);
        expect(changed.ino).toBe(initial.ino);
        expect(changed.size).toBe(initial.size);
        expect(changed.mtimeMs).toBe(initial.mtimeMs);
        if (process.platform === 'win32') expect(changed.ctimeNs).toBe(initial.ctimeNs);
        expect((await nextWithin(iterator)).value?.attempt).toBe(replacement.attempt);
      }
      appendFileSync(current, lines(record(3)));
      expect((await nextWithin(iterator)).value?.attempt).toBe(4);
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
