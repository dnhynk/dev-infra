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

try {
  Assert-AbsoluteCanonicalPath $SettingsPath
  if (-not [IO.File]::Exists($SettingsPath)) { throw 'manifest absent' }
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  $rawManifest = [IO.File]::ReadAllText($SettingsPath, $utf8)
  $runtime = $rawManifest | ConvertFrom-Json
  if ($null -eq $runtime -or $runtime -is [Array]) { throw 'manifest shape' }
  $expectedProperties = @(
    'schemaVersion', 'releaseRoot', 'releaseDigest', 'nodeExe', 'distCli',
    'config', 'state', 'orcaExe', 'logDirectory'
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
  if ($runtime.schemaVersion -ne 1 -or
      $runtime.releaseDigest -isnot [string] -or
      $runtime.releaseDigest -cnotmatch '^[a-f0-9]{64}$') { throw 'manifest version' }
  $canonicalManifest = ($runtime | ConvertTo-Json -Compress -Depth 3) + "`n"
  if (-not [String]::Equals($rawManifest, $canonicalManifest, [StringComparison]::Ordinal)) {
    throw 'manifest encoding'
  }
  foreach ($property in @('releaseRoot', 'nodeExe', 'distCli', 'config', 'state', 'orcaExe', 'logDirectory')) {
    if ($runtime.$property -isnot [string]) { throw 'manifest path type' }
    Assert-AbsoluteCanonicalPath ([string]$runtime.$property)
  }
  if (-not [String]::Equals(
      [IO.Path]::GetFileName([string]$runtime.releaseRoot),
      [string]$runtime.releaseDigest,
      [StringComparison]::Ordinal
    ) -or
    -not [String]::Equals(
      [string]$runtime.distCli,
      [IO.Path]::Combine([string]$runtime.releaseRoot, 'dist', 'cli.js'),
      [StringComparison]::OrdinalIgnoreCase
    )) { throw 'manifest release' }
  foreach ($file in @($runtime.nodeExe, $runtime.distCli, $runtime.config, $runtime.state, $runtime.orcaExe)) {
    if (-not [IO.File]::Exists([string]$file)) { throw 'manifest file' }
  }
  if (-not [IO.Directory]::Exists([string]$runtime.releaseRoot) -or
      -not [IO.Directory]::Exists([string]$runtime.logDirectory)) { throw 'manifest directory' }

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
}
