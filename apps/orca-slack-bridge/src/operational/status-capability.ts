import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  type BigIntStats,
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
const STATUS_OWNER_CLAIM_MAX_BYTES = 512;
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const WINDOWS_FULL_CONTROL = 0x1f01ff;
const WINDOWS_DIRECTORY_INHERITANCE = 0x3;

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

export type OperationalStatusOwnerClaim = {
  readonly stateIdentity: string;
  readonly capabilityPath: string;
  assertHeld(): void;
  release(): Promise<void>;
};

export type OperationalStatusCapabilityStore = {
  acquireOwnerClaim(path: string, stateIdentity: string): Promise<OperationalStatusOwnerClaim>;
  read(path: string): OperationalStatusCapabilityRead;
  publish(
    path: string,
    document: OperationalStatusCapabilityDocument,
    expected: OperationalStatusCapabilityDocument | null,
    claim: OperationalStatusOwnerClaim,
  ): void;
  remove(
    path: string,
    expected: RetiredOperationalStatusCapability,
    claim: OperationalStatusOwnerClaim,
  ): void;
};

/** Test-only ordering seams. Production uses the native operations without hooks. */
export type OperationalStatusCapabilityStoreHooks = {
  readonly afterQuarantine?: (
    operation: 'publish' | 'remove',
    originalPath: string,
    quarantinePath: string,
  ) => void;
  readonly afterInstall?: (path: string, temporaryPath: string) => void;
  readonly beforeInstall?: (path: string, temporaryPath: string) => void;
};

type WindowsAclRuleSummary = {
  readonly currentUser: boolean;
  readonly allow: boolean;
  readonly rights: number;
  readonly inherited: boolean;
  readonly inheritance: number;
  readonly propagation: number;
};

export type WindowsAclSummary = {
  readonly ownerCurrentUser: boolean;
  readonly protected: boolean;
  readonly rules: readonly WindowsAclRuleSummary[];
};

type PosixClaimDocument = {
  readonly version: 1;
  readonly stateIdentity: string;
  readonly claimId: string;
  readonly pid: number;
  readonly processStart: string;
};

type ProtectedDocument = {
  readonly value: OperationalStatusCapabilityDocument;
  readonly identity: BigIntStats;
};

type ProtectedPosixClaim = {
  readonly value: PosixClaimDocument;
  readonly identity: BigIntStats;
};

const CLAIM_AUTHORITY = Symbol('status-owner-claim-authority');
type AuthenticatedOwnerClaim = OperationalStatusOwnerClaim & {
  readonly [CLAIM_AUTHORITY]: CurrentUserOperationalStatusCapabilityStore;
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

function documentsEqual(
  left: OperationalStatusCapabilityDocument,
  right: OperationalStatusCapabilityDocument,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseWindowsAclRule(value: unknown): WindowsAclRuleSummary | null {
  const record = exactRecord(value, [
    'currentUser', 'allow', 'rights', 'inherited', 'inheritance', 'propagation',
  ]);
  if (record === null || typeof record['currentUser'] !== 'boolean' ||
      typeof record['allow'] !== 'boolean' || !Number.isSafeInteger(record['rights']) ||
      typeof record['inherited'] !== 'boolean' || !Number.isSafeInteger(record['inheritance']) ||
      !Number.isSafeInteger(record['propagation'])) return null;
  return record as unknown as WindowsAclRuleSummary;
}

function parseWindowsAclSummary(value: unknown): WindowsAclSummary | null {
  const record = exactRecord(value, ['ownerCurrentUser', 'protected', 'rules']);
  if (record === null || typeof record['ownerCurrentUser'] !== 'boolean' ||
      typeof record['protected'] !== 'boolean' || !Array.isArray(record['rules'])) return null;
  const rules = record['rules'].map(parseWindowsAclRule);
  if (rules.some((rule) => rule === null)) return null;
  return {
    ownerCurrentUser: record['ownerCurrentUser'],
    protected: record['protected'],
    rules: rules as readonly WindowsAclRuleSummary[],
  };
}

/** Pure verifier used by the native PowerShell collector and deterministic ACL regressions. */
export function operationalStatusWindowsAclIsExact(
  value: unknown,
  kind: 'directory' | 'file',
): boolean {
  const summary = parseWindowsAclSummary(value);
  if (summary === null || !summary.ownerCurrentUser || !summary.protected ||
      summary.rules.length !== 1) return false;
  const rule = summary.rules[0]!;
  return rule.currentUser && rule.allow && rule.rights === WINDOWS_FULL_CONTROL &&
    !rule.inherited && rule.inheritance === (kind === 'directory' ? WINDOWS_DIRECTORY_INHERITANCE : 0) &&
    rule.propagation === 0;
}

function parsePosixClaim(value: unknown): PosixClaimDocument | null {
  const record = exactRecord(value, ['version', 'stateIdentity', 'claimId', 'pid', 'processStart']);
  if (record === null || record['version'] !== 1 ||
      typeof record['stateIdentity'] !== 'string' || !HEX_64.test(record['stateIdentity']) ||
      typeof record['claimId'] !== 'string' || !HEX_32.test(record['claimId']) ||
      !Number.isSafeInteger(record['pid']) || Number(record['pid']) < 1 ||
      typeof record['processStart'] !== 'string' || !DECIMAL.test(record['processStart'])) return null;
  return record as unknown as PosixClaimDocument;
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

export function operationalStatusWindowsOwnerClaimEnvironment(
  root: string,
  name: string,
): NodeJS.ProcessEnv {
  return {
    SystemRoot: root,
    WINDIR: root,
    ORCA_STATUS_OWNER_CLAIM_NAME: name,
  };
}

export function operationalStatusWindowsOwnerClaimName(stateIdentity: string): string {
  if (!HEX_64.test(stateIdentity)) throw new TypeError('status.owner_claim_invalid');
  return `Global\\orca-slack-bridge-status-v2-${stateIdentity}`;
}

const WINDOWS_PROTECT_PATH = String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('ORCA_STATUS_CAPABILITY_PATH', 'Process')
$kind = [Environment]::GetEnvironmentVariable('ORCA_STATUS_CAPABILITY_KIND', 'Process')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = $kind -eq 'directory'
$item = if ($directory) { [IO.DirectoryInfo]::new($path) } else { [IO.FileInfo]::new($path) }
if (-not $item.Exists) { exit 11 }
$sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
$acl = $item.GetAccessControl($sections)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$inheritance = if ($directory) {
  [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  [Security.AccessControl.InheritanceFlags]::None
}
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
$acl.SetOwner($sid)
$item.SetAccessControl($acl)
`;

const WINDOWS_READ_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('ORCA_STATUS_CAPABILITY_PATH', 'Process')
$kind = [Environment]::GetEnvironmentVariable('ORCA_STATUS_CAPABILITY_KIND', 'Process')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Read-AclSummary([string]$candidate, [bool]$directory) {
  $item = if ($directory) { [IO.DirectoryInfo]::new($candidate) } else { [IO.FileInfo]::new($candidate) }
  if (-not $item.Exists) { exit 11 }
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $acl = $item.GetAccessControl($sections)
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  return [ordered]@{
    ownerCurrentUser = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid
    protected = [bool]$acl.AreAccessRulesProtected
    rules = @($rules | ForEach-Object {
      [ordered]@{
        currentUser = $_.IdentityReference.Value -eq $sid
        allow = $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
        rights = [int64]$_.FileSystemRights
        inherited = [bool]$_.IsInherited
        inheritance = [int]$_.InheritanceFlags
        propagation = [int]$_.PropagationFlags
      }
    })
  }
}
$result = if ($kind -eq 'artifact') {
  [ordered]@{
    directory = Read-AclSummary ([IO.Path]::GetDirectoryName($path)) $true
    file = Read-AclSummary $path $false
  }
} else {
  Read-AclSummary $path ($kind -eq 'directory')
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 6))
`;

const WINDOWS_HOLD_OWNER_MUTEX = String.raw`
$ErrorActionPreference = 'Stop'
$name = [Environment]::GetEnvironmentVariable('ORCA_STATUS_OWNER_CLAIM_NAME', 'Process')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = [Security.AccessControl.MutexSecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$security.SetOwner($sid)
$rule = [Security.AccessControl.MutexAccessRule]::new(
  $sid,
  [Security.AccessControl.MutexRights]::FullControl,
  [Security.AccessControl.AccessControlType]::Allow
)
[void]$security.AddAccessRule($rule)
$created = $false
$mutex = [Threading.Mutex]::new($false, $name, [ref]$created, $security)
if (-not $created) { $mutex.Dispose(); exit 17 }
$actual = $mutex.GetAccessControl()
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
    -not $actual.AreAccessRulesProtected -or $rules.Count -ne 1) {
  $mutex.Dispose(); exit 18
}
$actualRule = $rules[0]
if ($actualRule.IdentityReference.Value -ne $sid.Value -or
    $actualRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
    $actualRule.MutexRights -ne [Security.AccessControl.MutexRights]::FullControl -or
    $actualRule.IsInherited) {
  $mutex.Dispose(); exit 19
}
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
[void][Console]::In.ReadToEnd()
$mutex.Dispose()
`;

function sameFileIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function processStartIdentity(pid: number): string | null {
  try {
    const input = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = input.lastIndexOf(')');
    if (close < 1) return null;
    const fields = input.slice(close + 1).trim().split(/\s+/u);
    const start = fields[19];
    return start !== undefined && DECIMAL.test(start) ? start : null;
  } catch {
    return null;
  }
}

function posixClaimIsLiveOrUnknown(claim: PosixClaimDocument): boolean {
  const currentStart = processStartIdentity(claim.pid);
  if (currentStart !== null) return currentStart === claim.processStart;
  try {
    process.kill(claim.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function boundedPowerShellExecutable(env: NodeJS.ProcessEnv): { root: string; executable: string } {
  const root = env['SystemRoot'] ?? env['WINDIR'] ?? String.raw`C:\Windows`;
  if (!isAbsolute(root)) throw new Error('status.capability_permission_failed');
  const resolvedRoot = resolve(root);
  return {
    root: resolvedRoot,
    executable: join(resolvedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  };
}

function encodedPowerShellArguments(script: string): readonly string[] {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

async function waitForChildExit(child: ChildProcess, timeoutMilliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolveExit) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', exited);
      resolveExit(value);
    };
    const exited = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    timer.unref?.();
    child.once('exit', exited);
  });
}

export class CurrentUserOperationalStatusCapabilityStore implements OperationalStatusCapabilityStore {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly hooks: OperationalStatusCapabilityStoreHooks = {},
  ) {}

  async acquireOwnerClaim(
    path: string,
    stateIdentity: string,
  ): Promise<OperationalStatusOwnerClaim> {
    if (!HEX_64.test(stateIdentity)) throw new Error('status.owner_claim_failed');
    const parent = dirname(path);
    this.ensureProtectedDirectory(parent);
    return this.platform === 'win32'
      ? await this.acquireWindowsOwnerClaim(path, stateIdentity)
      : this.acquirePosixOwnerClaim(path, stateIdentity);
  }

  read(path: string): OperationalStatusCapabilityRead {
    try {
      const parent = dirname(path);
      if (!existsSync(parent)) return { kind: 'absent' };
      if (!existsSync(path)) {
        this.verifyProtectedPath(parent, true);
        return { kind: 'absent' };
      }
      const document = this.readDocumentWithIdentity(path);
      return { kind: 'ready', value: document.value };
    } catch {
      return { kind: 'invalid' };
    }
  }

  publish(
    path: string,
    document: OperationalStatusCapabilityDocument,
    expected: OperationalStatusCapabilityDocument | null,
    claim: OperationalStatusOwnerClaim,
  ): void {
    this.assertClaim(path, document.stateIdentity, claim);
    const serialized = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
    if (serialized.length > STATUS_OWNER_CAPABILITY_MAX_BYTES || parseDocument(document) === null) {
      throw new Error('status.capability_publish_failed');
    }
    const parent = dirname(path);
    this.ensureProtectedDirectory(parent);
    const temporary = join(parent, `.owner-${process.pid}-${randomBytes(16).toString('hex')}.tmp`);
    let descriptor: number | null = null;
    let temporaryIdentity: BigIntStats | null = null;
    let previousQuarantine: string | null = null;
    let previousIdentity: BigIntStats | null = null;
    let installed = false;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, serialized);
      fsyncSync(descriptor);
      temporaryIdentity = fstatSync(descriptor, { bigint: true });
      closeSync(descriptor);
      descriptor = null;
      if (this.platform === 'win32') this.protectWindowsPath(temporary, false);
      else chmodSync(temporary, 0o600);
      const prepared = this.readDocumentWithIdentity(temporary);
      if (!sameFileIdentity(prepared.identity, temporaryIdentity) ||
          !documentsEqual(prepared.value, document)) {
        throw new Error('status.capability_publish_failed');
      }

      this.assertClaim(path, document.stateIdentity, claim);
      if (expected === null) {
        const observed = this.read(path);
        if (observed.kind !== 'absent') throw new Error('status.capability_publish_failed');
      } else {
        let observed: ProtectedDocument;
        try { observed = this.readDocumentWithIdentity(path); } catch {
          throw new Error('status.capability_publish_failed');
        }
        if (!documentsEqual(observed.value, expected)) {
          throw new Error('status.capability_publish_failed');
        }
        previousIdentity = observed.identity;
        previousQuarantine = this.quarantinePath(parent);
        renameSync(path, previousQuarantine);
        this.hooks.afterQuarantine?.('publish', path, previousQuarantine);
        const quarantined = this.readDocumentWithIdentity(previousQuarantine);
        if (!sameFileIdentity(quarantined.identity, previousIdentity) ||
            !documentsEqual(quarantined.value, expected)) {
          this.restoreQuarantine(previousQuarantine, path);
          previousQuarantine = null;
          previousIdentity = null;
          throw new Error('status.capability_publish_failed');
        }
      }

      this.assertClaim(path, document.stateIdentity, claim);
      this.hooks.beforeInstall?.(path, temporary);
      linkSync(temporary, path);
      installed = true;
      this.hooks.afterInstall?.(path, temporary);
      const installedDocument = this.readDocumentWithIdentity(path);
      if (!sameFileIdentity(installedDocument.identity, temporaryIdentity) ||
          !documentsEqual(installedDocument.value, document)) {
        throw new Error('status.capability_publish_failed');
      }
      if (!this.quarantineAndRemoveIdentity(temporary, temporaryIdentity)) {
        throw new Error('status.capability_publish_failed');
      }
      if (previousQuarantine !== null) {
        if (previousIdentity === null || expected === null) {
          throw new Error('status.capability_publish_failed');
        }
        const previous = this.readDocumentWithIdentity(previousQuarantine);
        if (!sameFileIdentity(previous.identity, previousIdentity) ||
            !documentsEqual(previous.value, expected) ||
            !this.quarantineAndRemoveIdentity(previousQuarantine, previousIdentity)) {
          throw new Error('status.capability_publish_failed');
        }
        previousQuarantine = null;
        previousIdentity = null;
      }
      this.syncDirectory(parent);
    } catch {
      if (descriptor !== null) {
        if (temporaryIdentity === null) {
          try { temporaryIdentity = fstatSync(descriptor, { bigint: true }); } catch {
            /* identity-less incomplete artifact is preserved rather than unlinked */
          }
        }
        try { closeSync(descriptor); } catch { /* bounded best effort */ }
      }
      if (temporaryIdentity !== null) {
        this.quarantineAndRemoveIdentity(temporary, temporaryIdentity);
      }
      let claimHeld = true;
      try { this.assertClaim(path, document.stateIdentity, claim); } catch { claimHeld = false; }
      if (claimHeld && installed && temporaryIdentity !== null) {
        this.quarantineAndRemoveMatching(path, document, temporaryIdentity);
      }
      if (claimHeld && previousQuarantine !== null) {
        this.restoreQuarantine(previousQuarantine, path);
      }
      throw new Error('status.capability_publish_failed');
    }
  }

  remove(
    path: string,
    expected: RetiredOperationalStatusCapability,
    claim: OperationalStatusOwnerClaim,
  ): void {
    this.assertClaim(path, expected.stateIdentity, claim);
    let observed: ProtectedDocument;
    try { observed = this.readDocumentWithIdentity(path); } catch {
      throw new Error('status.capability_remove_failed');
    }
    if (!documentsEqual(observed.value, expected)) throw new Error('status.capability_remove_failed');
    const quarantine = this.quarantinePath(dirname(path));
    try {
      renameSync(path, quarantine);
      this.hooks.afterQuarantine?.('remove', path, quarantine);
      const isolated = this.readDocumentWithIdentity(quarantine);
      if (!sameFileIdentity(isolated.identity, observed.identity) ||
          !documentsEqual(isolated.value, expected)) {
        this.restoreQuarantine(quarantine, path);
        throw new Error('status.capability_remove_failed');
      }
      this.assertClaim(path, expected.stateIdentity, claim);
      if (!this.quarantineAndRemoveIdentity(quarantine, observed.identity)) {
        throw new Error('status.capability_remove_failed');
      }
      if (existsSync(path)) throw new Error('status.capability_remove_failed');
    } catch {
      let claimHeld = true;
      try { this.assertClaim(path, expected.stateIdentity, claim); } catch { claimHeld = false; }
      if (claimHeld && existsSync(quarantine)) this.restoreQuarantine(quarantine, path);
      throw new Error('status.capability_remove_failed');
    }
  }

  private async acquireWindowsOwnerClaim(
    path: string,
    stateIdentity: string,
  ): Promise<OperationalStatusOwnerClaim> {
    const { root, executable } = boundedPowerShellExecutable(this.env);
    const name = operationalStatusWindowsOwnerClaimName(stateIdentity);
    const child = spawn(executable, encodedPowerShellArguments(WINDOWS_HOLD_OWNER_MUTEX), {
      env: operationalStatusWindowsOwnerClaimEnvironment(root, name),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (stdout === null || stdin === null) {
      child.kill();
      throw new Error('status.owner_claim_failed');
    }
    let lost = false;
    await new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      let output = Buffer.alloc(0);
      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdout.off('data', data);
        child.off('error', failed);
        child.off('exit', exited);
        if (error === null) resolveReady();
        else rejectReady(error);
      };
      const failed = (): void => finish(new Error('status.owner_claim_failed'));
      const exited = (): void => finish(new Error('status.owner_claim_failed'));
      const data = (chunk: Buffer): void => {
        if (output.length + chunk.length > 32) {
          finish(new Error('status.owner_claim_failed'));
          return;
        }
        output = Buffer.concat([output, chunk]);
        const text = output.toString('utf8');
        if (/^ready\r?\n$/u.test(text)) finish(null);
        else if (text.includes('\n')) finish(new Error('status.owner_claim_failed'));
      };
      const timer = setTimeout(() => finish(new Error('status.owner_claim_failed')), 2_000);
      timer.unref?.();
      stdout.on('data', data);
      child.once('error', failed);
      child.once('exit', exited);
    }).catch(async (error: unknown) => {
      stdin.end();
      if (!await waitForChildExit(child, 100)) child.kill();
      throw error;
    });
    child.once('exit', () => { lost = true; });
    let released = false;
    return {
      stateIdentity,
      capabilityPath: path,
      [CLAIM_AUTHORITY]: this,
      assertHeld: () => {
        if (released || lost || child.exitCode !== null || child.signalCode !== null) {
          throw new Error('status.owner_claim_lost');
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        stdin.end();
        if (!await waitForChildExit(child, 1_500)) {
          child.kill();
          if (!await waitForChildExit(child, 500)) throw new Error('status.owner_claim_release_failed');
        }
      },
    } as AuthenticatedOwnerClaim;
  }

  private acquirePosixOwnerClaim(
    path: string,
    stateIdentity: string,
  ): OperationalStatusOwnerClaim {
    if (this.platform !== 'linux') throw new Error('status.owner_claim_failed');
    const processStart = processStartIdentity(process.pid);
    if (processStart === null) throw new Error('status.owner_claim_failed');
    const claimPath = `${path}.claim`;
    const document: PosixClaimDocument = {
      version: 1,
      stateIdentity,
      claimId: randomBytes(16).toString('hex'),
      pid: process.pid,
      processStart,
    };
    const serialized = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
    let descriptor: number | null = null;
    let incompleteIdentity: BigIntStats | null = null;
    for (let attempt = 0; attempt < 3 && descriptor === null; attempt += 1) {
      try {
        descriptor = openSync(claimPath, 'wx', 0o600);
        writeFileSync(descriptor, serialized);
        fsyncSync(descriptor);
        incompleteIdentity = fstatSync(descriptor, { bigint: true });
        chmodSync(claimPath, 0o600);
      } catch (error) {
        if (descriptor !== null) {
          if (incompleteIdentity === null) {
            try { incompleteIdentity = fstatSync(descriptor, { bigint: true }); } catch {
              /* identity-less incomplete claim is preserved rather than unlinked */
            }
          }
          try { closeSync(descriptor); } catch { /* bounded best effort */ }
          descriptor = null;
          if (incompleteIdentity !== null) {
            this.quarantineAndRemoveIdentity(claimPath, incompleteIdentity);
          }
          incompleteIdentity = null;
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new Error('status.owner_claim_failed');
        }
        const existing = this.readPosixClaim(claimPath);
        if (existing === null) throw new Error('status.owner_claim_failed');
        if (posixClaimIsLiveOrUnknown(existing.value)) {
          throw new Error('status.owner_claim_failed');
        }
        if (!this.quarantineAndRemoveClaim(claimPath, existing)) {
          throw new Error('status.owner_claim_failed');
        }
      }
    }
    if (descriptor === null) throw new Error('status.owner_claim_failed');
    const heldDescriptor = descriptor;
    const descriptorIdentity = fstatSync(heldDescriptor, { bigint: true });
    let released = false;
    const assertHeld = (): void => {
      if (released) throw new Error('status.owner_claim_lost');
      const pathIdentity = lstatSync(claimPath, { bigint: true });
      const currentDescriptor = fstatSync(heldDescriptor, { bigint: true });
      if (!sameFileIdentity(descriptorIdentity, currentDescriptor) ||
          !sameFileIdentity(descriptorIdentity, pathIdentity) ||
          !pathIdentity.isFile() || pathIdentity.isSymbolicLink() ||
          !this.posixProtectionIsExact(claimPath, false) ||
          !readFileSync(claimPath).equals(serialized)) {
        throw new Error('status.owner_claim_lost');
      }
    };
    assertHeld();
    return {
      stateIdentity,
      capabilityPath: path,
      [CLAIM_AUTHORITY]: this,
      assertHeld,
      release: async () => {
        if (released) return;
        try {
          assertHeld();
        } catch {
          released = true;
          try { closeSync(heldDescriptor); } catch { /* resource is already lost */ }
          throw new Error('status.owner_claim_release_failed');
        }
        const quarantine = this.quarantinePath(dirname(claimPath));
        let failed = false;
        try {
          renameSync(claimPath, quarantine);
          const isolated = this.readProtectedBytes(quarantine, STATUS_OWNER_CLAIM_MAX_BYTES);
          const isolatedIdentity = lstatSync(quarantine, { bigint: true });
          if (!isolated.equals(serialized) || !sameFileIdentity(descriptorIdentity, isolatedIdentity)) {
            this.restoreQuarantine(quarantine, claimPath);
            failed = true;
          } else if (!this.quarantineAndRemoveIdentity(quarantine, descriptorIdentity)) {
            failed = true;
          }
        } catch {
          if (existsSync(quarantine)) this.restoreQuarantine(quarantine, claimPath);
          failed = true;
        } finally {
          released = true;
          closeSync(heldDescriptor);
        }
        if (failed) throw new Error('status.owner_claim_release_failed');
      },
    } as AuthenticatedOwnerClaim;
  }

  private readPosixClaim(path: string): ProtectedPosixClaim | null {
    try {
      const artifact = this.readProtectedArtifact(path, STATUS_OWNER_CLAIM_MAX_BYTES);
      const value = parsePosixClaim(JSON.parse(artifact.input.toString('utf8')));
      return value === null ? null : { value, identity: artifact.identity };
    } catch {
      return null;
    }
  }

  private quarantineAndRemoveClaim(path: string, expected: ProtectedPosixClaim): boolean {
    const quarantine = this.quarantinePath(dirname(path));
    try {
      renameSync(path, quarantine);
      const isolated = this.readPosixClaim(quarantine);
      if (isolated === null || !sameFileIdentity(isolated.identity, expected.identity) ||
          JSON.stringify(isolated.value) !== JSON.stringify(expected.value)) {
        this.restoreQuarantine(quarantine, path);
        return false;
      }
      return this.quarantineAndRemoveIdentity(quarantine, expected.identity) && !existsSync(path);
    } catch {
      if (existsSync(quarantine)) this.restoreQuarantine(quarantine, path);
      return false;
    }
  }

  private assertClaim(
    path: string,
    stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): void {
    const authenticated = claim as Partial<AuthenticatedOwnerClaim>;
    if (authenticated[CLAIM_AUTHORITY] !== this || claim.capabilityPath !== path ||
        claim.stateIdentity !== stateIdentity) throw new Error('status.owner_claim_lost');
    claim.assertHeld();
  }

  private quarantineAndRemoveMatching(
    path: string,
    expected: OperationalStatusCapabilityDocument,
    expectedIdentity: BigIntStats,
  ): void {
    if (!existsSync(path)) return;
    const quarantine = this.quarantinePath(dirname(path));
    try {
      renameSync(path, quarantine);
      const isolated = this.readDocumentWithIdentity(quarantine);
      if (sameFileIdentity(isolated.identity, expectedIdentity) &&
          documentsEqual(isolated.value, expected)) {
        if (!this.quarantineAndRemoveIdentity(quarantine, expectedIdentity)) {
          this.restoreQuarantine(quarantine, path);
        }
      } else {
        this.restoreQuarantine(quarantine, path);
      }
    } catch {
      if (existsSync(quarantine)) this.restoreQuarantine(quarantine, path);
    }
  }

  private quarantineAndRemoveIdentity(path: string, expectedIdentity: BigIntStats): boolean {
    if (!existsSync(path)) return false;
    const quarantine = this.quarantinePath(dirname(path));
    try {
      renameSync(path, quarantine);
      const isolated = lstatSync(quarantine, { bigint: true });
      if (!isolated.isFile() || isolated.isSymbolicLink() ||
          !sameFileIdentity(isolated, expectedIdentity)) {
        this.restoreQuarantine(quarantine, path);
        return false;
      }
      unlinkSync(quarantine);
      this.syncDirectory(dirname(path));
      return true;
    } catch {
      if (existsSync(quarantine)) this.restoreQuarantine(quarantine, path);
      return false;
    }
  }

  private restoreQuarantine(quarantine: string, path: string): void {
    if (!existsSync(quarantine)) return;
    try {
      linkSync(quarantine, path);
      unlinkSync(quarantine);
    } catch {
      // A raced replacement at the original path wins. The isolated object remains protected and
      // is never destroyed merely because its detached contents happened to match an expectation.
    }
  }

  private quarantinePath(parent: string): string {
    return join(parent, `.owner-quarantine-${process.pid}-${randomBytes(16).toString('hex')}`);
  }

  private readDocumentWithIdentity(path: string): ProtectedDocument {
    const artifact = this.readProtectedArtifact(path, STATUS_OWNER_CAPABILITY_MAX_BYTES);
    const value = parseDocument(JSON.parse(artifact.input.toString('utf8')));
    if (value === null) throw new Error('status.capability_invalid');
    return { value, identity: artifact.identity };
  }

  private readProtectedBytes(path: string, maximumBytes: number): Buffer {
    return this.readProtectedArtifact(path, maximumBytes).input;
  }

  private readProtectedArtifact(
    path: string,
    maximumBytes: number,
  ): { readonly input: Buffer; readonly identity: BigIntStats } {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(path, 'r');
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.isSymbolicLink() || opened.size <= 0n ||
          opened.size > BigInt(maximumBytes)) throw new Error('status.capability_permission_failed');
      const input = readFileSync(descriptor);
      this.verifyProtectedArtifact(path);
      const current = lstatSync(path, { bigint: true });
      if (!sameFileIdentity(opened, current) || !current.isFile() || current.isSymbolicLink()) {
        throw new Error('status.capability_permission_failed');
      }
      return { input, identity: opened };
    } finally {
      if (descriptor !== null) closeSync(descriptor);
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
          if (this.platform === 'win32') this.protectWindowsPath(path, true);
          else chmodSync(path, 0o700);
        }
      } catch {
        throw new Error('status.capability_permission_failed');
      }
    }
    this.verifyProtectedPath(path, true);
  }

  private verifyProtectedPath(path: string, directory: boolean): void {
    const entry = lstatSync(path, { bigint: true });
    if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) {
      throw new Error('status.capability_permission_failed');
    }
    if (this.platform === 'win32') {
      const value = this.runWindows(WINDOWS_READ_ACL, path, directory ? 'directory' : 'file');
      if (!operationalStatusWindowsAclIsExact(JSON.parse(value), directory ? 'directory' : 'file')) {
        throw new Error('status.capability_permission_failed');
      }
    } else if (!this.posixProtectionIsExact(path, directory)) {
      throw new Error('status.capability_permission_failed');
    }
  }

  private verifyProtectedArtifact(path: string): void {
    const entry = lstatSync(path, { bigint: true });
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error('status.capability_permission_failed');
    }
    if (this.platform === 'win32') {
      const value = JSON.parse(this.runWindows(WINDOWS_READ_ACL, path, 'artifact'));
      const record = exactRecord(value, ['directory', 'file']);
      if (record === null || !operationalStatusWindowsAclIsExact(record['directory'], 'directory') ||
          !operationalStatusWindowsAclIsExact(record['file'], 'file')) {
        throw new Error('status.capability_permission_failed');
      }
      return;
    }
    this.verifyProtectedPath(dirname(path), true);
    this.verifyProtectedPath(path, false);
  }

  private posixProtectionIsExact(path: string, directory: boolean): boolean {
    const stat = statSync(path);
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    const expectedMode = directory ? 0o700 : 0o600;
    return stat.uid === expectedUid && (stat.mode & 0o777) === expectedMode;
  }

  private protectWindowsPath(path: string, directory: boolean): void {
    this.runWindows(WINDOWS_PROTECT_PATH, path, directory ? 'directory' : 'file');
  }

  private runWindows(
    script: string,
    path: string,
    kind: 'directory' | 'file' | 'artifact',
  ): string {
    const { root, executable } = boundedPowerShellExecutable(this.env);
    return execFileSync(executable, encodedPowerShellArguments(script), {
      encoding: 'utf8',
      env: operationalStatusWindowsPowerShellEnvironment(root, path, kind),
      windowsHide: true,
      timeout: 1_500,
      maxBuffer: 1_024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
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
