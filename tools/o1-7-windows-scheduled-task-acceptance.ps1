[CmdletBinding()]
param(
  [ValidateRange(75, 180)]
  [int]$TimeoutSeconds = 105
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$mutex = [Threading.Mutex]::new($false, 'Local\OrcaSlackBridgeO17ScheduledTaskAcceptance')
$mutexHeld = $false
$taskName = $null
$taskCreated = $false
$registrationAttempted = $false
$tempRoot = $null
$payloadPath = $null
$semanticExportMatched = $false
$semanticFailureCategories = @()
$demandStartObserved = $false
$ignoreNewObserved = $false
$failureExitObserved = $false
$nonzeroRestartObserved = $false
$cleanExitObserved = $false
$failureCode = $null
$residualTasks = 0
$residualProcesses = 0
$residualFiles = 0
$stage = 'preflight'

function Get-AcceptanceProcesses([string]$exactPayloadPath) {
  if ([String]::IsNullOrEmpty($exactPayloadPath)) { return @() }
  return @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -and
      $_.CommandLine.IndexOf($exactPayloadPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$Code) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $Code
}

function Write-AtomicJson([string]$Path, [hashtable]$Value) {
  $temporary = "$Path.$PID.tmp"
  $json = $Value | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $Path) {
    $backup = "$Path.$PID.bak"
    try {
      [IO.File]::Replace($temporary, $Path, $backup, $true)
    } finally {
      [IO.File]::Delete($backup)
    }
  } else {
    [IO.File]::Move($temporary, $Path)
  }
}

try {
  if (-not $IsWindows) { throw 'platform_not_windows' }
  $mutexHeld = $mutex.WaitOne(0)
  if (-not $mutexHeld) { throw 'acceptance_already_running' }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principalCheck = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'elevated_process_forbidden'
  }
  $sid = $identity.User.Value
  $nonce = [Guid]::NewGuid().ToString('N')
  $taskName = "Orca Slack Bridge O1-7 Acceptance $nonce"
  $marker = "ORCA_O1_7_DISPOSABLE_V1;$nonce"

  # The exact, unique target is checked before any task or file mutation.
  if ($null -ne (Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue)) {
    throw 'exact_target_collision'
  }

  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) "orca-o1-7-task-$nonce"
  $payloadPath = Join-Path $tempRoot 'mock-payload.ps1'
  $statePath = Join-Path $tempRoot 'state.json'
  $controlPath = Join-Path $tempRoot 'control.json'
  New-Item -ItemType Directory -Path $tempRoot -ErrorAction Stop | Out-Null

  @'
param(
  [Parameter(Mandatory=$true)][string]$StatePath,
  [Parameter(Mandatory=$true)][string]$ControlPath
)
$ErrorActionPreference = 'Stop'
$mutexName = 'Local\OrcaSlackBridgeO17Payload'
$guard = [Threading.Mutex]::new($false, $mutexName)
$held = $false
try {
  $held = $guard.WaitOne(0)
  if (-not $held) { exit 91 }
  $phase = [string](Get-Content -LiteralPath $ControlPath -Raw | ConvertFrom-Json).phase
  if ($phase -notin @('ignore', 'restart')) { exit 92 }
  $attempt = 1
  if (Test-Path -LiteralPath $StatePath) {
    $prior = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ([string]$prior.phase -eq $phase) { $attempt = [int]$prior.attempt + 1 }
  }
  $temporary = "$StatePath.$PID.tmp"
  $json = @{ phase = $phase; attempt = $attempt } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $StatePath) {
    $backup = "$StatePath.$PID.bak"
    try {
      [IO.File]::Replace($temporary, $StatePath, $backup, $true)
    } finally {
      [IO.File]::Delete($backup)
    }
  } else {
    [IO.File]::Move($temporary, $StatePath)
  }
  if ($phase -eq 'ignore') {
    Start-Sleep -Seconds 8
    exit 0
  }
  if ($attempt -eq 1) {
    exit 23
  }
  Start-Sleep -Seconds 2
  exit 0
} finally {
  if ($held) { $guard.ReleaseMutex() }
  $guard.Dispose()
}
'@ | Set-Content -LiteralPath $payloadPath -Encoding utf8NoBOM

  $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$payloadPath`" -StatePath `"$statePath`" -ControlPath `"$controlPath`""
  $stage = 'definition'
  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $tempRoot
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
  $restartTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30) `
    -RepetitionInterval ([TimeSpan]::FromMinutes(1)) `
    -RepetitionDuration ([TimeSpan]::FromMinutes(2))
  $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
  $definition = New-ScheduledTask -Action $action -Trigger @($logonTrigger, $restartTrigger) -Principal $principal `
    -Settings $settings -Description $marker
  $stage = 'register'
  $registrationAttempted = $true
  Register-ScheduledTask -TaskPath '\' -TaskName $taskName -InputObject $definition | Out-Null
  $taskCreated = $true

  $stage = 'semantic_export'
  $taskSnapshot = Get-ScheduledTask -TaskPath '\' -TaskName $taskName
  [xml]$export = Export-ScheduledTask -TaskPath '\' -TaskName $taskName
  $ns = [Xml.XmlNamespaceManager]::new($export.NameTable)
  $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
  $runLevelNode = $export.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:RunLevel', $ns)
  $runLevelMatched = if ($null -eq $runLevelNode) {
    [string]$taskSnapshot.Principal.RunLevel -eq 'Limited'
  } else {
    $runLevelNode.InnerText.Trim() -eq 'LeastPrivilege'
  }
  $semanticChecks = [ordered]@{
    description = $export.SelectSingleNode('/t:Task/t:RegistrationInfo/t:Description', $ns).InnerText -ceq $marker
    principal = $export.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:UserId', $ns).InnerText -ceq $sid
    logonType = $export.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:LogonType', $ns).InnerText -ceq 'InteractiveToken'
    runLevel = $runLevelMatched
    instances = $export.SelectSingleNode('/t:Task/t:Settings/t:MultipleInstancesPolicy', $ns).InnerText -ceq 'IgnoreNew'
    startWhenAvailable = $export.SelectSingleNode('/t:Task/t:Settings/t:StartWhenAvailable', $ns).InnerText -ceq 'true'
    restartInterval = $export.SelectSingleNode('/t:Task/t:Settings/t:RestartOnFailure/t:Interval', $ns).InnerText -ceq 'PT1M'
    restartCount = $export.SelectSingleNode('/t:Task/t:Settings/t:RestartOnFailure/t:Count', $ns).InnerText -ceq '3'
    triggerCount = $export.SelectNodes('/t:Task/t:Triggers/*', $ns).Count -eq 2
    restartRepetitionInterval = $export.SelectSingleNode('/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:Interval', $ns).InnerText -ceq 'PT1M'
    restartRepetitionDuration = $export.SelectSingleNode('/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:Duration', $ns).InnerText -ceq 'PT2M'
    actionCount = $export.SelectNodes('/t:Task/t:Actions/t:Exec', $ns).Count -eq 1
    command = $export.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Command', $ns).InnerText -ceq $powerShellPath
    arguments = $export.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Arguments', $ns).InnerText -ceq $arguments
    workingDirectory = $export.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:WorkingDirectory', $ns).InnerText -ceq $tempRoot
  }
  $semanticFailureCategories = @($semanticChecks.GetEnumerator() |
    Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
  $semanticExportMatched = [bool](@($semanticFailureCategories).Count -eq 0)
  if (-not $semanticExportMatched) { throw 'semantic_export_mismatch' }

  Write-AtomicJson $controlPath @{ phase = 'ignore' }
  $stage = 'demand_start'
  Start-ScheduledTask -TaskPath '\' -TaskName $taskName
  Wait-Until { (Get-AcceptanceProcesses $payloadPath).Count -eq 1 } 15 'demand_start_timeout'
  $demandStartObserved = $true
  Start-ScheduledTask -TaskPath '\' -TaskName $taskName
  Start-Sleep -Seconds 1
  $ignoreNewObserved = (Get-AcceptanceProcesses $payloadPath).Count -eq 1 -and
    (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).phase -eq 'ignore' -and
    (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).attempt -eq 1
  if (-not $ignoreNewObserved) { throw 'ignore_new_failed' }
  Wait-Until {
    $task = Get-ScheduledTask -TaskPath '\' -TaskName $taskName
    (Get-AcceptanceProcesses $payloadPath).Count -eq 0 -and
      [string]$task.State -eq 'Ready'
  } 20 'ignore_clean_exit_timeout'

  $stage = 'restart_prepare'
  Write-AtomicJson $controlPath @{ phase = 'restart' }
  Write-AtomicJson $statePath @{ phase = 'restart'; attempt = 0 }
  $stage = 'restart_first_attempt'
  Wait-Until {
    (Test-Path -LiteralPath $statePath) -and
      (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).phase -eq 'restart' -and
      [int](Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).attempt -eq 1
  } 45 'restart_first_attempt_timeout'
  $stage = 'restart_retry'
  Wait-Until {
    $info = Get-ScheduledTaskInfo -TaskPath '\' -TaskName $taskName
    if ([int64]$info.LastTaskResult -eq 23) { $script:failureExitObserved = $true }
    (Test-Path -LiteralPath $statePath) -and
      [int](Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).attempt -ge 2
  } $TimeoutSeconds 'restart_timeout'
  $nonzeroRestartObserved = $failureExitObserved
  if (-not $nonzeroRestartObserved) { throw 'failure_exit_not_observed' }
  $stage = 'clean_exit'
  Wait-Until {
    $info = Get-ScheduledTaskInfo -TaskPath '\' -TaskName $taskName
    (Get-AcceptanceProcesses $payloadPath).Count -eq 0 -and [int64]$info.LastTaskResult -eq 0
  } 20 'clean_exit_timeout'
  $cleanExitObserved = $true
} catch {
  $failureCode = if ($_.Exception.Message -match '^[a-z0-9_]+$') {
    $_.Exception.Message
  } else {
    "stage_$stage"
  }
} finally {
  if ($registrationAttempted) {
    try {
      $owned = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
      if ($null -ne $owned) {
        [xml]$ownedExport = Export-ScheduledTask -TaskPath '\' -TaskName $taskName
        $ownedNs = [Xml.XmlNamespaceManager]::new($ownedExport.NameTable)
        $ownedNs.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        $ownedMarkerNode = $ownedExport.SelectSingleNode('/t:Task/t:RegistrationInfo/t:Description', $ownedNs)
        if ($null -ne $ownedMarkerNode -and $ownedMarkerNode.InnerText -ceq $marker) {
          Stop-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
          Unregister-ScheduledTask -TaskPath '\' -TaskName $taskName -Confirm:$false
        } else {
          $failureCode = 'cleanup_ownership_drift'
        }
      }
    } catch {
      $failureCode = 'task_cleanup_failed'
    }
  }
  if ($payloadPath) {
    try {
      Wait-Until { (Get-AcceptanceProcesses $payloadPath).Count -eq 0 } 10 'process_cleanup_timeout'
    } catch {
      $failureCode = 'process_cleanup_failed'
    }
  }
  if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
    try {
      $resolvedSystemTemp = [IO.Path]::GetFullPath(
        (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath()) -ErrorAction Stop).Path
      ).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
      $resolvedTempRoot = [IO.Path]::GetFullPath(
        (Resolve-Path -LiteralPath $tempRoot -ErrorAction Stop).Path
      )
      $systemTempPrefix = $resolvedSystemTemp + [IO.Path]::DirectorySeparatorChar
      if (-not $resolvedTempRoot.StartsWith($systemTempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
          [IO.Path]::GetFileName($resolvedTempRoot) -cne "orca-o1-7-task-$nonce") {
        throw 'temp_root_cleanup_target_mismatch'
      }
      Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
    } catch {
      $failureCode = if ($_.Exception.Message -eq 'temp_root_cleanup_target_mismatch') {
        'temp_root_cleanup_target_mismatch'
      } else {
        'file_cleanup_failed'
      }
    }
  }
  $residualTasks = if ($taskName -and
    $null -ne (Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue)) { 1 } else { 0 }
  $residualProcesses = if ($payloadPath) { (Get-AcceptanceProcesses $payloadPath).Count } else { 0 }
  $residualFiles = if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) { 1 } else { 0 }
  if (($residualTasks -ne 0 -or $residualProcesses -ne 0 -or $residualFiles -ne 0) -and
      $null -eq $failureCode) {
    $failureCode = 'residual_artifact_detected'
  }
  if ($mutexHeld) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

$result = [ordered]@{
  schemaVersion = 1
  passed = $null -eq $failureCode
  createdAsNonAdmin = $taskCreated
  semanticExportMatched = $semanticExportMatched
  semanticFailureCategories = @($semanticFailureCategories)
  demandStartObserved = $demandStartObserved
  ignoreNewObserved = $ignoreNewObserved
  failureExitObserved = $failureExitObserved
  nonzeroRestartObserved = $nonzeroRestartObserved
  cleanExitObserved = $cleanExitObserved
  residualTasks = $residualTasks
  residualProcesses = $residualProcesses
  residualFiles = $residualFiles
  externalWrites = 0
  failureCode = $failureCode
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
if ($null -ne $failureCode) { exit 1 }
