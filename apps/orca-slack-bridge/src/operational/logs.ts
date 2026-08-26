import { open, stat, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { DaemonJobName } from '../store/operational-types.js';
import {
  MAX_OPERATIONAL_LOG_BACKUPS,
  MAX_OPERATIONAL_LOG_LINE_BYTES,
  OPERATIONAL_JOB_NAMES,
  OPERATIONAL_LOG_SERVICE,
  operationalLogPath,
  parseOperationalLogLine,
  type OperationalLogRecord,
} from './logger.js';
import { SCHEMA_VERSION } from '../store/schema.js';

export const DEFAULT_LOG_TAIL = 200;
export const MIN_LOG_TAIL = 1;
export const MAX_LOG_TAIL = 5_000;

const READ_CHUNK_BYTES = 64 * 1024;
const DIAGNOSTIC_BUILD = '000000000000';

export type ReadOperationalLogsOptions = {
  readonly logDir: string;
  readonly tail?: number;
  readonly job?: DaemonJobName | null;
  readonly backupLimit?: number;
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
};

export type FollowOperationalLogsOptions = ReadOperationalLogsOptions & {
  readonly signal: AbortSignal;
  readonly pollMilliseconds?: number;
};

type ReverseLine =
  | { readonly kind: 'line'; readonly bytes: Uint8Array }
  | { readonly kind: 'oversize' };

function validateOptions(options: ReadOperationalLogsOptions): {
  readonly tail: number;
  readonly job: DaemonJobName | null;
  readonly backupLimit: number;
  readonly clock: () => Date;
} {
  const tail = options.tail ?? DEFAULT_LOG_TAIL;
  if (!Number.isSafeInteger(tail) || tail < MIN_LOG_TAIL || tail > MAX_LOG_TAIL) {
    throw new TypeError('logs.tail_invalid');
  }
  const job = options.job ?? null;
  if (job !== null && !(OPERATIONAL_JOB_NAMES as readonly string[]).includes(job)) {
    throw new TypeError('logs.job_invalid');
  }
  const backupLimit = options.backupLimit ?? MAX_OPERATIONAL_LOG_BACKUPS;
  if (!Number.isSafeInteger(backupLimit) || backupLimit < 1 || backupLimit > MAX_OPERATIONAL_LOG_BACKUPS) {
    throw new TypeError('logs.backup_invalid');
  }
  return { tail, job, backupLimit, clock: options.clock ?? (() => new Date()) };
}

function safeNow(clock: () => Date): string {
  try {
    const value = clock();
    return Number.isFinite(value.getTime()) ? value.toISOString() : '1970-01-01T00:00:00.000Z';
  } catch {
    return '1970-01-01T00:00:00.000Z';
  }
}

function diagnostic(
  event: 'log.corrupt_line' | 'log.oversize_line',
  clock: () => Date,
): OperationalLogRecord {
  return {
    ts: safeNow(clock),
    level: 'warn',
    service: OPERATIONAL_LOG_SERVICE,
    schemaVersion: SCHEMA_VERSION,
    build: DIAGNOSTIC_BUILD,
    event,
    outcome: 'rejected',
    errorCode: 'validation.failed',
    retryable: false,
    counts: { rejected: 1 },
  };
}

function decodeLine(bytes: Uint8Array, clock: () => Date): OperationalLogRecord {
  if (bytes.byteLength + 1 > MAX_OPERATIONAL_LOG_LINE_BYTES) {
    return diagnostic('log.oversize_line', clock);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return diagnostic('log.corrupt_line', clock);
  }
  return parseOperationalLogLine(text) ?? diagnostic('log.corrupt_line', clock);
}

async function openIfPresent(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Reads one file backwards without retaining an unbounded corrupt line in memory. */
async function* reverseLines(path: string, signal?: AbortSignal): AsyncGenerator<ReverseLine> {
  const handle = await openIfPresent(path);
  if (handle === null) return;
  try {
    const info = await handle.stat();
    let position = info.size;
    let carry = Buffer.alloc(0);
    let carryOversize = false;

    while (position > 0) {
      if (signal?.aborted === true) return;
      const length = Math.min(READ_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const result = await handle.read(chunk, 0, length, position);
      const bytes = result.bytesRead === length ? chunk : chunk.subarray(0, result.bytesRead);
      const newlines: number[] = [];
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] === 0x0a) newlines.push(index);
      }

      if (newlines.length === 0) {
        if (!carryOversize) {
          if (bytes.length + carry.length + 1 > MAX_OPERATIONAL_LOG_LINE_BYTES) {
            carry = Buffer.alloc(0);
            carryOversize = true;
          } else {
            carry = Buffer.concat([bytes, carry]);
          }
        }
        continue;
      }

      const lastNewline = newlines[newlines.length - 1] as number;
      const trailing = bytes.subarray(lastNewline + 1);
      if (carryOversize || trailing.length + carry.length + 1 > MAX_OPERATIONAL_LOG_LINE_BYTES) {
        yield { kind: 'oversize' };
      } else if (trailing.length + carry.length > 0) {
        yield { kind: 'line', bytes: Buffer.concat([trailing, carry]) };
      }

      for (let index = newlines.length - 1; index >= 1; index -= 1) {
        const start = (newlines[index - 1] as number) + 1;
        const end = newlines[index] as number;
        if (end === start) continue;
        const line = bytes.subarray(start, end);
        yield line.length + 1 > MAX_OPERATIONAL_LOG_LINE_BYTES
          ? { kind: 'oversize' }
          : { kind: 'line', bytes: line };
      }

      const firstNewline = newlines[0] as number;
      carry = bytes.subarray(0, firstNewline);
      carryOversize = carry.length + 1 > MAX_OPERATIONAL_LOG_LINE_BYTES;
      if (carryOversize) carry = Buffer.alloc(0);
    }

    if (carryOversize) yield { kind: 'oversize' };
    else if (carry.length > 0) yield { kind: 'line', bytes: carry };
  } finally {
    await handle.close();
  }
}

function includeRecord(record: OperationalLogRecord, job: DaemonJobName | null): boolean {
  return record.event === 'log.corrupt_line' || record.event === 'log.oversize_line' ||
    job === null || record.job === job;
}

export async function readOperationalLogTail(
  options: ReadOperationalLogsOptions,
): Promise<readonly OperationalLogRecord[]> {
  const validated = validateOptions(options);
  const current = operationalLogPath(options.logDir);
  const newestFirst: OperationalLogRecord[] = [];
  for (let generation = 0; generation <= validated.backupLimit; generation += 1) {
    if (options.signal?.aborted === true) break;
    const path = generation === 0 ? current : `${current}.${generation}`;
    for await (const item of reverseLines(path, options.signal)) {
      const record = item.kind === 'oversize'
        ? diagnostic('log.oversize_line', validated.clock)
        : decodeLine(item.bytes, validated.clock);
      if (!includeRecord(record, validated.job)) continue;
      newestFirst.push(record);
      if (newestFirst.length === validated.tail) return newestFirst.reverse();
    }
  }
  return newestFirst.reverse();
}

export function formatOperationalLogRecord(record: OperationalLogRecord): string {
  return JSON.stringify(record);
}

class ForwardLineDecoder {
  private carry = Buffer.alloc(0);
  private oversize = false;

  constructor(private readonly clock: () => Date) {}

  feed(chunk: Uint8Array): readonly OperationalLogRecord[] {
    const output: OperationalLogRecord[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.append(chunk.subarray(start, index));
      output.push(this.finish());
      start = index + 1;
    }
    this.append(chunk.subarray(start));
    return output;
  }

  reset(): OperationalLogRecord | null {
    if (!this.oversize && this.carry.length === 0) return null;
    const record = this.oversize
      ? diagnostic('log.oversize_line', this.clock)
      : diagnostic('log.corrupt_line', this.clock);
    this.carry = Buffer.alloc(0);
    this.oversize = false;
    return record;
  }

  private append(segment: Uint8Array): void {
    if (this.oversize || segment.length === 0) return;
    if (this.carry.length + segment.length + 1 > MAX_OPERATIONAL_LOG_LINE_BYTES) {
      this.carry = Buffer.alloc(0);
      this.oversize = true;
      return;
    }
    this.carry = Buffer.concat([this.carry, segment]);
  }

  private finish(): OperationalLogRecord {
    const record = this.oversize
      ? diagnostic('log.oversize_line', this.clock)
      : decodeLine(this.carry, this.clock);
    this.carry = Buffer.alloc(0);
    this.oversize = false;
    return record;
  }
}

function fileIdentity(info: Stats): string {
  return `${String(info.dev)}:${String(info.ino)}`;
}

async function statIfPresent(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readRange(
  path: string,
  from: number,
  to: number,
  decoder: ForwardLineDecoder,
  signal?: AbortSignal,
): Promise<readonly OperationalLogRecord[]> {
  if (to <= from) return [];
  const handle = await openIfPresent(path);
  if (handle === null) return [];
  const output: OperationalLogRecord[] = [];
  try {
    let position = from;
    while (position < to) {
      if (signal?.aborted === true) break;
      const length = Math.min(READ_CHUNK_BYTES, to - position);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, position);
      if (result.bytesRead === 0) break;
      output.push(...decoder.feed(buffer.subarray(0, result.bytesRead)));
      position += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return output;
}

function waitForPoll(signal: AbortSignal, milliseconds: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Polling follow is rotation/truncation aware and owns no long-lived handle that could block Windows rename. */
export async function* followOperationalLogs(
  options: FollowOperationalLogsOptions,
): AsyncGenerator<OperationalLogRecord> {
  const validated = validateOptions(options);
  const pollMilliseconds = options.pollMilliseconds ?? 250;
  if (!Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 10 || pollMilliseconds > 60_000) {
    throw new TypeError('logs.poll_invalid');
  }
  const path = operationalLogPath(options.logDir);
  const initial = await readOperationalLogTail(options);
  // Establish the follow cursor before yielding the first tail record. Otherwise a writer can
  // append while the generator is suspended at that yield and the later cursor would skip it.
  let info = await statIfPresent(path);
  let identity = info === null ? null : fileIdentity(info);
  let offset = info?.size ?? 0;
  const decoder = new ForwardLineDecoder(validated.clock);
  for (const record of initial) {
    if (options.signal.aborted) return;
    yield record;
  }

  while (await waitForPoll(options.signal, pollMilliseconds)) {
    const next = await statIfPresent(path);
    if (next === null) {
      info = null;
      identity = null;
      offset = 0;
      const reset = decoder.reset();
      if (reset !== null && includeRecord(reset, validated.job)) yield reset;
      continue;
    }

    const nextIdentity = fileIdentity(next);
    if (identity !== null && nextIdentity !== identity) {
      // The closed-and-renamed prior current is now .1. Drain its final bytes before the new file.
      const rotated = await statIfPresent(`${path}.1`);
      if (rotated !== null && rotated.size >= offset) {
        for (const record of await readRange(
          `${path}.1`, offset, rotated.size, decoder, options.signal,
        )) {
          if (includeRecord(record, validated.job)) yield record;
        }
      }
      const reset = decoder.reset();
      if (reset !== null && includeRecord(reset, validated.job)) yield reset;
      offset = 0;
    } else if (next.size < offset ||
      (info !== null && next.size === offset && next.mtimeMs !== info.mtimeMs)) {
      // A truncate-and-rewrite can return to the exact prior byte size between polls. The mtime
      // comparison catches that case as well as an observed smaller size.
      const reset = decoder.reset();
      if (reset !== null && includeRecord(reset, validated.job)) yield reset;
      offset = 0;
    }

    for (const record of await readRange(path, offset, next.size, decoder, options.signal)) {
      if (includeRecord(record, validated.job)) yield record;
    }
    offset = next.size;
    info = next;
    identity = nextIdentity;
  }
}
