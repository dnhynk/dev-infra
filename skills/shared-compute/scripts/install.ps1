# Install one maintained source for native Windows agents; no auth or PATH edits.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = 'D:\dev-infra\skills\shared-compute'
$configRoot = 'C:\Users\dongh\.config\shared-compute'
$links = @('C:\Users\dongh\.agents\skills\shared-compute', 'C:\Users\dongh\.claude\skills\shared-compute')
foreach ($link in $links) {
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        if (-not $item.LinkType -or [IO.Path]::GetFullPath(@($item.Target)[0]) -ne $target) {
            throw "Refusing to replace existing discovery entry: $link"
        }
    }
}
if ($source -ne $target) {
    if (Test-Path -LiteralPath $target) { throw 'Target already exists; review it before reinstalling from another source.' }
    New-Item -ItemType Directory -Path $target | Out-Null
    foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File) {
        $relative = $file.FullName.Substring($source.Length + 1)
        if ($relative -match '(^|\\)__pycache__(\\|$)|\.pyc$') { continue }
        $destination = Join-Path $target $relative
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination
    }
}
foreach ($link in $links) {
    if (-not (Test-Path -LiteralPath $link)) {
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    }
}
New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
$configPath = Join-Path $configRoot 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    [IO.File]::WriteAllText($configPath, "{`"host`": null}`n", [Text.UTF8Encoding]::new($false))
}
Write-Output 'Installed shared-compute source, both discovery links and unset configuration.'
