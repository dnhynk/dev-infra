import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import { win32 } from 'node:path';
import { loadConfig, type ParsedBridgeConfig } from '../project/config.js';
import { APP_TOKEN_VAR, BOT_TOKEN_VAR } from '../slack/verify.js';
import { SCHEMA_VERSION } from '../store/schema.js';
import { SqliteDigestStore } from '../store/sqlite.js';
import {
  CurrentUserOperationalStatusCapabilityStore,
  operationalStatusCapabilityPath,
  operationalStatusStateIdentity,
  type OperationalStatusSnapshotLease,
  type OperationalStatusSnapshotLeaseStore,
} from '../operational/status-capability.js';

export const REQUIRED_BRIDGE_ENVIRONMENT_VARIABLES = [BOT_TOKEN_VAR, APP_TOKEN_VAR] as const;
export const REQUIRED_NODE_MAJOR = 26;

export type WindowsDeploymentPaths = {
  readonly appRoot: string;
  readonly nodePath: string;
  readonly orcaPath: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly logDir: string;
};

export type ValidatedWindowsDeployment = {
  readonly paths: WindowsDeploymentPaths & { readonly cliPath: string };
  readonly buildDigest: string;
  readonly config: ParsedBridgeConfig;
};

export interface ExecutableVersionProbe {
  readVersion(executable: string): Promise<string>;
}

export class SpawnExecutableVersionProbe implements ExecutableVersionProbe {
  async readVersion(executable: string): Promise<string> {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('windows.deploy.node_probe_timeout'));
      }, 10_000);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024) child.kill();
        else chunks.push(chunk);
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('windows.deploy.node_probe_failed'));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0 || size > 1024) reject(new Error('windows.deploy.node_probe_failed'));
        else resolve(Buffer.concat(chunks).toString('utf8').trim());
      });
    });
  }
}

export type ValidateWindowsDeploymentOptions = {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly versionProbe?: ExecutableVersionProbe;
};

function staticFailure(code: string): Error {
  return new Error(code);
}

function requireWindowsAbsolute(value: string, field: string): void {
  if (value.length === 0 || !win32.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw staticFailure(`windows.deploy.invalid_${field}`);
  }
}

function canonicalExisting(value: string, field: string, kind: 'file' | 'directory'): string {
  requireWindowsAbsolute(value, field);
  let canonical: string;
  try {
    canonical = realpathSync.native(value);
    const stats = statSync(canonical);
    if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) throw new Error('wrong kind');
  } catch {
    throw staticFailure(`windows.deploy.invalid_${field}`);
  }
  return canonical;
}

function canonicalCreatableDirectory(value: string, field: string): string {
  requireWindowsAbsolute(value, field);
  try {
    mkdirSync(value, { recursive: true });
    return canonicalExisting(value, field, 'directory');
  } catch {
    throw staticFailure(`windows.deploy.invalid_${field}`);
  }
}

function canonicalStatePath(value: string): string {
  requireWindowsAbsolute(value, 'state');
  try {
    if (existsSync(value)) return canonicalExisting(value, 'state', 'file');
    const parent = canonicalCreatableDirectory(win32.dirname(value), 'state_parent');
    const name = win32.basename(value);
    if (name.length === 0 || name === '.' || name === '..') throw new Error('invalid name');
    return win32.join(parent, name);
  } catch {
    throw staticFailure('windows.deploy.invalid_state');
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = win32.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !win32.isAbsolute(relative));
}

function verifyWritableDirectory(directory: string, field: string): void {
  const probe = win32.join(directory, `.orca-write-probe-${randomUUID()}`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(probe, 'wx');
    closeSync(descriptor);
    descriptor = null;
    unlinkSync(probe);
  } catch {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* static failure below */ }
    }
    try { if (existsSync(probe)) unlinkSync(probe); } catch { /* static failure below */ }
    throw staticFailure(`windows.deploy.unwritable_${field}`);
  }
}

function containsSecretKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  for (const key of Object.keys(value)) {
    if (/(?:token|secret|password|authorization|cookie)/iu.test(key)) return true;
    if (containsSecretKey((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

function configHasNoCredentialFields(path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw staticFailure('windows.deploy.invalid_config');
  }
  if (containsSecretKey(parsed)) throw staticFailure('windows.deploy.config_contains_credentials');
}

function environmentHasRequiredNames(env: NodeJS.ProcessEnv): boolean {
  return REQUIRED_BRIDGE_ENVIRONMENT_VARIABLES.every(
    (name) => Object.prototype.hasOwnProperty.call(env, name),
  );
}

function packageManifest(appRoot: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(win32.join(appRoot, 'package.json'), 'utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch {
    throw staticFailure('windows.deploy.invalid_release_manifest');
  }
}

function verifyDeployedDependencies(appRoot: string, manifest: Record<string, unknown>): void {
  const files = manifest['files'];
  const bin = manifest['bin'];
  const dependencies = manifest['dependencies'];
  if (manifest['name'] !== '@dev-infra/orca-slack-bridge' || !Array.isArray(files) ||
      !files.some((entry) => entry === 'dist' || entry === 'dist/**/*') ||
      bin === null || typeof bin !== 'object' ||
      (bin as Record<string, unknown>)['orca-slack-bridge'] !== './dist/cli.js' ||
      dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw staticFailure('windows.deploy.invalid_release_manifest');
  }
  for (const dependency of Object.keys(dependencies as Record<string, unknown>)) {
    const dependencyManifest = win32.join(appRoot, 'node_modules', ...dependency.split('/'), 'package.json');
    try {
      if (!statSync(dependencyManifest).isFile()) throw new Error('not a file');
    } catch {
      throw staticFailure('windows.deploy.incomplete_dependencies');
    }
  }
}

function hashReleaseDirectory(hash: ReturnType<typeof createHash>, root: string, relative: string): void {
  const directory = win32.join(root, relative);
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const childRelative = win32.join(relative, entry.name);
    const child = win32.join(root, childRelative);
    const stats = lstatSync(child);
    if (stats.isSymbolicLink()) throw staticFailure('windows.deploy.release_symlink');
    if (stats.isDirectory()) {
      hashReleaseDirectory(hash, root, childRelative);
      continue;
    }
    if (!stats.isFile()) throw staticFailure('windows.deploy.invalid_release_file');
    hash.update(childRelative.replaceAll('\\', '/'), 'utf8');
    hash.update('\0');
    hash.update(readFileSync(child));
    hash.update('\0');
  }
}

export function computeReleaseBuildDigest(appRoot: string): string {
  const hash = createHash('sha256');
  hash.update('orca-slack-bridge-release-v1\0', 'utf8');
  const manifest = readFileSync(win32.join(appRoot, 'package.json'));
  hash.update('package.json\0', 'utf8');
  hash.update(manifest);
  hash.update('\0');
  hashReleaseDirectory(hash, appRoot, 'dist');
  return hash.digest('hex');
}

export async function validateWindowsDeployment(
  input: WindowsDeploymentPaths,
  options: ValidateWindowsDeploymentOptions = {},
): Promise<ValidatedWindowsDeployment> {
  if ((options.platform ?? process.platform) !== 'win32') {
    throw staticFailure('windows.deploy.unsupported_platform');
  }
  const appRoot = canonicalExisting(input.appRoot, 'app_root', 'directory');
  const nodePath = canonicalExisting(input.nodePath, 'node', 'file');
  const orcaPath = canonicalExisting(input.orcaPath, 'orca', 'file');
  const configPath = canonicalExisting(input.configPath, 'config', 'file');
  const statePath = canonicalStatePath(input.statePath);
  const logDir = canonicalCreatableDirectory(input.logDir, 'log_dir');
  if (isWithin(appRoot, statePath) || isWithin(appRoot, logDir)) {
    throw staticFailure('windows.deploy.mutable_path_inside_release');
  }
  verifyWritableDirectory(win32.dirname(statePath), 'state_directory');
  verifyWritableDirectory(logDir, 'log_directory');
  const cliPath = canonicalExisting(win32.join(appRoot, 'dist', 'cli.js'), 'cli', 'file');
  const manifest = packageManifest(appRoot);
  verifyDeployedDependencies(appRoot, manifest);
  const version = await (options.versionProbe ?? new SpawnExecutableVersionProbe()).readVersion(nodePath);
  const match = /^v([0-9]+)(?:\.|$)/u.exec(version);
  if (match === null || Number(match[1]) < REQUIRED_NODE_MAJOR) {
    throw staticFailure('windows.deploy.unsupported_node');
  }
  configHasNoCredentialFields(configPath);
  let config: ParsedBridgeConfig;
  try {
    config = await loadConfig(configPath);
  } catch {
    throw staticFailure('windows.deploy.invalid_config');
  }
  if (config.slack === null) throw staticFailure('windows.deploy.slack_config_required');
  if (!environmentHasRequiredNames(options.env ?? process.env)) {
    throw staticFailure('windows.deploy.required_environment_absent');
  }
  return {
    paths: { appRoot, nodePath, orcaPath, configPath, statePath, logDir, cliPath },
    buildDigest: computeReleaseBuildDigest(appRoot),
    config,
  };
}

export type PreparedDeploymentState = {
  readonly backupPath: string | null;
  readonly release: () => Promise<void>;
};

export type PrepareDeploymentStateOptions = {
  readonly platform?: NodeJS.Platform;
  readonly clock?: () => Date;
  readonly leaseStore?: OperationalStatusSnapshotLeaseStore;
  readonly openStore?: (path: string) => SqliteDigestStore;
  readonly beforeMigration?: (version: number | null) => void;
  readonly afterBackup?: (backupPath: string) => void;
};

function readVersion(db: DatabaseSync): number | null {
  const table = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
  ).get();
  if (table === undefined) return null;
  const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as
    | { readonly version: unknown }
    | undefined;
  if (row === undefined || typeof row.version !== 'number' || !Number.isSafeInteger(row.version)) {
    throw staticFailure('windows.deploy.state_version_invalid');
  }
  return row.version;
}

function backupFileName(clock: () => Date): string {
  const value = clock();
  if (!Number.isFinite(value.getTime())) throw staticFailure('windows.deploy.clock_invalid');
  return `state-pre-v13-${value.toISOString().replace(/[:.]/gu, '-')}.db`;
}

async function checkpointAndBackup(
  statePath: string,
  appRoot: string,
  clock: () => Date,
): Promise<{ readonly version: number | null; readonly backupPath: string | null }> {
  if (!existsSync(statePath)) return { version: null, backupPath: null };
  let db: DatabaseSync | null = new DatabaseSync(statePath);
  try {
    const version = readVersion(db);
    if (version === null || version === SCHEMA_VERSION) return { version, backupPath: null };
    if (version < 1 || version > SCHEMA_VERSION) throw staticFailure('windows.deploy.state_version_unsupported');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { readonly busy?: unknown }
      | undefined;
    if (checkpoint === undefined || checkpoint.busy !== 0) {
      throw staticFailure('windows.deploy.wal_checkpoint_failed');
    }
    const backupDirectory = win32.join(win32.dirname(statePath), 'orca-slack-bridge-backups');
    mkdirSync(backupDirectory, { recursive: true });
    const canonicalBackupDirectory = realpathSync.native(backupDirectory);
    if (isWithin(appRoot, canonicalBackupDirectory)) {
      throw staticFailure('windows.deploy.backup_inside_release');
    }
    const backupPath = win32.join(canonicalBackupDirectory, backupFileName(clock));
    if (existsSync(backupPath)) throw staticFailure('windows.deploy.backup_exists');
    const sourcePage = db.prepare('PRAGMA page_count').get() as
      | { readonly page_count?: unknown }
      | undefined;
    const sourcePageCount = sourcePage?.page_count;
    if (typeof sourcePageCount !== 'number' || !Number.isSafeInteger(sourcePageCount) ||
        sourcePageCount < 1) throw staticFailure('windows.deploy.backup_verification_failed');
    const copiedPages = await backup(db, backupPath);
    if (copiedPages !== sourcePageCount) throw staticFailure('windows.deploy.backup_verification_failed');
    const verified = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const integrity = verified.prepare('PRAGMA integrity_check').get() as
        | { readonly integrity_check?: unknown }
        | undefined;
      const destinationPage = verified.prepare('PRAGMA page_count').get() as
        | { readonly page_count?: unknown }
        | undefined;
      if (integrity?.integrity_check !== 'ok' || destinationPage?.page_count !== sourcePageCount ||
          readVersion(verified) !== version) {
        throw staticFailure('windows.deploy.backup_verification_failed');
      }
    } finally {
      verified.close();
    }
    return { version, backupPath };
  } finally {
    db.close();
    db = null;
  }
}

function transitionDesiredState(store: SqliteDigestStore, state: 'running' | 'stopped', now: Date): void {
  const current = store.readDaemonHealth();
  if (current === null || current.desiredState === state) return;
  const at = new Date(Math.max(now.getTime(), Date.parse(current.updatedAt) + 1)).toISOString();
  if (store.setDaemonDesiredState(state, at) === null) {
    throw staticFailure('windows.deploy.desired_state_failed');
  }
}

/**
 * Acquires the O1-4 closed-snapshot lease before looking at the DB, performs any v13 migration only
 * after a checkpointed verified backup, and returns the still-held lease to cover task mutation.
 */
export async function prepareDeploymentState(
  deployment: ValidatedWindowsDeployment,
  options: PrepareDeploymentStateOptions = {},
): Promise<PreparedDeploymentState> {
  if ((options.platform ?? process.platform) !== 'win32') {
    throw staticFailure('windows.deploy.unsupported_platform');
  }
  const leaseStore = options.leaseStore ?? new CurrentUserOperationalStatusCapabilityStore();
  const capabilityPath = operationalStatusCapabilityPath(deployment.paths.statePath);
  let lease: OperationalStatusSnapshotLease | null = await leaseStore.tryAcquireSnapshotLease(
    capabilityPath,
    operationalStatusStateIdentity(deployment.paths.statePath),
  );
  if (lease === null) throw staticFailure('windows.deploy.state_in_use');
  try {
    lease.assertHeld();
    const clock = options.clock ?? (() => new Date());
    const preflight = await checkpointAndBackup(
      deployment.paths.statePath,
      deployment.paths.appRoot,
      clock,
    );
    if (preflight.backupPath !== null) options.afterBackup?.(preflight.backupPath);
    options.beforeMigration?.(preflight.version);
    lease.assertHeld();
    const store = (options.openStore ?? ((path) => new SqliteDigestStore(path)))(deployment.paths.statePath);
    try {
      transitionDesiredState(store, 'running', clock());
    } finally {
      store.close();
    }
    lease.assertHeld();
    return {
      backupPath: preflight.backupPath,
      release: async () => {
        if (lease === null) return;
        const held = lease;
        lease = null;
        held.assertHeld();
        await held.release();
      },
    };
  } catch (error) {
    if (lease !== null) {
      const held = lease;
      lease = null;
      try { await held.release(); } catch { /* retain the original static failure */ }
    }
    throw error;
  }
}

/** Uninstall's intentional concurrent writer: exact v13 only, no create and no migration. */
export function setDeploymentDesiredStopped(
  statePath: string,
  clock: () => Date = () => new Date(),
): void {
  if (!existsSync(statePath)) throw staticFailure('windows.uninstall.state_absent');
  const db = new DatabaseSync(statePath);
  try {
    if (readVersion(db) !== SCHEMA_VERSION) {
      throw staticFailure('windows.uninstall.state_version_mismatch');
    }
    db.exec('PRAGMA busy_timeout = 5000');
    const requested = clock();
    if (!Number.isFinite(requested.getTime())) throw staticFailure('windows.uninstall.clock_invalid');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare(
        'SELECT desired_state, updated_at FROM daemon_health WHERE id = 1',
      ).get() as { readonly desired_state: unknown; readonly updated_at: unknown } | undefined;
      if (current === undefined || current.desired_state === 'stopped') {
        db.exec('COMMIT');
        return;
      }
      if (current.desired_state !== 'running' || typeof current.updated_at !== 'string' ||
          !Number.isFinite(Date.parse(current.updated_at))) {
        throw staticFailure('windows.uninstall.state_corrupt');
      }
      const at = new Date(Math.max(
        requested.getTime(),
        Date.parse(current.updated_at) + 1,
      )).toISOString();
      const result = db.prepare(`
        UPDATE daemon_health
           SET revision = revision + 1, desired_state = 'stopped', updated_at = ?
         WHERE id = 1 AND desired_state = 'running' AND updated_at <= ?`).run(at, at);
      if (Number(result.changes) !== 1) throw staticFailure('windows.uninstall.desired_state_conflict');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve static failure */ }
      throw error;
    }
  } finally {
    db.close();
  }
}
