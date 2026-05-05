param(
    [switch]$OpenDashboard,
    [switch]$OpenInfoFile
)

$ErrorActionPreference = 'Stop'
$LauncherVersion = '2026-04-28.10'

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
$RuntimeBootstrapLog = $null
$launcherMutex = $null
$hasLauncherMutex = $false

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
        if ($RuntimeBootstrapLog) {
            [System.IO.File]::AppendAllText($RuntimeBootstrapLog, "$line`r`n")
        }
    } catch {
        # Never allow logging failure to block startup diagnostics.
    }
}

function Rotate-SessionLog([string]$logPath, [string]$previousPath) {
    try {
        if (Test-Path $previousPath) {
            Remove-Item -Path $previousPath -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path $logPath) {
            Move-Item -Path $logPath -Destination $previousPath -Force -ErrorAction SilentlyContinue
        }
        New-Item -ItemType File -Path $logPath -Force | Out-Null
    } catch {
        # If rotation fails, keep appending to existing log rather than breaking startup.
    }
}

try {
Write-Bootstrap 'Launcher start.'
Write-Bootstrap "Launcher version=$LauncherVersion"
$launchStartedAt = Get-Date

$launcherMutexName = 'Global\LC2Doge2SoloMinerLauncher'
$createdNewMutex = $false
try {
    $launcherMutex = New-Object System.Threading.Mutex($true, $launcherMutexName, [ref]$createdNewMutex)
} catch {
    # Fallback for environments where global mutex namespace creation fails.
    $launcherMutexName = 'LC2Doge2SoloMinerLauncher'
    $launcherMutex = New-Object System.Threading.Mutex($true, $launcherMutexName, [ref]$createdNewMutex)
}
if (-not $createdNewMutex) {
    Write-Bootstrap 'Another launcher instance is already running. Exiting duplicate launch.'
    throw 'Another launcher instance is already running. Wait a few seconds and try again.'
}
$hasLauncherMutex = $true

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$launcherLeaf = [System.IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
$versionMatch = [regex]::Match($launcherLeaf, 'start-miner-stack-(.+)$')
$preferredWatchdogPath = $null
if ($versionMatch.Success) {
    $preferredWatchdogPath = Join-Path $ProjectRoot ("watchdog-{0}.ps1" -f $versionMatch.Groups[1].Value)
}

$watchdogFiles = @()
try {
    $watchdogFiles = Get-ChildItem -Path (Join-Path $ProjectRoot 'watchdog*.ps1') -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
} catch {}

if ($preferredWatchdogPath -and (Test-Path $preferredWatchdogPath)) {
    $WatchdogPath = $preferredWatchdogPath
} elseif ($watchdogFiles -and $watchdogFiles.Count -gt 0) {
    $WatchdogPath = $watchdogFiles[0].FullName
} else {
    $WatchdogPath = Join-Path $ProjectRoot 'watchdog.ps1'
}

# Prune stale versioned launch/watchdog scripts so only current + unversioned remain.
$currentLauncherPath = if ($PSCommandPath) { [System.IO.Path]::GetFullPath($PSCommandPath) } else { '' }
$currentWatchdogPath = if ($WatchdogPath) { [System.IO.Path]::GetFullPath($WatchdogPath) } else { '' }
foreach ($stale in (Get-ChildItem -Path (Join-Path $ProjectRoot 'watchdog-*.ps1') -File -ErrorAction SilentlyContinue)) {
    try {
        if ([System.IO.Path]::GetFullPath($stale.FullName) -ne $currentWatchdogPath) {
            Remove-Item -Path $stale.FullName -Force -ErrorAction SilentlyContinue
            Write-Bootstrap "Pruned stale watchdog script: $($stale.Name)"
        }
    } catch {}
}
foreach ($stale in (Get-ChildItem -Path (Join-Path $ProjectRoot 'bin\windows\start-miner-stack-*.ps1') -File -ErrorAction SilentlyContinue)) {
    try {
        if ([System.IO.Path]::GetFullPath($stale.FullName) -ne $currentLauncherPath) {
            Remove-Item -Path $stale.FullName -Force -ErrorAction SilentlyContinue
            Write-Bootstrap "Pruned stale launcher script: $($stale.Name)"
        }
    } catch {}
}
$RuntimeRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'LC2 DOGE2 Solo Miner'
} elseif ($env:APPDATA) {
    Join-Path $env:APPDATA 'LC2 DOGE2 Solo Miner'
} else {
    $ProjectRoot
}

$RuntimeDataDir = Join-Path $RuntimeRoot 'data'
$RuntimeLogDir = Join-Path $RuntimeRoot 'logs'
$RuntimeBootstrapLog = Join-Path $RuntimeLogDir 'launcher.log'
$DiagnosticLogPath = Join-Path $RuntimeLogDir 'multi-asic-diagnostic.log'
$SummaryPath = Join-Path $RuntimeDataDir 'startup-summary.json'
$InfoPath = Join-Path $RuntimeRoot 'MINER-CONNECTION-INFO.txt'
$StatusPath = Join-Path $RuntimeRoot 'RUNTIME-STATUS.txt'
$DaemonSelectionPath = Join-Path $RuntimeDataDir 'daemon-selection.json'

if (-not (Test-Path $RuntimeDataDir)) {
    New-Item -ItemType Directory -Path $RuntimeDataDir -Force | Out-Null
}
if (-not (Test-Path $RuntimeLogDir)) {
    New-Item -ItemType Directory -Path $RuntimeLogDir -Force | Out-Null
}

Rotate-SessionLog -logPath $RuntimeBootstrapLog -previousPath (Join-Path $RuntimeLogDir 'launcher.previous.log')

foreach ($logPath in @(
    $RuntimeBootstrapLog,
    (Join-Path $RuntimeLogDir 'watchdog.log'),
    (Join-Path $RuntimeLogDir 'proxy-err.log'),
    (Join-Path $RuntimeLogDir 'proxy-out.log')
)) {
    if (-not (Test-Path $logPath)) {
        New-Item -ItemType File -Path $logPath -Force | Out-Null
    }
}

Write-Bootstrap "ProjectRoot=$ProjectRoot"
Write-Bootstrap "WatchdogPath=$WatchdogPath"
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
- $RuntimeLogDir\watchdog.log
- $RuntimeLogDir\proxy-err.log
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

function Get-WatchdogProcesses {
    $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue
    if (-not $procs) { return @() }

    return @($procs | Where-Object {
        $_.CommandLine -and (
            $_.CommandLine -like '*watchdog.ps1*' -or
            $_.CommandLine -like '*watchdog-*.ps1*'
        )
    })
}

function Stop-AllWatchdogs {
    foreach ($p in (Get-WatchdogProcesses)) {
        $cmd = $p.CommandLine
        try {
            Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
            Write-Bootstrap "Stopped watchdog PID=$($p.ProcessId) cmd=$cmd"
        } catch {}
    }
}

function Test-TcpPortOpen([string]$targetHost, [int]$port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $async = $client.BeginConnect($targetHost, $port, $null, $null)
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

function Read-DaemonSelection {
    $defaults = @{ lc2 = $true; doge2 = $true }
    try {
        if (-not (Test-Path $DaemonSelectionPath)) { return $defaults }
        $raw = Get-Content -Raw -Path $DaemonSelectionPath -ErrorAction SilentlyContinue
        if (-not $raw) { return $defaults }
        $parsed = $raw | ConvertFrom-Json
        if ($null -eq $parsed) { return $defaults }
        return @{
            lc2   = [bool]$parsed.lc2
            doge2 = [bool]$parsed.doge2
        }
    } catch {
        return $defaults
    }
}

function Write-DaemonSelection([bool]$lc2, [bool]$doge2) {
    $payload = @{
        lc2 = $lc2
        doge2 = $doge2
        updatedAt = (Get-Date -Format 'o')
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -Path $DaemonSelectionPath -Encoding UTF8
}

function Show-DaemonSelectionDialog([bool]$defaultLc2, [bool]$defaultDoge2) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'LC2 DOGE2 Solo Miner - Select Daemons'
    $form.StartPosition = 'CenterScreen'
    $form.Size = New-Object System.Drawing.Size(980, 760)
    $form.MinimumSize = New-Object System.Drawing.Size(720, 520)
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $true
    $form.TopMost = $false
    $form.BackColor = [System.Drawing.Color]::FromArgb(20, 20, 20)

    $picture = New-Object System.Windows.Forms.PictureBox
    $picture.Dock = 'Top'
    $picture.Height = 320
    $picture.SizeMode = 'Zoom'
    $picture.BackColor = [System.Drawing.Color]::Black

    $imageCandidates = @(
        (Join-Path $ProjectRoot 'bin\windows\BitsPleaseYT_Installer_Splash_Screen.png'),
        (Join-Path $ProjectRoot 'build\BitsPleaseYT_Installer_Splash_Screen.png'),
        (Join-Path $ProjectRoot 'BitsPleaseYT_Installer_Splash_Screen.png'),
        (Join-Path $ProjectRoot 'bin\windows\splash.png'),
        (Join-Path $ProjectRoot 'bin\windows\splash.bmp'),
        (Join-Path $ProjectRoot 'installer\windows\assets\splash.png'),
        (Join-Path $ProjectRoot 'installer\windows\assets\splash.bmp'),
        (Join-Path $ProjectRoot 'bin\windows\splash.jpg'),
        (Join-Path $ProjectRoot 'bin\windows\splash.jpeg'),
        (Join-Path $ProjectRoot 'installer\windows\assets\splash.jpg'),
        (Join-Path $ProjectRoot 'installer\windows\assets\splash.jpeg')
    )

    foreach ($candidate in $imageCandidates) {
        if (Test-Path $candidate) {
            try {
                $picture.Image = [System.Drawing.Image]::FromFile($candidate)
                Write-Bootstrap "Loaded splash image: $candidate"
                break
            } catch {}
        }
    }

    $panel = New-Object System.Windows.Forms.Panel
    $panel.Dock = 'Fill'
    $panel.Padding = New-Object System.Windows.Forms.Padding(16)
    $panel.BackColor = [System.Drawing.Color]::FromArgb(35, 35, 35)
    $panel.AutoScroll = $true

    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'Choose which daemons to run for this launch:'
    $title.ForeColor = [System.Drawing.Color]::White
    $title.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
    $title.AutoSize = $true
    $title.Location = New-Object System.Drawing.Point(16, 16)

    $cbLc2 = New-Object System.Windows.Forms.CheckBox
    $cbLc2.Text = 'LC2 daemon (LitecoinII)'
    $cbLc2.ForeColor = [System.Drawing.Color]::White
    $cbLc2.AutoSize = $true
    $cbLc2.Checked = $defaultLc2
    $cbLc2.Location = New-Object System.Drawing.Point(24, 56)

    $cbDoge2 = New-Object System.Windows.Forms.CheckBox
    $cbDoge2.Text = 'DOGE2 daemon (Dogecoin2)'
    $cbDoge2.ForeColor = [System.Drawing.Color]::White
    $cbDoge2.AutoSize = $true
    $cbDoge2.Checked = $defaultDoge2
    $cbDoge2.Location = New-Object System.Drawing.Point(24, 86)

    $hint = New-Object System.Windows.Forms.Label
    $hint.Text = 'Only selected daemons will run. Wallet data and mining addresses are not changed by this choice.'
    $hint.ForeColor = [System.Drawing.Color]::Gainsboro
    $hint.AutoSize = $true
    $hint.Location = New-Object System.Drawing.Point(24, 120)

    $btnStart = New-Object System.Windows.Forms.Button
    $btnStart.Text = 'Start Selected'
    $btnStart.Size = New-Object System.Drawing.Size(130, 34)
    $btnStart.Location = New-Object System.Drawing.Point(24, 152)
    $btnStart.UseVisualStyleBackColor = $false
    $btnStart.BackColor = [System.Drawing.Color]::FromArgb(236, 236, 236)
    $btnStart.ForeColor = [System.Drawing.Color]::Black

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = 'Cancel'
    $btnCancel.Size = New-Object System.Drawing.Size(110, 34)
    $btnCancel.Location = New-Object System.Drawing.Point(164, 152)
    $btnCancel.UseVisualStyleBackColor = $false
    $btnCancel.BackColor = [System.Drawing.Color]::FromArgb(236, 236, 236)
    $btnCancel.ForeColor = [System.Drawing.Color]::Black

    $ensurePanelSpace = {
        $desiredPanelMin = 220
        $newPictureHeight = [Math]::Min(360, [Math]::Max(180, $form.ClientSize.Height - $desiredPanelMin))
        if ($newPictureHeight -ne $picture.Height) {
            $picture.Height = $newPictureHeight
        }
    }
    $form.Add_Shown($ensurePanelSpace)
    $form.Add_Resize($ensurePanelSpace)

    $result = $null
    $btnStart.Add_Click({
        if (-not $cbLc2.Checked -and -not $cbDoge2.Checked) {
            [System.Windows.Forms.MessageBox]::Show('Select at least one daemon to continue.', 'No daemon selected', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
            return
        }
        $script:result = @{ lc2 = [bool]$cbLc2.Checked; doge2 = [bool]$cbDoge2.Checked }
        $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Close()
    })

    $btnCancel.Add_Click({
        $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
        $form.Close()
    })

    $panel.Controls.AddRange(@($title, $cbLc2, $cbDoge2, $hint, $btnStart, $btnCancel))
    $form.Controls.Add($panel)
    $form.Controls.Add($picture)

    $dialog = $form.ShowDialog()
    if ($dialog -ne [System.Windows.Forms.DialogResult]::OK -or $null -eq $script:result) {
        return $null
    }

    return $script:result
}

Stop-AllWatchdogs

$previousSelection = Read-DaemonSelection
$selection = Show-DaemonSelectionDialog -defaultLc2 $previousSelection.lc2 -defaultDoge2 $previousSelection.doge2
if ($null -eq $selection) {
    Write-Bootstrap 'User canceled daemon selection dialog.'
    throw 'Launch canceled by user before daemon startup.'
}

Write-DaemonSelection -lc2 $selection.lc2 -doge2 $selection.doge2
Write-Bootstrap "Daemon selection: lc2=$($selection.lc2) doge2=$($selection.doge2)"

$enableLc2Arg = if ($selection.lc2) { '1' } else { '0' }
$enableDoge2Arg = if ($selection.doge2) { '1' } else { '0' }

$watchdogArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', "`"$WatchdogPath`"",
    '-EnableLC2', $enableLc2Arg,
    '-EnableDOGE2', $enableDoge2Arg
)

Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -ArgumentList $watchdogArgs `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden
Write-Bootstrap 'Started fresh watchdog process.'

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

$dashReachable = Test-TcpPortOpen -targetHost $dashHost -port $dashPort

if ($startedCoins -eq 0 -or -not $dashReachable) {
    $watchdogLog = Join-Path $RuntimeLogDir 'watchdog.log'
    $proxyErrLog = Join-Path $RuntimeLogDir 'proxy-err.log'

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
3) Confirm your daemon selection dialog includes at least one checked coin.

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

Merged Mining (AuxPoW):
    DOGE2 is merge-mined automatically from LC2 shares.
    ASICs should use one pool endpoint only: LC2 above.
    Do not configure a second DOGE2 port in ASIC settings.

Block Rewards:
    LC2   -> 50 LC2 per block
    DOGE2 -> 500,000 DOGE2 per block
    DOGE2 halving in roughly 53 days -> 250,000 DOGE2 per block

Launch Selection:
    LC2 enabled:   $($selection.lc2)
    DOGE2 enabled: $($selection.doge2)

Dashboard:
  $dashUrl

Notes:
- These ports are selected automatically at startup.
- If default ports are busy, fallback ports are used.
- Latest values are saved in data\startup-summary.json.
- If your miner rejects stratum+tcp://, try the same host:port without it.
- Example: 127.0.0.1:$lc2Port

Dev Fee:
- 1% locked in app code.
- Dev fee address is hard baked and not user configurable.

Live Status File:
    $StatusPath

Diagnostic Log (for multi-miner troubleshooting):
    $DiagnosticLogPath
========================================================================
"@

Set-Content -Path $InfoPath -Value $info -Encoding UTF8

if ($OpenDashboard) {
    Start-Process $dashUrl
    Write-Bootstrap "Opened dashboard: $dashUrl"
}

Write-Host "Stack launch complete."
Write-Host "LC2:   stratum+tcp://127.0.0.1:$lc2Port"
Write-Host "DOGE2: merge-mined automatically via LC2 (no second ASIC pool/port needed)"
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
finally {
    if ($launcherMutex -and $hasLauncherMutex) {
        try { $launcherMutex.ReleaseMutex() } catch {}
    }
    if ($launcherMutex) {
        try { $launcherMutex.Dispose() } catch {}
    }
}
