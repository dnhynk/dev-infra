import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const STATUS_OWNER_CAPABILITY_VERSION = 2;
export const STATUS_OWNER_CAPABILITY_MAX_AGE_MS = 30_000;
export const STATUS_OWNER_CAPABILITY_FUTURE_TOLERANCE_MS = 1_000;
export const STATUS_OWNER_CAPABILITY_ROTATE_AFTER_MS = 15_000;
const STATUS_OWNER_CAPABILITY_MAX_BYTES = 1_024;
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export type OperationalStatusTransportEndpoint =
  | { readonly kind: 'tcp'; readonly host: '127.0.0.1'; readonly port: number }
  | { readonly kind: 'pipe'; readonly path: string };

export type ActiveOperationalStatusCapability = {
  readonly version: 2;
  readonly status: 'active';
  readonly stateIdentity: string;
  readonly capabilityId: string;
  readonly transport: OperationalStatusTransportEndpoint;
  readonly publishedAt: string;
  readonly secret: string;
};

export type RetiredOperationalStatusCapability = {
  readonly version: 2;
  readonly status: 'retired';
  readonly stateIdentity: string;
  readonly capabilityId: string;
  readonly transport: OperationalStatusTransportEndpoint;
  readonly retiredAt: string;
};

export type OperationalStatusCapabilityDocument =
  | ActiveOperationalStatusCapability
  | RetiredOperationalStatusCapability;

export type OperationalStatusCapabilityRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ready'; readonly value: OperationalStatusCapabilityDocument };

export type OperationalStatusCapabilityStore = {
  read(path: string, enforceProtection?: boolean): OperationalStatusCapabilityRead;
  publish(path: string, document: OperationalStatusCapabilityDocument): void;
  remove(path: string, expected: RetiredOperationalStatusCapability): void;
};

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key)) ? record : null;
}

function parseTransport(value: unknown): OperationalStatusTransportEndpoint | null {
  const kind = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)['kind']
    : null;
  const record = exactRecord(value, kind === 'tcp' ? ['kind', 'host', 'port'] : ['kind', 'path']);
  if (record === null) return null;
  if (record['kind'] === 'tcp') {
    return record['host'] === '127.0.0.1' && Number.isSafeInteger(record['port']) &&
        Number(record['port']) >= 1 && Number(record['port']) <= 65_535
      ? record as unknown as OperationalStatusTransportEndpoint
      : null;
  }
  return record['kind'] === 'pipe' && typeof record['path'] === 'string' &&
      record['path'].length >= 1 && record['path'].length <= 256
    ? record as unknown as OperationalStatusTransportEndpoint
    : null;
}

function parseDocument(value: unknown): OperationalStatusCapabilityDocument | null {
  const common = exactRecord(value, value !== null && typeof value === 'object' &&
    (value as Record<string, unknown>)['status'] === 'active'
    ? ['version', 'status', 'stateIdentity', 'capabilityId', 'transport', 'publishedAt', 'secret']
    : ['version', 'status', 'stateIdentity', 'capabilityId', 'transport', 'retiredAt']);
  if (common === null || common['version'] !== STATUS_OWNER_CAPABILITY_VERSION ||
      typeof common['stateIdentity'] !== 'string' || !HEX_64.test(common['stateIdentity']) ||
      typeof common['capabilityId'] !== 'string' || !HEX_32.test(common['capabilityId']) ||
      parseTransport(common['transport']) === null) return null;
  if (common['status'] === 'active') {
    if (!canonicalIso(common['publishedAt']) ||
        typeof common['secret'] !== 'string' || !HEX_64.test(common['secret'])) return null;
    return common as unknown as ActiveOperationalStatusCapability;
  }
  if (common['status'] !== 'retired' || !canonicalIso(common['retiredAt'])) return null;
  return common as unknown as RetiredOperationalStatusCapability;
}

export function operationalStatusStateIdentity(
  statePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const canonical = platform === 'win32' ? resolve(statePath).toLowerCase() : resolve(statePath);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function operationalStatusCapabilityPath(
  statePath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const stateIdentity = operationalStatusStateIdentity(statePath, platform);
  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'] ?? env['APPDATA'];
    if (base === undefined || !isAbsolute(base)) throw new Error('status.capability_path_unavailable');
    return join(base, 'orca-slack-bridge-status-v2', `owner-${stateIdentity.slice(0, 24)}.json`);
  }
  const configured = env['XDG_RUNTIME_DIR'];
  const base = configured !== undefined && isAbsolute(configured) ? configured : tmpdir();
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return join(base, `orca-slack-bridge-status-v2-${user}`, `owner-${stateIdentity.slice(0, 24)}.json`);
}

export function activeOperationalStatusCapability(
  stateIdentity: string,
  transport: OperationalStatusTransportEndpoint,
  publishedAt: string,
): ActiveOperationalStatusCapability {
  return {
    version: 2,
    status: 'active',
    stateIdentity,
    capabilityId: randomBytes(16).toString('hex'),
    transport,
    publishedAt,
    secret: randomBytes(32).toString('hex'),
  };
}

export function retiredOperationalStatusCapability(
  active: ActiveOperationalStatusCapability,
  retiredAt: string,
): RetiredOperationalStatusCapability {
  return {
    version: 2,
    status: 'retired',
    stateIdentity: active.stateIdentity,
    capabilityId: active.capabilityId,
    transport: active.transport,
    retiredAt,
  };
}

export function operationalStatusCapabilityIsFresh(
  capability: ActiveOperationalStatusCapability,
  now: Date,
): boolean {
  const age = now.getTime() - Date.parse(capability.publishedAt);
  return age >= -STATUS_OWNER_CAPABILITY_FUTURE_TOLERANCE_MS &&
    age <= STATUS_OWNER_CAPABILITY_MAX_AGE_MS;
}

export function operationalStatusWindowsPowerShellEnvironment(
  root: string,
  path: string,
  kind: 'directory' | 'file' | 'artifact',
): NodeJS.ProcessEnv {
  return {
    SystemRoot: root,
    WINDIR: root,
    ORCA_STATUS_CAPABILITY_PATH: path,
    ORCA_STATUS_CAPABILITY_KIND: kind,
  };
}

const WINDOWS_PROTECT_DIRECTORY = String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('ORCA_STATUS_CAPABILITY_PATH', 'Process')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$item = [IO.DirectoryInfo]::new($path)
$sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
$acl = $item.GetAccessControl($sections)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$access = [Security.AccessControl.AccessControlType]::Allow
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, $propagation, $access)
[void]$acl.AddAccessRule($rule)
$acl.SetOwner($sid)
$item.SetAccessControl($acl)
`;

const WINDOWS_VERIFY_PATH = String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('ORCA_STATUS_CAPABILITY_PATH', 'Process')
$kind = [Environment]::GetEnvironmentVariable('ORCA_STATUS_CAPABILITY_KIND', 'Process')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Assert-ProtectedPath([string]$candidate, [bool]$directory) {
  $item = if ($directory) { [IO.DirectoryInfo]::new($candidate) } else { [IO.FileInfo]::new($candidate) }
  if (-not $item.Exists) { exit 11 }
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $acl = $item.GetAccessControl($sections)
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($owner -ne $sid -or $rules.Count -ne 1) { exit 12 }
  $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $sid -or
      $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
       [Security.AccessControl.FileSystemRights]::FullControl)) { exit 13 }
  if ($directory -and -not $acl.AreAccessRulesProtected) { exit 14 }
}
if ($kind -eq 'artifact') {
  Assert-ProtectedPath ([IO.Path]::GetDirectoryName($path)) $true
  Assert-ProtectedPath $path $false
} else {
  Assert-ProtectedPath $path ($kind -eq 'directory')
}
[Console]::Out.Write('ok')
`;

export class CurrentUserOperationalStatusCapabilityStore implements OperationalStatusCapabilityStore {
  private readonly protectionWitnesses = new Map<string, string>();

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly replaceFile: (source: string, destination: string) => void = renameSync,
  ) {}

  read(path: string, enforceProtection = true): OperationalStatusCapabilityRead {
    try {
      const parent = dirname(path);
      if (!existsSync(parent)) return { kind: 'absent' };
      if (!existsSync(path)) {
        if (enforceProtection) this.verifyProtectedPath(parent, true);
        return { kind: 'absent' };
      }
      if (enforceProtection) this.verifyProtectedArtifact(path);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 ||
          stat.size > STATUS_OWNER_CAPABILITY_MAX_BYTES) return { kind: 'invalid' };
      const document = parseDocument(JSON.parse(readFileSync(path, 'utf8')));
      return document === null ? { kind: 'invalid' } : { kind: 'ready', value: document };
    } catch {
      return { kind: 'invalid' };
    }
  }

  publish(path: string, document: OperationalStatusCapabilityDocument): void {
    const serialized = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
    if (serialized.length > STATUS_OWNER_CAPABILITY_MAX_BYTES || parseDocument(document) === null) {
      throw new Error('status.capability_publish_failed');
    }
    const parent = dirname(path);
    this.ensureProtectedDirectory(parent);
    const temporary = join(parent, `.owner-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    let descriptor: number | null = null;
    let installed = false;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, serialized);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      if (this.platform !== 'win32') chmodSync(temporary, 0o600);
      this.replaceFile(temporary, path);
      installed = true;
      this.verifyProtectedArtifact(path);
      const observed = this.read(path, false);
      if (observed.kind !== 'ready' || JSON.stringify(observed.value) !== JSON.stringify(document)) {
        throw new Error('status.capability_publish_failed');
      }
      this.syncDirectory(parent);
    } catch {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* bounded best effort */ }
      }
      try { rmSync(temporary, { force: true }); } catch { /* bounded best effort */ }
      if (installed) {
        try {
          const observed = this.read(path, false);
          if (observed.kind === 'ready' &&
              JSON.stringify(observed.value) === JSON.stringify(document)) unlinkSync(path);
        } catch { /* never remove a raced replacement */ }
      }
      throw new Error('status.capability_publish_failed');
    }
  }

  remove(path: string, expected: RetiredOperationalStatusCapability): void {
    const observed = this.read(path);
    if (observed.kind === 'absent') return;
    if (observed.kind !== 'ready' || JSON.stringify(observed.value) !== JSON.stringify(expected)) {
      throw new Error('status.capability_remove_failed');
    }
    try {
      unlinkSync(path);
      this.syncDirectory(dirname(path));
    } catch {
      throw new Error('status.capability_remove_failed');
    }
  }

  private ensureProtectedDirectory(path: string): void {
    if (!existsSync(path)) {
      try {
        let created = false;
        try {
          mkdirSync(path, { mode: 0o700 });
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        if (created) {
          if (this.platform === 'win32') {
            this.runWindows(WINDOWS_PROTECT_DIRECTORY, path, 'directory');
          } else {
            chmodSync(path, 0o700);
          }
        }
      } catch {
        throw new Error('status.capability_permission_failed');
      }
    }
    this.verifyProtectedPath(path, true);
  }

  private verifyProtectedPath(path: string, directory: boolean): void {
    const before = this.protectionWitness(path, directory);
    if (this.protectionWitnesses.get(path) === before) return;
    if (this.platform === 'win32') {
      this.runWindows(WINDOWS_VERIFY_PATH, path, directory ? 'directory' : 'file');
    } else {
      const stat = statSync(path);
      const expectedUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
      const expectedMode = directory ? 0o700 : 0o600;
      if (stat.uid !== expectedUid || (stat.mode & 0o777) !== expectedMode) {
        throw new Error('status.capability_permission_failed');
      }
    }
    this.protectionWitnesses.set(path, this.protectionWitness(path, directory));
  }

  private verifyProtectedArtifact(path: string): void {
    if (this.platform === 'win32') {
      const parent = dirname(path);
      const parentWitness = this.protectionWitness(parent, true);
      const fileWitness = this.protectionWitness(path, false);
      if (this.protectionWitnesses.get(parent) === parentWitness &&
          this.protectionWitnesses.get(path) === fileWitness) return;
      this.runWindows(WINDOWS_VERIFY_PATH, path, 'artifact');
      this.protectionWitnesses.set(parent, this.protectionWitness(parent, true));
      this.protectionWitnesses.set(path, this.protectionWitness(path, false));
      return;
    }
    this.verifyProtectedPath(dirname(path), true);
    this.verifyProtectedPath(path, false);
  }

  private protectionWitness(path: string, directory: boolean): string {
    const entry = lstatSync(path, { bigint: true });
    if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) {
      throw new Error('status.capability_permission_failed');
    }
    return [
      directory ? 'd' : 'f', entry.dev, entry.ino, entry.mode, entry.size,
      entry.birthtimeNs, entry.ctimeNs, entry.mtimeNs,
    ].join(':');
  }

  private runWindows(script: string, path: string, kind: 'directory' | 'file' | 'artifact'): void {
    const root = this.env['SystemRoot'] ?? this.env['WINDIR'] ?? String.raw`C:\Windows`;
    if (!isAbsolute(root)) throw new Error('status.capability_permission_failed');
    const executable = join(resolve(root), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = execFileSync(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], {
      encoding: 'utf8',
      env: operationalStatusWindowsPowerShellEnvironment(root, path, kind),
      windowsHide: true,
      timeout: 1_500,
      maxBuffer: 1_024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (script === WINDOWS_VERIFY_PATH && result !== 'ok') {
      throw new Error('status.capability_permission_failed');
    }
  }

  private syncDirectory(path: string): void {
    if (this.platform === 'win32') return;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(path, 'r');
      fsyncSync(descriptor);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
}
