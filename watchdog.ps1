# watchdog.ps1 — Monitors and auto-restarts all mining components
# Checks every 30 seconds: LC2 daemon, DOGE2 daemon, stratum proxy
# Logs to %TEMP%\watchdog.log

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

$ProxyDir    = $PSScriptRoot
$LC2Exe      = "$ProxyDir\bin\lc2\litecoinIId.exe"
$LC2DataDir  = Join-Path $env:APPDATA 'LitecoinII'
$Doge2BaseDir = "$ProxyDir\bin\doge2"
$Doge2DataDir = Join-Path $env:APPDATA 'Dogecoin2'
$Doge2RpcPort = 22655
$Doge2RpcUser = 'doge2rpc'
$Doge2RpcPass = 'Doge2RpcPass2026!'
$ProxyExe    = "$ProxyDir\dist\lc2-solo-proxy-windows.exe"
$LogFile     = "$env:TEMP\watchdog.log"
$ProxyOut    = "$env:TEMP\proxy-out.log"
$ProxyErr    = "$env:TEMP\proxy-err.log"
$RuntimeRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'LC2 DOGE2 Solo Miner'
} elseif ($env:APPDATA) {
    Join-Path $env:APPDATA 'LC2 DOGE2 Solo Miner'
} else {
    $ProxyDir
}
$StartupSummaryPath = Join-Path $RuntimeRoot 'data\startup-summary.json'
$StatusPath = Join-Path $RuntimeRoot 'RUNTIME-STATUS.txt'

$CheckInterval = 30   # seconds between health checks

function Resolve-Doge2ExePath {
    if (-not (Test-Path $Doge2BaseDir)) {
        throw "DOGE2 directory not found: $Doge2BaseDir"
    }

    $daemonExeNames = @('dogecoind.exe', 'dogecoin2d.exe')

    $candidates = Get-ChildItem -Path $Doge2BaseDir -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending

    foreach ($dir in $candidates) {
        foreach ($exeName in $daemonExeNames) {
            $exePath = Join-Path $dir.FullName $exeName
            if (Test-Path $exePath) {
                return $exePath
            }
        }
    }

    foreach ($exeName in $daemonExeNames) {
        $directExePath = Join-Path $Doge2BaseDir $exeName
        if (Test-Path $directExePath) {
            return $directExePath
        }
    }

    throw "No DOGE2 daemon executable found in $Doge2BaseDir. Extract the latest DOGE2 Windows wallet release into this folder."
}

$Doge2Exe = Resolve-Doge2ExePath
$Doge2ProcessName = [System.IO.Path]::GetFileNameWithoutExtension($Doge2Exe)

function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    [System.IO.File]::AppendAllText($LogFile, "$line`r`n")
    Write-Host $line
}

function Test-RpcAlive($port, $user, $pass) {
    try {
        $body  = '{"method":"getblockcount","params":[],"id":1}'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $cred  = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("${user}:${pass}"))
        $req   = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:${port}/")
        $req.Method        = 'POST'
        $req.ContentType   = 'application/json'
        $req.ContentLength = $bytes.Length
        $req.Timeout       = 4000
        $req.Headers.Add('Authorization', "Basic $cred")
        $stream = $req.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch { return $false }
}

function Invoke-RpcMethod($port, $user, $pass, $method, $params = @()) {
    try {
        $payloadObj = @{
            method = $method
            params = $params
            id = 1
        }
        $body  = ($payloadObj | ConvertTo-Json -Compress)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $cred  = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("${user}:${pass}"))
        $req   = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:${port}/")
        $req.Method        = 'POST'
        $req.ContentType   = 'application/json'
        $req.ContentLength = $bytes.Length
        $req.Timeout       = 4000
        $req.Headers.Add('Authorization', "Basic $cred")

        $stream = $req.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()

        $resp = $req.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $json = $reader.ReadToEnd()
        $reader.Close()
        $resp.Close()

        $parsed = $json | ConvertFrom-Json
        return $parsed.result
    } catch {
        return $null
    }
}

function Get-SyncInfo($port, $user, $pass) {
    $info = Invoke-RpcMethod -port $port -user $user -pass $pass -method 'getblockchaininfo'
    if (-not $info) {
        return @{
            blocks = $null
            headers = $null
            progressPct = $null
            initialBlockDownload = $null
            behind = $null
        }
    }

    $blocks = $null
    $headers = $null
    $progressPct = $null
    $ibd = $null
    $behind = $null

    if ($null -ne $info.blocks) { $blocks = [int]$info.blocks }
    if ($null -ne $info.headers) { $headers = [int]$info.headers }
    if ($null -ne $info.verificationprogress) { $progressPct = [math]::Round(([double]$info.verificationprogress) * 100, 4) }
    if ($null -ne $info.initialblockdownload) { $ibd = [bool]$info.initialblockdownload }
    if ($null -ne $blocks -and $null -ne $headers) { $behind = [math]::Max(0, $headers - $blocks) }

    return @{
        blocks = $blocks
        headers = $headers
        progressPct = $progressPct
        initialBlockDownload = $ibd
        behind = $behind
    }
}

function Write-LiveStatus($lc2Proc, $lc2RpcOk, $doge2Proc, $doge2RpcOk, $proxyProc, $managedStratumPorts, $dashPort) {
    try {
        $lc2Sync = if ($lc2RpcOk) { Get-SyncInfo 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo' } else { $null }
        $doge2Sync = if ($doge2RpcOk) { Get-SyncInfo $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass } else { $null }

        $status = @"
========================================================================
  LC2/DOGE2 SOLO MINER - RUNTIME STATUS
========================================================================
Updated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Runtime: $RuntimeRoot

Processes:
- LC2 daemon running: $($lc2Proc.Count -gt 0)
- DOGE2 daemon running: $($doge2Proc.Count -gt 0)
- Proxy running: $($proxyProc.Count -gt 0)

RPC:
- LC2 RPC responsive: $lc2RpcOk
- DOGE2 RPC responsive: $doge2RpcOk

Sync:
- LC2 blocks/headers: $($lc2Sync.blocks)/$($lc2Sync.headers)
- LC2 verification: $($lc2Sync.progressPct)%
- LC2 behind: $($lc2Sync.behind)
- LC2 IBD: $($lc2Sync.initialBlockDownload)

- DOGE2 blocks/headers: $($doge2Sync.blocks)/$($doge2Sync.headers)
- DOGE2 verification: $($doge2Sync.progressPct)%
- DOGE2 behind: $($doge2Sync.behind)
- DOGE2 IBD: $($doge2Sync.initialBlockDownload)

Network:
- Stratum ports: $($managedStratumPorts -join ', ')
- Dashboard port: $dashPort

Logs:
- $LogFile
- $ProxyOut
- $ProxyErr
========================================================================
"@

        [System.IO.File]::WriteAllText($StatusPath, $status)
    } catch {
        Write-Log "WARNING: Failed to write runtime status file: $($_.Exception.Message)"
    }
}

function Test-PortListening($port) {
    $tcp = [System.Net.Sockets.TcpClient]::new()
    try {
        $tcp.Connect('127.0.0.1', $port)
        $tcp.Close()
        return $true
    } catch { return $false }
}

function Get-StartupSummary {
    if (-not (Test-Path $StartupSummaryPath)) {
        return $null
    }

    try {
        return Get-Content -Raw -Path $StartupSummaryPath | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-ManagedProcesses([string[]]$processNames, [string[]]$pathHints = @(), [string[]]$commandLineHints = @()) {
    if (-not $processNames -or $processNames.Count -eq 0) {
        return @()
    }

    $filters = $processNames | ForEach-Object { "Name='$_'" }
    $query = ($filters -join ' OR ')
    $records = Get-CimInstance Win32_Process -Filter $query -ErrorAction SilentlyContinue
    if (-not $records) {
        return @()
    }

    return @($records | Where-Object {
        $exePath = $_.ExecutablePath
        $cmdLine = $_.CommandLine

        $pathMatch = $false
        if ($pathHints.Count -eq 0) {
            $pathMatch = $true
        } else {
            foreach ($hint in $pathHints) {
                if ($hint -and $exePath -and $exePath.StartsWith($hint, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $pathMatch = $true
                    break
                }
            }
        }

        $cmdMatch = $false
        if ($commandLineHints.Count -eq 0) {
            $cmdMatch = $true
        } else {
            foreach ($hint in $commandLineHints) {
                if ($hint -and $cmdLine -and $cmdLine.IndexOf($hint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    $cmdMatch = $true
                    break
                }
            }
        }

        $pathMatch -and $cmdMatch
    })
}

function Stop-ManagedProcesses($processRecords) {
    foreach ($proc in @($processRecords)) {
        Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
    }
}

function Get-LC2ManagedProcesses {
    return Get-ManagedProcesses -processNames @('litecoinIId') -pathHints @($LC2Exe)
}

function Get-Doge2ManagedProcesses {
    return Get-ManagedProcesses -processNames @($Doge2ProcessName) -pathHints @($Doge2Exe)
}

function Get-ProxyManagedProcesses {
    $proxyExeName = [System.IO.Path]::GetFileName($ProxyExe)
    $proxyExeBase = [System.IO.Path]::GetFileNameWithoutExtension($ProxyExe)

    $records = @()
    if (Test-Path $ProxyExe) {
        $records += Get-ManagedProcesses -processNames @($proxyExeBase) -pathHints @($ProxyExe)
    }

    $records += Get-ManagedProcesses -processNames @('node') -commandLineHints @($ProxyDir, 'src/index.js')
    return @($records | Sort-Object ProcessId -Unique)
}

function Get-ManagedStratumPorts {
    $summary = Get-StartupSummary
    if (-not $summary -or -not $summary.coins) {
        return @()
    }

    return @(
        $summary.coins |
            Where-Object { $_.started -and $_.stratumPort } |
            ForEach-Object { [int]$_.stratumPort }
    )
}

function Get-ManagedDashboardPort {
    $summary = Get-StartupSummary
    if ($summary -and $summary.dashboard -and $summary.dashboard.port) {
        return [int]$summary.dashboard.port
    }
    return $null
}

function Resolve-NodeExePath {
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:ProgramFiles(x86)\nodejs\node.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }

    if ($candidates.Count -gt 0) {
        return $candidates[0]
    }

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { return $nodeCmd.Source }

    return $null
}

function Start-LC2Daemon {
    Write-Log "RESTART: Starting LC2 daemon..."
    $lc2Args = @(
        "-datadir=$LC2DataDir",
        '-server=1',
        '-rpcport=9222',
        '-rpcuser=lc2rpc',
        '-rpcpassword=7ezB1EwlQf4iKJGba85ymAgo',
        '-rpcallowip=127.0.0.1'
    )
    Start-Process -FilePath $LC2Exe `
        -ArgumentList $lc2Args `
        -WindowStyle Hidden
    Start-Sleep 5
    Write-Log "LC2 daemon launched — waiting for RPC..."
    $tries = 0
    while ($tries -lt 12 -and -not (Test-RpcAlive 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo')) {
        Start-Sleep 5; $tries++
    }
    Write-Log "LC2 daemon ready (or timed out after $($tries*5)s)."
}

function Start-Doge2Daemon {
    Write-Log "RESTART: Starting DOGE2 daemon..."
    $doge2Args = @(
        "-datadir=$Doge2DataDir",
        '-server=1',
        "-rpcport=$Doge2RpcPort",
        "-rpcuser=$Doge2RpcUser",
        "-rpcpassword=$Doge2RpcPass",
        '-rpcallowip=127.0.0.1'
    )
    Start-Process -FilePath $Doge2Exe -ArgumentList $doge2Args -WindowStyle Hidden
    Start-Sleep 5
    Write-Log "DOGE2 daemon launched — waiting for RPC..."
    $tries = 0
    while ($tries -lt 12 -and -not (Test-RpcAlive $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass)) {
        Start-Sleep 5; $tries++
    }
    Write-Log "DOGE2 daemon ready (or timed out after $($tries*5)s)."
}

function Start-Proxy {
    Write-Log "RESTART: Starting stratum proxy..."
    Stop-ManagedProcesses (Get-ProxyManagedProcesses)
    Start-Sleep 2

    $launchFile = $null
    $launchArgs = ''

    if (Test-Path $ProxyExe) {
        $launchFile = $ProxyExe
    } else {
        $nodeExe = Resolve-NodeExePath
        if (-not $nodeExe) {
            throw 'Cannot start proxy: no packaged exe found and Node.js is not installed.'
        }
        $launchFile = $nodeExe
        $launchArgs = 'src/index.js'
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $launchFile
    $psi.Arguments              = $launchArgs
    $psi.WorkingDirectory       = $ProxyDir
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true

    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $proc.Start() | Out-Null

    # Pipe stdout/stderr to log files without blocking the watchdog
    $outWriter = [System.IO.StreamWriter]::new($ProxyOut, $true, [System.Text.Encoding]::UTF8)
    $outWriter.AutoFlush = $true
    $errWriter = [System.IO.StreamWriter]::new($ProxyErr, $true, [System.Text.Encoding]::UTF8)
    $errWriter.AutoFlush = $true

    Register-ObjectEvent -InputObject $proc -EventName 'OutputDataReceived' -Action {
        if ($null -ne $Event.SourceEventArgs.Data) {
            $outWriter.WriteLine($Event.SourceEventArgs.Data)
        }
    } | Out-Null

    Register-ObjectEvent -InputObject $proc -EventName 'ErrorDataReceived' -Action {
        if ($null -ne $Event.SourceEventArgs.Data) {
            $errWriter.WriteLine($Event.SourceEventArgs.Data)
        }
    } | Out-Null

    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    # Wait for startup-summary.json to appear and report the selected ports (max 30s)
    $tries = 0
    while ($tries -lt 6 -and -not (Get-StartupSummary)) {
        Start-Sleep 5; $tries++
    }

    $ports = Get-ManagedStratumPorts
    if ($ports.Count -gt 0 -and (@($ports | Where-Object { Test-PortListening $_ })).Count -gt 0) {
        Write-Log "Stratum proxy started OK (PID $($proc.Id), ports $($ports -join ', ') up)."
    } else {
        Write-Log "WARNING: Proxy started (PID $($proc.Id)) but managed ports are not yet reported/listening."
    }
}

# ─── Main watch loop ──────────────────────────────────────────────────────────
Write-Log "=== Watchdog started. Checking every ${CheckInterval}s ==="
Write-Log "    LC2 exe  : $LC2Exe"
Write-Log "    LC2 data : $LC2DataDir"
Write-Log "    DOGE2 exe: $Doge2Exe"
Write-Log "    DOGE2 data: $Doge2DataDir"
Write-Log "    Runtime root: $RuntimeRoot"
Write-Log "    Proxy dir: $ProxyDir"

while ($true) {

    # ── 1. LC2 daemon ──────────────────────────────────────────────────────────
    $lc2Proc = Get-LC2ManagedProcesses
    $lc2RpcOk = $false
    if (-not $lc2Proc -or $lc2Proc.Count -eq 0) {
        Write-Log "ALERT: LC2 daemon not running — restarting."
        Start-LC2Daemon
        $lc2RpcOk = Test-RpcAlive 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo'
    } elseif (-not (Test-RpcAlive 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo')) {
        Write-Log "ALERT: LC2 daemon process exists but RPC unresponsive — killing and restarting."
        Stop-ManagedProcesses $lc2Proc
        Start-Sleep 3
        Start-LC2Daemon
        $lc2RpcOk = Test-RpcAlive 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo'
    } else {
        $lc2RpcOk = $true
        Write-Log "OK: LC2 daemon alive (PID $((@($lc2Proc)[0]).ProcessId))"
    }

    # ── 2. DOGE2 daemon ────────────────────────────────────────────────────────
    $doge2Proc = Get-Doge2ManagedProcesses
    $doge2RpcOk = $false
    if (-not $doge2Proc -or $doge2Proc.Count -eq 0) {
        Write-Log "ALERT: DOGE2 daemon not running — restarting."
        Start-Doge2Daemon
        $doge2RpcOk = Test-RpcAlive $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass
    } elseif (-not (Test-RpcAlive $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass)) {
        Write-Log "ALERT: DOGE2 daemon process exists but RPC unresponsive — killing and restarting."
        Stop-ManagedProcesses $doge2Proc
        Start-Sleep 3
        Start-Doge2Daemon
        $doge2RpcOk = Test-RpcAlive $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass
    } else {
        $doge2RpcOk = $true
        Write-Log "OK: DOGE2 daemon alive (PID $((@($doge2Proc)[0]).ProcessId))"
    }

    # ── 3. Stratum proxy — check only this app's managed proxy/ports ───────────
    $proxyProc = Get-ProxyManagedProcesses
    $managedStratumPorts = Get-ManagedStratumPorts
    $managedPortUp = $managedStratumPorts.Count -gt 0 -and (@($managedStratumPorts | Where-Object { Test-PortListening $_ })).Count -gt 0

    if (-not $proxyProc -or $proxyProc.Count -eq 0) {
        Write-Log "ALERT: Managed stratum proxy is not running — restarting proxy."
        Start-Proxy
    } elseif ($managedStratumPorts.Count -gt 0 -and -not $managedPortUp) {
        Write-Log "ALERT: Managed stratum ports ($($managedStratumPorts -join ', ')) not responding — restarting proxy."
        Start-Proxy
    } else {
        $primaryProc = @($proxyProc)[0]
        if ($managedStratumPorts.Count -gt 0) {
            Write-Log "OK: Stratum proxy alive (ports $($managedStratumPorts -join ', ') up, PID $($primaryProc.ProcessId))"
        } else {
            Write-Log "OK: Stratum proxy process alive (PID $($primaryProc.ProcessId)); waiting for managed port summary."
        }
    }

    # ── 4. Dashboard ───────────────────────────────────────────────────────────
    $dashPort = Get-ManagedDashboardPort
    if ($dashPort -and -not (Test-PortListening $dashPort)) {
        Write-Log "WARNING: Dashboard port $dashPort not responding."
    }

    Write-LiveStatus -lc2Proc $lc2Proc -lc2RpcOk $lc2RpcOk -doge2Proc $doge2Proc -doge2RpcOk $doge2RpcOk -proxyProc $proxyProc -managedStratumPorts $managedStratumPorts -dashPort $dashPort

    Start-Sleep $CheckInterval
}
