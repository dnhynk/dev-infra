import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
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
const SNAPSHOT_ATTEMPTS = 3;

export type ReadOperationalLogsOptions = {
  readonly logDir: string;
  readonly tail?: number;
  readonly job?: DaemonJobName | null;
  readonly backupLimit?: number;
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
  /** Deterministic test seam invoked before each captured name epoch is validated. */
  readonly afterLogChainCapture?: (attempt: number) => void | Promise<void>;
  /** Deterministic identity-only seam; production always uses the native bigint identity. */
  readonly fileIdentity?: (
    path: string,
    native: Pick<BigIntStats, 'dev' | 'ino'>,
  ) => Pick<BigIntStats, 'dev' | 'ino'>;
};

export type FollowOperationalLogsOptions = ReadOperationalLogsOptions & {
  readonly signal: AbortSignal;
  readonly pollMilliseconds?: number;
  /** Deterministic test seam invoked after all initial file sizes are pinned. */
  readonly afterInitialSnapshot?: () => void | Promise<void>;
};

type ValidatedOptions = {
  readonly tail: number;
  readonly job: DaemonJobName | null;
  readonly backupLimit: number;
  readonly clock: () => Date;
};

type ReverseLine =
  | { readonly kind: 'line'; readonly bytes: Uint8Array }
  | { readonly kind: 'oversize' };

type OpenLogGeneration = {
  readonly generation: number;
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: string;
  readonly size: number;
};

type LogChainSnapshot = {
  readonly entries: readonly OpenLogGeneration[];
};

type FollowCursor = {
  readonly identity: string;
  readonly offset: number;
  readonly digest: string;
};

function validateOptions(options: ReadOperationalLogsOptions): ValidatedOptions {
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

export function serializeOperationalLogFileIdentity(
  info: Pick<BigIntStats, 'dev' | 'ino'>,
): string {
  return `${info.dev.toString(10)}:${info.ino.toString(10)}`;
}

function safeFileSize(info: Pick<BigIntStats, 'size'>): number {
  if (info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('logs.read_failed');
  }
  return Number(info.size);
}

function fileIdentity(
  path: string,
  info: Pick<BigIntStats, 'dev' | 'ino'>,
  override?: ReadOperationalLogsOptions['fileIdentity'],
): string {
  return serializeOperationalLogFileIdentity(override?.(path, info) ?? info);
}

async function statIfPresent(path: string): Promise<BigIntStats | null> {
  try {
    return await stat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function generationPath(current: string, generation: number): string {
  return generation === 0 ? current : `${current}.${generation}`;
}

async function closeSnapshot(snapshot: LogChainSnapshot): Promise<void> {
  const results = await Promise.allSettled(snapshot.entries.map(async (entry) => {
    try {
      await entry.handle.close();
    } catch {
      throw new Error('logs.read_failed');
    }
  }));
  if (results.some((result) => result.status === 'rejected')) throw new Error('logs.read_failed');
}

async function captureLogChainOnce(
  current: string,
  backupLimit: number,
  identityOverride?: ReadOperationalLogsOptions['fileIdentity'],
): Promise<LogChainSnapshot> {
  const entries: OpenLogGeneration[] = [];
  try {
    for (let generation = 0; generation <= backupLimit; generation += 1) {
      const path = generationPath(current, generation);
      const handle = await openIfPresent(path);
      if (handle === null) continue;
      try {
        const info = await handle.stat({ bigint: true });
        entries.push({
          generation,
          path,
          handle,
          identity: fileIdentity(path, info, identityOverride),
          size: safeFileSize(info),
        });
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    return { entries };
  } catch (error) {
    await closeSnapshot({ entries });
    throw error;
  }
}

async function snapshotStillNamesSameFiles(
  current: string,
  backupLimit: number,
  snapshot: LogChainSnapshot,
  identityOverride?: ReadOperationalLogsOptions['fileIdentity'],
): Promise<boolean> {
  const identities = new Map(snapshot.entries.map((entry) => [entry.generation, entry.identity]));
  for (let generation = 0; generation <= backupLimit; generation += 1) {
    const info = await statIfPresent(generationPath(current, generation));
    if ((info === null ? null : fileIdentity(
      generationPath(current, generation), info, identityOverride,
    )) !==
        (identities.get(generation) ?? null)) return false;
  }
  return true;
}

/**
 * Opens and pins one coherent chain naming epoch. A rotation during capture is retried; appends
 * do not invalidate the epoch because every handle's size is already the exact read boundary.
 */
async function captureLogChain(
  current: string,
  backupLimit: number,
  afterCapture?: (attempt: number) => void | Promise<void>,
  identityOverride?: ReadOperationalLogsOptions['fileIdentity'],
): Promise<LogChainSnapshot> {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const snapshot = await captureLogChainOnce(current, backupLimit, identityOverride);
    try {
      await afterCapture?.(attempt);
      if (await snapshotStillNamesSameFiles(
        current, backupLimit, snapshot, identityOverride,
      )) return snapshot;
    } catch (error) {
      await closeSnapshot(snapshot);
      throw error;
    }
    await closeSnapshot(snapshot);
  }
  // Generation labels are useful only when every pinned handle belongs to one verified naming
  // epoch. A continuously rotating writer therefore fails closed after the bounded retry budget.
  throw new Error('logs.read_failed');
}

/** Reads one pinned file backwards without retaining an unbounded corrupt line in memory. */
async function* reverseLines(
  file: OpenLogGeneration,
  signal?: AbortSignal,
): AsyncGenerator<ReverseLine> {
  let position = file.size;
  let carry = Buffer.alloc(0);
  let carryOversize = false;
  let sawDelimiter = false;

  while (position > 0) {
    if (signal?.aborted === true) return;
    const length = Math.min(READ_CHUNK_BYTES, position);
    position -= length;
    const chunk = Buffer.allocUnsafe(length);
    const result = await file.handle.read(chunk, 0, length, position);
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

    const terminalBatch = !sawDelimiter;
    sawDelimiter = true;
    const lastNewline = newlines[newlines.length - 1] as number;
    const trailing = bytes.subarray(lastNewline + 1);
    // The bytes after the last LF are not a physical NDJSON record yet. The initial tail omits
    // that suffix; follow transfers the same bytes into its forward decoder until an LF arrives.
    if (!terminalBatch) {
      if (carryOversize || trailing.length + carry.length + 1 > MAX_OPERATIONAL_LOG_LINE_BYTES) {
        yield { kind: 'oversize' };
      } else {
        yield { kind: 'line', bytes: Buffer.concat([trailing, carry]) };
      }
    }

    for (let index = newlines.length - 1; index >= 1; index -= 1) {
      const start = (newlines[index - 1] as number) + 1;
      const end = newlines[index] as number;
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

  if (sawDelimiter) {
    if (carryOversize) yield { kind: 'oversize' };
    else yield { kind: 'line', bytes: carry };
  }
}

function includeRecord(record: OperationalLogRecord, job: DaemonJobName | null): boolean {
  return record.event === 'log.corrupt_line' || record.event === 'log.oversize_line' ||
    job === null || record.job === job;
}

async function readTailFromSnapshot(
  snapshot: LogChainSnapshot,
  validated: ValidatedOptions,
  signal?: AbortSignal,
): Promise<readonly OperationalLogRecord[]> {
  const newestFirst: OperationalLogRecord[] = [];
  const seenIdentities = new Set<string>();
  for (const file of [...snapshot.entries].sort((left, right) => left.generation - right.generation)) {
    if (signal?.aborted === true) break;
    if (seenIdentities.has(file.identity)) continue;
    seenIdentities.add(file.identity);
    for await (const item of reverseLines(file, signal)) {
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

export async function readOperationalLogTail(
  options: ReadOperationalLogsOptions,
): Promise<readonly OperationalLogRecord[]> {
  const validated = validateOptions(options);
  if (options.signal?.aborted === true) return [];
  const snapshot = await captureLogChain(
    operationalLogPath(options.logDir),
    validated.backupLimit,
    options.afterLogChainCapture,
    options.fileIdentity,
  );
  try {
    return await readTailFromSnapshot(snapshot, validated, options.signal);
  } finally {
    await closeSnapshot(snapshot);
  }
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

async function readRange(
  file: OpenLogGeneration,
  from: number,
  to: number,
  decoder: ForwardLineDecoder,
  signal?: AbortSignal,
): Promise<readonly OperationalLogRecord[]> {
  if (to <= from) return [];
  const output: OperationalLogRecord[] = [];
  let position = from;
  while (position < to) {
    if (signal?.aborted === true) break;
    const length = Math.min(READ_CHUNK_BYTES, to - position);
    const buffer = Buffer.allocUnsafe(length);
    const result = await file.handle.read(buffer, 0, length, position);
    if (result.bytesRead === 0) break;
    output.push(...decoder.feed(buffer.subarray(0, result.bytesRead)));
    position += result.bytesRead;
  }
  return output;
}

async function digestPrefix(
  file: OpenLogGeneration,
  length: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const hash = createHash('sha256');
  let position = 0;
  while (position < length) {
    if (signal?.aborted === true) return null;
    const requested = Math.min(READ_CHUNK_BYTES, length - position);
    const buffer = Buffer.allocUnsafe(requested);
    const result = await file.handle.read(buffer, 0, requested, position);
    if (result.bytesRead === 0) return null;
    hash.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  return hash.digest('hex');
}

async function unterminatedSuffixStart(
  file: OpenLogGeneration,
  signal?: AbortSignal,
): Promise<number | null> {
  let position = file.size;
  while (position > 0) {
    if (signal?.aborted === true) return null;
    const length = Math.min(READ_CHUNK_BYTES, position);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    const result = await file.handle.read(buffer, 0, length, position);
    if (result.bytesRead !== length) throw new Error('logs.read_failed');
    for (let index = result.bytesRead - 1; index >= 0; index -= 1) {
      if (buffer[index] !== 0x0a) continue;
      const start = position + index + 1;
      return start === file.size ? null : start;
    }
  }
  return file.size === 0 ? null : 0;
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

function appendReset(
  output: OperationalLogRecord[],
  decoder: ForwardLineDecoder,
): void {
  const reset = decoder.reset();
  if (reset !== null) output.push(reset);
}

async function drainFollowSnapshot(
  snapshot: LogChainSnapshot,
  previous: FollowCursor | null,
  decoder: ForwardLineDecoder,
  signal: AbortSignal,
): Promise<{ readonly records: readonly OperationalLogRecord[]; readonly cursor: FollowCursor | null }> {
  const output: OperationalLogRecord[] = [];
  const entries = [...snapshot.entries].sort((left, right) => left.generation - right.generation);
  const current = entries.find((entry) => entry.generation === 0) ?? null;
  if (current === null) return { records: output, cursor: previous };

  const finalDigest = await digestPrefix(current, current.size, signal);
  if (finalDigest === null) return { records: output, cursor: previous };

  // File identity, size, ctime, and mtime can all collide on Windows. Only the content witness can
  // prove that a consumed generation is unchanged, so even the no-growth path hashes before it
  // returns. This intentionally trades O(current-size) changed-poll I/O for lossless observation.
  if (previous !== null && previous.identity === current.identity &&
      previous.offset === current.size && previous.digest === finalDigest) {
    return { records: output, cursor: previous };
  }

  if (previous === null) {
    output.push(...await readRange(current, 0, current.size, decoder, signal));
    return {
      records: output,
      cursor: {
        identity: current.identity, offset: current.size, digest: finalDigest,
      },
    };
  }

  const priorFile = entries.find((entry) => entry.identity === previous.identity) ?? null;
  if (priorFile === null) {
    // The cursor fell outside the configured retained chain. Emit one static gap diagnostic,
    // then recover from every generation still available in physical chronological order.
    appendReset(output, decoder);
    output.push(diagnostic('log.corrupt_line', () => new Date(0)));
    const seen = new Set<string>();
    for (const file of [...entries].sort((left, right) => right.generation - left.generation)) {
      if (seen.has(file.identity)) continue;
      seen.add(file.identity);
      output.push(...await readRange(file, 0, file.size, decoder, signal));
      if (file !== current) appendReset(output, decoder);
    }
    return {
      records: output,
      cursor: {
        identity: current.identity, offset: current.size, digest: finalDigest,
      },
    };
  }

  let start = previous.offset;
  let retainedPrefix = false;
  if (priorFile.size >= previous.offset) {
    retainedPrefix = priorFile === current && priorFile.size === previous.offset
      ? finalDigest === previous.digest
      : await digestPrefix(priorFile, previous.offset, signal) === previous.digest;
  }
  if (!retainedPrefix) {
    // Inode and timestamps are insufficient: an in-place truncate/rewrite can grow past the old
    // offset. The SHA-256 witness proves whether every already-consumed byte was retained.
    appendReset(output, decoder);
    start = 0;
  }

  const chronological = entries
    .filter((entry) => entry.generation <= priorFile.generation)
    .sort((left, right) => right.generation - left.generation);
  const seen = new Set<string>();
  for (const file of chronological) {
    if (seen.has(file.identity)) continue;
    seen.add(file.identity);
    const from = file.identity === priorFile.identity ? start : 0;
    output.push(...await readRange(file, from, file.size, decoder, signal));
    if (file !== current) appendReset(output, decoder);
  }

  return {
    records: output,
    cursor: {
      identity: current.identity, offset: current.size, digest: finalDigest,
    },
  };
}

/**
 * Polling follow pins each observed generation only for a bounded scan. It then closes every
 * handle before yielding, so Windows rotation remains unblocked while the consumer is suspended.
 */
export async function* followOperationalLogs(
  options: FollowOperationalLogsOptions,
): AsyncGenerator<OperationalLogRecord> {
  const validated = validateOptions(options);
  const pollMilliseconds = options.pollMilliseconds ?? 250;
  if (!Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 10 || pollMilliseconds > 60_000) {
    throw new TypeError('logs.poll_invalid');
  }
  if (options.signal.aborted) return;

  const path = operationalLogPath(options.logDir);
  const initialSnapshot = await captureLogChain(
    path,
    validated.backupLimit,
    options.afterLogChainCapture,
    options.fileIdentity,
  );
  let initial: readonly OperationalLogRecord[];
  let cursor: FollowCursor | null = null;
  const decoder = new ForwardLineDecoder(validated.clock);
  try {
    const current = initialSnapshot.entries.find((entry) => entry.generation === 0) ?? null;
    await options.afterInitialSnapshot?.();
    initial = await readTailFromSnapshot(initialSnapshot, validated, options.signal);
    if (current !== null) {
      const suffixStart = await unterminatedSuffixStart(current, options.signal);
      if (suffixStart !== null) {
        const seeded = await readRange(current, suffixStart, current.size, decoder, options.signal);
        if (seeded.length !== 0) throw new Error('logs.read_failed');
      }
      const digest = await digestPrefix(current, current.size, options.signal);
      if (digest !== null) cursor = {
        identity: current.identity,
        offset: current.size,
        digest,
      };
    }
  } finally {
    await closeSnapshot(initialSnapshot);
  }

  // Cursor and content witness are established from the exact same pinned size as the tail.
  // Every later append therefore belongs exclusively to the first follow drain.
  for (const record of initial) {
    if (options.signal.aborted) return;
    yield record;
  }

  while (await waitForPoll(options.signal, pollMilliseconds)) {
    const snapshot = await captureLogChain(
      path,
      validated.backupLimit,
      options.afterLogChainCapture,
      options.fileIdentity,
    );
    let drained: Awaited<ReturnType<typeof drainFollowSnapshot>>;
    try {
      drained = await drainFollowSnapshot(snapshot, cursor, decoder, options.signal);
    } finally {
      await closeSnapshot(snapshot);
    }
    if (options.signal.aborted) return;
    cursor = drained.cursor;
    for (const record of drained.records) {
      if (options.signal.aborted) return;
      if (includeRecord(record, validated.job)) yield record;
    }
  }
}
