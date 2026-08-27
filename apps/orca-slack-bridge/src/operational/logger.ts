import { createHash } from 'node:crypto';
import {
  mkdir as nodeMkdir,
  open as nodeOpen,
  rename as nodeRename,
  rm as nodeRm,
  stat as nodeStat,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '../store/schema.js';
import {
  OPERATIONAL_FAILURE_CODES,
  type DaemonJobName,
  type OperationalFailureCode,
} from '../store/operational-types.js';

export const OPERATIONAL_LOG_FILE = 'operational.ndjson';
export const OPERATIONAL_LOG_SERVICE = 'orca-slack-bridge';
export const MAX_OPERATIONAL_LOG_LINE_BYTES = 16 * 1024;
export const DEFAULT_OPERATIONAL_LOG_MAX_MIB = 5;
export const DEFAULT_OPERATIONAL_LOG_BACKUPS = 5;
export const MIN_OPERATIONAL_LOG_MAX_MIB = 1;
export const MAX_OPERATIONAL_LOG_MAX_MIB = 100;
export const MIN_OPERATIONAL_LOG_BACKUPS = 1;
export const MAX_OPERATIONAL_LOG_BACKUPS = 20;

export const OPERATIONAL_LOG_EVENTS = [
  'daemon.started',
  'daemon.heartbeat',
  'daemon.stopped',
  'daemon.failed',
  'job.started',
  'job.succeeded',
  'job.failed',
  'job.backoff',
  'discovery.completed',
  'registry.changed',
  'root_intent.changed',
  'logger.failed',
  'telemetry.rejected',
  'log.corrupt_line',
  'log.oversize_line',
] as const;

export const OPERATIONAL_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const OPERATIONAL_LOG_OUTCOMES = [
  'started',
  'running',
  'succeeded',
  'failed',
  'backoff',
  'deferred',
  'stopped',
  'healthy',
  'degraded',
  'rejected',
  'uncertain',
  'dead',
] as const;
export const OPERATIONAL_COUNT_FIELDS = [
  'active',
  'pending',
  'rejected',
  'deferred',
  'processed',
  'succeeded',
  'failed',
  'uncertain',
  'dead',
  'total',
] as const;

export type OperationalLogEvent = typeof OPERATIONAL_LOG_EVENTS[number];
export type OperationalLogLevel = typeof OPERATIONAL_LOG_LEVELS[number];
export type OperationalLogOutcome = typeof OPERATIONAL_LOG_OUTCOMES[number];
export type OperationalCountField = typeof OPERATIONAL_COUNT_FIELDS[number];
export type EntityIdentity = object & { readonly __entityIdentity: unique symbol };
export type EntityRef = string & { readonly __entityRef: unique symbol };

export type OperationalLogCounts = Partial<Readonly<Record<OperationalCountField, number>>>;

export type OperationalLogInput = {
  readonly level: OperationalLogLevel;
  readonly event: OperationalLogEvent;
  readonly job?: DaemonJobName;
  readonly outcome?: OperationalLogOutcome;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly nextRunAt?: string;
  readonly errorCode?: OperationalFailureCode;
  readonly retryable?: boolean;
  readonly counts?: OperationalLogCounts;
  /** Opaque raw identity token. The concrete logger hashes it at the persistence boundary. */
  readonly entityIdentity?: EntityIdentity;
};

/** The complete persisted shape. No free-form message/detail/payload field exists. */
export type OperationalLogRecord = {
  readonly ts: string;
  readonly level: OperationalLogLevel;
  readonly service: typeof OPERATIONAL_LOG_SERVICE;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly build: string;
  readonly event: OperationalLogEvent;
  readonly job?: DaemonJobName;
  readonly outcome?: OperationalLogOutcome;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly nextRunAt?: string;
  readonly errorCode?: OperationalFailureCode;
  readonly retryable?: boolean;
  readonly counts?: OperationalLogCounts;
  readonly entityRef?: EntityRef;
};

export type LoggerFailureNotice = {
  readonly at: string;
  readonly errorCode: 'logger.write_failed';
  /** A second consecutive terminal operation failure is fatal to the future daemon supervisor. */
  readonly fatal: boolean;
};

export interface OperationalTelemetrySink {
  log(input: unknown): Promise<{ readonly ok: true } | { readonly ok: false; readonly errorCode: 'logger.write_failed' }>;
  close(): Promise<void>;
}

export interface OperationalLogHandle {
  writeFile(data: Uint8Array): Promise<void>;
  stat(): Promise<{ readonly size: number }>;
  close(): Promise<void>;
}

export interface OperationalLoggerFileSystem {
  mkdir(path: string): Promise<void>;
  open(path: string, flags: 'a' | 'ax'): Promise<OperationalLogHandle>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export type OperationalLoggerOptions = {
  readonly logDir: string;
  /** Any release identity is hashed before it can enter a record. */
  readonly buildIdentity: string;
  readonly maxFileMiB?: number;
  readonly backupCount?: number;
  readonly clock?: () => Date;
  readonly fileSystem?: OperationalLoggerFileSystem;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly stderr?: (staticCode: 'logger.write_failed') => void;
  readonly onFailure?: (notice: LoggerFailureNotice) => void | Promise<void>;
};

const LOG_FIELDS = [
  'ts', 'level', 'service', 'schemaVersion', 'build', 'event', 'job', 'outcome', 'attempt',
  'durationMs', 'nextRunAt', 'errorCode', 'retryable', 'counts', 'entityRef',
] as const;
const INPUT_FIELDS = [
  'level', 'event', 'job', 'outcome', 'attempt', 'durationMs', 'nextRunAt', 'errorCode',
  'retryable', 'counts', 'entityIdentity',
] as const;
const PARSED_INPUT_FIELDS = [
  'level', 'event', 'job', 'outcome', 'attempt', 'durationMs', 'nextRunAt', 'errorCode',
  'retryable', 'counts',
] as const;
export const OPERATIONAL_JOB_NAMES: readonly DaemonJobName[] = [
  'repository-discovery', 'run-observer', 'pr-digest', 'gate-reconcile', 'channel-delivery',
];
const MAX_COUNT = 1_000_000_000;
const MAX_ENTITY_IDENTITY_BYTES = 4 * 1024;
const BUILD_REF_RE = /^[0-9a-f]{12}$/;
const ENTITY_REF_RE = /^[0-9a-f]{12}$/;
const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RAW_ENTITY_IDENTITIES = new WeakMap<object, string>();

const DEFAULT_FILE_SYSTEM: OperationalLoggerFileSystem = {
  mkdir: async (path) => { await nodeMkdir(path, { recursive: true }); },
  open: async (path, flags) => await nodeOpen(path, flags) as FileHandle,
  rename: async (from, to) => { await nodeRename(from, to); },
  remove: async (path) => { await nodeRm(path, { force: true }); },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCatalogValue<T extends string>(value: unknown, catalog: readonly T[]): value is T {
  return typeof value === 'string' && (catalog as readonly string[]).includes(value);
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function canonicalIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function safeNow(clock: () => Date): string {
  try {
    const value = clock();
    return Number.isFinite(value.getTime()) ? value.toISOString() : '1970-01-01T00:00:00.000Z';
  } catch {
    return '1970-01-01T00:00:00.000Z';
  }
}

/** Hashes any caller-provided identity before it crosses the telemetry boundary. */
export function operationalFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Wraps a raw private identity without making it enumerable or serializable. The wrapper is
 * deliberately not a pre-hashed reference: only the concrete logger may derive `entityRef`.
 */
export function entityIdentity(value: string): EntityIdentity {
  const token = Object.freeze(Object.create(null)) as EntityIdentity;
  RAW_ENTITY_IDENTITIES.set(token, value);
  return token;
}

function rawEntityIdentity(value: unknown): string | null {
  const raw = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null
      ? RAW_ENTITY_IDENTITIES.get(value) ?? null
      : null;
  if (raw === null || raw.length === 0 || Buffer.byteLength(raw, 'utf8') > MAX_ENTITY_IDENTITY_BYTES) {
    return null;
  }
  return raw;
}

function normalizeCounts(value: unknown): OperationalLogCounts | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !(OPERATIONAL_COUNT_FIELDS as readonly string[]).includes(key))) return null;
  const counts: Partial<Record<OperationalCountField, number>> = {};
  for (const key of OPERATIONAL_COUNT_FIELDS) {
    if (value[key] === undefined) continue;
    if (!safeInteger(value[key], MAX_COUNT)) return null;
    counts[key] = value[key];
  }
  return counts;
}

function normalizeCommonInput(
  value: Record<string, unknown>,
): Omit<OperationalLogRecord, 'ts' | 'service' | 'schemaVersion' | 'build' | 'entityRef'> | null {
  if (!isCatalogValue(value['level'], OPERATIONAL_LOG_LEVELS)) return null;
  if (!isCatalogValue(value['event'], OPERATIONAL_LOG_EVENTS)) return null;

  const normalized: Record<string, unknown> = { level: value['level'], event: value['event'] };
  if (value['job'] !== undefined) {
    if (!isCatalogValue(value['job'], OPERATIONAL_JOB_NAMES)) return null;
    normalized['job'] = value['job'];
  }
  if (value['outcome'] !== undefined) {
    if (!isCatalogValue(value['outcome'], OPERATIONAL_LOG_OUTCOMES)) return null;
    normalized['outcome'] = value['outcome'];
  }
  for (const field of ['attempt', 'durationMs'] as const) {
    if (value[field] === undefined) continue;
    if (!safeInteger(value[field])) return null;
    normalized[field] = value[field];
  }
  if (value['nextRunAt'] !== undefined) {
    const nextRunAt = canonicalIso(value['nextRunAt']);
    if (nextRunAt === null) return null;
    normalized['nextRunAt'] = nextRunAt;
  }
  if (value['errorCode'] !== undefined) {
    if (!isCatalogValue(value['errorCode'], OPERATIONAL_FAILURE_CODES)) return null;
    normalized['errorCode'] = value['errorCode'];
  }
  if (value['retryable'] !== undefined) {
    if (typeof value['retryable'] !== 'boolean') return null;
    normalized['retryable'] = value['retryable'];
  }
  if (value['counts'] !== undefined) {
    const counts = normalizeCounts(value['counts']);
    if (counts === null) return null;
    normalized['counts'] = counts;
  }
  return normalized as Omit<
    OperationalLogRecord,
    'ts' | 'service' | 'schemaVersion' | 'build' | 'entityRef'
  >;
}

function normalizeInput(value: unknown): Omit<OperationalLogRecord, 'ts' | 'service' | 'schemaVersion' | 'build'> | null {
  try {
    if (!isRecord(value)) return null;
    if (Object.keys(value).some((key) => !(INPUT_FIELDS as readonly string[]).includes(key))) return null;
    const normalized = normalizeCommonInput(value);
    if (normalized === null) return null;
    if (value['entityIdentity'] !== undefined) {
      const identity = rawEntityIdentity(value['entityIdentity']);
      if (identity === null) return null;
      return {
        ...normalized,
        entityRef: operationalFingerprint(identity).slice(0, 12) as EntityRef,
      };
    }
    return normalized;
  } catch {
    // Proxies/getters are untrusted input too. Their thrown object is never stringified.
    return null;
  }
}

function serializeRecord(record: OperationalLogRecord): Uint8Array | null {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  return bytes.byteLength <= MAX_OPERATIONAL_LOG_LINE_BYTES ? bytes : null;
}

/** Strict parser shared by `logs`; unknown fields and non-canonical values fail closed. */
export function parseOperationalLogLine(line: string): OperationalLogRecord | null {
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_OPERATIONAL_LOG_LINE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !(LOG_FIELDS as readonly string[]).includes(key))) {
    return null;
  }
  const ts = canonicalIso(value['ts']);
  if (ts === null || ts !== value['ts']) return null;
  if (value['service'] !== OPERATIONAL_LOG_SERVICE || value['schemaVersion'] !== SCHEMA_VERSION) return null;
  if (typeof value['build'] !== 'string' || !BUILD_REF_RE.test(value['build'])) return null;
  const parsedInput = Object.fromEntries(
    Object.entries(value).filter(([key]) => (PARSED_INPUT_FIELDS as readonly string[]).includes(key)),
  );
  const normalized = normalizeCommonInput(parsedInput);
  if (normalized === null) return null;
  const { level, event, ...optional } = normalized;
  let entityRef: EntityRef | undefined;
  if (value['entityRef'] !== undefined) {
    if (typeof value['entityRef'] !== 'string' || !ENTITY_REF_RE.test(value['entityRef'])) return null;
    entityRef = value['entityRef'] as EntityRef;
  }
  return {
    ts,
    level,
    service: OPERATIONAL_LOG_SERVICE,
    schemaVersion: SCHEMA_VERSION,
    build: value['build'],
    event,
    ...optional,
    ...(entityRef === undefined ? {} : { entityRef }),
  };
}

function validateBound(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name}: validation.failed`);
  }
  return value;
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function resolveOperationalLogDir(
  explicit: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (explicit !== null && explicit.trim() !== '') return explicit;
  const configured = env['ORCA_SLACK_BRIDGE_LOG_DIR'];
  if (configured !== undefined && configured.trim() !== '') return configured;
  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'];
    if (base === undefined || base.trim() === '') throw new Error('logs.path_unavailable');
    return join(base, 'OrcaSlackBridge', 'logs');
  }
  const xdg = env['XDG_STATE_HOME'];
  const base = xdg !== undefined && xdg.startsWith('/') ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'orca-slack-bridge', 'logs');
}

export function operationalLogPath(logDir: string): string {
  return join(logDir, OPERATIONAL_LOG_FILE);
}

export class OperationalNdjsonLogger implements OperationalTelemetrySink {
  private readonly path: string;
  private readonly build: string;
  private readonly maximumBytes: number;
  private readonly backups: number;
  private readonly clock: () => Date;
  private readonly fs: OperationalLoggerFileSystem;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly stderr: (staticCode: 'logger.write_failed') => void;
  private readonly onFailure: ((notice: LoggerFailureNotice) => void | Promise<void>) | undefined;
  private handle: OperationalLogHandle | null = null;
  private bytes = 0;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private consecutiveFailures = 0;

  private constructor(options: OperationalLoggerOptions) {
    const maxFileMiB = validateBound(
      'logging.maxFileMiB', options.maxFileMiB ?? DEFAULT_OPERATIONAL_LOG_MAX_MIB,
      MIN_OPERATIONAL_LOG_MAX_MIB, MAX_OPERATIONAL_LOG_MAX_MIB,
    );
    this.backups = validateBound(
      'logging.backupCount', options.backupCount ?? DEFAULT_OPERATIONAL_LOG_BACKUPS,
      MIN_OPERATIONAL_LOG_BACKUPS, MAX_OPERATIONAL_LOG_BACKUPS,
    );
    this.path = operationalLogPath(options.logDir);
    this.build = operationalFingerprint(options.buildIdentity).slice(0, 12);
    this.maximumBytes = maxFileMiB * 1024 * 1024;
    this.clock = options.clock ?? (() => new Date());
    this.fs = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
    this.delay = options.delay ?? defaultDelay;
    this.stderr = options.stderr ?? ((code) => { process.stderr.write(`${code}\n`); });
    this.onFailure = options.onFailure;
  }

  static async create(options: OperationalLoggerOptions): Promise<OperationalNdjsonLogger> {
    const logger = new OperationalNdjsonLogger(options);
    await logger.prepare(options.logDir);
    return logger;
  }

  private async prepare(logDir: string): Promise<void> {
    try {
      await this.fs.mkdir(logDir);
      for (let index = MAX_OPERATIONAL_LOG_BACKUPS; index > this.backups; index -= 1) {
        await this.fs.remove(`${this.path}.${index}`);
      }
      if (!(await this.openWithRecovery('a'))) await this.reportFailure();
    } catch {
      await this.reportFailure();
    }
  }

  log(input: unknown): Promise<{ readonly ok: true } | { readonly ok: false; readonly errorCode: 'logger.write_failed' }> {
    if (this.closed) return Promise.resolve({ ok: false, errorCode: 'logger.write_failed' });
    const operation = this.chain.then(() => this.writeOne(input), () => this.writeOne(input));
    this.chain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async writeOne(input: unknown): Promise<{ readonly ok: true } | { readonly ok: false; readonly errorCode: 'logger.write_failed' }> {
    const normalized = normalizeInput(input) ?? {
      level: 'warn' as const,
      event: 'telemetry.rejected' as const,
      outcome: 'rejected' as const,
      errorCode: 'validation.failed' as const,
      retryable: false,
    };
    const { level, event, ...optional } = normalized;
    let record: OperationalLogRecord = {
      ts: safeNow(this.clock),
      level,
      service: OPERATIONAL_LOG_SERVICE,
      schemaVersion: SCHEMA_VERSION,
      build: this.build,
      event,
      ...optional,
    };
    let line = serializeRecord(record);
    if (line === null) {
      record = {
        ts: safeNow(this.clock), level: 'warn', service: OPERATIONAL_LOG_SERVICE,
        schemaVersion: SCHEMA_VERSION, build: this.build, event: 'telemetry.rejected',
        outcome: 'rejected', errorCode: 'validation.failed', retryable: false,
      };
      line = serializeRecord(record);
    }
    if (line === null || !(await this.ensureOpen())) return await this.failedResult();
    try {
      if (this.bytes > 0 && this.bytes + line.byteLength > this.maximumBytes) await this.rotate();
      if (this.handle === null) return await this.failedResult();
      await this.handle.writeFile(line);
      this.bytes += line.byteLength;
      this.consecutiveFailures = 0;
      return { ok: true };
    } catch {
      await this.closeHandle();
      return await this.failedResult();
    }
  }

  private async ensureOpen(): Promise<boolean> {
    return this.handle !== null || await this.openWithRecovery('a');
  }

  private async openWithRecovery(flags: 'a' | 'ax'): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.handle = await this.fs.open(this.path, flags);
        this.bytes = (await this.handle.stat()).size;
        return true;
      } catch {
        await this.closeHandle();
        if (attempt === 0) await this.delay(10);
      }
    }
    return false;
  }

  private async rotate(): Promise<void> {
    // Windows cannot reliably rename an open file. This close is deliberately before every rename.
    await this.closeHandle(true);
    for (let index = MAX_OPERATIONAL_LOG_BACKUPS; index >= this.backups; index -= 1) {
      await this.fs.remove(`${this.path}.${index}`);
    }
    for (let index = this.backups - 1; index >= 1; index -= 1) {
      await this.renameIfPresent(`${this.path}.${index}`, `${this.path}.${index + 1}`);
    }
    await this.renameIfPresent(this.path, `${this.path}.1`);
    if (!(await this.openWithRecovery('ax'))) throw new Error('logger.write_failed');
    this.bytes = 0;
  }

  private async renameIfPresent(from: string, to: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.fs.rename(from, to);
        return;
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT') return;
        if (!RETRYABLE_RENAME_CODES.has(code ?? '') || attempt === 3) throw error;
        await this.delay(10 * (attempt + 1));
      }
    }
  }

  private async closeHandle(strict = false): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        if (strict) {
          this.handle = handle;
          throw new Error('logger.write_failed');
        }
      }
    }
  }

  private async failedResult(): Promise<{ readonly ok: false; readonly errorCode: 'logger.write_failed' }> {
    await this.reportFailure();
    return { ok: false, errorCode: 'logger.write_failed' };
  }

  private async reportFailure(): Promise<void> {
    this.consecutiveFailures += 1;
    try { this.stderr('logger.write_failed'); } catch { /* never expose the triggering payload */ }
    if (this.onFailure !== undefined) {
      try {
        await this.onFailure({
          at: safeNow(this.clock), errorCode: 'logger.write_failed',
          fatal: this.consecutiveFailures >= 2,
        });
      } catch {
        // The health sink is best-effort; its thrown object is never rendered or serialized.
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.chain;
    try {
      await this.closeHandle(true);
    } catch {
      await this.closeHandle();
      await this.reportFailure();
    }
  }
}
