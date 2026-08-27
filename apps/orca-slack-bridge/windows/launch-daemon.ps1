param(
  [Parameter(Mandatory = $true)]
  [string]$SettingsPath
)

$botTokenName = 'ORCA_SLACK_BRIDGE_BOT_TOKEN'
$appTokenName = 'ORCA_SLACK_BRIDGE_APP_TOKEN'
$buildIdentityName = 'ORCA_SLACK_BRIDGE_BUILD'

# Task Scheduler may cache a logon environment. Remove both inherited values before doing any
# manifest work; only fresh Windows User-scope values are copied into the daemon child below.
[Environment]::SetEnvironmentVariable($botTokenName, $null, [EnvironmentVariableTarget]::Process)
[Environment]::SetEnvironmentVariable($appTokenName, $null, [EnvironmentVariableTarget]::Process)
[Environment]::SetEnvironmentVariable($buildIdentityName, $null, [EnvironmentVariableTarget]::Process)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Exit-StaticFailure([string]$Code) {
  [Console]::Error.WriteLine($Code)
  exit 2
}

function Assert-AbsoluteCanonicalPath([string]$Value) {
  if ([String]::IsNullOrWhiteSpace($Value) -or
      $Value.IndexOf([char]0) -ge 0 -or
      $Value.IndexOf([char]13) -ge 0 -or
      $Value.IndexOf([char]10) -ge 0 -or
      $Value.IndexOf([char]34) -ge 0 -or
      -not [IO.Path]::IsPathRooted($Value) -or
      -not [String]::Equals([IO.Path]::GetFullPath($Value), $Value, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'invalid path'
  }
}

function ConvertTo-NativeArgument([string]$Value) {
  if ($Value.IndexOf([char]0) -ge 0 -or $Value.IndexOf([char]13) -ge 0 -or
      $Value.IndexOf([char]10) -ge 0) { throw 'invalid argument' }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append([char]34)
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) {
      $backslashes += 1
      continue
    }
    if ($character -eq [char]34) {
      [void]$builder.Append(([string][char]92) * ($backslashes * 2 + 1))
      [void]$builder.Append([char]34)
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) { [void]$builder.Append(([string][char]92) * $backslashes) }
    [void]$builder.Append($character)
    $backslashes = 0
  }
  if ($backslashes -gt 0) { [void]$builder.Append(([string][char]92) * ($backslashes * 2)) }
  [void]$builder.Append([char]34)
  return $builder.ToString()
}

function Test-PrivateAcl([string]$Target, [bool]$Directory) {
  try {
    $item = if ($Directory) { [IO.DirectoryInfo]::new($Target) } else { [IO.FileInfo]::new($Target) }
    if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      return $false
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $sections = [Security.AccessControl.AccessControlSections]::Access -bor
      [Security.AccessControl.AccessControlSections]::Owner
    $acl = $item.GetAccessControl($sections)
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or
        $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
        $rules.Count -ne 1) { return $false }
    $rule = $rules[0]
    $expectedInheritance = if ($Directory) {
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

function Assert-WindowsReleaseTree([string]$Root) {
  $rootItem = [IO.DirectoryInfo]::new($Root)
  if (-not $rootItem.Exists -or
      ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      -not [String]::Equals($rootItem.FullName, $Root, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'release root attributes'
  }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $pending = [Collections.Generic.Stack[object]]::new()
  $pending.Push([pscustomobject]@{ directory = $rootItem; relative = '' })
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($item in $current.directory.GetFileSystemInfos()) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'release reparse point'
      }
      $isDirectory = $item -is [IO.DirectoryInfo]
      if (-not $isDirectory -and $item -isnot [IO.FileInfo]) { throw 'release kind' }
      $name = [string]$item.Name
      if (-not [String]::Equals(
          $name.Normalize([Text.NormalizationForm]::FormC), $name, [StringComparison]::Ordinal
        ) -or $name.EndsWith('.') -or $name.EndsWith(' ')) { throw 'release name' }
      $relative = if ([String]::IsNullOrEmpty([string]$current.relative)) {
        $name
      } else { [string]$current.relative + '\' + $name }
      if (-not $seen.Add($relative.Normalize([Text.NormalizationForm]::FormC))) {
        throw 'release collision'
      }
      if ($isDirectory) {
        $pending.Push([pscustomobject]@{ directory = $item; relative = $relative })
      }
    }
  }
}

function ConvertTo-LowerHex([byte[]]$Bytes) {
  return [BitConverter]::ToString($Bytes).Replace('-', '').ToLowerInvariant()
}

function Get-StreamSha256([IO.Stream]$Stream) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $Stream.Position = 0
    $result = ConvertTo-LowerHex ($sha.ComputeHash($Stream))
    $Stream.Position = 0
    return $result
  } finally { $sha.Dispose() }
}

function Get-RuntimeManifestDigest($Runtime) {
  $separator = [string][char]0
  $values = @(
    [string]$Runtime.schemaVersion,
    [string]$Runtime.manifestRevision,
    [string]$Runtime.releaseRoot,
    [string]$Runtime.releaseDigest,
    [string]$Runtime.nodeExe,
    [string]$Runtime.distCli,
    [string]$Runtime.launcherPath,
    [string]$Runtime.launcherSha256,
    [string]$Runtime.taskSemanticFingerprint,
    [string]$Runtime.config,
    [string]$Runtime.state,
    [string]$Runtime.orcaExe,
    [string]$Runtime.logDirectory
  )
  $identity = 'orca-slack-bridge-runtime-manifest-v2' + $separator +
    (($values | ForEach-Object { $_ + $separator }) -join '')
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ConvertTo-LowerHex ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))) }
  finally { $sha.Dispose() }
}

$releaseVerifier = @'
const crypto = require('node:crypto');
const fs = require('node:fs');
const { win32 } = require('node:path');

function samePath(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function isWithin(parent, candidate) {
  const child = win32.relative(parent, candidate);
  return child === '' || (child !== '..' && !child.startsWith('..\\') && !win32.isAbsolute(child));
}

function identity(path) {
  const stats = fs.lstatSync(path, { bigint: true });
  if (stats.isSymbolicLink()) throw new Error('reparse');
  if (stats.isFile() && stats.nlink !== 1n) throw new Error('hardlink');
  return {
    file: stats.isFile(),
    directory: stats.isDirectory(),
    size: stats.size,
    identity: [stats.dev, stats.ino, stats.size, stats.nlink, stats.mtimeNs, stats.ctimeNs]
      .map((value) => value.toString()).join(':'),
  };
}

function descriptorIdentity(descriptor) {
  const stats = fs.fstatSync(descriptor, { bigint: true });
  if (stats.isFile() && stats.nlink !== 1n) throw new Error('hardlink');
  return {
    file: stats.isFile(),
    size: stats.size,
    identity: [stats.dev, stats.ino, stats.size, stats.nlink, stats.mtimeNs, stats.ctimeNs]
      .map((value) => value.toString()).join(':'),
  };
}

function collect(root) {
  const result = [];
  const normalizedPaths = new Set();
  const visit = (directory, relative) => {
    const entries = fs.readdirSync(directory, { encoding: 'utf8' }).sort();
    for (const entry of entries) {
      if (entry.normalize('NFC') !== entry || /[\0\\/]/u.test(entry) || /[. ]$/u.test(entry)) {
        throw new Error('name');
      }
      const childRelative = win32.join(relative, entry);
      const child = win32.join(root, childRelative);
      const observed = identity(child);
      const canonical = fs.realpathSync.native(child);
      if (!samePath(canonical, child) || !isWithin(root, canonical)) throw new Error('escape');
      if (!observed.file && !observed.directory) throw new Error('kind');
      const relativeForDigest = childRelative.replaceAll('\\', '/');
      const normalizedKey = relativeForDigest.normalize('NFC').toLowerCase();
      if (normalizedPaths.has(normalizedKey)) throw new Error('collision');
      normalizedPaths.add(normalizedKey);
      result.push({
        kind: observed.directory ? 'directory' : 'file',
        relative: relativeForDigest,
        nativePath: child,
        identity: observed.identity,
        size: observed.size,
      });
      if (observed.directory) visit(child, childRelative);
    }
  };
  visit(root, '');
  return result;
}

function updateLength(hash, length) {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(length);
  hash.update(encoded);
}

const manifestKeys = [
  'schemaVersion', 'manifestRevision', 'releaseRoot', 'releaseDigest', 'nodeExe', 'distCli',
  'launcherPath', 'launcherSha256', 'taskSemanticFingerprint',
  'config', 'state', 'orcaExe', 'logDirectory', 'manifestDigest',
];

function manifestIdentityDigest(runtime) {
  const hash = crypto.createHash('sha256');
  hash.update('orca-slack-bridge-runtime-manifest-v2\0', 'utf8');
  for (const key of manifestKeys) {
    if (key === 'manifestDigest') continue;
    hash.update(String(runtime[key]), 'utf8').update('\0', 'utf8');
  }
  return hash.digest('hex');
}

function parseManifest(encoded, root, expected, expectedLauncher) {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > 128 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error('manifest bytes');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('manifest bytes');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (raw.charCodeAt(0) === 0xfeff) throw new Error('manifest encoding');
  const runtime = JSON.parse(raw);
  if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime) ||
      JSON.stringify(Object.keys(runtime)) !== JSON.stringify(manifestKeys) ||
      JSON.stringify(runtime) + '\n' !== raw || runtime.schemaVersion !== 2 ||
      runtime.manifestRevision !== 1 || runtime.releaseRoot !== root ||
      runtime.releaseDigest !== expected || !samePath(runtime.launcherPath, expectedLauncher) ||
      !/^[a-f0-9]{64}$/u.test(runtime.launcherSha256) ||
      !/^[a-f0-9]{64}$/u.test(runtime.taskSemanticFingerprint) ||
      !/^[a-f0-9]{64}$/u.test(runtime.manifestDigest) ||
      manifestIdentityDigest(runtime) !== runtime.manifestDigest) throw new Error('manifest identity');
  return runtime;
}

function verify(root, expected, expectedLauncher, encodedManifest) {
  if (process.argv.length !== 4 || typeof root !== 'string' || typeof expected !== 'string' ||
      typeof expectedLauncher !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(expected) || !win32.isAbsolute(root) ||
      win32.basename(root) !== expected) throw new Error('arguments');
  const runtime = parseManifest(encodedManifest, root, expected, expectedLauncher);
  const rootBefore = identity(root);
  if (!rootBefore.directory || !samePath(fs.realpathSync.native(root), root)) throw new Error('root');
  const before = collect(root);
  const hash = crypto.createHash('sha256');
  let launcherSha256 = null;
  hash.update('orca-slack-bridge-release-v2\0', 'utf8');
  for (const entry of before) {
    hash.update(entry.kind === 'directory' ? 'D' : 'F', 'ascii');
    const name = Buffer.from(entry.relative, 'utf8');
    updateLength(hash, BigInt(name.length));
    hash.update(name);
    if (entry.kind === 'file') {
      let descriptor = null;
      let bytes;
      try {
        descriptor = fs.openSync(entry.nativePath, 'r');
        const immediatelyBefore = descriptorIdentity(descriptor);
        if (!immediatelyBefore.file || immediatelyBefore.identity !== entry.identity) {
          throw new Error('changed');
        }
        bytes = fs.readFileSync(descriptor);
        const afterRead = descriptorIdentity(descriptor);
        if (!afterRead.file || afterRead.identity !== entry.identity ||
            BigInt(bytes.length) !== entry.size) throw new Error('changed');
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
      }
      const afterPathRead = identity(entry.nativePath);
      if (!afterPathRead.file || afterPathRead.identity !== entry.identity) throw new Error('changed');
      updateLength(hash, BigInt(bytes.length));
      hash.update(bytes);
      if (entry.relative === 'windows/launch-daemon.ps1') {
        launcherSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      }
    }
  }
  const after = collect(root);
  const projection = (entries) => entries.map(({ kind, relative, identity }) => ({
    kind, relative, identity,
  }));
  if (JSON.stringify(projection(after)) !== JSON.stringify(projection(before))) {
    throw new Error('changed');
  }
  const rootAfter = identity(root);
  if (!rootAfter.directory || rootAfter.identity !== rootBefore.identity ||
      !samePath(fs.realpathSync.native(root), root)) throw new Error('changed');
  const actual = hash.digest('hex');
  if (actual !== expected || launcherSha256 !== runtime.launcherSha256) throw new Error('digest');
}

try {
  verify(process.argv[1], process.argv[2], process.argv[3], fs.readFileSync(0, 'utf8'));
} catch {
  process.exitCode = 1;
}
'@

function Assert-ReleaseClosure($Runtime, [byte[]]$ManifestBytes) {
  Assert-WindowsReleaseTree ([string]$Runtime.releaseRoot)
  $encodedVerifier = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($releaseVerifier))
  $verifierBootstrap = "const source=process.argv[1];process.argv.splice(1,1);eval(Buffer.from(source,'base64').toString('utf8'));"
  $arguments = @(
    '--input-type=commonjs', '--eval', $verifierBootstrap, $encodedVerifier,
    [string]$Runtime.releaseRoot, [string]$Runtime.releaseDigest, [string]$Runtime.launcherPath
  )
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = [string]$Runtime.nodeExe
  $start.WorkingDirectory = [string]$Runtime.releaseRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.Arguments = (($arguments | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join ' ')
  [void]$start.EnvironmentVariables.Remove($botTokenName)
  [void]$start.EnvironmentVariables.Remove($appTokenName)
  [void]$start.EnvironmentVariables.Remove($buildIdentityName)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw 'verifier start' }
    $process.StandardInput.Write([Convert]::ToBase64String($ManifestBytes))
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) {
      try { $process.Kill() } catch { }
      throw 'verifier timeout'
    }
    if ($process.ExitCode -ne 0) { throw 'verifier rejected' }
  } finally {
    $process.Dispose()
  }
  Assert-WindowsReleaseTree ([string]$Runtime.releaseRoot)
}

$taskBindingVerifier = @'
const fs = require('node:fs');
const { win32 } = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.length === 0 || raw.length > 2 * 1024 * 1024) throw new Error('input');
  const input = JSON.parse(raw);
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      JSON.stringify(Object.keys(input)) !== JSON.stringify([
        'xml', 'currentSid', 'resolvedTriggerUserSid', 'powerShellPath', 'settingsPath', 'releaseRoot',
        'releaseDigest', 'launcherPath', 'taskSemanticFingerprint',
      ]) || typeof input.xml !== 'string' || input.xml.length === 0 ||
      input.xml.length > 1024 * 1024 || typeof input.currentSid !== 'string' ||
      !/^S-[0-9]+(?:-[0-9]+)+$/u.test(input.currentSid) ||
      typeof input.resolvedTriggerUserSid !== 'string' ||
      !/^S-[0-9]+(?:-[0-9]+)+$/u.test(input.resolvedTriggerUserSid)) throw new Error('input');
  const modulePath = win32.join(input.releaseRoot, 'dist', 'windows', 'task-scheduler.js');
  const api = await import(pathToFileURL(modulePath).href);
  if (!api.windowsTaskXmlMatchesLaunchBinding(input.xml, {
    currentSid: input.currentSid,
    releaseRoot: input.releaseRoot,
    releaseDigest: input.releaseDigest,
    powerShellPath: input.powerShellPath,
    launcherPath: input.launcherPath,
    runtimeManifestPath: input.settingsPath,
    taskSemanticFingerprint: input.taskSemanticFingerprint,
  }, undefined, input.resolvedTriggerUserSid)) throw new Error('identity');
}

main().catch(() => { process.exitCode = 1; });
'@

function Assert-TaskBinding($Runtime, [string]$RuntimeSettingsPath) {
  $taskName = 'Orca Slack Bridge Daemon'
  $taskPath = '\'
  $task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
  if ($null -eq $task -or
      -not [String]::Equals([string]$task.TaskName, $taskName, [StringComparison]::Ordinal) -or
      -not [String]::Equals([string]$task.TaskPath, $taskPath, [StringComparison]::Ordinal)) {
    throw 'task identity'
  }
  $xmlBefore = Export-ScheduledTask -TaskPath $taskPath -TaskName $taskName
  if ([String]::IsNullOrWhiteSpace($xmlBefore) -or $xmlBefore.Length -gt 1048576) {
    throw 'task export'
  }
  $xmlSettings = [Xml.XmlReaderSettings]::new()
  $xmlSettings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $xmlSettings.XmlResolver = $null
  $stringReader = [IO.StringReader]::new($xmlBefore)
  $xmlReader = [Xml.XmlReader]::Create($stringReader, $xmlSettings)
  try {
    $taskDocument = [Xml.XmlDocument]::new()
    $taskDocument.XmlResolver = $null
    $taskDocument.Load($xmlReader)
  } finally {
    $xmlReader.Dispose()
    $stringReader.Dispose()
  }
  $namespace = [Xml.XmlNamespaceManager]::new($taskDocument.NameTable)
  $namespace.AddNamespace('task', $taskDocument.DocumentElement.NamespaceURI)
  $triggerUsers = @($taskDocument.SelectNodes(
    '/task:Task/task:Triggers/task:LogonTrigger/task:UserId',
    $namespace
  ))
  if ($triggerUsers.Count -ne 1) { throw 'task trigger identity' }
  $rawTriggerUser = [string]$triggerUsers[0].InnerText
  if ([String]::IsNullOrWhiteSpace($rawTriggerUser) -or
      -not [String]::Equals($rawTriggerUser, $rawTriggerUser.Trim(), [StringComparison]::Ordinal)) {
    throw 'task trigger identity'
  }
  [object[]]$resolvedTriggerUsers = @()
  try {
    $resolvedTriggerUsers = @([Security.Principal.SecurityIdentifier]::new($rawTriggerUser))
  } catch [ArgumentException] {
    try {
      $resolvedTriggerUsers = @(
        [Security.Principal.NTAccount]::new($rawTriggerUser).Translate(
          [Security.Principal.SecurityIdentifier]
        )
      )
    } catch [Security.Principal.IdentityNotMappedException] {
      throw 'task trigger identity'
    }
  }
  if ($resolvedTriggerUsers.Count -ne 1 -or
      $resolvedTriggerUsers[0] -isnot [Security.Principal.SecurityIdentifier]) {
    throw 'task trigger identity'
  }
  $resolvedTriggerUserSid = [string]$resolvedTriggerUsers[0].Value
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $systemDirectory = [Environment]::SystemDirectory
  Assert-AbsoluteCanonicalPath $systemDirectory
  $expectedPowerShell = [IO.Path]::Combine(
    $systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  )
  $currentPowerShell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  Assert-AbsoluteCanonicalPath $currentPowerShell
  if (-not [String]::Equals(
      $currentPowerShell, $expectedPowerShell, [StringComparison]::OrdinalIgnoreCase
    )) { throw 'task shell' }
  $inputObject = [ordered]@{
    xml = $xmlBefore
    currentSid = $sid
    resolvedTriggerUserSid = $resolvedTriggerUserSid
    powerShellPath = $currentPowerShell
    settingsPath = $RuntimeSettingsPath
    releaseRoot = [string]$Runtime.releaseRoot
    releaseDigest = [string]$Runtime.releaseDigest
    launcherPath = [string]$Runtime.launcherPath
    taskSemanticFingerprint = [string]$Runtime.taskSemanticFingerprint
  }
  $encodedVerifier = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($taskBindingVerifier))
  $verifierBootstrap = "eval(Buffer.from(process.argv[1],'base64').toString('utf8'));"
  $arguments = @('--input-type=commonjs', '--eval', $verifierBootstrap, $encodedVerifier)
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = [string]$Runtime.nodeExe
  $start.WorkingDirectory = [string]$Runtime.releaseRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.Arguments = (($arguments | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join ' ')
  [void]$start.EnvironmentVariables.Remove($botTokenName)
  [void]$start.EnvironmentVariables.Remove($appTokenName)
  [void]$start.EnvironmentVariables.Remove($buildIdentityName)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw 'task verifier start' }
    $process.StandardInput.Write(($inputObject | ConvertTo-Json -Compress -Depth 3))
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) {
      try { $process.Kill() } catch { }
      throw 'task verifier timeout'
    }
    if ($process.ExitCode -ne 0) { throw 'task verifier rejected' }
  } finally { $process.Dispose() }
  $xmlAfter = Export-ScheduledTask -TaskPath $taskPath -TaskName $taskName
  if ($xmlAfter -cne $xmlBefore) { throw 'task changed' }
}

$manifestStream = $null
$launcherStream = $null
try {
  Assert-AbsoluteCanonicalPath $PSCommandPath
  $launcherStream = [IO.File]::Open(
    $PSCommandPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read
  )
  Assert-AbsoluteCanonicalPath $SettingsPath
  $knownLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  Assert-AbsoluteCanonicalPath $knownLocalAppData
  if (-not [IO.Directory]::Exists($knownLocalAppData)) { throw 'known folder absent' }
  $expectedSettingsPath = [IO.Path]::Combine($knownLocalAppData, 'OrcaSlackBridge', 'runtime.json')
  if (-not [String]::Equals($SettingsPath, $expectedSettingsPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'manifest path'
  }
  $manifestParent = [IO.Path]::GetDirectoryName($SettingsPath)
  if (-not (Test-PrivateAcl $manifestParent $true) -or
      -not (Test-PrivateAcl $SettingsPath $false)) { throw 'manifest protection' }
  $manifestStream = [IO.File]::Open(
    $SettingsPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read
  )
  if ($manifestStream.Length -le 0 -or $manifestStream.Length -gt 65536) { throw 'manifest size' }
  $manifestBytes = [byte[]]::new([int]$manifestStream.Length)
  $offset = 0
  while ($offset -lt $manifestBytes.Length) {
    $count = $manifestStream.Read($manifestBytes, $offset, $manifestBytes.Length - $offset)
    if ($count -le 0) { throw 'manifest read' }
    $offset += $count
  }
  if (-not (Test-PrivateAcl $manifestParent $true) -or
      -not (Test-PrivateAcl $SettingsPath $false)) { throw 'manifest protection' }
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  $rawManifest = $utf8.GetString($manifestBytes)
  $runtime = $rawManifest | ConvertFrom-Json
  if ($null -eq $runtime -or $runtime -is [Array]) { throw 'manifest shape' }
  $expectedProperties = @(
    'schemaVersion', 'manifestRevision', 'releaseRoot', 'releaseDigest', 'nodeExe', 'distCli',
    'launcherPath', 'launcherSha256', 'taskSemanticFingerprint',
    'config', 'state', 'orcaExe', 'logDirectory', 'manifestDigest'
  )
  $actualProperties = @($runtime.PSObject.Properties.Name)
  if ($actualProperties.Count -ne $expectedProperties.Count) { throw 'manifest keys' }
  for ($index = 0; $index -lt $expectedProperties.Count; $index += 1) {
    if (-not [String]::Equals(
      [string]$actualProperties[$index],
      [string]$expectedProperties[$index],
      [StringComparison]::Ordinal
    )) { throw 'manifest keys' }
  }
  if ($runtime.schemaVersion -ne 2 -or $runtime.manifestRevision -ne 1 -or
      $runtime.releaseDigest -isnot [string] -or
      $runtime.releaseDigest -cnotmatch '^[a-f0-9]{64}$' -or
      $runtime.launcherSha256 -isnot [string] -or
      $runtime.launcherSha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $runtime.taskSemanticFingerprint -isnot [string] -or
      $runtime.taskSemanticFingerprint -cnotmatch '^[a-f0-9]{64}$' -or
      $runtime.manifestDigest -isnot [string] -or
      $runtime.manifestDigest -cnotmatch '^[a-f0-9]{64}$' -or
      -not [String]::Equals(
        [string]$runtime.manifestDigest,
        (Get-RuntimeManifestDigest $runtime),
        [StringComparison]::Ordinal
      )) { throw 'manifest identity' }
  $canonicalManifest = ($runtime | ConvertTo-Json -Compress -Depth 4) + "`n"
  if (-not [String]::Equals($rawManifest, $canonicalManifest, [StringComparison]::Ordinal)) {
    throw 'manifest encoding'
  }
  foreach ($property in @(
    'releaseRoot', 'nodeExe', 'distCli', 'launcherPath',
    'config', 'state', 'orcaExe', 'logDirectory'
  )) {
    if ($runtime.$property -isnot [string]) { throw 'manifest path type' }
    Assert-AbsoluteCanonicalPath ([string]$runtime.$property)
  }
  $expectedReleaseRoot = [IO.Path]::Combine(
    $knownLocalAppData, 'OrcaSlackBridge', 'releases', [string]$runtime.releaseDigest
  )
  if (-not [String]::Equals(
      [string]$runtime.releaseRoot,
      $expectedReleaseRoot,
      [StringComparison]::OrdinalIgnoreCase
    )) { throw 'manifest release root' }
  if (-not [String]::Equals(
      [IO.Path]::GetFileName([string]$runtime.releaseRoot),
      [string]$runtime.releaseDigest,
      [StringComparison]::Ordinal
    ) -or
    -not [String]::Equals(
      [string]$runtime.distCli,
      [IO.Path]::Combine([string]$runtime.releaseRoot, 'dist', 'cli.js'),
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not [String]::Equals([string]$runtime.launcherPath, $PSCommandPath, [StringComparison]::OrdinalIgnoreCase) -or
    -not [String]::Equals(
      [string]$runtime.launcherSha256,
      (Get-StreamSha256 $launcherStream),
      [StringComparison]::Ordinal
    )) { throw 'manifest release' }
  foreach ($file in @(
    $runtime.nodeExe, $runtime.distCli, $runtime.launcherPath,
    $runtime.config, $runtime.state, $runtime.orcaExe
  )) {
    if (-not [IO.File]::Exists([string]$file)) { throw 'manifest file' }
  }
  if (-not [IO.Directory]::Exists([string]$runtime.releaseRoot) -or
      -not [IO.Directory]::Exists([string]$runtime.logDirectory)) { throw 'manifest directory' }

  # Hash and structural verification run before either Windows User-scope secret is read.
  Assert-ReleaseClosure $runtime $manifestBytes
  Assert-TaskBinding $runtime $SettingsPath
  # The task verifier imports only the already-verified scheduler parser; rescan before secrets.
  Assert-ReleaseClosure $runtime $manifestBytes
  $manifestStream.Dispose()
  $manifestStream = $null

  # These are the only two Windows User-scope reads performed by the launcher.
  $botToken = [Environment]::GetEnvironmentVariable($botTokenName, [EnvironmentVariableTarget]::User)
  $appToken = [Environment]::GetEnvironmentVariable($appTokenName, [EnvironmentVariableTarget]::User)
  if ([String]::IsNullOrWhiteSpace($botToken) -or [String]::IsNullOrWhiteSpace($appToken)) {
    Exit-StaticFailure 'windows.launcher.required_environment_absent'
  }

  $daemonArguments = @(
    [string]$runtime.distCli, 'daemon',
    '--config', [string]$runtime.config,
    '--state', [string]$runtime.state,
    '--orca', [string]$runtime.orcaExe,
    '--log-dir', [string]$runtime.logDirectory
  )
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = [string]$runtime.nodeExe
  $start.WorkingDirectory = [string]$runtime.releaseRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.Arguments = (($daemonArguments | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join ' ')
  [void]$start.EnvironmentVariables.Remove($botTokenName)
  [void]$start.EnvironmentVariables.Remove($appTokenName)
  [void]$start.EnvironmentVariables.Remove($buildIdentityName)
  $start.EnvironmentVariables[$botTokenName] = $botToken
  $start.EnvironmentVariables[$appTokenName] = $appToken
  $start.EnvironmentVariables[$buildIdentityName] = [string]$runtime.releaseDigest

  $daemon = [Diagnostics.Process]::new()
  $daemon.StartInfo = $start
  if (-not $daemon.Start()) { throw 'daemon start' }
  $daemon.WaitForExit()
  $exitCode = $daemon.ExitCode
  $daemon.Dispose()
  exit $exitCode
} catch {
  Exit-StaticFailure 'windows.launcher.invalid_runtime_manifest'
} finally {
  if ($null -ne $manifestStream) { $manifestStream.Dispose() }
  if ($null -ne $launcherStream) { $launcherStream.Dispose() }
}
