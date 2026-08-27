import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  type BigIntStats,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

export const STATUS_OWNER_CAPABILITY_VERSION = 2;
export const STATUS_OWNER_CAPABILITY_MAX_AGE_MS = 30_000;
export const STATUS_OWNER_CAPABILITY_FUTURE_TOLERANCE_MS = 1_000;
export const STATUS_OWNER_CAPABILITY_ROTATE_AFTER_MS = 15_000;
const STATUS_OWNER_CAPABILITY_SLOT_BYTES = 1_024;
const STATUS_OWNER_CAPABILITY_MAX_BYTES = STATUS_OWNER_CAPABILITY_SLOT_BYTES * 2;
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const WINDOWS_FULL_CONTROL = 0x1f01ff;
const WINDOWS_DIRECTORY_INHERITANCE = 0x3;
const WINDOWS_STATUS_PATH_MAX_CHARACTERS = 240;
const POSIX_OWNER_SOCKET_MAX_BYTES = 103;
const POSIX_OWNER_MAX_RETAINED_SOCKET_RESIDUES = 8;
const TRUSTED_WINDOWS_SYSTEM_DIRECTORY =
  String.raw`\\?\GLOBALROOT\SystemRoot\System32`;
const WINDOWS_RESERVED_COMPONENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export type OperationalStatusTransportEndpoint =
  | { readonly kind: 'tcp'; readonly host: '127.0.0.1'; readonly port: number }
  | {
    readonly kind: 'pipe';
    readonly path: string;
    readonly device: string;
    readonly inode: string;
  };

export type OperationalStatusOwnerTransportIdentity = Extract<
  OperationalStatusTransportEndpoint,
  { readonly kind: 'pipe' }
>;

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

export type OperationalStatusSnapshotLease = {
  assertHeld(): void;
  release(): Promise<void>;
};

export type OperationalStatusSnapshotLeaseStore = {
  tryAcquireSnapshotLease(
    path: string,
    stateIdentity: string,
  ): Promise<OperationalStatusSnapshotLease | null>;
};

export type OperationalStatusCapabilityStore = {
  acquireOwnerClaim(path: string, stateIdentity: string): Promise<OperationalStatusOwnerClaim>;
  read(path: string): OperationalStatusCapabilityRead;
  readForRequest(path: string, signal: AbortSignal): Promise<OperationalStatusCapabilityRead>;
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
  prepareOwnerTransport(
    path: string,
    stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): void;
  activateOwnerTransport(
    path: string,
    stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): OperationalStatusOwnerTransportIdentity;
  assertOwnerTransport(
    transport: OperationalStatusOwnerTransportIdentity,
    stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): void;
  retireOwnerTransport(
    transport: OperationalStatusOwnerTransportIdentity,
    stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): void;
  verifyOwnerTransport(transport: OperationalStatusOwnerTransportIdentity): boolean;
};

/** Test-only ordering seams. Production uses the native operations without hooks. */
export type OperationalStatusCapabilityStoreHooks = {
  readonly afterInstall?: (path: string, temporaryPath: string) => void;
  readonly beforeInstall?: (path: string, temporaryPath: string) => void;
  readonly afterPosixClaimBootstrapCreate?: (path: string) => void;
  readonly afterPosixClaimBootstrapWrite?: (path: string) => void;
  readonly afterPosixClaimBootstrapFsync?: (path: string) => void;
  readonly afterPosixClaimLink?: (path: string) => void;
  readonly beforePosixLegacyClaimMutation?: (path: string) => void;
  readonly duringPosixClaimAssertion?: (claimPath: string) => void;
  readonly duringPosixSnapshotLeaseAssertion?: (leasePath: string) => void;
  readonly windowsKnownLocalAppData?: () => string;
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

function validPosixClaimDocument(input: Buffer, stateIdentity: string): boolean {
  try {
    const parsed = JSON.parse(input.toString('utf8')) as unknown;
    const record = exactRecord(parsed, [
      'version', 'stateIdentity', 'claimId', 'pid', 'processStart',
    ]);
    return record !== null && record['version'] === 1 &&
      record['stateIdentity'] === stateIdentity && typeof record['claimId'] === 'string' &&
      HEX_32.test(record['claimId']) && Number.isSafeInteger(record['pid']) &&
      Number(record['pid']) >= 1 && typeof record['processStart'] === 'string' &&
      DECIMAL.test(record['processStart']) &&
      input.equals(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'));
  } catch {
    return false;
  }
}

type CapabilitySlot = {
  readonly sequence: number;
  readonly document: OperationalStatusCapabilityDocument | null;
};

type ProtectedCapabilityState = CapabilitySlot & {
  readonly identity: BigIntStats;
  readonly activeSlot: 0 | 1;
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
  const record = exactRecord(
    value,
    kind === 'tcp' ? ['kind', 'host', 'port'] : ['kind', 'path', 'device', 'inode'],
  );
  if (record === null) return null;
  if (record['kind'] === 'tcp') {
    return record['host'] === '127.0.0.1' && Number.isSafeInteger(record['port']) &&
        Number(record['port']) >= 1 && Number(record['port']) <= 65_535
      ? record as unknown as OperationalStatusTransportEndpoint
      : null;
  }
  return record['kind'] === 'pipe' && typeof record['path'] === 'string' &&
      record['path'].length >= 1 && record['path'][0] !== '\0' &&
      Buffer.byteLength(record['path'], 'utf8') <= POSIX_OWNER_SOCKET_MAX_BYTES &&
      typeof record['device'] === 'string' && DECIMAL.test(record['device']) &&
      typeof record['inode'] === 'string' && DECIMAL.test(record['inode'])
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

function capabilitySlotDigest(
  sequence: number,
  document: OperationalStatusCapabilityDocument | null,
): string {
  return createHash('sha256').update(JSON.stringify({ sequence, document }), 'utf8').digest('hex');
}

function encodeCapabilitySlot(
  sequence: number,
  document: OperationalStatusCapabilityDocument | null,
): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence < 1 ||
      (document !== null && parseDocument(document) === null)) {
    throw new Error('status.capability_publish_failed');
  }
  const payload = Buffer.from(JSON.stringify({
    sequence,
    document,
    digest: capabilitySlotDigest(sequence, document),
  }), 'utf8');
  if (payload.length > STATUS_OWNER_CAPABILITY_SLOT_BYTES - 4) {
    throw new Error('status.capability_publish_failed');
  }
  const slot = Buffer.alloc(STATUS_OWNER_CAPABILITY_SLOT_BYTES);
  slot.writeUInt32BE(payload.length, 0);
  payload.copy(slot, 4);
  return slot;
}

function parseCapabilitySlot(input: Buffer): CapabilitySlot | null {
  if (input.length !== STATUS_OWNER_CAPABILITY_SLOT_BYTES) return null;
  const length = input.readUInt32BE(0);
  if (length < 1 || length > STATUS_OWNER_CAPABILITY_SLOT_BYTES - 4 ||
      input.subarray(4 + length).some((byte) => byte !== 0)) return null;
  try {
    const record = exactRecord(JSON.parse(input.subarray(4, 4 + length).toString('utf8')), [
      'sequence', 'document', 'digest',
    ]);
    if (record === null || !Number.isSafeInteger(record['sequence']) ||
        Number(record['sequence']) < 1 ||
        (record['document'] !== null && parseDocument(record['document']) === null) ||
        typeof record['digest'] !== 'string' || !HEX_64.test(record['digest']) ||
        record['digest'] !== capabilitySlotDigest(
          Number(record['sequence']),
          record['document'] as OperationalStatusCapabilityDocument | null,
        )) return null;
    return {
      sequence: Number(record['sequence']),
      document: record['document'] as OperationalStatusCapabilityDocument | null,
    };
  } catch {
    return null;
  }
}

function parseCapabilityState(input: Buffer): Omit<ProtectedCapabilityState, 'identity'> | null {
  if (input.length !== STATUS_OWNER_CAPABILITY_MAX_BYTES) return null;
  const slots = [
    parseCapabilitySlot(input.subarray(0, STATUS_OWNER_CAPABILITY_SLOT_BYTES)),
    parseCapabilitySlot(input.subarray(STATUS_OWNER_CAPABILITY_SLOT_BYTES)),
  ] as const;
  if (slots[0] === null && slots[1] === null) return null;
  if (slots[0] !== null && slots[1] !== null && slots[0].sequence === slots[1].sequence) return null;
  const activeSlot: 0 | 1 = slots[1] !== null &&
      (slots[0] === null || slots[1].sequence > slots[0].sequence) ? 1 : 0;
  const selected = slots[activeSlot];
  return selected === null ? null : { ...selected, activeSlot };
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

/** Platform-neutral seam for exact POSIX owner/type/mode admission tests. */
export function operationalStatusPosixProtectionIsExact(
  value: {
    readonly uid: bigint;
    readonly mode: bigint;
    readonly type: 'directory' | 'file' | 'socket' | 'other';
  },
  expectedUid: bigint,
  kind: 'directory' | 'file' | 'socket',
): boolean {
  const expectedMode = kind === 'directory' ? 0o700n : 0o600n;
  return value.uid === expectedUid && value.type === kind &&
    (value.mode & 0o777n) === expectedMode;
}

export function operationalStatusStateIdentity(
  statePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const canonical = platform === 'win32'
    ? win32.resolve(statePath).toLowerCase()
    : posix.resolve(statePath);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Lexical Windows trust-boundary check; filesystem canonicalization follows before use. */
export function operationalStatusWindowsLocalPathIsCanonical(value: string): boolean {
  if (value.length < 3 || value.length > WINDOWS_STATUS_PATH_MAX_CHARACTERS ||
      !hasValidUnicode(value) || /[\u0000-\u001f\u007f]/u.test(value) || value.includes('/')) return false;
  if (!/^[A-Za-z]:\\/u.test(value) || value.slice(2).includes(':') ||
      value.startsWith('\\\\')) return false;
  const components = value.slice(3).split('\\');
  if (components.length === 0 || components.some((component) =>
    component.length === 0 || component === '.' || component === '..' ||
    /[<>"|?*]/u.test(component) || /[. ]$/u.test(component) ||
    WINDOWS_RESERVED_COMPONENT.test(component))) return false;
  return win32.normalize(value) === value;
}

function windowsPathIsInside(base: string, candidate: string): boolean {
  const relative = win32.relative(base, candidate);
  return relative !== '' && !relative.startsWith(`..${win32.sep}`) && relative !== '..' &&
    !win32.isAbsolute(relative);
}

function canonicalWindowsLocalBase(
  knownFolder: () => string = operationalStatusWindowsKnownLocalAppData,
): string {
  const base = knownFolder();
  if (!operationalStatusWindowsLocalPathIsCanonical(base)) {
    throw new Error('status.capability_path_unavailable');
  }
  return base;
}

export function operationalStatusCapabilityPath(
  statePath: string,
  _env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  windowsKnownFolder: () => string = operationalStatusWindowsKnownLocalAppData,
): string {
  const stateIdentity = operationalStatusStateIdentity(statePath, platform);
  if (platform === 'win32') {
    const base = canonicalWindowsLocalBase(windowsKnownFolder);
    const artifact = win32.join(
      base,
      'orca-slack-bridge-status-v2',
      `owner-${stateIdentity.slice(0, 24)}.json`,
    );
    if (!operationalStatusWindowsLocalPathIsCanonical(artifact) ||
        !windowsPathIsInside(base, artifact)) throw new Error('status.capability_path_unavailable');
    return artifact;
  }
  const configured = _env['XDG_RUNTIME_DIR'];
  const fallback = platform === process.platform ? tmpdir() : '/tmp';
  const base = configured !== undefined && posix.isAbsolute(configured) ? configured : fallback;
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return posix.join(
    base,
    `orca-slack-bridge-status-v2-${user}`,
    `owner-${stateIdentity.slice(0, 24)}.json`,
  );
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

export function operationalStatusWindowsSnapshotLeaseEnvironment(
  root: string,
  name: string,
): NodeJS.ProcessEnv {
  return {
    SystemRoot: root,
    WINDIR: root,
    ORCA_STATUS_SNAPSHOT_LEASE_NAME: name,
  };
}

export function operationalStatusWindowsKnownFolderEnvironment(root: string): NodeJS.ProcessEnv {
  return { SystemRoot: root, WINDIR: root };
}

export function operationalStatusWindowsOwnerClaimName(stateIdentity: string): string {
  if (!HEX_64.test(stateIdentity)) throw new TypeError('status.owner_claim_invalid');
  return `Global\\orca-slack-bridge-status-v2-${stateIdentity}`;
}

export function operationalStatusWindowsSnapshotLeaseName(stateIdentity: string): string {
  if (!HEX_64.test(stateIdentity)) throw new TypeError('status.snapshot_lease_invalid');
  return `Global\\orca-slack-bridge-status-v2-snapshot-${stateIdentity}`;
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

const WINDOWS_HOLD_CURRENT_USER_MUTEX = String.raw`
$ErrorActionPreference = 'Stop'
$name = [Environment]::GetEnvironmentVariable('ORCA_STATUS_OWNER_CLAIM_NAME', 'Process')
$snapshotName = [Environment]::GetEnvironmentVariable('ORCA_STATUS_SNAPSHOT_LEASE_NAME', 'Process')
if ([String]::IsNullOrEmpty($name)) { $name = $snapshotName }
if ([String]::IsNullOrEmpty($name)) { exit 16 }
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

const WINDOWS_READ_LOCAL_APP_DATA = String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([String]::IsNullOrWhiteSpace($path)) { exit 11 }
[Console]::Out.Write($path)
`;

const WINDOWS_READ_APP_DATA = String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
if ([String]::IsNullOrWhiteSpace($path)) { exit 11 }
[Console]::Out.Write($path)
`;

let windowsKnownLocalAppDataCache: string | null = null;
let windowsKnownAppDataCache: string | null = null;

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

export function operationalStatusWindowsTrustedPowerShell(
  canonicalize: (path: string) => string = realpathSync.native,
): { readonly root: string; readonly systemDirectory: string; readonly executable: string } {
  const systemDirectory = canonicalize(TRUSTED_WINDOWS_SYSTEM_DIRECTORY);
  if (!operationalStatusWindowsLocalPathIsCanonical(systemDirectory) ||
      win32.basename(systemDirectory).toLowerCase() !== 'system32') {
    throw new Error('status.capability_permission_failed');
  }
  const root = win32.dirname(systemDirectory);
  const expected = win32.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const executable = canonicalize(expected);
  if (!operationalStatusWindowsLocalPathIsCanonical(executable) ||
      executable.toLowerCase() !== expected.toLowerCase() ||
      !windowsPathIsInside(systemDirectory, executable)) {
    throw new Error('status.capability_permission_failed');
  }
  return { root, systemDirectory, executable };
}

export function operationalStatusWindowsKnownLocalAppData(): string {
  if (windowsKnownLocalAppDataCache !== null) return windowsKnownLocalAppDataCache;
  const { root, executable } = operationalStatusWindowsTrustedPowerShell();
  const output = execFileSync(executable, encodedPowerShellArguments(WINDOWS_READ_LOCAL_APP_DATA), {
    encoding: 'utf8',
    env: operationalStatusWindowsKnownFolderEnvironment(root),
    windowsHide: true,
    timeout: 1_500,
    maxBuffer: 512,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (output !== output.trim() || output.length === 0) {
    throw new Error('status.capability_path_unavailable');
  }
  const base = realpathSync.native(output);
  if (!operationalStatusWindowsLocalPathIsCanonical(base)) {
    throw new Error('status.capability_path_unavailable');
  }
  windowsKnownLocalAppDataCache = base;
  return base;
}

/** Resolves the current user's roaming AppData through the trusted Windows known-folder API. */
export function operationalStatusWindowsKnownAppData(): string {
  if (windowsKnownAppDataCache !== null) return windowsKnownAppDataCache;
  const { root, executable } = operationalStatusWindowsTrustedPowerShell();
  const output = execFileSync(executable, encodedPowerShellArguments(WINDOWS_READ_APP_DATA), {
    encoding: 'utf8',
    env: operationalStatusWindowsKnownFolderEnvironment(root),
    windowsHide: true,
    timeout: 1_500,
    maxBuffer: 512,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (output !== output.trim() || output.length === 0) {
    throw new Error('status.capability_path_unavailable');
  }
  const base = realpathSync.native(output);
  if (!operationalStatusWindowsLocalPathIsCanonical(base)) {
    throw new Error('status.capability_path_unavailable');
  }
  windowsKnownAppDataCache = base;
  return base;
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

export class CurrentUserOperationalStatusCapabilityStore implements
  OperationalStatusCapabilityStore, OperationalStatusSnapshotLeaseStore {
  private readonly windowsCapabilityBase: string | null;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly hooks: OperationalStatusCapabilityStoreHooks;

  constructor(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    hooks: OperationalStatusCapabilityStoreHooks = {},
  ) {
    this.platform = platform;
    this.env = env;
    this.hooks = hooks;
    this.windowsCapabilityBase = platform === 'win32'
      ? canonicalWindowsLocalBase(hooks.windowsKnownLocalAppData)
      : null;
  }

  async acquireOwnerClaim(
    path: string,
    stateIdentity: string,
  ): Promise<OperationalStatusOwnerClaim> {
    if (!HEX_64.test(stateIdentity)) throw new Error('status.owner_claim_failed');
    this.assertCapabilityPath(path);
    const parent = dirname(path);
    this.ensureProtectedDirectory(parent);
    return this.platform === 'win32'
      ? await this.acquireWindowsOwnerClaim(path, stateIdentity)
      : this.acquirePosixOwnerClaim(path, stateIdentity);
  }

  async tryAcquireSnapshotLease(
    path: string,
    stateIdentity: string,
  ): Promise<OperationalStatusSnapshotLease | null> {
    try {
      if (!HEX_64.test(stateIdentity)) return null;
      this.assertCapabilityPath(path);
      this.ensureProtectedDirectory(dirname(path));
      return this.platform === 'win32'
        ? await this.acquireWindowsHeldMutex(operationalStatusWindowsSnapshotLeaseEnvironment(
          operationalStatusWindowsTrustedPowerShell().root,
          operationalStatusWindowsSnapshotLeaseName(stateIdentity),
        ))
        : this.acquirePosixSnapshotLease(path);
    } catch {
      return null;
    }
  }

  read(path: string): OperationalStatusCapabilityRead {
    try {
      this.assertCapabilityPath(path);
      const parent = dirname(path);
      if (!existsSync(parent)) return { kind: 'absent' };
      if (!existsSync(path)) {
        this.verifyProtectedPath(parent, true);
        return { kind: 'absent' };
      }
      const state = this.readCapabilityStateWithIdentity(path);
      return state.document === null
        ? { kind: 'absent' }
        : { kind: 'ready', value: state.document };
    } catch {
      return { kind: 'invalid' };
    }
  }

  async readForRequest(
    path: string,
    signal: AbortSignal,
  ): Promise<OperationalStatusCapabilityRead> {
    try {
      if (signal.aborted) return { kind: 'invalid' };
      this.assertCapabilityPath(path);
      const parent = dirname(path);
      if (!existsSync(parent)) return { kind: 'absent' };
      if (!existsSync(path)) {
        await this.verifyProtectedPathForRequest(parent, true, signal);
        return signal.aborted ? { kind: 'invalid' } : { kind: 'absent' };
      }
      const state = await this.readCapabilityStateWithIdentityForRequest(path, signal);
      return signal.aborted
        ? { kind: 'invalid' }
        : state.document === null
          ? { kind: 'absent' }
          : { kind: 'ready', value: state.document };
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
    if (parseDocument(document) === null) throw new Error('status.capability_publish_failed');
    this.writeCapabilityState(path, document, expected, claim, 'status.capability_publish_failed');
  }

  remove(
    path: string,
    expected: RetiredOperationalStatusCapability,
    claim: OperationalStatusOwnerClaim,
  ): void {
    this.writeCapabilityState(path, null, expected, claim, 'status.capability_remove_failed');
  }

  private writeCapabilityState(
    path: string,
    next: OperationalStatusCapabilityDocument | null,
    expected: OperationalStatusCapabilityDocument | null,
    claim: OperationalStatusOwnerClaim,
    failureCode: 'status.capability_publish_failed' | 'status.capability_remove_failed',
  ): void {
    const stateIdentity = next?.stateIdentity ?? expected?.stateIdentity;
    if (stateIdentity === undefined) throw new Error(failureCode);
    this.assertCapabilityPath(path);
    this.assertClaim(path, stateIdentity, claim);
    const parent = dirname(path);
    this.ensureProtectedDirectory(parent);
    const bootstrap = `${path}.bootstrap`;
    this.assertCapabilityPath(bootstrap);
    let descriptor: number | null = null;
    try {
      if (!existsSync(path)) {
        if (expected !== null) throw new Error(failureCode);
        let created = false;
        try {
          descriptor = openSync(bootstrap, 'wx+', 0o600);
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          descriptor = openSync(bootstrap, 'r+');
        }
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.isSymbolicLink()) throw new Error(failureCode);
        if (created) {
          fchmodSync(descriptor, 0o600);
          if (this.platform === 'win32') this.protectWindowsPath(bootstrap, false);
        } else {
          this.verifyProtectedPath(bootstrap, false);
          const currentBootstrap = lstatSync(bootstrap, { bigint: true });
          if (!sameFileIdentity(opened, currentBootstrap)) throw new Error(failureCode);
        }
        const initial = Buffer.concat([
          encodeCapabilitySlot(1, next),
          Buffer.alloc(STATUS_OWNER_CAPABILITY_SLOT_BYTES),
        ]);
        ftruncateSync(descriptor, 0);
        this.writeDescriptorBytes(descriptor, initial, 0);
        fsyncSync(descriptor);
        const prepared = fstatSync(descriptor, { bigint: true });
        closeSync(descriptor);
        descriptor = null;
        const verified = this.readCapabilityStateWithIdentity(bootstrap);
        if (!sameFileIdentity(prepared, verified.identity) || verified.sequence !== 1 ||
            !this.optionalDocumentsEqual(verified.document, next)) throw new Error(failureCode);
        this.assertClaim(path, stateIdentity, claim);
        this.hooks.beforeInstall?.(path, bootstrap);
        linkSync(bootstrap, path);
        this.hooks.afterInstall?.(path, bootstrap);
        const installed = this.readCapabilityStateWithIdentity(path);
        if (!sameFileIdentity(installed.identity, prepared) || installed.sequence !== 1 ||
            !this.optionalDocumentsEqual(installed.document, next)) throw new Error(failureCode);
        this.syncDirectory(parent);
        return;
      }

      const observed = this.readCapabilityStateWithIdentity(path);
      if (!this.optionalDocumentsEqual(observed.document, expected)) throw new Error(failureCode);
      const bootstrapIdentity = lstatSync(bootstrap, { bigint: true });
      if (!sameFileIdentity(observed.identity, bootstrapIdentity)) throw new Error(failureCode);
      descriptor = openSync(path, 'r+');
      const opened = fstatSync(descriptor, { bigint: true });
      if (!sameFileIdentity(opened, observed.identity)) throw new Error(failureCode);
      const before = parseCapabilityState(
        this.readDescriptorBytes(descriptor, STATUS_OWNER_CAPABILITY_MAX_BYTES),
      );
      if (before === null || before.sequence !== observed.sequence ||
          !this.optionalDocumentsEqual(before.document, expected)) throw new Error(failureCode);
      this.assertClaim(path, stateIdentity, claim);
      this.hooks.beforeInstall?.(path, path);
      const nextSequence = before.sequence + 1;
      if (!Number.isSafeInteger(nextSequence)) throw new Error(failureCode);
      const nextSlot = before.activeSlot === 0 ? 1 : 0;
      this.writeDescriptorBytes(
        descriptor,
        encodeCapabilitySlot(nextSequence, next),
        nextSlot * STATUS_OWNER_CAPABILITY_SLOT_BYTES,
      );
      fsyncSync(descriptor);
      this.hooks.afterInstall?.(path, path);
      this.assertCapabilityDescriptorState(
        path,
        descriptor,
        opened,
        nextSequence,
        next,
        failureCode,
      );
      const finalSequence = nextSequence + 1;
      const finalSlot = nextSlot === 0 ? 1 : 0;
      this.writeDescriptorBytes(
        descriptor,
        encodeCapabilitySlot(finalSequence, next),
        finalSlot * STATUS_OWNER_CAPABILITY_SLOT_BYTES,
      );
      fsyncSync(descriptor);
      this.assertCapabilityDescriptorState(
        path,
        descriptor,
        opened,
        finalSequence,
        next,
        failureCode,
      );
      closeSync(descriptor);
      descriptor = null;
      this.syncDirectory(parent);
    } catch {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* the stable inode remains recoverable */ }
      }
      throw new Error(failureCode);
    }
  }

  private assertCapabilityDescriptorState(
    path: string,
    descriptor: number,
    expectedIdentity: BigIntStats,
    sequence: number,
    document: OperationalStatusCapabilityDocument | null,
    failureCode: string,
  ): void {
    const descriptorState = fstatSync(descriptor, { bigint: true });
    this.verifyProtectedArtifact(path);
    const pathState = lstatSync(path, { bigint: true });
    const parsed = parseCapabilityState(
      this.readDescriptorBytes(descriptor, STATUS_OWNER_CAPABILITY_MAX_BYTES),
    );
    if (!sameFileIdentity(expectedIdentity, descriptorState) ||
        !sameFileIdentity(expectedIdentity, pathState) || parsed === null ||
        parsed.sequence !== sequence || !this.optionalDocumentsEqual(parsed.document, document)) {
      throw new Error(failureCode);
    }
  }

  private optionalDocumentsEqual(
    left: OperationalStatusCapabilityDocument | null,
    right: OperationalStatusCapabilityDocument | null,
  ): boolean {
    return left === null ? right === null : right !== null && documentsEqual(left, right);
  }

  prepareOwnerTransport(
    path: string,
    stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): void {
    if (this.platform !== 'linux' || path[0] === '\0' ||
        !posix.isAbsolute(path) || Buffer.byteLength(path, 'utf8') > POSIX_OWNER_SOCKET_MAX_BYTES) {
      throw new Error('status.owner_transport_failed');
    }
    this.assertClaim(claim.capabilityPath, stateIdentity, claim);
    const parent = posix.dirname(path);
    this.ensureProtectedDirectory(parent);
    if (!existsSync(path)) return;
    let observed: BigIntStats;
    try {
      observed = lstatSync(path, { bigint: true });
      if (!this.posixSocketProtectionIsRecoverable(observed)) {
        throw new Error('status.owner_transport_failed');
      }
      const quarantine = this.posixSocketResiduePath(parent, stateIdentity);
      renameSync(path, quarantine);
      const isolated = lstatSync(quarantine, { bigint: true });
      if (!sameFileIdentity(observed, isolated) ||
          !this.posixSocketProtectionIsRecoverable(isolated)) {
        this.restoreQuarantine(quarantine, path);
        throw new Error('status.owner_transport_failed');
      }
      // Node has no conditional unlink-by-inode. Crash residue is isolated without deletion and a
      // hard cap prevents unbounded growth; clean net.Server shutdown removes its own socket path.
      this.syncDirectory(parent);
    } catch {
      throw new Error('status.owner_transport_failed');
    }
  }

  activateOwnerTransport(
    path: string,
    stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): OperationalStatusOwnerTransportIdentity {
    if (this.platform !== 'linux') throw new Error('status.owner_transport_failed');
    this.assertClaim(claim.capabilityPath, stateIdentity, claim);
    const before = lstatSync(path, { bigint: true });
    if (!before.isSocket() || before.isSymbolicLink()) throw new Error('status.owner_transport_failed');
    chmodSync(path, 0o600);
    const after = lstatSync(path, { bigint: true });
    if (!sameFileIdentity(before, after) || !this.posixSocketProtectionIsExact(after)) {
      throw new Error('status.owner_transport_failed');
    }
    this.verifyProtectedPath(posix.dirname(path), true);
    return { kind: 'pipe', path, device: String(after.dev), inode: String(after.ino) };
  }

  assertOwnerTransport(
    transport: OperationalStatusOwnerTransportIdentity,
    stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): void {
    this.assertClaim(claim.capabilityPath, stateIdentity, claim);
    if (!this.verifyOwnerTransport(transport)) throw new Error('status.owner_transport_lost');
  }

  retireOwnerTransport(
    transport: OperationalStatusOwnerTransportIdentity,
    stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): void {
    if (this.platform !== 'linux') throw new Error('status.owner_transport_failed');
    this.assertClaim(claim.capabilityPath, stateIdentity, claim);
    if (!existsSync(transport.path)) return;
    this.assertOwnerTransport(transport, stateIdentity, claim);
    const expected = lstatSync(transport.path, { bigint: true });
    const quarantine = this.posixSocketResiduePath(
      posix.dirname(transport.path),
      stateIdentity,
    );
    try {
      renameSync(transport.path, quarantine);
      const isolated = lstatSync(quarantine, { bigint: true });
      if (!sameFileIdentity(expected, isolated) || !this.posixSocketProtectionIsExact(isolated)) {
        this.restoreQuarantine(quarantine, transport.path);
        throw new Error('status.owner_transport_failed');
      }
      this.syncDirectory(posix.dirname(transport.path));
    } catch {
      throw new Error('status.owner_transport_failed');
    }
  }

  verifyOwnerTransport(transport: OperationalStatusOwnerTransportIdentity): boolean {
    try {
      if (this.platform !== 'linux' || transport.path[0] === '\0' ||
          !posix.isAbsolute(transport.path) ||
          Buffer.byteLength(transport.path, 'utf8') > POSIX_OWNER_SOCKET_MAX_BYTES) return false;
      this.verifyProtectedPath(posix.dirname(transport.path), true);
      const socket = lstatSync(transport.path, { bigint: true });
      return this.posixSocketProtectionIsExact(socket) &&
        String(socket.dev) === transport.device && String(socket.ino) === transport.inode;
    } catch {
      return false;
    }
  }

  private posixSocketResiduePath(parent: string, stateIdentity: string): string {
    const prefix = `.owner-socket-residue-${stateIdentity.slice(0, 16)}-`;
    const retained = readdirSync(parent).filter((entry) => entry.startsWith(prefix));
    if (retained.length >= POSIX_OWNER_MAX_RETAINED_SOCKET_RESIDUES) {
      throw new Error('status.owner_transport_failed');
    }
    return posix.join(parent, `${prefix}${randomBytes(8).toString('hex')}`);
  }

  private async acquireWindowsOwnerClaim(
    path: string,
    stateIdentity: string,
  ): Promise<OperationalStatusOwnerClaim> {
    const { root, executable } = operationalStatusWindowsTrustedPowerShell();
    const name = operationalStatusWindowsOwnerClaimName(stateIdentity);
    let held: OperationalStatusSnapshotLease;
    try {
      held = await this.acquireWindowsHeldMutex(
        operationalStatusWindowsOwnerClaimEnvironment(root, name),
        executable,
      );
    } catch {
      throw new Error('status.owner_claim_failed');
    }
    return {
      stateIdentity,
      capabilityPath: path,
      [CLAIM_AUTHORITY]: this,
      assertHeld: () => {
        try { held.assertHeld(); } catch { throw new Error('status.owner_claim_lost'); }
      },
      release: async () => {
        try { await held.release(); } catch { throw new Error('status.owner_claim_release_failed'); }
      },
    } as AuthenticatedOwnerClaim;
  }

  private async acquireWindowsHeldMutex(
    env: NodeJS.ProcessEnv,
    executable: string = operationalStatusWindowsTrustedPowerShell().executable,
  ): Promise<OperationalStatusSnapshotLease> {
    const child = spawn(executable, encodedPowerShellArguments(WINDOWS_HOLD_CURRENT_USER_MUTEX), {
      env,
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
      assertHeld: () => {
        if (released || lost || child.exitCode !== null || child.signalCode !== null) {
          throw new Error('status.snapshot_lease_lost');
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        stdin.end();
        if (!await waitForChildExit(child, 1_500)) {
          child.kill();
          if (!await waitForChildExit(child, 500)) {
            throw new Error('status.snapshot_lease_release_failed');
          }
        }
      },
    };
  }

  private acquirePosixSnapshotLease(path: string): OperationalStatusSnapshotLease {
    if (this.platform !== 'linux') throw new Error('status.snapshot_lease_failed');
    const leasePath = `${path}.snapshot-lease`;
    const parent = posix.dirname(leasePath);
    let descriptor: number | null = null;
    try {
      let created = false;
      try {
        descriptor = openSync(leasePath, 'wx+', 0o600);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        descriptor = openSync(
          leasePath,
          fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
        );
      }
      if (created) {
        fchmodSync(descriptor, 0o600);
        fsyncSync(descriptor);
        this.syncDirectory(parent);
      }
      const opened = fstatSync(descriptor, { bigint: true });
      const pathBeforeLock = lstatSync(leasePath, { bigint: true });
      if (!this.posixFileProtectionIsExact(opened) || opened.size !== 0n || opened.nlink !== 1n ||
          !sameFileIdentity(opened, pathBeforeLock)) {
        throw new Error('status.snapshot_lease_failed');
      }
      execFileSync(this.trustedPosixFlockExecutable(), ['--exclusive', '--nonblock', '0'], {
        timeout: 1_000,
        maxBuffer: 32,
        stdio: [descriptor, 'ignore', 'ignore'],
      });
      const descriptorAfterLock = fstatSync(descriptor, { bigint: true });
      const pathAfterLock = lstatSync(leasePath, { bigint: true });
      if (!sameFileIdentity(opened, descriptorAfterLock) ||
          !sameFileIdentity(opened, pathAfterLock) ||
          !this.posixFileProtectionIsExact(descriptorAfterLock) ||
          !this.posixFileProtectionIsExact(pathAfterLock) || descriptorAfterLock.size !== 0n ||
          pathAfterLock.size !== 0n || descriptorAfterLock.nlink !== 1n ||
          pathAfterLock.nlink !== 1n) throw new Error('status.snapshot_lease_failed');
    } catch {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* closing releases any acquired flock */ }
      }
      throw new Error('status.snapshot_lease_failed');
    }

    const heldDescriptor = descriptor;
    if (heldDescriptor === null) throw new Error('status.snapshot_lease_failed');
    const descriptorIdentity = fstatSync(heldDescriptor, { bigint: true });
    let released = false;
    const assertHeld = (): void => {
      if (released) throw new Error('status.snapshot_lease_lost');
      const pathBefore = lstatSync(leasePath, { bigint: true });
      const descriptorBefore = fstatSync(heldDescriptor, { bigint: true });
      this.hooks.duringPosixSnapshotLeaseAssertion?.(leasePath);
      const descriptorAfter = fstatSync(heldDescriptor, { bigint: true });
      const pathAfter = lstatSync(leasePath, { bigint: true });
      if (!sameFileIdentity(descriptorIdentity, descriptorBefore) ||
          !sameFileIdentity(descriptorIdentity, descriptorAfter) ||
          !sameFileIdentity(descriptorIdentity, pathBefore) ||
          !sameFileIdentity(descriptorIdentity, pathAfter) ||
          !this.posixFileProtectionIsExact(descriptorBefore) ||
          !this.posixFileProtectionIsExact(descriptorAfter) ||
          !this.posixFileProtectionIsExact(pathBefore) ||
          !this.posixFileProtectionIsExact(pathAfter) || descriptorBefore.size !== 0n ||
          descriptorAfter.size !== 0n || pathBefore.size !== 0n || pathAfter.size !== 0n ||
          descriptorBefore.nlink !== 1n || descriptorAfter.nlink !== 1n ||
          pathBefore.nlink !== 1n || pathAfter.nlink !== 1n) {
        throw new Error('status.snapshot_lease_lost');
      }
    };
    try {
      assertHeld();
    } catch {
      released = true;
      try { closeSync(heldDescriptor); } catch { /* the failed acquisition owns no lease */ }
      throw new Error('status.snapshot_lease_failed');
    }
    return {
      assertHeld,
      release: async () => {
        if (released) return;
        try { assertHeld(); } catch {
          released = true;
          try { closeSync(heldDescriptor); } catch { /* resource is already lost */ }
          throw new Error('status.snapshot_lease_release_failed');
        }
        released = true;
        closeSync(heldDescriptor);
      },
    };
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
    const parent = posix.dirname(claimPath);
    const bootstrapPath = `${claimPath}.bootstrap`;
    let guardDescriptor: number | null = null;
    let descriptor: number | null = null;
    let bootstrapIdentity: BigIntStats | null = null;
    let claimUsesBootstrap = false;
    try {
      let createdBootstrap = false;
      try {
        guardDescriptor = openSync(bootstrapPath, 'wx+', 0o600);
        createdBootstrap = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        guardDescriptor = openSync(
          bootstrapPath,
          fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
        );
      }
      if (createdBootstrap) {
        fchmodSync(guardDescriptor, 0o600);
        fsyncSync(guardDescriptor);
        this.syncDirectory(parent);
        this.hooks.afterPosixClaimBootstrapCreate?.(bootstrapPath);
      }
      const openedBootstrap = fstatSync(guardDescriptor, { bigint: true });
      const bootstrapBeforeLock = lstatSync(bootstrapPath, { bigint: true });
      if (!this.posixFileProtectionIsExact(openedBootstrap) ||
          !sameFileIdentity(openedBootstrap, bootstrapBeforeLock) ||
          openedBootstrap.nlink < 1n || openedBootstrap.nlink > 2n ||
          (openedBootstrap.size !== 0n &&
           (openedBootstrap.size > 1_024n || !validPosixClaimDocument(
             this.readDescriptorBytes(guardDescriptor, Number(openedBootstrap.size)),
             stateIdentity,
           )))) throw new Error('status.owner_claim_failed');
      execFileSync(this.trustedPosixFlockExecutable(), ['--exclusive', '--nonblock', '0'], {
        timeout: 1_000,
        maxBuffer: 32,
        stdio: [guardDescriptor, 'ignore', 'ignore'],
      });
      const lockedBootstrap = fstatSync(guardDescriptor, { bigint: true });
      const bootstrapAfterLock = lstatSync(bootstrapPath, { bigint: true });
      if (!sameFileIdentity(openedBootstrap, lockedBootstrap) ||
          !sameFileIdentity(openedBootstrap, bootstrapAfterLock) ||
          !this.posixFileProtectionIsExact(lockedBootstrap) ||
          !this.posixFileProtectionIsExact(bootstrapAfterLock) ||
          lockedBootstrap.nlink < 1n || lockedBootstrap.nlink > 2n ||
          (lockedBootstrap.size !== 0n &&
           (lockedBootstrap.size > 1_024n || !validPosixClaimDocument(
             this.readDescriptorBytes(guardDescriptor, Number(lockedBootstrap.size)),
             stateIdentity,
           )))) {
        throw new Error('status.owner_claim_failed');
      }
      bootstrapIdentity = openedBootstrap;

      if (!existsSync(claimPath)) {
        if (bootstrapAfterLock.nlink !== 1n) throw new Error('status.owner_claim_failed');
        ftruncateSync(guardDescriptor, 0);
        this.writeDescriptorBytes(guardDescriptor, serialized, 0);
        fchmodSync(guardDescriptor, 0o600);
        this.hooks.afterPosixClaimBootstrapWrite?.(bootstrapPath);
        fsyncSync(guardDescriptor);
        this.hooks.afterPosixClaimBootstrapFsync?.(bootstrapPath);
        const prepared = fstatSync(guardDescriptor, { bigint: true });
        const preparedPath = lstatSync(bootstrapPath, { bigint: true });
        if (!sameFileIdentity(openedBootstrap, prepared) ||
            !sameFileIdentity(openedBootstrap, preparedPath) ||
            !this.posixFileProtectionIsExact(prepared) || prepared.nlink !== 1n ||
            !this.readDescriptorBytes(guardDescriptor, serialized.length).equals(serialized)) {
          throw new Error('status.owner_claim_failed');
        }
        linkSync(bootstrapPath, claimPath);
        this.hooks.afterPosixClaimLink?.(claimPath);
        const installed = lstatSync(claimPath, { bigint: true });
        const linkedBootstrap = lstatSync(bootstrapPath, { bigint: true });
        if (!sameFileIdentity(openedBootstrap, installed) ||
            !sameFileIdentity(openedBootstrap, linkedBootstrap) || installed.nlink !== 2n ||
            !this.posixFileProtectionIsExact(installed)) throw new Error('status.owner_claim_failed');
        this.syncDirectory(parent);
        descriptor = guardDescriptor;
        guardDescriptor = null;
        claimUsesBootstrap = true;
      } else {
        const claimBeforeOpen = lstatSync(claimPath, { bigint: true });
        if (sameFileIdentity(openedBootstrap, claimBeforeOpen)) {
          if (claimBeforeOpen.nlink !== 2n || !this.posixFileProtectionIsExact(claimBeforeOpen)) {
            throw new Error('status.owner_claim_failed');
          }
          descriptor = guardDescriptor;
          guardDescriptor = null;
          claimUsesBootstrap = true;
        } else {
          descriptor = openSync(claimPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
          const openedClaim = fstatSync(descriptor, { bigint: true });
          if (!this.posixFileProtectionIsExact(openedClaim) || openedClaim.nlink < 1n ||
              openedClaim.nlink > 2n || !sameFileIdentity(openedClaim, claimBeforeOpen)) {
            throw new Error('status.owner_claim_failed');
          }
          execFileSync(this.trustedPosixFlockExecutable(), ['--exclusive', '--nonblock', '0'], {
            timeout: 1_000,
            maxBuffer: 32,
            stdio: [descriptor, 'ignore', 'ignore'],
          });
          const claimAfterLock = lstatSync(claimPath, { bigint: true });
          const lockedClaim = fstatSync(descriptor, { bigint: true });
          if (!sameFileIdentity(openedClaim, lockedClaim) ||
              !sameFileIdentity(openedClaim, claimAfterLock) ||
              !this.posixFileProtectionIsExact(lockedClaim) ||
              !this.posixFileProtectionIsExact(claimAfterLock) ||
              lockedClaim.nlink < 1n || lockedClaim.nlink > 2n ||
              claimAfterLock.nlink < 1n || claimAfterLock.nlink > 2n ||
              claimAfterLock.size !== lockedClaim.size ||
              lockedClaim.size > 1_024n) {
            throw new Error('status.owner_claim_failed');
          }
          const admittedClaimBytes = this.readDescriptorBytes(
            descriptor,
            Number(lockedClaim.size),
          );
          // A distinct inode is a legacy publication. The flock proves it has no cooperating
          // owner, but only our exact same-state document or our empty released shape authorizes
          // mutation; every unknown current-user object remains byte-for-byte untouched.
          if (lockedClaim.size !== 0n &&
              !validPosixClaimDocument(admittedClaimBytes, stateIdentity)) {
            throw new Error('status.owner_claim_failed');
          }
          ftruncateSync(guardDescriptor, 0);
          fsyncSync(guardDescriptor);
          this.hooks.beforePosixLegacyClaimMutation?.(claimPath);
          const claimBeforeMutation = lstatSync(claimPath, { bigint: true });
          const descriptorBeforeMutation = fstatSync(descriptor, { bigint: true });
          const bytesBeforeMutation = this.readDescriptorBytes(
            descriptor,
            Number(descriptorBeforeMutation.size),
          );
          const descriptorAfterRead = fstatSync(descriptor, { bigint: true });
          if (!sameFileIdentity(openedClaim, descriptorBeforeMutation) ||
              !sameFileIdentity(openedClaim, descriptorAfterRead) ||
              !sameFileIdentity(openedClaim, claimBeforeMutation) ||
              !this.posixFileProtectionIsExact(descriptorBeforeMutation) ||
              !this.posixFileProtectionIsExact(descriptorAfterRead) ||
              !this.posixFileProtectionIsExact(claimBeforeMutation) ||
              descriptorBeforeMutation.nlink < 1n || descriptorBeforeMutation.nlink > 2n ||
              descriptorAfterRead.nlink < 1n || descriptorAfterRead.nlink > 2n ||
              claimBeforeMutation.nlink < 1n || claimBeforeMutation.nlink > 2n ||
              descriptorBeforeMutation.size !== lockedClaim.size ||
              descriptorAfterRead.size !== lockedClaim.size ||
              claimBeforeMutation.size !== lockedClaim.size ||
              !bytesBeforeMutation.equals(admittedClaimBytes)) {
            throw new Error('status.owner_claim_failed');
          }
        }
        ftruncateSync(descriptor, 0);
        this.writeDescriptorBytes(descriptor, serialized, 0);
        fchmodSync(descriptor, 0o600);
        fsyncSync(descriptor);
        this.syncDirectory(parent);
      }

      const opened = fstatSync(descriptor, { bigint: true });
      const pathAfterWrite = lstatSync(claimPath, { bigint: true });
      if (!sameFileIdentity(opened, pathAfterWrite) ||
          !this.posixFileProtectionIsExact(opened) ||
          !this.readDescriptorBytes(descriptor, serialized.length).equals(serialized)) {
        throw new Error('status.owner_claim_failed');
      }
    } catch {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* closing releases any acquired flock */ }
      }
      if (guardDescriptor !== null) {
        try { closeSync(guardDescriptor); } catch { /* closing releases the bootstrap guard */ }
      }
      throw new Error('status.owner_claim_failed');
    }
    const heldDescriptor = descriptor;
    if (heldDescriptor === null) throw new Error('status.owner_claim_failed');
    const descriptorIdentity = fstatSync(heldDescriptor, { bigint: true });
    const heldGuardDescriptor = guardDescriptor;
    const heldBootstrapIdentity = bootstrapIdentity;
    if (heldBootstrapIdentity === null) {
      try { closeSync(heldDescriptor); } catch { /* failed acquisition owns no claim */ }
      if (heldGuardDescriptor !== null) {
        try { closeSync(heldGuardDescriptor); } catch { /* failed acquisition owns no guard */ }
      }
      throw new Error('status.owner_claim_failed');
    }
    let released = false;
    const assertHeld = (): void => {
      if (released) throw new Error('status.owner_claim_lost');
      const pathBefore = lstatSync(claimPath, { bigint: true });
      const descriptorBefore = fstatSync(heldDescriptor, { bigint: true });
      const bytes = this.readDescriptorBytes(heldDescriptor, serialized.length);
      const descriptorAfter = fstatSync(heldDescriptor, { bigint: true });
      const bootstrapBefore = lstatSync(bootstrapPath, { bigint: true });
      const guardBefore = heldGuardDescriptor === null
        ? descriptorBefore
        : fstatSync(heldGuardDescriptor, { bigint: true });
      this.hooks.duringPosixClaimAssertion?.(claimPath);
      const pathAfter = lstatSync(claimPath, { bigint: true });
      const bootstrapAfter = lstatSync(bootstrapPath, { bigint: true });
      const guardAfter = heldGuardDescriptor === null
        ? descriptorAfter
        : fstatSync(heldGuardDescriptor, { bigint: true });
      if (!sameFileIdentity(descriptorIdentity, descriptorBefore) ||
          !sameFileIdentity(descriptorIdentity, descriptorAfter) ||
          !sameFileIdentity(descriptorIdentity, pathBefore) ||
          !sameFileIdentity(descriptorIdentity, pathAfter) ||
          !sameFileIdentity(heldBootstrapIdentity, bootstrapBefore) ||
          !sameFileIdentity(heldBootstrapIdentity, bootstrapAfter) ||
          !sameFileIdentity(heldBootstrapIdentity, guardBefore) ||
          !sameFileIdentity(heldBootstrapIdentity, guardAfter) ||
          !this.posixFileProtectionIsExact(descriptorBefore) ||
          !this.posixFileProtectionIsExact(descriptorAfter) ||
          !this.posixFileProtectionIsExact(pathBefore) ||
          !this.posixFileProtectionIsExact(pathAfter) ||
          !this.posixFileProtectionIsExact(bootstrapBefore) ||
          !this.posixFileProtectionIsExact(bootstrapAfter) ||
          !this.posixFileProtectionIsExact(guardBefore) ||
          !this.posixFileProtectionIsExact(guardAfter) ||
          descriptorBefore.size !== BigInt(serialized.length) ||
          descriptorAfter.size !== BigInt(serialized.length) ||
          pathBefore.size !== BigInt(serialized.length) ||
          pathAfter.size !== BigInt(serialized.length) ||
          (claimUsesBootstrap
            ? descriptorBefore.nlink !== 2n || descriptorAfter.nlink !== 2n ||
              pathBefore.nlink !== 2n || pathAfter.nlink !== 2n ||
              bootstrapBefore.nlink !== 2n || bootstrapAfter.nlink !== 2n
            : guardBefore.size !== 0n || guardAfter.size !== 0n ||
              guardBefore.nlink !== 1n || guardAfter.nlink !== 1n ||
              descriptorBefore.nlink < 1n || descriptorBefore.nlink > 2n ||
              descriptorAfter.nlink < 1n || descriptorAfter.nlink > 2n ||
              pathBefore.nlink < 1n || pathBefore.nlink > 2n ||
              pathAfter.nlink < 1n || pathAfter.nlink > 2n) ||
          !bytes.equals(serialized)) {
        throw new Error('status.owner_claim_lost');
      }
    };
    try {
      assertHeld();
    } catch {
      released = true;
      try { closeSync(heldDescriptor); } catch { /* the failed acquisition owns no usable claim */ }
      if (heldGuardDescriptor !== null) {
        try { closeSync(heldGuardDescriptor); } catch { /* the failed acquisition owns no guard */ }
      }
      throw new Error('status.owner_claim_failed');
    }
    return {
      stateIdentity,
      capabilityPath: path,
      [CLAIM_AUTHORITY]: this,
      assertHeld,
      release: async () => {
        if (released) return;
        try {
          assertHeld();
          ftruncateSync(heldDescriptor, 0);
          fsyncSync(heldDescriptor);
          const pathBeforeClose = lstatSync(claimPath, { bigint: true });
          const descriptorBeforeClose = fstatSync(heldDescriptor, { bigint: true });
          if (!sameFileIdentity(descriptorIdentity, pathBeforeClose) ||
              !sameFileIdentity(descriptorIdentity, descriptorBeforeClose) ||
              descriptorBeforeClose.size !== 0n) {
            throw new Error('status.owner_claim_release_failed');
          }
        } catch {
          released = true;
          try { closeSync(heldDescriptor); } catch { /* resource is already lost */ }
          if (heldGuardDescriptor !== null) {
            try { closeSync(heldGuardDescriptor); } catch { /* resource is already lost */ }
          }
          throw new Error('status.owner_claim_release_failed');
        }
        released = true;
        closeSync(heldDescriptor);
        if (heldGuardDescriptor !== null) closeSync(heldGuardDescriptor);
      },
    } as AuthenticatedOwnerClaim;
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

  private restoreQuarantine(quarantine: string, path: string): void {
    if (!existsSync(quarantine)) return;
    try {
      linkSync(quarantine, path);
    } catch {
      // A raced replacement at the original path wins. The isolated object remains protected and
      // is never destroyed merely because its detached contents happened to match an expectation.
    }
  }

  private readCapabilityStateWithIdentity(path: string): ProtectedCapabilityState {
    const artifact = this.readProtectedArtifact(path, STATUS_OWNER_CAPABILITY_MAX_BYTES);
    const value = parseCapabilityState(artifact.input);
    if (value === null) throw new Error('status.capability_invalid');
    return { ...value, identity: artifact.identity };
  }

  private async readCapabilityStateWithIdentityForRequest(
    path: string,
    signal: AbortSignal,
  ): Promise<ProtectedCapabilityState> {
    const artifact = await this.readProtectedArtifactForRequest(
      path,
      STATUS_OWNER_CAPABILITY_MAX_BYTES,
      signal,
    );
    const value = parseCapabilityState(artifact.input);
    if (value === null) throw new Error('status.capability_invalid');
    return { ...value, identity: artifact.identity };
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

  private async readProtectedArtifactForRequest(
    path: string,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<{ readonly input: Buffer; readonly identity: BigIntStats }> {
    let descriptor: number | null = null;
    try {
      if (signal.aborted) throw new Error('status.capability_permission_failed');
      descriptor = openSync(path, 'r');
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.isSymbolicLink() || opened.size <= 0n ||
          opened.size > BigInt(maximumBytes)) throw new Error('status.capability_permission_failed');
      const input = readFileSync(descriptor);
      await this.verifyProtectedArtifactForRequest(path, signal);
      if (signal.aborted) throw new Error('status.capability_permission_failed');
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
    this.assertCapabilityPath(path);
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
    this.assertCapabilityPath(path);
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

  private async verifyProtectedPathForRequest(
    path: string,
    directory: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertCapabilityPath(path);
    const entry = lstatSync(path, { bigint: true });
    if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) {
      throw new Error('status.capability_permission_failed');
    }
    if (this.platform === 'win32') {
      const value = await this.runWindowsForRequest(
        WINDOWS_READ_ACL,
        path,
        directory ? 'directory' : 'file',
        signal,
      );
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

  private async verifyProtectedArtifactForRequest(
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertCapabilityPath(path);
    const entry = lstatSync(path, { bigint: true });
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error('status.capability_permission_failed');
    }
    if (this.platform === 'win32') {
      const value = JSON.parse(await this.runWindowsForRequest(
        WINDOWS_READ_ACL,
        path,
        'artifact',
        signal,
      ));
      const record = exactRecord(value, ['directory', 'file']);
      if (record === null || !operationalStatusWindowsAclIsExact(record['directory'], 'directory') ||
          !operationalStatusWindowsAclIsExact(record['file'], 'file')) {
        throw new Error('status.capability_permission_failed');
      }
      return;
    }
    await this.verifyProtectedPathForRequest(dirname(path), true, signal);
    await this.verifyProtectedPathForRequest(path, false, signal);
  }

  private posixProtectionIsExact(path: string, directory: boolean): boolean {
    const stat = statSync(path);
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    return operationalStatusPosixProtectionIsExact({
      uid: BigInt(stat.uid),
      mode: BigInt(stat.mode),
      type: directory ? (stat.isDirectory() ? 'directory' : 'other') :
        (stat.isFile() ? 'file' : 'other'),
    }, BigInt(expectedUid), directory ? 'directory' : 'file');
  }

  private posixFileProtectionIsExact(stat: BigIntStats): boolean {
    const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : stat.uid;
    return !stat.isSymbolicLink() && operationalStatusPosixProtectionIsExact({
      uid: stat.uid,
      mode: stat.mode,
      type: stat.isFile() ? 'file' : 'other',
    }, expectedUid, 'file');
  }

  private posixSocketProtectionIsExact(stat: BigIntStats): boolean {
    const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : stat.uid;
    return !stat.isSymbolicLink() && operationalStatusPosixProtectionIsExact({
      uid: stat.uid,
      mode: stat.mode,
      type: stat.isSocket() ? 'socket' : 'other',
    }, expectedUid, 'socket');
  }

  private posixSocketProtectionIsRecoverable(stat: BigIntStats): boolean {
    if (this.posixSocketProtectionIsExact(stat)) return true;
    const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : stat.uid;
    return !stat.isSymbolicLink() && stat.isSocket() && stat.uid === expectedUid &&
      (stat.mode & 0o777n) === 0o755n;
  }

  private trustedPosixFlockExecutable(): string {
    const executable = realpathSync.native('/usr/bin/flock');
    const identity = statSync(executable, { bigint: true });
    if (executable !== '/usr/bin/flock' || !identity.isFile() || identity.uid !== 0n ||
        (identity.mode & 0o022n) !== 0n) throw new Error('status.owner_claim_failed');
    return executable;
  }

  private protectWindowsPath(path: string, directory: boolean): void {
    this.runWindows(WINDOWS_PROTECT_PATH, path, directory ? 'directory' : 'file');
  }

  private runWindows(
    script: string,
    path: string,
    kind: 'directory' | 'file' | 'artifact',
  ): string {
    this.assertCapabilityPath(path);
    const { root, executable } = operationalStatusWindowsTrustedPowerShell();
    return execFileSync(executable, encodedPowerShellArguments(script), {
      encoding: 'utf8',
      env: operationalStatusWindowsPowerShellEnvironment(root, path, kind),
      windowsHide: true,
      timeout: 1_500,
      maxBuffer: 1_024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  }

  private async runWindowsForRequest(
    script: string,
    path: string,
    kind: 'directory' | 'file' | 'artifact',
    signal: AbortSignal,
  ): Promise<string> {
    this.assertCapabilityPath(path);
    const { root, executable } = operationalStatusWindowsTrustedPowerShell();
    return await new Promise<string>((resolveRun, rejectRun) => {
      execFile(executable, encodedPowerShellArguments(script), {
        encoding: 'utf8',
        env: operationalStatusWindowsPowerShellEnvironment(root, path, kind),
        windowsHide: true,
        timeout: 1_500,
        maxBuffer: 1_024,
        signal,
      }, (error, stdout) => {
        if (error !== null || signal.aborted) rejectRun(new Error('status.capability_permission_failed'));
        else resolveRun(stdout);
      });
    });
  }

  private readDescriptorBytes(descriptor: number, length: number): Buffer {
    const output = Buffer.alloc(length);
    let offset = 0;
    while (offset < output.length) {
      const count = readSync(descriptor, output, offset, output.length - offset, offset);
      if (count <= 0) throw new Error('status.owner_claim_lost');
      offset += count;
    }
    return output;
  }

  private writeDescriptorBytes(descriptor: number, input: Buffer, position: number): void {
    let offset = 0;
    while (offset < input.length) {
      const count = writeSync(
        descriptor,
        input,
        offset,
        input.length - offset,
        position + offset,
      );
      if (count <= 0) throw new Error('status.capability_publish_failed');
      offset += count;
    }
  }

  private assertCapabilityPath(path: string): void {
    if (this.platform !== 'win32') return;
    const base = this.windowsCapabilityBase;
    if (base === null || !operationalStatusWindowsLocalPathIsCanonical(path) ||
        !windowsPathIsInside(base, path)) throw new Error('status.capability_permission_failed');
    const currentBase = realpathSync.native(base);
    if (!operationalStatusWindowsLocalPathIsCanonical(currentBase) ||
        currentBase.toLowerCase() !== base.toLowerCase()) {
      throw new Error('status.capability_permission_failed');
    }
    const parent = win32.dirname(path);
    if (existsSync(parent)) {
      const canonicalParent = realpathSync.native(parent);
      if (!operationalStatusWindowsLocalPathIsCanonical(canonicalParent) ||
          (canonicalParent.toLowerCase() !== base.toLowerCase() &&
           !windowsPathIsInside(base, canonicalParent))) {
        throw new Error('status.capability_permission_failed');
      }
    }
    if (existsSync(path)) {
      const canonicalPath = realpathSync.native(path);
      if (!operationalStatusWindowsLocalPathIsCanonical(canonicalPath) ||
          canonicalPath.toLowerCase() !== path.toLowerCase()) {
        throw new Error('status.capability_permission_failed');
      }
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
