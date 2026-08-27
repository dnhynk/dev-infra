import { spawn, spawnSync } from 'node:child_process';
import {
  operationalStatusWindowsTrustedPowerShell,
} from '../operational/status-capability.js';

const WINDOWS_RELEASE_PUBLICATION_MUTEX = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = [Security.AccessControl.MutexSecurity]::new()
$security.SetOwner($sid)
$security.SetAccessRuleProtection($true, $false)
$rule = [Security.AccessControl.MutexAccessRule]::new(
  $sid,
  [Security.AccessControl.MutexRights]::FullControl,
  [Security.AccessControl.AccessControlType]::Allow
)
$security.AddAccessRule($rule)
$created = $false
$mutex = $null
$held = $false
try {
  $mutex = [Threading.Mutex]::new(
    $false, 'Local\OrcaSlackBridgeReleasePublication-' + $sid.Value, [ref]$created, $security
  )
  $actual = $mutex.GetAccessControl()
  $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
      -not $actual.AreAccessRulesProtected -or $rules.Count -ne 1) { exit 17 }
  $actualRule = $rules[0]
  if ($actualRule.IdentityReference.Value -ne $sid.Value -or
      $actualRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      $actualRule.MutexRights -ne [Security.AccessControl.MutexRights]::FullControl -or
      $actualRule.IsInherited) { exit 18 }
  try { $held = $mutex.WaitOne(600000) }
  catch [Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { exit 19 }
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  [void][Console]::In.ReadToEnd()
} finally {
  if ($held) { try { $mutex.ReleaseMutex() } catch { } }
  if ($null -ne $mutex) { $mutex.Dispose() }
}
`;

const WINDOWS_ASSERT_RELEASE_TREE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$root = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($root -isnot [string] -or [String]::IsNullOrWhiteSpace($root) -or
    -not [IO.Path]::IsPathRooted($root) -or
    -not [String]::Equals([IO.Path]::GetFullPath($root), $root, [StringComparison]::OrdinalIgnoreCase)) {
  exit 21
}
$rootItem = [IO.DirectoryInfo]::new($root)
if (-not $rootItem.Exists -or
    ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    -not [String]::Equals($rootItem.FullName, $root, [StringComparison]::OrdinalIgnoreCase)) { exit 22 }
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$pending = [Collections.Generic.Stack[object]]::new()
$pending.Push([pscustomobject]@{ directory = $rootItem; relative = '' })
while ($pending.Count -gt 0) {
  $current = $pending.Pop()
  foreach ($item in $current.directory.GetFileSystemInfos()) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 23 }
    $isDirectory = $item -is [IO.DirectoryInfo]
    if (-not $isDirectory -and $item -isnot [IO.FileInfo]) { exit 24 }
    $name = [string]$item.Name
    if (-not [String]::Equals(
        $name.Normalize([Text.NormalizationForm]::FormC), $name, [StringComparison]::Ordinal
      ) -or $name.EndsWith('.') -or $name.EndsWith(' ')) { exit 25 }
    $relative = if ([String]::IsNullOrEmpty([string]$current.relative)) {
      $name
    } else { [string]$current.relative + '\' + $name }
    if (-not $seen.Add($relative.Normalize([Text.NormalizationForm]::FormC))) { exit 26 }
    if ($isDirectory) {
      $pending.Push([pscustomobject]@{ directory = $item; relative = $relative })
    }
  }
}
[Console]::Out.Write('ok')
`;

function encodedPowerShellArguments(script: string): readonly string[] {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

function trustedPowerShellEnvironment(root: string): NodeJS.ProcessEnv {
  return { SystemRoot: root, WINDIR: root };
}

export type WindowsReleasePublicationMutex = {
  readonly release: () => Promise<void>;
};

/** Current-user-only named mutex that serializes all publications into this user's release store. */
export async function acquireWindowsReleasePublicationMutex(): Promise<WindowsReleasePublicationMutex> {
  const trusted = operationalStatusWindowsTrustedPowerShell();
  return await new Promise((resolveLock, rejectLock) => {
    const child = spawn(
      trusted.executable,
      encodedPowerShellArguments(WINDOWS_RELEASE_PUBLICATION_MUTEX),
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        env: trustedPowerShellEnvironment(trusted.root),
      },
    );
    let output = '';
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      rejectLock(new Error('windows.stage.publication_mutex_failed'));
    };
    const timer = setTimeout(fail, 610_000);
    timer.unref?.();
    child.once('error', fail);
    child.once('exit', () => { if (!settled) fail(); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 16) { fail(); return; }
      if (output !== 'ready\r\n' && output !== 'ready\n') return;
      settled = true;
      clearTimeout(timer);
      let released = false;
      resolveLock({
        release: async () => {
          if (released) return;
          released = true;
          child.stdin.end();
          await new Promise<void>((resolveExit, rejectExit) => {
            if (child.exitCode !== null) {
              if (child.exitCode === 0) resolveExit();
              else rejectExit(new Error('windows.stage.publication_mutex_release_failed'));
              return;
            }
            const releaseTimer = setTimeout(() => {
              child.kill();
              rejectExit(new Error('windows.stage.publication_mutex_release_failed'));
            }, 10_000);
            releaseTimer.unref?.();
            child.once('exit', (code) => {
              clearTimeout(releaseTimer);
              if (code === 0) resolveExit();
              else rejectExit(new Error('windows.stage.publication_mutex_release_failed'));
            });
          });
        },
      });
    });
  });
}

/** Native Windows attribute/NFC/OrdinalIgnoreCase scan independent of Node's POSIX-like stat view. */
export function assertWindowsReleaseFilesystemSemantics(root: string): void {
  const trusted = operationalStatusWindowsTrustedPowerShell();
  const checked = spawnSync(
    trusted.executable,
    encodedPowerShellArguments(WINDOWS_ASSERT_RELEASE_TREE),
    {
      input: JSON.stringify(root),
      encoding: 'utf8',
      env: trustedPowerShellEnvironment(trusted.root),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 120_000,
      maxBuffer: 64,
    },
  );
  if (checked.error !== undefined || checked.status !== 0 || checked.stdout !== 'ok') {
    throw new Error('windows.stage.invalid_windows_release_tree');
  }
}
