import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import { join as nativeJoin, win32 } from 'node:path';
import { loadConfig, type ParsedBridgeConfig } from '../project/config.js';
import { APP_TOKEN_VAR, BOT_TOKEN_VAR } from '../slack/verify.js';
import { SCHEMA_VERSION } from '../store/schema.js';
import { SqliteDigestStore } from '../store/sqlite.js';
import {
  CurrentUserOperationalStatusCapabilityStore,
  operationalStatusCapabilityPath,
  operationalStatusStateIdentity,
  operationalStatusWindowsKnownAppData,
  operationalStatusWindowsKnownLocalAppData,
  operationalStatusWindowsTrustedPowerShell,
  type OperationalStatusSnapshotLease,
  type OperationalStatusSnapshotLeaseStore,
} from '../operational/status-capability.js';
import { fingerprintOperationalBuild } from '../operational/status.js';
import {
  windowsReleaseLauncherPath,
  windowsRuntimeManifestPath,
} from './runtime-manifest.js';
import { assertWindowsReleaseFilesystemSemantics } from './release-publication.js';

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
  readonly paths: WindowsDeploymentPaths & {
    readonly cliPath: string;
    readonly launcherPath: string;
    readonly powerShellPath: string;
    readonly runtimeManifestPath: string;
  };
  readonly buildDigest: string;
  readonly launcherSha256: string;
  readonly config: ParsedBridgeConfig;
};

export interface ExecutableVersionProbe {
  readVersion(executable: string): Promise<string>;
}

export interface CurrentUserEnvironmentPresenceProbe {
  requiredBridgeEnvironmentPresent(): Promise<boolean>;
}

export interface OrcaReadinessProbe {
  ready(
    executable: string,
    knownFolders: { readonly appData: string; readonly localAppData: string },
  ): Promise<boolean>;
}

/**
 * Maps logical Windows paths to the filesystem hosting a hermetic test fixture. Production keeps
 * both operations as native Windows filesystem calls; all lexical containment remains `win32`.
 */
export interface WindowsDeploymentPathAccess {
  canonicalize(windowsPath: string): string;
  toNativePath(windowsPath: string): string;
}

const NATIVE_WINDOWS_DEPLOYMENT_PATH_ACCESS: WindowsDeploymentPathAccess = {
  canonicalize: (windowsPath) => realpathSync.native(windowsPath),
  toNativePath: (windowsPath) => windowsPath,
};

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

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

/** Closed parser for the supported `orca status --json` readiness document. */
export function parseOrcaReadinessOutput(raw: string): boolean {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return false; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const top = value as Record<string, unknown>;
  if (!exactObjectKeys(top, ['id', 'ok', 'result', '_meta']) ||
      typeof top['id'] !== 'string' || top['id'].length === 0 || top['ok'] !== true ||
      top['result'] === null || typeof top['result'] !== 'object' || Array.isArray(top['result']) ||
      top['_meta'] === null || typeof top['_meta'] !== 'object' || Array.isArray(top['_meta'])) return false;
  const result = top['result'] as Record<string, unknown>;
  const meta = top['_meta'] as Record<string, unknown>;
  if (!exactObjectKeys(result, ['target', 'app', 'runtime', 'graph']) ||
      !exactObjectKeys(meta, ['runtimeId'])) return false;
  const target = result['target'];
  const app = result['app'];
  const runtime = result['runtime'];
  const graph = result['graph'];
  if (target === null || typeof target !== 'object' || Array.isArray(target) ||
      app === null || typeof app !== 'object' || Array.isArray(app) ||
      runtime === null || typeof runtime !== 'object' || Array.isArray(runtime) ||
      graph === null || typeof graph !== 'object' || Array.isArray(graph)) return false;
  const targetRecord = target as Record<string, unknown>;
  const appRecord = app as Record<string, unknown>;
  const runtimeRecord = runtime as Record<string, unknown>;
  const graphRecord = graph as Record<string, unknown>;
  if (!exactObjectKeys(targetRecord, ['kind']) || targetRecord['kind'] !== 'local' ||
      !exactObjectKeys(appRecord, ['running', 'pid', 'desktopWindowStatus']) ||
      appRecord['running'] !== true || appRecord['desktopWindowStatus'] !== 'available' ||
      typeof appRecord['pid'] !== 'number' || !Number.isSafeInteger(appRecord['pid']) ||
      appRecord['pid'] <= 0 ||
      !exactObjectKeys(runtimeRecord, [
        'state', 'reachable', 'runtimeId', 'appVersion', 'remoteUpdateSupport', 'capabilities',
      ]) || runtimeRecord['state'] !== 'ready' || runtimeRecord['reachable'] !== true ||
      typeof runtimeRecord['runtimeId'] !== 'string' || runtimeRecord['runtimeId'].length === 0 ||
      typeof runtimeRecord['appVersion'] !== 'string' || runtimeRecord['appVersion'].length === 0 ||
      !Array.isArray(runtimeRecord['capabilities']) ||
      !exactObjectKeys(graphRecord, ['state']) || graphRecord['state'] !== 'ready' ||
      meta['runtimeId'] !== runtimeRecord['runtimeId']) return false;
  const update = runtimeRecord['remoteUpdateSupport'];
  return update !== null && typeof update === 'object' && !Array.isArray(update) &&
    exactObjectKeys(update as Record<string, unknown>, ['installMode', 'automatic', 'reason']) &&
    typeof (update as Record<string, unknown>)['installMode'] === 'string' &&
    typeof (update as Record<string, unknown>)['automatic'] === 'boolean' &&
    typeof (update as Record<string, unknown>)['reason'] === 'string';
}

export class SpawnOrcaReadinessProbe implements OrcaReadinessProbe {
  constructor(private readonly timeoutMilliseconds = 10_000) {}

  async ready(
    executable: string,
    knownFolders: { readonly appData: string; readonly localAppData: string },
  ): Promise<boolean> {
    const env: NodeJS.ProcessEnv = {
      APPDATA: knownFolders.appData,
      LOCALAPPDATA: knownFolders.localAppData,
    };
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return await new Promise<boolean>((resolve, reject) => {
      const child = spawn(executable, ['status', '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) reject(error);
        else resolve(parseOrcaReadinessOutput(Buffer.concat(chunks).toString('utf8')));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(staticFailure('windows.deploy.orca_probe_failed'));
      }, this.timeoutMilliseconds);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          child.kill();
          finish(staticFailure('windows.deploy.orca_probe_failed'));
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.once('error', () => finish(staticFailure('windows.deploy.orca_probe_failed')));
      child.once('exit', (code) => {
        if (code === 0) finish();
        else finish(staticFailure('windows.deploy.orca_probe_failed'));
      });
    });
  }
}

const USER_ENVIRONMENT_PRESENCE_POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
$bot = [Environment]::GetEnvironmentVariable('ORCA_SLACK_BRIDGE_BOT_TOKEN', [EnvironmentVariableTarget]::User)
$app = [Environment]::GetEnvironmentVariable('ORCA_SLACK_BRIDGE_APP_TOKEN', [EnvironmentVariableTarget]::User)
$present = -not [String]::IsNullOrWhiteSpace($bot) -and -not [String]::IsNullOrWhiteSpace($app)
[Console]::Out.Write((@{ present = $present } | ConvertTo-Json -Compress))
`;

/** Reads presence only from Windows User scope and never returns or renders either value. */
export class WindowsUserEnvironmentPresenceProbe implements CurrentUserEnvironmentPresenceProbe {
  async requiredBridgeEnvironmentPresent(): Promise<boolean> {
    if (process.platform !== 'win32') throw staticFailure('windows.deploy.unsupported_platform');
    let trusted: ReturnType<typeof operationalStatusWindowsTrustedPowerShell>;
    try { trusted = operationalStatusWindowsTrustedPowerShell(); } catch {
      throw staticFailure('windows.deploy.user_environment_unavailable');
    }
    const encoded = Buffer.from(USER_ENVIRONMENT_PRESENCE_POWERSHELL, 'utf16le').toString('base64');
    return await new Promise<boolean>((resolve, reject) => {
      const child = spawn(trusted.executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encoded,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { SystemRoot: trusted.root, WINDIR: trusted.root },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) { reject(error); return; }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (value === null || typeof value !== 'object' ||
              typeof (value as { present?: unknown }).present !== 'boolean') throw new Error('invalid');
          resolve((value as { present: boolean }).present);
        } catch { reject(staticFailure('windows.deploy.user_environment_unavailable')); }
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(staticFailure('windows.deploy.user_environment_unavailable'));
      }, 5_000);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256) {
          child.kill();
          finish(staticFailure('windows.deploy.user_environment_unavailable'));
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.once('error', () => finish(staticFailure('windows.deploy.user_environment_unavailable')));
      child.once('exit', (code) => {
        if (code === 0) finish();
        else finish(staticFailure('windows.deploy.user_environment_unavailable'));
      });
    });
  }
}

export type ValidateWindowsDeploymentOptions = {
  readonly platform?: NodeJS.Platform;
  readonly versionProbe?: ExecutableVersionProbe;
  readonly environmentPresenceProbe?: CurrentUserEnvironmentPresenceProbe;
  readonly orcaReadinessProbe?: OrcaReadinessProbe;
  readonly pathAccess?: WindowsDeploymentPathAccess;
  readonly knownAppData?: () => string;
  readonly knownLocalAppData?: () => string;
  readonly trustedPowerShell?: () => { readonly executable: string };
};

function staticFailure(code: string): Error {
  return new Error(code);
}

function requireWindowsAbsolute(value: string, field: string): void {
  if (value.length === 0 || !win32.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw staticFailure(`windows.deploy.invalid_${field}`);
  }
}

function canonicalExisting(
  value: string,
  field: string,
  kind: 'file' | 'directory',
  pathAccess: WindowsDeploymentPathAccess,
): string {
  requireWindowsAbsolute(value, field);
  let canonical: string;
  try {
    canonical = pathAccess.canonicalize(value);
    requireWindowsAbsolute(canonical, field);
    const stats = statSync(pathAccess.toNativePath(canonical));
    if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) throw new Error('wrong kind');
  } catch {
    throw staticFailure(`windows.deploy.invalid_${field}`);
  }
  return canonical;
}

function canonicalCreatableDirectory(
  value: string,
  field: string,
  pathAccess: WindowsDeploymentPathAccess,
): string {
  requireWindowsAbsolute(value, field);
  try {
    mkdirSync(pathAccess.toNativePath(value), { recursive: true });
    return canonicalExisting(value, field, 'directory', pathAccess);
  } catch {
    throw staticFailure(`windows.deploy.invalid_${field}`);
  }
}

/** Resolves an existing prefix without creating the absent suffix. */
function canonicalFuturePath(
  value: string,
  field: string,
  kind: 'file' | 'directory',
  pathAccess: WindowsDeploymentPathAccess,
): string {
  requireWindowsAbsolute(value, field);
  try {
    if (existsSync(pathAccess.toNativePath(value))) {
      return canonicalExisting(value, field, kind, pathAccess);
    }
    const suffix: string[] = [];
    let cursor = value;
    while (!existsSync(pathAccess.toNativePath(cursor))) {
      const name = win32.basename(cursor);
      const parent = win32.dirname(cursor);
      if (name.length === 0 || name === '.' || name === '..' || sameWindowsPath(parent, cursor)) {
        throw new Error('invalid future path');
      }
      suffix.unshift(name);
      cursor = parent;
    }
    const ancestor = canonicalExisting(cursor, `${field}_ancestor`, 'directory', pathAccess);
    const canonical = win32.join(ancestor, ...suffix);
    if (!sameWindowsPath(canonical, win32.normalize(value))) throw new Error('noncanonical path');
    return canonical;
  } catch {
    throw staticFailure(`windows.deploy.invalid_${field}`);
  }
}

function prepareMutableDeploymentPaths(
  deployment: ValidatedWindowsDeployment,
  pathAccess: WindowsDeploymentPathAccess,
): void {
  try {
    mkdirSync(pathAccess.toNativePath(win32.dirname(deployment.paths.statePath)), { recursive: true });
    mkdirSync(pathAccess.toNativePath(deployment.paths.logDir), { recursive: true });
    const stateParent = canonicalExisting(
      win32.dirname(deployment.paths.statePath),
      'state_parent',
      'directory',
      pathAccess,
    );
    const logDir = canonicalExisting(deployment.paths.logDir, 'log_dir', 'directory', pathAccess);
    if (!sameWindowsPath(
      win32.join(stateParent, win32.basename(deployment.paths.statePath)),
      deployment.paths.statePath,
    ) || !sameWindowsPath(logDir, deployment.paths.logDir)) throw new Error('path raced');
    if (existsSync(pathAccess.toNativePath(deployment.paths.statePath))) {
      const state = canonicalExisting(deployment.paths.statePath, 'state', 'file', pathAccess);
      if (!sameWindowsPath(state, deployment.paths.statePath)) throw new Error('state raced');
    }
    verifyWritableDirectory(stateParent, 'state_directory', pathAccess);
    verifyWritableDirectory(logDir, 'log_directory', pathAccess);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('windows.deploy.')) throw error;
    throw staticFailure('windows.deploy.mutable_path_preparation_failed');
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = win32.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !win32.isAbsolute(relative));
}

function verifyWritableDirectory(
  directory: string,
  field: string,
  pathAccess: WindowsDeploymentPathAccess,
): void {
  const probe = win32.join(directory, `.orca-write-probe-${randomUUID()}`);
  const nativeProbe = pathAccess.toNativePath(probe);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(nativeProbe, 'wx');
    closeSync(descriptor);
    descriptor = null;
    unlinkSync(nativeProbe);
  } catch {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* static failure below */ }
    }
    try { if (existsSync(nativeProbe)) unlinkSync(nativeProbe); } catch { /* static failure below */ }
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

function configHasNoCredentialFields(
  path: string,
  pathAccess: WindowsDeploymentPathAccess,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pathAccess.toNativePath(path), 'utf8')) as unknown;
  } catch {
    throw staticFailure('windows.deploy.invalid_config');
  }
  if (containsSecretKey(parsed)) throw staticFailure('windows.deploy.config_contains_credentials');
}

function packageManifest(
  appRoot: string,
  pathAccess: WindowsDeploymentPathAccess,
): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(
      pathAccess.toNativePath(win32.join(appRoot, 'package.json')),
      'utf8',
    )) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch {
    throw staticFailure('windows.deploy.invalid_release_manifest');
  }
}

function verifyDeployedDependencies(
  appRoot: string,
  manifest: Record<string, unknown>,
  pathAccess: WindowsDeploymentPathAccess,
): void {
  const files = manifest['files'];
  const bin = manifest['bin'];
  const dependencies = manifest['dependencies'];
  if (manifest['name'] !== '@dev-infra/orca-slack-bridge' || !Array.isArray(files) ||
      !files.some((entry) => entry === 'dist' || entry === 'dist/**/*') ||
      !files.some((entry) => entry === 'windows/launch-daemon.ps1') ||
      bin === null || typeof bin !== 'object' ||
      (bin as Record<string, unknown>)['orca-slack-bridge'] !== './dist/cli.js' ||
      dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw staticFailure('windows.deploy.invalid_release_manifest');
  }
  verifyProductionDependencyClosure(appRoot, manifest, pathAccess);
}

export function canonicalWindowsReleaseRoot(
  digest: string,
  knownLocalAppData: () => string = operationalStatusWindowsKnownLocalAppData,
): string {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw staticFailure('windows.deploy.invalid_release_digest');
  const base = knownLocalAppData();
  requireWindowsAbsolute(base, 'local_app_data');
  if (win32.normalize(base) !== base) throw staticFailure('windows.deploy.local_app_data_unavailable');
  return win32.join(base, 'OrcaSlackBridge', 'releases', digest);
}

export function verifyCanonicalWindowsRelease(
  appRoot: string,
  digest: string,
  knownLocalAppData: () => string = operationalStatusWindowsKnownLocalAppData,
): boolean {
  try {
    return sameWindowsPath(realpathSync.native(appRoot), canonicalWindowsReleaseRoot(digest, knownLocalAppData)) &&
      win32.basename(appRoot) === digest && computeReleaseBuildDigest(appRoot) === digest;
  } catch { return false; }
}

function sameWindowsPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function dependencyNames(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw staticFailure('windows.deploy.invalid_release_manifest');
  }
  const dependencies = value as Record<string, unknown>;
  for (const [name, range] of Object.entries(dependencies)) {
    if (!/^(?:@[a-z0-9_.-]+\/[a-z0-9_.-]+|[a-z0-9_.-]+)$/iu.test(name) ||
        typeof range !== 'string' || range.length === 0) {
      throw staticFailure('windows.deploy.invalid_release_manifest');
    }
  }
  return Object.keys(dependencies).sort();
}

function resolveDependencyManifest(
  appRoot: string,
  packageRoot: string,
  dependency: string,
  pathAccess: WindowsDeploymentPathAccess,
): string | null {
  let current = packageRoot;
  while (isWithin(appRoot, current)) {
    const candidate = win32.join(current, 'node_modules', ...dependency.split('/'), 'package.json');
    if (existsSync(pathAccess.toNativePath(candidate))) return candidate;
    if (sameWindowsPath(current, appRoot)) break;
    current = win32.dirname(current);
  }
  return null;
}

function verifyProductionDependencyClosure(
  appRoot: string,
  rootManifest: Record<string, unknown>,
  pathAccess: WindowsDeploymentPathAccess,
): void {
  const pending: { readonly root: string; readonly manifest: Record<string, unknown> }[] = [
    { root: appRoot, manifest: rootManifest },
  ];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    const required = dependencyNames(current.manifest['dependencies']);
    const optional = dependencyNames(current.manifest['optionalDependencies']);
    for (const dependency of [...required, ...optional]) {
      const manifestPath = resolveDependencyManifest(appRoot, current.root, dependency, pathAccess);
      if (manifestPath === null) {
        if (optional.includes(dependency)) continue;
        throw staticFailure('windows.deploy.incomplete_dependencies');
      }
      let canonical: string;
      let parsed: unknown;
      try {
        canonical = pathAccess.canonicalize(manifestPath);
        if (!sameWindowsPath(canonical, manifestPath) || !isWithin(appRoot, canonical) ||
            !lstatSync(pathAccess.toNativePath(canonical)).isFile()) throw new Error('invalid dependency');
        parsed = JSON.parse(readFileSync(pathAccess.toNativePath(canonical), 'utf8')) as unknown;
      } catch {
        throw staticFailure('windows.deploy.incomplete_dependencies');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw staticFailure('windows.deploy.incomplete_dependencies');
      }
      const key = canonical.toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);
      pending.push({ root: win32.dirname(canonical), manifest: parsed as Record<string, unknown> });
    }
  }
}

type ReleaseEntry = {
  readonly kind: 'directory' | 'file';
  readonly relative: string;
  readonly nativePath: string;
  readonly identity: string;
  readonly size: bigint;
};

function releaseIdentity(path: string): {
  readonly identity: string;
  readonly file: boolean;
  readonly directory: boolean;
  readonly size: bigint;
} {
  const stats = lstatSync(path, { bigint: true });
  if (stats.isSymbolicLink()) throw staticFailure('windows.deploy.release_reparse_point');
  if (stats.isFile() && stats.nlink !== 1n) throw staticFailure('windows.deploy.release_hard_link');
  return {
    file: stats.isFile(),
    directory: stats.isDirectory(),
    size: stats.size,
    identity: [stats.dev, stats.ino, stats.size, stats.nlink, stats.mtimeNs, stats.ctimeNs]
      .map((value) => value.toString()).join(':'),
  };
}

function releaseDescriptorIdentity(descriptor: number): ReturnType<typeof releaseIdentity> {
  const stats = fstatSync(descriptor, { bigint: true });
  if (stats.isFile() && stats.nlink !== 1n) throw staticFailure('windows.deploy.release_hard_link');
  return {
    file: stats.isFile(),
    directory: stats.isDirectory(),
    size: stats.size,
    identity: [stats.dev, stats.ino, stats.size, stats.nlink, stats.mtimeNs, stats.ctimeNs]
      .map((value) => value.toString()).join(':'),
  };
}

function collectReleaseEntries(
  root: string,
  pathAccess: WindowsDeploymentPathAccess,
): readonly ReleaseEntry[] {
  const result: ReleaseEntry[] = [];
  const normalizedPaths = new Set<string>();
  const visit = (directory: string, relative: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(pathAccess.toNativePath(directory), { encoding: 'utf8' }).sort();
    } catch { throw staticFailure('windows.deploy.invalid_release_tree'); }
    for (const entry of entries) {
      if (entry.normalize('NFC') !== entry || /[\0\\/]/u.test(entry) || /[. ]$/u.test(entry)) {
        throw staticFailure('windows.deploy.invalid_release_name');
      }
      const childRelative = win32.join(relative, entry);
      const child = win32.join(root, childRelative);
      const nativeChild = pathAccess.toNativePath(child);
      let identity: ReturnType<typeof releaseIdentity>;
      try {
        identity = releaseIdentity(nativeChild);
        const canonical = pathAccess.canonicalize(child);
        if (!sameWindowsPath(canonical, child) || !isWithin(root, canonical)) {
          throw new Error('release escape');
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('windows.deploy.')) throw error;
        throw staticFailure('windows.deploy.release_reparse_point');
      }
      if (!identity.file && !identity.directory) {
        throw staticFailure('windows.deploy.invalid_release_file');
      }
      const relativeForDigest = childRelative.replaceAll('\\', '/');
      const normalizedKey = relativeForDigest.normalize('NFC').toLowerCase();
      if (normalizedPaths.has(normalizedKey)) {
        throw staticFailure('windows.deploy.release_path_collision');
      }
      normalizedPaths.add(normalizedKey);
      result.push({
        kind: identity.directory ? 'directory' : 'file',
        relative: relativeForDigest,
        nativePath: nativeChild,
        identity: identity.identity,
        size: identity.size,
      });
      if (identity.directory) visit(child, childRelative);
    }
  };
  visit(root, '');
  return result;
}

function updateLength(hash: ReturnType<typeof createHash>, length: bigint): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(length);
  hash.update(encoded);
}

function normalizeReleaseTextFile(path: string): void {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) throw new Error('invalid file');
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('bom');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const normalized = Buffer.from(text.replace(/\r\n?/gu, '\n'), 'utf8');
    if (!bytes.equals(normalized)) writeFileSync(path, normalized);
  } catch {
    throw staticFailure('windows.stage.invalid_app_owned_text');
  }
}

/** Canonicalizes only app-owned text; production dependency bytes remain byte-for-byte intact. */
export function normalizeWindowsReleaseTextFiles(nativeReleaseRoot: string): void {
  const dist = nativeJoin(nativeReleaseRoot, 'dist');
  const visit = (directory: string): void => {
    let entries: string[];
    try {
      const stats = lstatSync(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('invalid directory');
      entries = readdirSync(directory, { encoding: 'utf8' }).sort();
    } catch {
      throw staticFailure('windows.stage.invalid_app_owned_text');
    }
    for (const entry of entries) {
      const path = nativeJoin(directory, entry);
      let stats: ReturnType<typeof lstatSync>;
      try { stats = lstatSync(path); } catch {
        throw staticFailure('windows.stage.invalid_app_owned_text');
      }
      if (stats.isDirectory() && !stats.isSymbolicLink()) visit(path);
      else normalizeReleaseTextFile(path);
    }
  };
  visit(dist);
  normalizeReleaseTextFile(nativeJoin(nativeReleaseRoot, 'windows', 'launch-daemon.ps1'));
}

export function computeReleaseBuildDigest(
  appRoot: string,
  pathAccess: WindowsDeploymentPathAccess = NATIVE_WINDOWS_DEPLOYMENT_PATH_ACCESS,
): string {
  const requiresNativeWindowsSemantics = process.platform === 'win32' &&
    pathAccess === NATIVE_WINDOWS_DEPLOYMENT_PATH_ACCESS;
  if (requiresNativeWindowsSemantics) assertWindowsReleaseFilesystemSemantics(appRoot);
  let rootBefore: ReturnType<typeof releaseIdentity>;
  try {
    rootBefore = releaseIdentity(pathAccess.toNativePath(appRoot));
    if (!rootBefore.directory || !sameWindowsPath(pathAccess.canonicalize(appRoot), appRoot)) {
      throw new Error('invalid root');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('windows.deploy.')) throw error;
    throw staticFailure('windows.deploy.invalid_release_tree');
  }
  const manifest = packageManifest(appRoot, pathAccess);
  verifyDeployedDependencies(appRoot, manifest, pathAccess);
  const before = collectReleaseEntries(appRoot, pathAccess);
  const hash = createHash('sha256');
  hash.update('orca-slack-bridge-release-v2\0', 'utf8');
  for (const entry of before) {
    hash.update(entry.kind === 'directory' ? 'D' : 'F', 'ascii');
    const name = Buffer.from(entry.relative, 'utf8');
    updateLength(hash, BigInt(name.length));
    hash.update(name);
    if (entry.kind === 'file') {
      let descriptor: number | null = null;
      let bytes: Buffer;
      try {
        descriptor = openSync(entry.nativePath, 'r');
        const immediatelyBefore = releaseDescriptorIdentity(descriptor);
        if (!immediatelyBefore.file || immediatelyBefore.identity !== entry.identity) {
          throw staticFailure('windows.deploy.release_changed');
        }
        bytes = readFileSync(descriptor);
        const afterRead = releaseDescriptorIdentity(descriptor);
        if (!afterRead.file || afterRead.identity !== entry.identity ||
            BigInt(bytes.length) !== entry.size) throw staticFailure('windows.deploy.release_changed');
      } finally {
        if (descriptor !== null) closeSync(descriptor);
      }
      const afterPathRead = releaseIdentity(entry.nativePath);
      if (!afterPathRead.file || afterPathRead.identity !== entry.identity) {
        throw staticFailure('windows.deploy.release_changed');
      }
      updateLength(hash, BigInt(bytes.length));
      hash.update(bytes);
    }
  }
  const after = collectReleaseEntries(appRoot, pathAccess);
  if (JSON.stringify(after.map(({ kind, relative, identity }) => ({ kind, relative, identity }))) !==
      JSON.stringify(before.map(({ kind, relative, identity }) => ({ kind, relative, identity })))) {
    throw staticFailure('windows.deploy.release_changed');
  }
  const rootAfter = releaseIdentity(pathAccess.toNativePath(appRoot));
  if (!rootAfter.directory || rootAfter.identity !== rootBefore.identity ||
      !sameWindowsPath(pathAccess.canonicalize(appRoot), appRoot)) {
    throw staticFailure('windows.deploy.release_changed');
  }
  if (requiresNativeWindowsSemantics) assertWindowsReleaseFilesystemSemantics(appRoot);
  return hash.digest('hex');
}

export async function validateWindowsDeployment(
  input: WindowsDeploymentPaths,
  options: ValidateWindowsDeploymentOptions = {},
): Promise<ValidatedWindowsDeployment> {
  if ((options.platform ?? process.platform) !== 'win32') {
    throw staticFailure('windows.deploy.unsupported_platform');
  }
  const pathAccess = options.pathAccess ?? NATIVE_WINDOWS_DEPLOYMENT_PATH_ACCESS;
  const appRoot = canonicalExisting(input.appRoot, 'app_root', 'directory', pathAccess);
  let localAppData: string;
  let appData: string;
  try {
    localAppData = canonicalExisting(
      (options.knownLocalAppData ?? operationalStatusWindowsKnownLocalAppData)(),
      'local_app_data',
      'directory',
      pathAccess,
    );
  } catch {
    throw staticFailure('windows.deploy.local_app_data_unavailable');
  }
  try {
    appData = canonicalExisting(
      (options.knownAppData ?? operationalStatusWindowsKnownAppData)(),
      'app_data',
      'directory',
      pathAccess,
    );
  } catch {
    throw staticFailure('windows.deploy.app_data_unavailable');
  }
  const buildDigest = computeReleaseBuildDigest(appRoot, pathAccess);
  const expectedReleaseRoot = win32.join(
    localAppData,
    'OrcaSlackBridge',
    'releases',
    buildDigest,
  );
  if (!sameWindowsPath(appRoot, expectedReleaseRoot) || win32.basename(appRoot) !== buildDigest) {
    throw staticFailure('windows.deploy.noncanonical_release_root');
  }
  const nodePath = canonicalExisting(input.nodePath, 'node', 'file', pathAccess);
  const orcaPath = canonicalExisting(input.orcaPath, 'orca', 'file', pathAccess);
  const configPath = canonicalExisting(input.configPath, 'config', 'file', pathAccess);
  const statePath = canonicalFuturePath(input.statePath, 'state', 'file', pathAccess);
  const logDir = canonicalFuturePath(input.logDir, 'log_dir', 'directory', pathAccess);
  if (isWithin(appRoot, statePath) || isWithin(appRoot, logDir)) {
    throw staticFailure('windows.deploy.mutable_path_inside_release');
  }
  const cliPath = canonicalExisting(
    win32.join(appRoot, 'dist', 'cli.js'),
    'cli',
    'file',
    pathAccess,
  );
  const launcherPath = canonicalExisting(
    windowsReleaseLauncherPath(appRoot),
    'launcher',
    'file',
    pathAccess,
  );
  const launcherSha256 = createHash('sha256')
    .update(readFileSync(pathAccess.toNativePath(launcherPath)))
    .digest('hex');
  let powerShellPath: string;
  try {
    powerShellPath = canonicalExisting(
      (options.trustedPowerShell ?? operationalStatusWindowsTrustedPowerShell)().executable,
      'powershell',
      'file',
      pathAccess,
    );
  } catch {
    throw staticFailure('windows.deploy.powershell_unavailable');
  }
  const runtimeManifestPath = windowsRuntimeManifestPath(() => localAppData);
  const version = await (options.versionProbe ?? new SpawnExecutableVersionProbe()).readVersion(nodePath);
  const match = /^v([0-9]+)(?:\.|$)/u.exec(version);
  if (match === null || Number(match[1]) < REQUIRED_NODE_MAJOR) {
    throw staticFailure('windows.deploy.unsupported_node');
  }
  try {
    if (!await (options.orcaReadinessProbe ?? new SpawnOrcaReadinessProbe()).ready(
      orcaPath,
      { appData, localAppData },
    )) {
      throw new Error('not ready');
    }
  } catch {
    throw staticFailure('windows.deploy.orca_not_ready');
  }
  configHasNoCredentialFields(configPath, pathAccess);
  let config: ParsedBridgeConfig;
  try {
    config = await loadConfig(pathAccess.toNativePath(configPath));
  } catch {
    throw staticFailure('windows.deploy.invalid_config');
  }
  if (config.slack === null) throw staticFailure('windows.deploy.slack_config_required');
  if (!await (options.environmentPresenceProbe ??
      new WindowsUserEnvironmentPresenceProbe()).requiredBridgeEnvironmentPresent()) {
    throw staticFailure('windows.deploy.required_environment_absent');
  }
  return {
    paths: {
      appRoot, nodePath, orcaPath, configPath, statePath, logDir, cliPath,
      launcherPath, powerShellPath, runtimeManifestPath,
    },
    buildDigest,
    launcherSha256,
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
  readonly resolveSnapshotLeaseIdentity?: (
    statePath: string,
    platform: NodeJS.Platform,
  ) => { readonly capabilityPath: string; readonly stateIdentity: string };
  readonly pathAccess?: WindowsDeploymentPathAccess;
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
  pathAccess: WindowsDeploymentPathAccess,
): Promise<{ readonly version: number | null; readonly backupPath: string | null }> {
  const nativeStatePath = pathAccess.toNativePath(statePath);
  if (!existsSync(nativeStatePath)) return { version: null, backupPath: null };
  let version: number | null;
  try {
    const inspection = new DatabaseSync(nativeStatePath, { readOnly: true });
    try { version = readVersion(inspection); } finally { inspection.close(); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('windows.deploy.')) throw error;
    throw staticFailure('windows.deploy.state_version_invalid');
  }
  if (version === null) throw staticFailure('windows.deploy.state_unversioned');
  if (version === SCHEMA_VERSION) return { version, backupPath: null };
  if (version < 1 || version > SCHEMA_VERSION) {
    throw staticFailure('windows.deploy.state_version_unsupported');
  }
  const db = new DatabaseSync(nativeStatePath);
  try {
    if (readVersion(db) !== version) throw staticFailure('windows.deploy.state_version_changed');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { readonly busy?: unknown }
      | undefined;
    if (checkpoint === undefined || checkpoint.busy !== 0) {
      throw staticFailure('windows.deploy.wal_checkpoint_failed');
    }
    const backupDirectory = win32.join(win32.dirname(statePath), 'orca-slack-bridge-backups');
    mkdirSync(pathAccess.toNativePath(backupDirectory), { recursive: true });
    const canonicalBackupDirectory = canonicalExisting(
      backupDirectory,
      'backup_directory',
      'directory',
      pathAccess,
    );
    if (isWithin(appRoot, canonicalBackupDirectory)) {
      throw staticFailure('windows.deploy.backup_inside_release');
    }
    const backupPath = win32.join(canonicalBackupDirectory, backupFileName(clock));
    const nativeBackupPath = pathAccess.toNativePath(backupPath);
    if (existsSync(nativeBackupPath)) throw staticFailure('windows.deploy.backup_exists');
    const sourcePage = db.prepare('PRAGMA page_count').get() as
      | { readonly page_count?: unknown }
      | undefined;
    const sourcePageCount = sourcePage?.page_count;
    if (typeof sourcePageCount !== 'number' || !Number.isSafeInteger(sourcePageCount) ||
        sourcePageCount < 1) throw staticFailure('windows.deploy.backup_verification_failed');
    const copiedPages = await backup(db, nativeBackupPath);
    if (copiedPages !== sourcePageCount) throw staticFailure('windows.deploy.backup_verification_failed');
    const verified = new DatabaseSync(nativeBackupPath, { readOnly: true });
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
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw staticFailure('windows.deploy.unsupported_platform');
  }
  const pathAccess = options.pathAccess ?? NATIVE_WINDOWS_DEPLOYMENT_PATH_ACCESS;
  prepareMutableDeploymentPaths(deployment, pathAccess);
  const leaseStore = options.leaseStore ??
    new CurrentUserOperationalStatusCapabilityStore(platform, process.env);
  const leaseIdentity = options.resolveSnapshotLeaseIdentity?.(
    deployment.paths.statePath,
    platform,
  ) ?? {
    capabilityPath: operationalStatusCapabilityPath(
      deployment.paths.statePath,
      process.env,
      platform,
    ),
    stateIdentity: operationalStatusStateIdentity(deployment.paths.statePath, platform),
  };
  let lease: OperationalStatusSnapshotLease | null = await leaseStore.tryAcquireSnapshotLease(
    leaseIdentity.capabilityPath,
    leaseIdentity.stateIdentity,
  );
  if (lease === null) throw staticFailure('windows.deploy.state_in_use');
  try {
    lease.assertHeld();
    const clock = options.clock ?? (() => new Date());
    const preflight = await checkpointAndBackup(
      deployment.paths.statePath,
      deployment.paths.appRoot,
      clock,
      pathAccess,
    );
    if (preflight.backupPath !== null) options.afterBackup?.(preflight.backupPath);
    options.beforeMigration?.(preflight.version);
    lease.assertHeld();
    const store = (options.openStore ?? ((path) => new SqliteDigestStore(path)))(
      pathAccess.toNativePath(deployment.paths.statePath),
    );
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

type UninstallDaemonHealthRow = {
  readonly revision: number;
  readonly instance_id: string;
  readonly build_fingerprint: string;
  readonly config_fingerprint: string;
  readonly desired_state: 'running' | 'stopped';
  readonly state: 'running' | 'stopped';
  readonly started_at: string;
  readonly updated_at: string;
};

export type DeploymentDaemonHealthLease =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'present';
      readonly revision: number;
      readonly instanceId: string;
      readonly buildFingerprint: string;
      readonly configFingerprint: string;
      readonly desiredState: 'running' | 'stopped';
      readonly state: 'running' | 'stopped';
      readonly startedAt: string;
      readonly updatedAt: string;
    };

function validatedUninstallDaemonHealth(
  db: DatabaseSync,
  expectedBuildIdentity?: string,
): UninstallDaemonHealthRow | undefined {
  if (readVersion(db) !== SCHEMA_VERSION) {
    throw staticFailure('windows.uninstall.state_version_mismatch');
  }
  const current = db.prepare(
    `SELECT revision, instance_id, build_fingerprint, config_fingerprint,
            desired_state, state, started_at, updated_at
       FROM daemon_health WHERE id = 1`,
  ).get() as Record<string, unknown> | undefined;
  if (current === undefined) return undefined;
  if (typeof current['revision'] !== 'number' || !Number.isSafeInteger(current['revision']) ||
      current['revision'] < 0 || typeof current['instance_id'] !== 'string' ||
      current['instance_id'].length < 1 || typeof current['build_fingerprint'] !== 'string' ||
      typeof current['config_fingerprint'] !== 'string' ||
      (current['desired_state'] !== 'running' && current['desired_state'] !== 'stopped') ||
      (current['state'] !== 'running' && current['state'] !== 'stopped') ||
      typeof current['started_at'] !== 'string' || !Number.isFinite(Date.parse(current['started_at'])) ||
      typeof current['updated_at'] !== 'string' ||
      !Number.isFinite(Date.parse(current['updated_at']))) {
    throw staticFailure('windows.uninstall.state_corrupt');
  }
  if (expectedBuildIdentity !== undefined &&
      current['build_fingerprint'] !== fingerprintOperationalBuild(expectedBuildIdentity)) {
    throw staticFailure('windows.uninstall.state_identity_mismatch');
  }
  return current as UninstallDaemonHealthRow;
}

function uninstallDaemonHealthLease(
  row: UninstallDaemonHealthRow | undefined,
): DeploymentDaemonHealthLease {
  return row === undefined ? { kind: 'absent' } : {
    kind: 'present',
    revision: row.revision,
    instanceId: row.instance_id,
    buildFingerprint: row.build_fingerprint,
    configFingerprint: row.config_fingerprint,
    desiredState: row.desired_state,
    state: row.state,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function sameDaemonHealthLease(
  current: UninstallDaemonHealthRow | undefined,
  expected: DeploymentDaemonHealthLease,
): boolean {
  if (current === undefined || expected.kind === 'absent') {
    return current === undefined && expected.kind === 'absent';
  }
  return current.revision === expected.revision && current.instance_id === expected.instanceId &&
    current.build_fingerprint === expected.buildFingerprint &&
    current.config_fingerprint === expected.configFingerprint &&
    current.desired_state === expected.desiredState && current.state === expected.state &&
    current.started_at === expected.startedAt && current.updated_at === expected.updatedAt;
}

/** Read-only ownership precondition used before the task is disabled. */
export function verifyDeploymentDaemonBuildIdentity(
  statePath: string,
  expectedBuildIdentity: string,
): DeploymentDaemonHealthLease {
  if (!existsSync(statePath)) throw staticFailure('windows.uninstall.state_absent');
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    return uninstallDaemonHealthLease(
      validatedUninstallDaemonHealth(db, expectedBuildIdentity),
    );
  } finally { db.close(); }
}

/** Uninstall's intentional concurrent writer: exact v13 only, no create and no migration. */
export function setDeploymentDesiredStopped(
  statePath: string,
  expectedBuildIdentity: string,
  expectedHealth: DeploymentDaemonHealthLease,
  clock: () => Date = () => new Date(),
): void {
  if (!existsSync(statePath)) throw staticFailure('windows.uninstall.state_absent');
  const db = new DatabaseSync(statePath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const requested = clock();
    if (!Number.isFinite(requested.getTime())) throw staticFailure('windows.uninstall.clock_invalid');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = validatedUninstallDaemonHealth(db, expectedBuildIdentity);
      if (!sameDaemonHealthLease(current, expectedHealth)) {
        throw staticFailure('windows.uninstall.desired_state_conflict');
      }
      if (current === undefined) {
        db.exec('COMMIT');
        return;
      }
      if (current.desired_state === 'stopped') {
        db.exec('COMMIT');
        return;
      }
      const at = new Date(Math.max(
        requested.getTime(),
        Date.parse(current.updated_at) + 1,
      )).toISOString();
      const result = db.prepare(`
        UPDATE daemon_health
         SET revision = revision + 1, desired_state = 'stopped', updated_at = ?
         WHERE id = 1 AND revision = ? AND instance_id = ? AND build_fingerprint = ?
           AND config_fingerprint = ? AND desired_state = 'running' AND state = ?
           AND started_at = ? AND updated_at = ?`)
        .run(
          at, current.revision, current.instance_id, current.build_fingerprint,
          current.config_fingerprint, current.state, current.started_at, current.updated_at,
        );
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
