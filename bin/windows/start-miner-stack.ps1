param(
    [switch]$OpenDashboard,
    [switch]$OpenInfoFile
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command Join-Path -ErrorAction SilentlyContinue)) {
    $corePaths = @(
        [System.IO.Path]::Combine($PSHOME, 'Modules'),
        [System.IO.Path]::Combine($env:WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    )

    if ($env:ProgramFiles) {
        $corePaths += [System.IO.Path]::Combine($env:ProgramFiles, 'WindowsPowerShell', 'Modules')
    }

    $existing = @()
    if ($env:PSModulePath) {
        foreach ($p in ($env:PSModulePath -split ';')) {
            if ($p) { $existing += $p }
        }
    }

    $allPaths = @($corePaths + $existing)
    $uniquePaths = New-Object System.Collections.Generic.List[string]
    foreach ($p in $allPaths) {
        if (-not $p) { continue }
        if (-not $uniquePaths.Contains($p)) {
            $uniquePaths.Add($p)
        }
    }

    $env:PSModulePath = [string]::Join(';', $uniquePaths)

    Import-Module Microsoft.PowerShell.Management -ErrorAction SilentlyContinue
    Import-Module Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue
}

function Get-TempRoot {
    if ($env:TEMP) { return $env:TEMP }
    if ($env:TMP) { return $env:TMP }
    try {
        $p = [System.IO.Path]::GetTempPath()
        if ($p) { return $p }
    } catch {}
    return 'C:\Windows\Temp'
}

$BootstrapLog = [System.IO.Path]::Combine((Get-TempRoot), 'miner-launcher.log')

try {
    $bootstrapDir = [System.IO.Path]::GetDirectoryName($BootstrapLog)
    if ($bootstrapDir -and -not [System.IO.Directory]::Exists($bootstrapDir)) {
        [System.IO.Directory]::CreateDirectory($bootstrapDir) | Out-Null
    }
} catch {}

function Write-Bootstrap($msg) {
    try {
        $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
        [System.IO.File]::AppendAllText($BootstrapLog, "$line`r`n")
    } catch {
        # Never allow logging failure to block startup diagnostics.
    }
}

try {
Write-Bootstrap 'Launcher start.'
$launchStartedAt = Get-Date

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$WatchdogPath = Join-Path $ProjectRoot 'watchdog.ps1'
$RuntimeRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'LC2 DOGE2 Solo Miner'
} elseif ($env:APPDATA) {
    Join-Path $env:APPDATA 'LC2 DOGE2 Solo Miner'
} else {
    $ProjectRoot
}

$RuntimeDataDir = Join-Path $RuntimeRoot 'data'
$SummaryPath = Join-Path $RuntimeDataDir 'startup-summary.json'
$InfoPath = Join-Path $RuntimeRoot 'MINER-CONNECTION-INFO.txt'
$StatusPath = Join-Path $RuntimeRoot 'RUNTIME-STATUS.txt'

if (-not (Test-Path $RuntimeDataDir)) {
    New-Item -ItemType Directory -Path $RuntimeDataDir -Force | Out-Null
}

Write-Bootstrap "ProjectRoot=$ProjectRoot"
Write-Bootstrap "RuntimeRoot=$RuntimeRoot"
Write-Bootstrap "SummaryPath=$SummaryPath"
Write-Bootstrap "InfoPath=$InfoPath"

$startupInfo = @"
========================================================================
    LC2/DOGE2 SOLO MINER - STARTING
========================================================================
Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Project:   $ProjectRoot
Runtime:   $RuntimeRoot

Status:
- Launching watchdog and miner components.
- Waiting for live ports from data\startup-summary.json.
- This can take 30-180 seconds on first run.

If startup takes too long, check:
- %TEMP%\watchdog.log
- %TEMP%\proxy-err.log
========================================================================
"@

Set-Content -Path $InfoPath -Value $startupInfo -Encoding UTF8
Write-Bootstrap 'Wrote startup info file.'

if ($OpenInfoFile) {
    Start-Process $InfoPath
    Write-Bootstrap 'Opened info file.'
}

if (-not (Test-Path $WatchdogPath)) {
    throw "watchdog.ps1 not found at: $WatchdogPath"
}

function Test-WatchdogRunning {
    $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue
    if (-not $procs) { return $false }

    foreach ($p in $procs) {
        if ($p.CommandLine -and $p.CommandLine -like "*watchdog.ps1*") {
            return $true
        }
    }
    return $false
}

function Test-TcpPortOpen([string]$host, [int]$port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $async = $client.BeginConnect($host, $port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(2000, $false)) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

if (-not (Test-WatchdogRunning)) {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchdogPath`"" `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden
    Write-Bootstrap 'Started watchdog process.'
} else {
    Write-Bootstrap 'Watchdog already running.'
}

$summary = $null
for ($i = 0; $i -lt 90; $i++) {
    if (Test-Path $SummaryPath) {
        try {
            $summaryItem = Get-Item -Path $SummaryPath -ErrorAction SilentlyContinue
            if ($summaryItem -and $summaryItem.LastWriteTime -lt $launchStartedAt.AddSeconds(-5)) {
                Start-Sleep -Seconds 2
                continue
            }
            $summary = Get-Content -Raw -Path $SummaryPath | ConvertFrom-Json
            if ($summary -and $summary.coins) { break }
        } catch {
            # keep waiting until file is complete
        }
    }
    Start-Sleep -Seconds 2
}

$lc2Port = 3333
$doge2Port = 3334
$dashUrl = 'http://127.0.0.1:8081/'

if ($summary) {
    $lc2 = $null
    $doge2 = $null
    foreach ($coin in @($summary.coins)) {
        if (-not $coin) { continue }
        if (-not $lc2 -and $coin.key -eq 'lc2') { $lc2 = $coin }
        if (-not $doge2 -and $coin.key -eq 'doge2') { $doge2 = $coin }
    }

    if ($lc2 -and $lc2.stratumPort) { $lc2Port = [int]$lc2.stratumPort }
    if ($doge2 -and $doge2.stratumPort) { $doge2Port = [int]$doge2.stratumPort }
    if ($summary.dashboard -and $summary.dashboard.url) { $dashUrl = [string]$summary.dashboard.url }
}

$startedCoins = 0
if ($summary -and $summary.coins) {
    foreach ($coin in @($summary.coins)) {
        if ($coin -and $coin.started) { $startedCoins++ }
    }
}

$dashReachable = $false
$dashHost = '127.0.0.1'
$dashPort = 8081
try {
    $dashUri = [Uri]$dashUrl
    $dashHost = $dashUri.Host
    $dashPort = $dashUri.Port
} catch {}

$dashReachable = Test-TcpPortOpen -host $dashHost -port $dashPort

if ($startedCoins -eq 0 -or -not $dashReachable) {
    $watchdogLog = [System.IO.Path]::Combine((Get-TempRoot), 'watchdog.log')
    $proxyErrLog = [System.IO.Path]::Combine((Get-TempRoot), 'proxy-err.log')

    $failureInfo = @"
========================================================================
  LC2/DOGE2 SOLO MINER - STARTUP FAILED
========================================================================
Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Project:   $ProjectRoot
Runtime:   $RuntimeRoot

Failure Details:
- Coins started: $startedCoins
- Dashboard URL: $dashUrl
- Dashboard reachable: $dashReachable

Next Steps:
1) Wait 1-2 minutes and launch again.
2) Open logs below and check the latest errors.

Logs:
- Launcher: $BootstrapLog
- Watchdog: $watchdogLog
- Proxy errors: $proxyErrLog

Live status file:
- $StatusPath

Summary path:
- $SummaryPath
========================================================================
"@

    Set-Content -Path $InfoPath -Value $failureInfo -Encoding UTF8
    Write-Bootstrap "Startup check failed. startedCoins=$startedCoins dashboardReachable=$dashReachable"

    if (Test-Path $BootstrapLog) { Start-Process notepad.exe $BootstrapLog }
    if (Test-Path $watchdogLog) { Start-Process notepad.exe $watchdogLog }
    if (Test-Path $proxyErrLog) { Start-Process notepad.exe $proxyErrLog }

    throw "Startup failed: no coin started or dashboard unreachable. See logs."
}

$info = @"
========================================================================
  LC2/DOGE2 SOLO MINER - LIVE CONNECTION INFO
========================================================================
Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Project:   $ProjectRoot
Runtime:   $RuntimeRoot

Current Stratum Endpoints:
  LC2   -> stratum+tcp://127.0.0.1:$lc2Port
  DOGE2 -> stratum+tcp://127.0.0.1:$doge2Port

Dashboard:
  $dashUrl

Notes:
- These ports are selected automatically at startup.
- If default ports are busy, fallback ports are used.
- Latest values are saved in data\startup-summary.json.

Dev Fee:
- 1% locked in app code.
- Dev fee address is hard baked and not user configurable.

Live Status File:
    $StatusPath
========================================================================
"@

Set-Content -Path $InfoPath -Value $info -Encoding UTF8

if ($OpenDashboard) {
    Start-Process $dashUrl
    Write-Bootstrap "Opened dashboard: $dashUrl"
}

Write-Host "Stack launch complete."
Write-Host "LC2:   stratum+tcp://127.0.0.1:$lc2Port"
Write-Host "DOGE2: stratum+tcp://127.0.0.1:$doge2Port"
Write-Host "Dashboard: $dashUrl"
Write-Host "Info file: $InfoPath"
Write-Bootstrap 'Launcher completed successfully.'
}
catch {
    Write-Bootstrap ("FATAL: " + $_.Exception.Message)
    Write-Bootstrap ("STACK: " + $_.ScriptStackTrace)
    try {
        Start-Process notepad.exe $BootstrapLog
    } catch {}
    throw
}
