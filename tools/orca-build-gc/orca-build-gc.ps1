<#
  orca-build-gc — orchestration Task가 남긴 빌드 lane을 회수한다.

  init-orchestrate SKILL.md §8 의 lane 정리 규약에 대한 안전망이다. 규약대로 Task가 lane을
  지웠다면 이 스크립트는 아무것도 지우지 않는다.

  기본은 dry-run이다. 실제 삭제는 -Apply 를 줄 때만 한다.
#>
param(
  [int]$MinAgeDays = 2,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$log = "$PSScriptRoot\orca-build-gc.log"
$cut = (Get-Date).AddDays(-$MinAgeDays)

# 화이트리스트: 이 루트의 직계 자식만 회수 대상이다.
$roots = @(
  @{ Path = 'D:\orca-build';                    Depth = 2 }   # <repo>\<task>
  @{ Path = "$env:USERPROFILE\orca\targets";    Depth = 1 }
  @{ Path = "$env:TEMP";                        Depth = 1; Pattern = '^(t\d|academic-)' }
)

function Get-LaneAge([string]$p){
  # 루트와 직계 자식의 최종 수정 시각 중 최대. cargo 는 빌드 시 target 루트와 debug/ 를 갱신한다.
  $t = (Get-Item $p).LastWriteTime
  Get-ChildItem $p -Force -EA SilentlyContinue | ForEach-Object {
    if($_.LastWriteTime -gt $t){ $t = $_.LastWriteTime }
  }
  return $t
}

function Get-Lanes {
  foreach($r in $roots){
    if(-not (Test-Path $r.Path)){ continue }
    $items = if($r.Depth -eq 2){
      Get-ChildItem $r.Path -Directory -Force -EA SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Directory -Force -EA SilentlyContinue }
    } else {
      Get-ChildItem $r.Path -Directory -Force -EA SilentlyContinue
    }
    foreach($i in $items){
      if($r.Pattern -and $i.Name -notmatch $r.Pattern){ continue }
      $last = Get-LaneAge $i.FullName
      if($last -ge $cut){ continue }
      $sz = (Get-ChildItem $i.FullName -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum
      [PSCustomObject]@{ Path=$i.FullName; GB=[math]::Round(($sz/1GB),2); Last=$last }
    }
  }
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$lanes = @(Get-Lanes)
$mode  = if($Apply){'APPLY'}else{'DRYRUN'}
$total = ($lanes | Measure-Object GB -Sum).Sum

Add-Content $log "[$stamp] $mode  min-age=${MinAgeDays}d  candidates=$($lanes.Count)  ${total} GB"

$freed = 0.0; $failed = 0
foreach($l in $lanes){
  if($Apply){
    try   { Remove-Item -LiteralPath $l.Path -Recurse -Force -EA Stop
            $freed += $l.GB
            Add-Content $log "  removed  $($l.GB) GB  $($l.Path)" }
    catch { $failed++
            Add-Content $log "  INUSE    $($l.Path)  :: $($_.Exception.Message -replace '\s+',' ')" }
  } else {
    Add-Content $log "  would-rm $($l.GB) GB  $($l.Path)  (last=$($l.Last))"
  }
}

# WSL native lane (규약: 검증 직후 제거. 남았다면 회수한다)
$wslFreed = ''
if(Get-Command wsl.exe -EA SilentlyContinue){
  try {
    # WSL 절반은 sh 파일로 실행한다. 개행이 든 문자열은 wsl.exe 인자로 전달되지 않는다.
    $shWin = "$PSScriptRoot\gc-wsl.sh"
    $shWsl = '/mnt/' + $shWin.Substring(0,1).ToLower() + $shWin.Substring(2).Replace([char]92,'/')
    $wslMode = if($Apply){'apply'}else{'dry'}
    $wslFreed = wsl.exe -d Ubuntu -- bash $shWsl $MinAgeDays $wslMode 2>&1 | Out-String
    if($wslFreed.Trim()){ Add-Content $log "  wsl: $($wslFreed.Trim() -replace '\s+',' ')" }
  } catch { Add-Content $log "  wsl: skipped :: $($_.Exception.Message)" }
}

$res = "[$stamp] $mode done. freed=${freed} GB  inuse-skipped=$failed"
Add-Content $log $res
Write-Output $res
if(-not $Apply -and $lanes.Count){ Write-Output "dry-run: $($lanes.Count) lanes / $total GB. 실제 삭제는 -Apply" }
