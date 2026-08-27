import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import {
  operationalStatusWindowsKnownLocalAppData,
  operationalStatusWindowsTrustedPowerShell,
} from '../operational/status-capability.js';

export const WINDOWS_RUNTIME_MANIFEST_SCHEMA_VERSION = 2;
export const WINDOWS_RUNTIME_MANIFEST_REVISION = 1;
export const WINDOWS_RUNTIME_MANIFEST_FILE = 'runtime.json';
export const WINDOWS_RELEASE_LAUNCHER_RELATIVE_PATH = win32.join('windows', 'launch-daemon.ps1');
const HEX_64 = /^[a-f0-9]{64}$/u;
const MANIFEST_KEYS = [
  'schemaVersion', 'manifestRevision', 'releaseRoot', 'releaseDigest', 'nodeExe', 'distCli',
  'launcherPath', 'launcherSha256', 'taskSemanticFingerprint',
  'config', 'state', 'orcaExe', 'logDirectory', 'manifestDigest',
] as const;
const MANIFEST_IDENTITY_HEADER = 'orca-slack-bridge-runtime-manifest-v2\0';

export type WindowsRuntimeManifest = {
  readonly schemaVersion: typeof WINDOWS_RUNTIME_MANIFEST_SCHEMA_VERSION;
  readonly manifestRevision: typeof WINDOWS_RUNTIME_MANIFEST_REVISION;
  readonly releaseRoot: string;
  readonly releaseDigest: string;
  readonly nodeExe: string;
  readonly distCli: string;
  readonly launcherPath: string;
  readonly launcherSha256: string;
  readonly taskSemanticFingerprint: string;
  readonly config: string;
  readonly state: string;
  readonly orcaExe: string;
  readonly logDirectory: string;
  readonly manifestDigest: string;
};

type WindowsRuntimeManifestIdentity = Omit<WindowsRuntimeManifest, 'manifestDigest'>;

export type WindowsRuntimeManifestSnapshot =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'present';
      readonly bytes: Buffer;
      readonly protected: boolean;
      readonly manifest: WindowsRuntimeManifest | null;
    };

export interface WindowsRuntimeManifestStore {
  inspect(path: string): Promise<WindowsRuntimeManifestSnapshot>;
  replace(path: string, expected: Buffer | null, desired: Buffer | null): Promise<void>;
}

type RuntimeManifestPowerShellRecord = {
  readonly exists?: boolean;
  readonly protected?: boolean;
  readonly bytes?: string;
  readonly ok?: boolean;
};

const RUNTIME_MANIFEST_POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$operation = $env:ORCA_RUNTIME_MANIFEST_OPERATION
$raw = [Console]::In.ReadToEnd()
$inputObject = $raw | ConvertFrom-Json
$path = [string]$inputObject.path
$parent = [IO.Path]::GetDirectoryName($path)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User

function Write-Result([object]$value) {
  [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 6))
}

function Set-PrivateAcl([string]$target, [bool]$directory) {
  $item = if ($directory) { [IO.DirectoryInfo]::new($target) } else { [IO.FileInfo]::new($target) }
  if (-not $item.Exists) { throw 'path absent' }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $acl = $item.GetAccessControl($sections)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inheritance = if ($directory) {
    [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  } else { [Security.AccessControl.InheritanceFlags]::None }
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
}

function Test-PrivateAcl([string]$target, [bool]$directory) {
  try {
    $item = if ($directory) { [IO.DirectoryInfo]::new($target) } else { [IO.FileInfo]::new($target) }
    if (-not $item.Exists) { return $false }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
    $acl = $item.GetAccessControl($sections)
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or
        $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
        $rules.Count -ne 1) { return $false }
    $rule = $rules[0]
    $expectedInheritance = if ($directory) {
      [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else { [Security.AccessControl.InheritanceFlags]::None }
    return $rule.IdentityReference.Value -eq $sid.Value -and
      $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $rule.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
      $rule.InheritanceFlags -eq $expectedInheritance -and
      $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None -and
      -not $rule.IsInherited
  } catch { return $false }
}

function Current-Base64 {
  if (-not [IO.File]::Exists($path)) { return $null }
  return [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
}

function Assert-Expected([object]$expected) {
  $current = Current-Base64
  if ($null -eq $expected) {
    if ($null -ne $current) { throw 'manifest changed' }
  } elseif ($null -eq $current -or -not [String]::Equals([string]$current, [string]$expected, [StringComparison]::Ordinal)) {
    throw 'manifest changed'
  }
}

$mutex = $null
$mutexHeld = $false
try {
if ($operation -eq 'replace') {
  $mutex = [Threading.Mutex]::new($false, 'Local\OrcaSlackBridgeRuntimeManifest-' + $sid.Value)
  try { $mutexHeld = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $mutexHeld = $true }
  if (-not $mutexHeld) { throw 'manifest mutex timeout' }
}
switch ($operation) {
  'inspect' {
    if (-not [IO.File]::Exists($path)) { Write-Result @{ exists = $false }; break }
    Write-Result @{
      exists = $true
      protected = ((Test-PrivateAcl $parent $true) -and (Test-PrivateAcl $path $false))
      bytes = (Current-Base64)
    }
  }
  'replace' {
    if (-not [IO.Directory]::Exists($parent)) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
    Set-PrivateAcl $parent $true
    Assert-Expected $inputObject.expected
    if ($null -eq $inputObject.desired) {
      if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
      Write-Result @{ ok = $true }
      break
    }
    $desired = [Convert]::FromBase64String([string]$inputObject.desired)
    $temporary = [IO.Path]::Combine($parent, '.runtime-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $backup = [IO.Path]::Combine($parent, '.runtime-' + [Guid]::NewGuid().ToString('N') + '.bak')
    $replacedExisting = $false
    $committed = $false
    try {
      $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $stream.Write($desired, 0, $desired.Length); $stream.Flush($true) } finally { $stream.Dispose() }
      Set-PrivateAcl $temporary $false
      Assert-Expected $inputObject.expected
      if ([IO.File]::Exists($path)) {
        [IO.File]::Replace($temporary, $path, $backup, $true)
        $replacedExisting = $true
      } else { [IO.File]::Move($temporary, $path) }
      if (-not (Test-PrivateAcl $parent $true) -or -not (Test-PrivateAcl $path $false) -or
          -not [String]::Equals((Current-Base64), [string]$inputObject.desired, [StringComparison]::Ordinal)) {
        if ($replacedExisting -and [IO.File]::Exists($backup) -and [IO.File]::Exists($path)) {
          [IO.File]::Replace($backup, $path, $null, $true)
        } elseif (-not $replacedExisting -and [IO.File]::Exists($path)) {
          [IO.File]::Delete($path)
        }
        throw 'manifest verification failed'
      }
      if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
      $committed = $true
      Write-Result @{ ok = $true }
    } finally {
      if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
      if (-not $committed -and [IO.File]::Exists($backup)) {
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($backup, $path, $null, $true) }
        else { [IO.File]::Move($backup, $path) }
      }
      if ($committed -and [IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
    }
  }
  default { throw 'unsupported operation' }
}
} finally {
  if ($mutexHeld) { try { $mutex.ReleaseMutex() } catch {} }
  if ($null -ne $mutex) { $mutex.Dispose() }
}
`;

function canonicalWindowsPath(value: string): boolean {
  return value.length > 0 && win32.isAbsolute(value) && win32.normalize(value) === value &&
    !/[\0\r\n"]/u.test(value);
}

function sameWindowsPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function windowsRuntimeManifestPath(
  knownLocalAppData: () => string = operationalStatusWindowsKnownLocalAppData,
): string {
  const base = knownLocalAppData();
  if (!canonicalWindowsPath(base)) throw new Error('windows.runtime_manifest.path_unavailable');
  const path = win32.join(base, 'OrcaSlackBridge', WINDOWS_RUNTIME_MANIFEST_FILE);
  if (!canonicalWindowsPath(path)) throw new Error('windows.runtime_manifest.path_unavailable');
  return path;
}

export function windowsReleaseLauncherPath(releaseRoot: string): string {
  if (!canonicalWindowsPath(releaseRoot)) throw new Error('windows.runtime_manifest.invalid');
  return win32.join(releaseRoot, WINDOWS_RELEASE_LAUNCHER_RELATIVE_PATH);
}

export function fingerprintWindowsRuntimeManifest(
  manifest: WindowsRuntimeManifestIdentity,
): string {
  const hash = createHash('sha256').update(MANIFEST_IDENTITY_HEADER, 'utf8');
  for (const key of MANIFEST_KEYS) {
    if (key === 'manifestDigest') continue;
    hash.update(String(manifest[key]), 'utf8').update('\0', 'utf8');
  }
  return hash.digest('hex');
}

export function createWindowsRuntimeManifest(input: {
  readonly releaseRoot: string;
  readonly releaseDigest: string;
  readonly nodeExe: string;
  readonly distCli: string;
  readonly launcherPath: string;
  readonly launcherSha256: string;
  readonly taskSemanticFingerprint: string;
  readonly config: string;
  readonly state: string;
  readonly orcaExe: string;
  readonly logDirectory: string;
}): WindowsRuntimeManifest {
  const identity: WindowsRuntimeManifestIdentity = {
    schemaVersion: WINDOWS_RUNTIME_MANIFEST_SCHEMA_VERSION,
    manifestRevision: WINDOWS_RUNTIME_MANIFEST_REVISION,
    ...input,
  };
  const manifest: WindowsRuntimeManifest = {
    ...identity,
    manifestDigest: fingerprintWindowsRuntimeManifest(identity),
  };
  if (parseWindowsRuntimeManifest(serializeWindowsRuntimeManifest(manifest)) === null) {
    throw new Error('windows.runtime_manifest.invalid');
  }
  return manifest;
}

export function serializeWindowsRuntimeManifest(manifest: WindowsRuntimeManifest): Buffer {
  return Buffer.from(JSON.stringify(manifest) + '\n', 'utf8');
}

export function parseWindowsRuntimeManifest(bytes: Buffer): WindowsRuntimeManifest | null {
  let raw: string;
  let value: unknown;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (raw.charCodeAt(0) === 0xfeff) return null;
    value = JSON.parse(raw) as unknown;
  } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record)) !== JSON.stringify(MANIFEST_KEYS) ||
      record['schemaVersion'] !== WINDOWS_RUNTIME_MANIFEST_SCHEMA_VERSION ||
      record['manifestRevision'] !== WINDOWS_RUNTIME_MANIFEST_REVISION ||
      typeof record['releaseDigest'] !== 'string' || !HEX_64.test(record['releaseDigest']) ||
      typeof record['launcherSha256'] !== 'string' || !HEX_64.test(record['launcherSha256']) ||
      typeof record['taskSemanticFingerprint'] !== 'string' ||
      !HEX_64.test(record['taskSemanticFingerprint']) ||
      typeof record['manifestDigest'] !== 'string' || !HEX_64.test(record['manifestDigest'])) return null;
  for (const key of [
    'releaseRoot', 'nodeExe', 'distCli', 'launcherPath', 'config', 'state', 'orcaExe', 'logDirectory',
  ] as const) {
    if (typeof record[key] !== 'string' || !canonicalWindowsPath(record[key])) return null;
  }
  const manifest = record as WindowsRuntimeManifest;
  if (!sameWindowsPath(win32.basename(manifest.releaseRoot), manifest.releaseDigest) ||
      !sameWindowsPath(manifest.distCli, win32.join(manifest.releaseRoot, 'dist', 'cli.js')) ||
      !sameWindowsPath(manifest.launcherPath, windowsReleaseLauncherPath(manifest.releaseRoot)) ||
      manifest.manifestDigest !== fingerprintWindowsRuntimeManifest(manifest) ||
      raw !== serializeWindowsRuntimeManifest(manifest).toString('utf8')) return null;
  return manifest;
}

export class CurrentUserWindowsRuntimeManifestStore implements WindowsRuntimeManifestStore {
  constructor(private readonly timeoutMilliseconds = 10_000) {}

  async inspect(path: string): Promise<WindowsRuntimeManifestSnapshot> {
    this.assertCanonicalPath(path);
    const record = await this.run('inspect', { path });
    if (!record.exists) return { kind: 'absent' };
    if (typeof record.protected !== 'boolean' || typeof record.bytes !== 'string') {
      throw new Error('windows.runtime_manifest.invalid_response');
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(record.bytes, 'base64');
      if (bytes.toString('base64') !== record.bytes) throw new Error('non-canonical base64');
    } catch {
      throw new Error('windows.runtime_manifest.invalid_response');
    }
    return {
      kind: 'present', bytes, protected: record.protected,
      manifest: parseWindowsRuntimeManifest(bytes),
    };
  }

  async replace(path: string, expected: Buffer | null, desired: Buffer | null): Promise<void> {
    this.assertCanonicalPath(path);
    if (desired !== null && parseWindowsRuntimeManifest(desired) === null) {
      throw new Error('windows.runtime_manifest.invalid');
    }
    await this.run('replace', {
      path,
      expected: expected?.toString('base64') ?? null,
      desired: desired?.toString('base64') ?? null,
    });
  }

  private assertCanonicalPath(path: string): void {
    let expected: string;
    try { expected = windowsRuntimeManifestPath(); } catch {
      throw new Error('windows.runtime_manifest.path_unavailable');
    }
    if (!sameWindowsPath(path, expected)) throw new Error('windows.runtime_manifest.invalid_path');
  }

  private async run(
    operation: 'inspect' | 'replace',
    input: object,
  ): Promise<RuntimeManifestPowerShellRecord> {
    if (process.platform !== 'win32') throw new Error('windows.runtime_manifest.unsupported_platform');
    let trusted: ReturnType<typeof operationalStatusWindowsTrustedPowerShell>;
    try { trusted = operationalStatusWindowsTrustedPowerShell(); } catch {
      throw new Error('windows.runtime_manifest.powershell_unavailable');
    }
    const encoded = Buffer.from(RUNTIME_MANIFEST_POWERSHELL, 'utf16le').toString('base64');
    return await new Promise<RuntimeManifestPowerShellRecord>((resolve, reject) => {
      const child = spawn(trusted.executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encoded,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          SystemRoot: trusted.root,
          WINDIR: trusted.root,
          ORCA_RUNTIME_MANIFEST_OPERATION: operation,
        },
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
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (parsed === null || typeof parsed !== 'object') {
            throw new Error('invalid');
          }
          const record = parsed as RuntimeManifestPowerShellRecord;
          if ((operation === 'inspect' && typeof record.exists !== 'boolean') ||
              (operation === 'replace' && record.ok !== true)) throw new Error('invalid');
          resolve(record);
        } catch { reject(new Error('windows.runtime_manifest.invalid_response')); }
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('windows.runtime_manifest.timeout'));
      }, this.timeoutMilliseconds);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          child.kill();
          finish(new Error('windows.runtime_manifest.response_too_large'));
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.once('error', () => finish(new Error('windows.runtime_manifest.launch_failed')));
      child.once('exit', (code) => {
        if (code === 0) finish();
        else finish(new Error('windows.runtime_manifest.command_failed'));
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}

export async function readValidatedWindowsRuntimeManifest(
  store: WindowsRuntimeManifestStore,
  path: string,
): Promise<{ readonly manifest: WindowsRuntimeManifest; readonly bytes: Buffer }> {
  const snapshot = await store.inspect(path);
  if (snapshot.kind !== 'present' || !snapshot.protected || snapshot.manifest === null) {
    throw new Error('windows.runtime_manifest.invalid');
  }
  return { manifest: snapshot.manifest, bytes: snapshot.bytes };
}
