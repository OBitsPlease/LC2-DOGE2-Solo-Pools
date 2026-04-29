# watchdog.ps1 - Monitors and auto-restarts all mining components
# Checks every 30 seconds: LC2 daemon, DOGE2 daemon, stratum proxy
# Logs to %TEMP%\watchdog.log

param(
    $EnableLC2 = '1',
    $EnableDOGE2 = '1'
)

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
$Doge2CookieFile = Join-Path $Doge2DataDir '.cookie'
$Doge2ConfFile = Join-Path $Doge2DataDir 'dogecoin2.conf'
$ProxyExe    = "$ProxyDir\dist\lc2-solo-proxy-windows.exe"
$RuntimeRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'LC2 DOGE2 Solo Miner'
} elseif ($env:APPDATA) {
    Join-Path $env:APPDATA 'LC2 DOGE2 Solo Miner'
} else {
    $ProxyDir
}
$RuntimeLogDir = Join-Path $RuntimeRoot 'logs'
if (-not (Test-Path $RuntimeLogDir)) {
    New-Item -ItemType Directory -Path $RuntimeLogDir -Force | Out-Null
}
$LogFile     = Join-Path $RuntimeLogDir 'watchdog.log'
$ProxyEventLog = Join-Path $RuntimeLogDir 'proxy-events.log'
$ProxyOut    = Join-Path $RuntimeLogDir 'proxy-out.log'
$ProxyErr    = Join-Path $RuntimeLogDir 'proxy-err.log'
$Lc2Out      = Join-Path $RuntimeLogDir 'lc2-out.log'
$Lc2Err      = Join-Path $RuntimeLogDir 'lc2-err.log'
$Doge2Out    = Join-Path $RuntimeLogDir 'doge2-out.log'
$Doge2Err    = Join-Path $RuntimeLogDir 'doge2-err.log'
$StartupSummaryPath = Join-Path $RuntimeRoot 'data\startup-summary.json'
$StatusPath = Join-Path $RuntimeRoot 'RUNTIME-STATUS.txt'
$DaemonSelectionPath = Join-Path $RuntimeRoot 'data\daemon-selection.json'
$WatchdogVersion = '2026-04-28.9'

$Doge2BootstrapNodeFiles = @(
    (Join-Path $ProxyDir 'data\doge2-bootstrap-nodes.txt'),
    (Join-Path $RuntimeRoot 'data\doge2-bootstrap-nodes.txt')
)

$CheckInterval = 30   # seconds between health checks

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
        # Keep existing log if rotation fails; watchdog must continue running.
    }
}

Rotate-SessionLog -logPath $LogFile -previousPath (Join-Path $RuntimeLogDir 'watchdog.previous.log')

function Resolve-Doge2ExePath {
    if (-not (Test-Path $Doge2BaseDir)) {
        throw "DOGE2 directory not found: $Doge2BaseDir"
    }

    $daemonExeNames = @('dogecoin2d.exe', 'dogecoind.exe')

    foreach ($exeName in $daemonExeNames) {
        $foundPaths = Get-ChildItem -Path $Doge2BaseDir -Recurse -File -Filter $exeName -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending
        if ($foundPaths -and $foundPaths.Count -gt 0) {
            return $foundPaths[0].FullName
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

function Write-ProxyEvent($msg) {
    try {
        $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
        [System.IO.File]::AppendAllText($ProxyEventLog, "$line`r`n")
    } catch {}
}

function Ensure-LogFile($path) {
    try {
        $dir = [System.IO.Path]::GetDirectoryName($path)
        if ($dir -and -not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        if (-not (Test-Path $path)) {
            New-Item -ItemType File -Path $path -Force | Out-Null
        }
        return $true
    } catch {
        Write-Log "ERROR: Failed to ensure log file at $path : $($_.Exception.Message)"
        return $false
    }
}

function Convert-ToSelectionBool($value, [bool]$defaultValue = $true) {
    if ($null -eq $value) { return $defaultValue }

    if ($value -is [bool]) {
        return [bool]$value
    }

    $raw = ([string]$value).Trim().ToLowerInvariant()
    switch ($raw) {
        '1' { return $true }
        'true' { return $true }
        'yes' { return $true }
        'y' { return $true }
        'on' { return $true }
        '0' { return $false }
        'false' { return $false }
        'no' { return $false }
        'n' { return $false }
        'off' { return $false }
        default { return $defaultValue }
    }
}

function Read-DaemonSelectionFallback {
    $defaults = @{
        lc2 = (Convert-ToSelectionBool -value $EnableLC2 -defaultValue $true)
        doge2 = (Convert-ToSelectionBool -value $EnableDOGE2 -defaultValue $true)
    }
    try {
        if (-not (Test-Path $DaemonSelectionPath)) { return $defaults }
        $raw = Get-Content -Raw -Path $DaemonSelectionPath -ErrorAction SilentlyContinue
        if (-not $raw) { return $defaults }
        $parsed = $raw | ConvertFrom-Json
        if ($null -eq $parsed) { return $defaults }

        return @{
            lc2 = [bool]$parsed.lc2
            doge2 = [bool]$parsed.doge2
        }
    } catch {
        return $defaults
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

if (-not $PSBoundParameters.ContainsKey('EnableLC2') -or -not $PSBoundParameters.ContainsKey('EnableDOGE2')) {
    $fallbackSelection = Read-DaemonSelectionFallback
    if (-not $PSBoundParameters.ContainsKey('EnableLC2')) {
        $EnableLC2 = [bool]$fallbackSelection.lc2
    }
    if (-not $PSBoundParameters.ContainsKey('EnableDOGE2')) {
        $EnableDOGE2 = [bool]$fallbackSelection.doge2
    }
}

$EnableLC2 = Convert-ToSelectionBool -value $EnableLC2 -defaultValue $true
$EnableDOGE2 = Convert-ToSelectionBool -value $EnableDOGE2 -defaultValue $true

function Write-Doge2Config {
    try {
        if (-not (Test-Path $Doge2DataDir)) {
            New-Item -ItemType Directory -Path $Doge2DataDir -Force | Out-Null
        }

        $bootstrapNodes = @()
        foreach ($nodeFile in $Doge2BootstrapNodeFiles) {
            if (-not (Test-Path $nodeFile)) { continue }
            try {
                $rawNodes = Get-Content -Path $nodeFile -ErrorAction SilentlyContinue
                foreach ($rawLine in @($rawNodes)) {
                    if ($null -eq $rawLine) { continue }

                    $line = ([string]$rawLine).Trim()
                    if (-not $line) { continue }
                    if ($line.StartsWith('#')) { continue }

                    # Allow "addnode=host:port" and strip inline comments.
                    $line = ($line -split '#', 2)[0].Trim()
                    $line = ($line -split ';', 2)[0].Trim()
                    if (-not $line) { continue }

                    if ($line.StartsWith('addnode=', [System.StringComparison]::OrdinalIgnoreCase)) {
                        $line = $line.Substring(8).Trim()
                    }

                    # Handle common typo from manual paste: doge2,org -> doge2.org
                    $line = $line.Replace(',', '.')

                    if (-not $line) { continue }
                    if ($line.Contains(' ')) { continue }

                    $bootstrapNodes += $line
                }
            } catch {}
        }
        $bootstrapNodes = @($bootstrapNodes | Select-Object -Unique)

        $managedHeader = '# BEGIN LC2-DOGE2-SOLO-MINER MANAGED BLOCK'
        $managedFooter = '# END LC2-DOGE2-SOLO-MINER MANAGED BLOCK'
        $managedLines = @(
            $managedHeader,
            'server=1',
            "rpcport=$Doge2RpcPort",
            "rpcuser=$Doge2RpcUser",
            "rpcpassword=$Doge2RpcPass",
            'rpcallowip=127.0.0.1',
            'printtoconsole=1',
            'dnsseed=1',
            'discover=1',
            'listen=1',
            'listenonion=0',
            'onlynet=ipv4',
            'maxconnections=64'
        )

        foreach ($node in $bootstrapNodes) {
            $managedLines += "addnode=$node"
        }
        $managedLines += $managedFooter

        $managedBlock = [string]::Join("`r`n", $managedLines)

        $existingText = ''
        if (Test-Path $Doge2ConfFile) {
            try { $existingText = [System.IO.File]::ReadAllText($Doge2ConfFile) } catch {}
        }

        if ($existingText) {
            $escapedHeader = [regex]::Escape($managedHeader)
            $escapedFooter = [regex]::Escape($managedFooter)
            $pattern = "$escapedHeader[\\s\\S]*?$escapedFooter"

            if ([regex]::IsMatch($existingText, $pattern)) {
                $configText = [regex]::Replace($existingText, $pattern, $managedBlock)
            } else {
                $separator = if ($existingText.EndsWith("`r`n")) { '' } else { "`r`n" }
                $configText = "$existingText$separator`r`n$managedBlock`r`n"
            }
        } else {
            $configText = "$managedBlock`r`n"
        }

        [System.IO.File]::WriteAllText($Doge2ConfFile, $configText)
        Write-Log "DOGE2 config written: $Doge2ConfFile (bootstrap-nodes=$($bootstrapNodes.Count))"
        return $true
    } catch {
        Write-Log "ERROR: Failed writing DOGE2 config: $($_.Exception.Message)"
        return $false
    }
}

function Try-Doge2AddrmanBootstrap {
    try {
        $addresses = Invoke-RpcMethod -port $Doge2RpcPort -user $Doge2RpcUser -pass $Doge2RpcPass -method 'getnodeaddresses' -params @(32) -cookieFile $Doge2CookieFile
        if (-not $addresses) {
            Write-Log 'DOGE2 bootstrap: getnodeaddresses returned no entries.'
            return 0
        }

        $attempted = 0
        foreach ($entry in @($addresses)) {
            if (-not $entry) { continue }
            $addr = $entry.address
            if (-not $addr) { continue }
            $attempted++
            Invoke-RpcMethod -port $Doge2RpcPort -user $Doge2RpcUser -pass $Doge2RpcPass -method 'addnode' -params @($addr, 'onetry') -cookieFile $Doge2CookieFile | Out-Null
        }

        Write-Log "DOGE2 bootstrap: attempted onetry to $attempted addrman peers."
        return $attempted
    } catch {
        Write-Log "DOGE2 bootstrap: addrman bootstrap failed: $($_.Exception.Message)"
        return 0
    }
}

function Get-Doge2BootstrapNodes {
    $nodes = @()
    foreach ($nodeFile in $Doge2BootstrapNodeFiles) {
        if (-not (Test-Path $nodeFile)) { continue }
        try {
            $rawNodes = Get-Content -Path $nodeFile -ErrorAction SilentlyContinue
            foreach ($rawLine in @($rawNodes)) {
                if ($null -eq $rawLine) { continue }

                $line = ([string]$rawLine).Trim()
                if (-not $line) { continue }
                if ($line.StartsWith('#')) { continue }

                $line = ($line -split '#', 2)[0].Trim()
                $line = ($line -split ';', 2)[0].Trim()
                if (-not $line) { continue }

                if ($line.StartsWith('addnode=', [System.StringComparison]::OrdinalIgnoreCase)) {
                    $line = $line.Substring(8).Trim()
                }

                $line = $line.Replace(',', '.')

                if (-not $line) { continue }
                if ($line.Contains(' ')) { continue }

                $nodes += $line
            }
        } catch {}
    }

    return @($nodes | Select-Object -Unique)
}

function Test-TcpReachability([string]$target, [int]$defaultPort = 22656) {
    $targetHost = $target
    $targetPort = $defaultPort

    if ($target -match '^\[([^\]]+)\]:(\d+)$') {
        $targetHost = $Matches[1]
        $targetPort = [int]$Matches[2]
    } elseif ($target -match '^([^:]+):(\d+)$') {
        $targetHost = $Matches[1]
        $targetPort = [int]$Matches[2]
    }

    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($targetHost, $targetPort, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(2500, $false)) {
            return @{ Reachable = $false; Host = $targetHost; Port = $targetPort; Error = 'timeout' }
        }
        $client.EndConnect($iar)
        return @{ Reachable = $true; Host = $targetHost; Port = $targetPort; Error = '' }
    } catch {
        return @{ Reachable = $false; Host = $targetHost; Port = $targetPort; Error = $_.Exception.Message }
    } finally {
        if ($client) {
            try { $client.Close() } catch {}
        }
    }
}

function Invoke-Doge2BootstrapConnects {
    $nodes = Get-Doge2BootstrapNodes
    if (-not $nodes -or $nodes.Count -eq 0) {
        Write-Log 'DOGE2 bootstrap: no bootstrap nodes configured.'
        return 0
    }

    $attempted = 0
    foreach ($node in $nodes) {
        $resolvedNode = $node
        if ($node -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}') {
            try {
                $ipaddr = [System.Net.Dns]::GetHostAddresses($node) | Select-Object -First 1 -ExpandProperty IPAddressToString
                if ($ipaddr) {
                    $resolvedNode = $ipaddr
                    Write-Log "DOGE2 bootstrap: $node resolved to $ipaddr"
                } else {
                    Write-Log "DOGE2 bootstrap: WARNING - failed to resolve $node"
                }
            } catch {
                Write-Log "DOGE2 bootstrap: WARNING - DNS resolution failed for $node : $($_.Exception.Message)"
            }
        }

        $connectTarget = $resolvedNode
        if ($connectTarget -notmatch ':(\d+)$') {
            $connectTarget = "$connectTarget:22656"
        }
        $reach = Test-TcpReachability -target $connectTarget
        if ($reach.Reachable) {
            Write-Log "DOGE2 bootstrap: TCP reachable $($reach.Host):$($reach.Port)"
        } else {
            Write-Log "DOGE2 bootstrap: TCP unreachable $($reach.Host):$($reach.Port) ($($reach.Error))"
        }

        try {
            # Keep a persistent addnode entry and also trigger immediate one-shot connect.
            Invoke-RpcMethod -port $Doge2RpcPort -user $Doge2RpcUser -pass $Doge2RpcPass -method 'addnode' -params @($resolvedNode, 'add') -cookieFile $Doge2CookieFile | Out-Null
        } catch {}

        try {
            Invoke-RpcMethod -port $Doge2RpcPort -user $Doge2RpcUser -pass $Doge2RpcPass -method 'addnode' -params @($resolvedNode, 'onetry') -cookieFile $Doge2CookieFile | Out-Null
            $attempted++
        } catch {
            Write-Log "DOGE2 bootstrap: addnode failed for $node (resolved: $resolvedNode) : $($_.Exception.Message)"
        }
    }

    Write-Log "DOGE2 bootstrap: attempted addnode/onetry for $attempted node(s)."
    return $attempted
}

function Ensure-Doge2BootstrapSeedFile {
    $seedFile = Join-Path $ProxyDir 'data\doge2-bootstrap-nodes.txt'
    try {
        if (-not (Test-Path $seedFile)) {
            $content = @"
# Optional DOGE2 bootstrap nodes (one host[:port] per line)
# Example:
# 1.2.3.4:22656
# my.seed.host:22656
"@
            [System.IO.File]::WriteAllText($seedFile, $content)
            Write-Log "Created optional DOGE2 bootstrap seed file: $seedFile"
        }
    } catch {
        Write-Log "WARNING: Could not create DOGE2 bootstrap seed file: $($_.Exception.Message)"
    }
}

function Get-Doge2PeerInfo {
    try {
        $peerInfo = Invoke-RpcMethod -port $Doge2RpcPort -user $Doge2RpcUser -pass $Doge2RpcPass -method 'getpeerinfo' -cookieFile $Doge2CookieFile
        if ($peerInfo -and @($peerInfo).Count -gt 0) {
            return @($peerInfo) | ForEach-Object { "$($_.addr)" }
        }
        return @()
    } catch {
        return @()
    }
}

function Get-RpcAuthCandidates($user, $pass, $cookieFile = $null) {
    $auth = New-Object System.Collections.Generic.List[string]

    $cred = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("${user}:${pass}"))
    $auth.Add("Basic $cred")

    if ($cookieFile -and (Test-Path $cookieFile)) {
        try {
            $cookie = (Get-Content -Raw -Path $cookieFile -ErrorAction SilentlyContinue).Trim()
            if ($cookie -and $cookie.Contains(':')) {
                $cookieCred = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes($cookie))
                $auth.Add("Basic $cookieCred")
            }
        } catch {}
    }

    return @($auth | Select-Object -Unique)
}

function Test-RpcAlive($port, $user, $pass, $cookieFile = $null) {
    $body  = '{"method":"getblockcount","params":[],"id":1}'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

    foreach ($authHeader in (Get-RpcAuthCandidates -user $user -pass $pass -cookieFile $cookieFile)) {
        try {
            $req   = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:${port}/")
            $req.Method        = 'POST'
            $req.ContentType   = 'application/json'
            $req.ContentLength = $bytes.Length
            $req.Timeout       = 4000
            $req.Headers.Add('Authorization', $authHeader)
            $stream = $req.GetRequestStream()
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Close()
            $resp = $req.GetResponse()
            $resp.Close()
            return $true
        } catch {}
    }

    return $false
}

function Invoke-RpcMethod($port, $user, $pass, $method, $params = @(), $cookieFile = $null) {
    $payloadObj = @{
        method = $method
        params = $params
        id = 1
    }
    $body  = ($payloadObj | ConvertTo-Json -Compress)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

    foreach ($authHeader in (Get-RpcAuthCandidates -user $user -pass $pass -cookieFile $cookieFile)) {
        try {
            $req   = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:${port}/")
            $req.Method        = 'POST'
            $req.ContentType   = 'application/json'
            $req.ContentLength = $bytes.Length
            $req.Timeout       = 4000
            $req.Headers.Add('Authorization', $authHeader)

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
        } catch {}
    }

    return $null
}

function Get-SyncInfo($port, $user, $pass, $cookieFile = $null) {
    $info = Invoke-RpcMethod -port $port -user $user -pass $pass -method 'getblockchaininfo' -cookieFile $cookieFile
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

function Get-PeerCount($port, $user, $pass, $cookieFile = $null) {
    $info = Invoke-RpcMethod -port $port -user $user -pass $pass -method 'getnetworkinfo' -cookieFile $cookieFile
    if ($info -and $null -ne $info.connections) {
        return [int]$info.connections
    }
    return $null
}

function Write-LiveStatus($lc2Proc, $lc2RpcOk, $doge2Proc, $doge2RpcOk, $proxyProc, $managedStratumPorts, $dashPort) {
    try {
        $lc2Sync = if ($lc2RpcOk) { Get-SyncInfo 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo' } else { $null }
        $doge2Sync = if ($doge2RpcOk) { Get-SyncInfo $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass $Doge2CookieFile } else { $null }
        $lc2Peers = if ($lc2RpcOk) { Get-PeerCount 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo' } else { $null }
        $doge2Peers = if ($doge2RpcOk) { Get-PeerCount $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass $Doge2CookieFile } else { $null }

        $lc2Running   = $lc2RpcOk -or ($lc2Proc.Count -gt 0)
        $doge2Running = $doge2RpcOk -or ($doge2Proc.Count -gt 0)
        $proxyPortUp  = $proxyProc.Count -gt 0
        if (-not $proxyPortUp -and $managedStratumPorts) {
            foreach ($p in $managedStratumPorts) {
                if (Test-TcpPortOpen '127.0.0.1' $p) { $proxyPortUp = $true; break }
            }
        }

        $status = @"
========================================================================
  LC2/DOGE2 SOLO MINER - RUNTIME STATUS
========================================================================
Updated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Runtime: $RuntimeRoot

Processes:
- LC2 daemon running: $lc2Running
- DOGE2 daemon running: $doge2Running
- Proxy running: $proxyPortUp

RPC:
- LC2 RPC responsive: $lc2RpcOk
- DOGE2 RPC responsive: $doge2RpcOk

Sync:
- LC2 blocks/headers: $($lc2Sync.blocks)/$($lc2Sync.headers)
- LC2 verification: $($lc2Sync.progressPct)%
- LC2 behind: $($lc2Sync.behind)
- LC2 IBD: $($lc2Sync.initialBlockDownload)
- LC2 peers: $lc2Peers

- DOGE2 blocks/headers: $($doge2Sync.blocks)/$($doge2Sync.headers)
- DOGE2 verification: $($doge2Sync.progressPct)%
- DOGE2 behind: $($doge2Sync.behind)
- DOGE2 IBD: $($doge2Sync.initialBlockDownload)
- DOGE2 peers: $doge2Peers

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

    $nameVariants = New-Object System.Collections.Generic.List[string]
    foreach ($name in $processNames) {
        if (-not $name) { continue }
        if (-not $nameVariants.Contains($name)) {
            $nameVariants.Add($name)
        }

        if ($name.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
            $bareName = [System.IO.Path]::GetFileNameWithoutExtension($name)
            if ($bareName -and -not $nameVariants.Contains($bareName)) {
                $nameVariants.Add($bareName)
            }
        } else {
            $exeName = "$name.exe"
            if (-not $nameVariants.Contains($exeName)) {
                $nameVariants.Add($exeName)
            }
        }
    }

    $filters = $nameVariants | ForEach-Object { "Name='$_'" }
    $query = ($filters -join ' OR ')
    $records = Get-CimInstance Win32_Process -Filter $query -ErrorAction SilentlyContinue
    if (-not $records) {
        return @()
    }

    return @($records | Where-Object {
        $exePath = $_.ExecutablePath
        $cmdLine = $_.CommandLine
        $hasPathHints = $pathHints.Count -gt 0
        $hasCmdHints = $commandLineHints.Count -gt 0

        $pathMatch = $false
        if (-not $hasPathHints) {
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
        if (-not $hasCmdHints) {
            $cmdMatch = $true
        } else {
            foreach ($hint in $commandLineHints) {
                if ($hint -and $cmdLine -and $cmdLine.IndexOf($hint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    $cmdMatch = $true
                    break
                }
            }
        }

        if ($hasPathHints -and $hasCmdHints) {
            # Some Windows environments do not expose ExecutablePath or CommandLine reliably.
            # Accept either signal to avoid false negatives in runtime status.
            return ($pathMatch -or $cmdMatch)
        }

        return ($pathMatch -and $cmdMatch)
    })
}

function Stop-ManagedProcesses($processRecords) {
    foreach ($proc in @($processRecords)) {
        Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
    }
}

function Get-LC2ManagedProcesses {
    return Get-ManagedProcesses -processNames @('litecoinIId') -pathHints @($LC2Exe) -commandLineHints @($LC2Exe, 'litecoinIId.exe', '-rpcport=9222')
}

function Get-Doge2ManagedProcesses {
    return Get-ManagedProcesses -processNames @($Doge2ProcessName) -pathHints @($Doge2Exe) -commandLineHints @($Doge2Exe, [System.IO.Path]::GetFileName($Doge2Exe), '-rpcport=22655')
}

function Get-ProxyManagedProcesses {
    $proxyExeName = [System.IO.Path]::GetFileName($ProxyExe)
    $proxyExeBase = [System.IO.Path]::GetFileNameWithoutExtension($ProxyExe)

    $records = @()
    if (Test-Path $ProxyExe) {
        $records += Get-ManagedProcesses -processNames @($proxyExeBase) -pathHints @($ProxyExe) -commandLineHints @($ProxyExe, $proxyExeName, $proxyExeBase)
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
    if (-not (Test-Path $LC2DataDir)) {
        New-Item -ItemType Directory -Path $LC2DataDir -Force | Out-Null
    }
    $lc2Args = @(
        "-datadir=$LC2DataDir",
        '-server=1',
        '-rpcport=9222',
        '-rpcuser=lc2rpc',
        '-rpcpassword=7ezB1EwlQf4iKJGba85ymAgo',
        '-rpcallowip=127.0.0.1'
    )
    $proc = Start-Process -FilePath $LC2Exe `
        -ArgumentList $lc2Args `
        -WorkingDirectory ([System.IO.Path]::GetDirectoryName($LC2Exe)) `
        -WindowStyle Hidden `
        -RedirectStandardOutput $Lc2Out `
        -RedirectStandardError $Lc2Err `
        -PassThru
    Start-Sleep 5
    if ($proc -and $proc.HasExited) {
        Write-Log "ERROR: LC2 daemon exited immediately with code $($proc.ExitCode)."
        if (Test-Path $Lc2Err) {
            $tail = (Get-Content -Path $Lc2Err -Tail 5 -ErrorAction SilentlyContinue) -join ' | '
            if ($tail) { Write-Log "LC2 stderr tail: $tail" }
        }
        if (Test-Path $Lc2Out) {
            $tail = (Get-Content -Path $Lc2Out -Tail 5 -ErrorAction SilentlyContinue) -join ' | '
            if ($tail) { Write-Log "LC2 stdout tail: $tail" }
        }
    }
    Write-Log "LC2 daemon launched - waiting for RPC..."
    $tries = 0
    while ($tries -lt 12 -and -not (Test-RpcAlive 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo')) {
        Start-Sleep 5; $tries++
    }
    Write-Log "LC2 daemon ready (or timed out after $($tries*5)s)."
}

function Start-Doge2Daemon {
    Write-Log "RESTART: Starting DOGE2 daemon..."
    Write-Log "DOGE2 launch inputs: exe=$Doge2Exe data=$Doge2DataDir out=$Doge2Out err=$Doge2Err"

    if (-not (Test-Path $Doge2Exe)) {
        Write-Log "ERROR: DOGE2 executable not found at $Doge2Exe"
        return
    }

    if (-not (Test-Path $Doge2DataDir)) {
        New-Item -ItemType Directory -Path $Doge2DataDir -Force | Out-Null
    }

    $configReady = Write-Doge2Config
    if (-not $configReady) {
        Write-Log "ERROR: DOGE2 config preparation failed."
    }

    $doge2Args = @(
        "-datadir=$Doge2DataDir",
        "-conf=$Doge2ConfFile",
        '-server=1',
        "-rpcport=$Doge2RpcPort",
        "-rpcuser=$Doge2RpcUser",
        "-rpcpassword=$Doge2RpcPass",
        '-rpcallowip=127.0.0.1',
        '-printtoconsole=1'
    )
    $outReady = Ensure-LogFile $Doge2Out
    $errReady = Ensure-LogFile $Doge2Err
    if (-not $outReady -or -not $errReady) {
        Write-Log "ERROR: DOGE2 log file preparation failed."
    }

    try {
        [System.IO.File]::AppendAllText($Doge2Out, "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Launching DOGE2 daemon`r`n")
        [System.IO.File]::AppendAllText($Doge2Err, "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Launching DOGE2 daemon`r`n")
        Write-Log "DOGE2 log files initialized. outExists=$(Test-Path $Doge2Out) errExists=$(Test-Path $Doge2Err)"
    } catch {
        Write-Log "ERROR: Failed writing initial DOGE2 log banners: $($_.Exception.Message)"
    }
    $proc = $null
    try {
        $proc = Start-Process -FilePath $Doge2Exe `
            -ArgumentList $doge2Args `
            -WorkingDirectory ([System.IO.Path]::GetDirectoryName($Doge2Exe)) `
            -WindowStyle Hidden `
            -RedirectStandardOutput $Doge2Out `
            -RedirectStandardError $Doge2Err `
            -PassThru
    } catch {
        Write-Log "ERROR: Failed to launch DOGE2 process: $($_.Exception.Message)"
        return
    }

    if ($proc) {
        Write-Log "DOGE2 process created with PID $($proc.Id)."
    }

    Start-Sleep 5
    if ($proc -and $proc.HasExited) {
        Write-Log "ERROR: DOGE2 daemon exited immediately with code $($proc.ExitCode)."
        if (Test-Path $Doge2Err) {
            $tail = (Get-Content -Path $Doge2Err -Tail 5 -ErrorAction SilentlyContinue) -join ' | '
            if ($tail) { Write-Log "DOGE2 stderr tail: $tail" }
        }
        if (Test-Path $Doge2Out) {
            $tail = (Get-Content -Path $Doge2Out -Tail 5 -ErrorAction SilentlyContinue) -join ' | '
            if ($tail) { Write-Log "DOGE2 stdout tail: $tail" }
        }
    }
    Write-Log "DOGE2 daemon launched - waiting for RPC..."
    $tries = 0
    while ($tries -lt 12 -and -not (Test-RpcAlive $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass $Doge2CookieFile)) {
        Start-Sleep 5; $tries++
    }
    if (Test-RpcAlive $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass $Doge2CookieFile) {
        Write-Log "DOGE2 RPC is responsive."
    } else {
        Write-Log "ERROR: DOGE2 RPC did not respond after $($tries*5)s."
        if (Test-Path $Doge2Err) {
            $tail = (Get-Content -Path $Doge2Err -Tail 10 -ErrorAction SilentlyContinue) -join ' | '
            if ($tail) { Write-Log "DOGE2 stderr tail: $tail" }
        }
        if (Test-Path $Doge2Out) {
            $tail = (Get-Content -Path $Doge2Out -Tail 10 -ErrorAction SilentlyContinue) -join ' | '
            if ($tail) { Write-Log "DOGE2 stdout tail: $tail" }
        }
    }
}

function Start-Proxy([string]$reason = 'unspecified') {
    Write-Log "RESTART: Starting stratum proxy..."
    Write-ProxyEvent "RESTART requested reason=$reason"
    $existingProxyProcs = Get-ProxyManagedProcesses
    if ($existingProxyProcs -and $existingProxyProcs.Count -gt 0) {
        foreach ($p in $existingProxyProcs) {
            Write-ProxyEvent "STOP pid=$($p.ProcessId) cmd=$($p.CommandLine)"
        }
    } else {
        Write-ProxyEvent "STOP none (no managed proxy process found)"
    }
    Stop-ManagedProcesses $existingProxyProcs
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
    $psi.EnvironmentVariables['DAEMON_ENABLE_LC2'] = if ($EnableLC2) { '1' } else { '0' }
    $psi.EnvironmentVariables['DAEMON_ENABLE_DOGE2'] = if ($EnableDOGE2) { '1' } else { '0' }

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
        Write-ProxyEvent "START OK pid=$($proc.Id) ports=$($ports -join ',')"
    } else {
        Write-Log "WARNING: Proxy started (PID $($proc.Id)) but managed ports are not yet reported/listening."
        Write-ProxyEvent "START WARN pid=$($proc.Id) ports-not-ready"
    }
}

# Main watch loop
Write-Log "=== Watchdog started. Checking every ${CheckInterval}s ==="
Write-Log "    Watchdog version: $WatchdogVersion"
Write-Log "    Watchdog script: $PSCommandPath"
Write-Log "    Selection: LC2=$EnableLC2 DOGE2=$EnableDOGE2"
Write-Log "    LC2 exe  : $LC2Exe"
Write-Log "    LC2 data : $LC2DataDir"
Write-Log "    DOGE2 exe: $Doge2Exe"
Write-Log "    DOGE2 data: $Doge2DataDir"
Write-Log "    Runtime root: $RuntimeRoot"
Write-Log "    Proxy dir: $ProxyDir"

Ensure-Doge2BootstrapSeedFile

$doge2NoPeerCycles = 0

while ($true) {

    # 1. LC2 daemon
    $lc2Proc = Get-LC2ManagedProcesses
    $lc2RpcOk = $false
    if (-not $EnableLC2) {
        if ($lc2Proc -and $lc2Proc.Count -gt 0) {
            Write-Log "INFO: LC2 disabled by user selection - stopping managed LC2 daemon process(es)."
            Stop-ManagedProcesses $lc2Proc
            Start-Sleep 2
        } else {
            Write-Log "INFO: LC2 disabled by user selection."
        }
        $lc2Proc = @()
    } else {
        if (Test-RpcAlive 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo') {
            $lc2RpcOk = $true
            if ($lc2Proc -and $lc2Proc.Count -gt 0) {
                Write-Log "OK: LC2 daemon alive (PID $((@($lc2Proc)[0]).ProcessId), RPC responsive)"
            } else {
                Write-Log "OK: LC2 RPC responsive (process metadata unavailable or external daemon)."
            }
        } elseif (-not $lc2Proc -or $lc2Proc.Count -eq 0) {
            Write-Log "ALERT: LC2 daemon not running - restarting."
            Start-LC2Daemon
            $lc2RpcOk = Test-RpcAlive 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo'
        } elseif (-not (Test-RpcAlive 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo')) {
            Write-Log "ALERT: LC2 daemon process exists but RPC unresponsive - killing and restarting."
            Stop-ManagedProcesses $lc2Proc
            Start-Sleep 3
            Start-LC2Daemon
            $lc2RpcOk = Test-RpcAlive 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo'
        }
    }

    # 2. DOGE2 daemon
    $doge2Proc = Get-Doge2ManagedProcesses
    $doge2RpcOk = $false
    if (-not $EnableDOGE2) {
        if ($doge2Proc -and $doge2Proc.Count -gt 0) {
            Write-Log "INFO: DOGE2 disabled by user selection - stopping managed DOGE2 daemon process(es)."
            Stop-ManagedProcesses $doge2Proc
            Start-Sleep 2
        } else {
            Write-Log "INFO: DOGE2 disabled by user selection."
        }
        $doge2Proc = @()
    } else {
        if (Test-RpcAlive $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass $Doge2CookieFile) {
            $doge2RpcOk = $true
            if ($doge2Proc -and $doge2Proc.Count -gt 0) {
                Write-Log "OK: DOGE2 daemon alive (PID $((@($doge2Proc)[0]).ProcessId), RPC responsive)"
            } else {
                Write-Log "OK: DOGE2 RPC responsive (process metadata unavailable or external daemon)."
            }
        } elseif (-not $doge2Proc -or $doge2Proc.Count -eq 0) {
            Write-Log "ALERT: DOGE2 daemon not running - restarting."
            Start-Doge2Daemon
            $doge2RpcOk = Test-RpcAlive $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass $Doge2CookieFile
        } elseif (-not (Test-RpcAlive $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass $Doge2CookieFile)) {
            Write-Log "ALERT: DOGE2 daemon process exists but RPC unresponsive - killing and restarting."
            Stop-ManagedProcesses $doge2Proc
            Start-Sleep 3
            Start-Doge2Daemon
            $doge2RpcOk = Test-RpcAlive $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass $Doge2CookieFile
        }
    }

    # 3. Stratum proxy - check only this app's managed proxy/ports
    $proxyProc = Get-ProxyManagedProcesses
    $managedStratumPorts = Get-ManagedStratumPorts
    $missingManagedPorts = @()
    if ($managedStratumPorts.Count -gt 0) {
        foreach ($p in $managedStratumPorts) {
            if (-not (Test-PortListening $p)) {
                $missingManagedPorts += $p
            }
        }
    }

    if (-not $proxyProc -or $proxyProc.Count -eq 0) {
        Write-Log "ALERT: Managed stratum proxy is not running - restarting proxy."
        Write-ProxyEvent "ALERT process-missing"
        Start-Proxy -reason 'process-missing'
    } elseif ($managedStratumPorts.Count -gt 0 -and $missingManagedPorts.Count -gt 0) {
        Write-Log "ALERT: Managed stratum ports down ($($missingManagedPorts -join ', ')); expected up ($($managedStratumPorts -join ', ')) - restarting proxy."
        Write-ProxyEvent "ALERT ports-down missing=$($missingManagedPorts -join ',') expected=$($managedStratumPorts -join ',')"
        Start-Proxy -reason 'ports-down'
    } else {
        $primaryProc = @($proxyProc)[0]
        if ($managedStratumPorts.Count -gt 0) {
            Write-Log "OK: Stratum proxy alive (ports $($managedStratumPorts -join ', ') up, PID $($primaryProc.ProcessId))"
        } else {
            Write-Log "OK: Stratum proxy process alive (PID $($primaryProc.ProcessId)); waiting for managed port summary."
        }
    }

    # 4. Dashboard
    $dashPort = Get-ManagedDashboardPort
    if ($dashPort -and -not (Test-PortListening $dashPort)) {
        Write-Log "WARNING: Dashboard port $dashPort not responding."
    }

    # 4b. Explicit sync snapshots to avoid guesswork when daemons are up but stalled.
    if ($lc2RpcOk) {
        $lc2SyncNow = Get-SyncInfo 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo'
        $lc2PeersNow = Get-PeerCount 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo'
        Write-Log "SYNC: LC2 blocks=$($lc2SyncNow.blocks) headers=$($lc2SyncNow.headers) behind=$($lc2SyncNow.behind) ibd=$($lc2SyncNow.initialBlockDownload) peers=$lc2PeersNow"
    }
    if ($doge2RpcOk) {
        $doge2SyncNow = Get-SyncInfo $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass $Doge2CookieFile
        $doge2PeersNow = Get-PeerCount $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass $Doge2CookieFile
        Write-Log "SYNC: DOGE2 blocks=$($doge2SyncNow.blocks) headers=$($doge2SyncNow.headers) behind=$($doge2SyncNow.behind) ibd=$($doge2SyncNow.initialBlockDownload) peers=$doge2PeersNow"

        $doge2NoPeersAndNoBlocks = ($doge2PeersNow -eq 0 -and (($doge2SyncNow.blocks -eq 0) -or ($null -eq $doge2SyncNow.blocks)))
        if ($doge2NoPeersAndNoBlocks) {
            $doge2NoPeerCycles++
            if ($doge2NoPeerCycles -ge 4) {
                Write-Log "DOGE2 appears stuck with 0 peers/0 blocks for $($doge2NoPeerCycles * $CheckInterval)s - attempting configured bootstrap nodes."
                $attempted = Invoke-Doge2BootstrapConnects

                if ($attempted -le 0) {
                    Write-Log 'DOGE2 bootstrap via configured nodes made no successful RPC calls; trying addrman fallback.'
                    $attempted = Try-Doge2AddrmanBootstrap
                }

                if ($attempted -gt 0) {
                    Write-Log 'DOGE2 bootstrap action taken; waiting for peers to connect.'
                }
                $doge2NoPeerCycles = 2
            } elseif ($doge2NoPeerCycles -ge 2) {
                $connectedPeers = @(Get-Doge2PeerInfo)
                if ($connectedPeers.Count -gt 0) {
                    Write-Log "DOGE2 bootstrap recovered! Connected peers: $($connectedPeers -join ', ')"
                    $doge2NoPeerCycles = 0
                } else {
                    Write-Log "DOGE2 bootstrap diagnostic: no peer connections established yet (attempt $doge2NoPeerCycles)"
                }
            }
        } else {
            $doge2NoPeerCycles = 0
        }
    } else {
        $doge2NoPeerCycles = 0
    }

    # 5. Daemon update handler
    $UpdateRequestPath = Join-Path $RuntimeRoot 'data\update-request.json'
    $UpdateStatusPath  = Join-Path $RuntimeRoot 'data\update-status.json'

    if (Test-Path $UpdateRequestPath) {
        $updateReq = $null
        try {
            $updateReq = Get-Content -Raw $UpdateRequestPath -ErrorAction Stop | ConvertFrom-Json
        } catch {
            Write-Log "UPDATE ERROR: Failed to read update-request.json: $($_.Exception.Message)"
            Remove-Item $UpdateRequestPath -Force -ErrorAction SilentlyContinue
        }

        if ($updateReq) {
            $upCoin      = $updateReq.coinId
            $upAssetUrl  = $updateReq.assetUrl
            $upAssetName = $updateReq.assetName
            $upVersion   = $updateReq.targetVersion

            Write-Log "UPDATE: Daemon update requested for $upCoin -> v$upVersion"

            function Write-UpdateStatus($upSt, $upMsg = '') {
                try {
                    $obj = @{ coinId=$upCoin; status=$upSt; message=$upMsg; updatedAt=(Get-Date -Format 'o') }
                    $obj | ConvertTo-Json -Compress | Out-File $UpdateStatusPath -Encoding UTF8 -Force
                } catch {}
            }

            try {
                Write-UpdateStatus 'downloading'

                # Create temp download dir
                $tempDir = Join-Path $env:TEMP "coin-update-$upCoin-$(Get-Random)"
                if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
                New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
                $zipPath = Join-Path $tempDir $upAssetName

                # Download
                $wc = New-Object System.Net.WebClient
                $wc.Headers.Add('User-Agent', 'lc2-doge2-solo-miner/watchdog')
                $wc.DownloadFile($upAssetUrl, $zipPath)
                Write-Log "UPDATE: Downloaded $upAssetName"

                # Stop daemon via RPC
                Write-UpdateStatus 'stopping-daemon'
                if ($upCoin -eq 'lc2') {
                    Invoke-RpcMethod 9222 'lc2rpc' '7ezB1EwlQf4iKJGba85ymAgo' 'stop' | Out-Null
                    Write-Log "UPDATE: Sent stop to LC2 daemon"
                } elseif ($upCoin -eq 'doge2') {
                    Invoke-RpcMethod $Doge2RpcPort $Doge2RpcUser $Doge2RpcPass 'stop' @() $Doge2CookieFile | Out-Null
                    Write-Log "UPDATE: Sent stop to DOGE2 daemon"
                }
                # Give daemon time to shut down cleanly
                Start-Sleep 8

                # Extract archive
                Write-UpdateStatus 'extracting'
                $extractDir = Join-Path $tempDir 'extracted'
                Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
                Write-Log "UPDATE: Extracted archive"

                # Locate the daemon exe inside the archive
                $exeNames = @('litecoinIId.exe', 'litecoinii-daemon.exe', 'dogecoin2d.exe', 'dogecoind.exe')
                $newExe = $null
                foreach ($exeName in $exeNames) {
                    $found = Get-ChildItem -Path $extractDir -Recurse -File -Filter $exeName -ErrorAction SilentlyContinue |
                             Sort-Object FullName | Select-Object -First 1
                    if ($found) { $newExe = $found; break }
                }

                if (-not $newExe) {
                    throw "No daemon executable found in archive. Looked for: $($exeNames -join ', ')"
                }

                # Replace the binary
                Write-UpdateStatus 'replacing-binary'
                if ($upCoin -eq 'lc2') {
                    $destExe = $LC2Exe
                } elseif ($upCoin -eq 'doge2') {
                    $destExe = $Doge2Exe
                } else {
                    throw "Unknown coin '$upCoin' - cannot determine destination path"
                }

                # Keep a .bak copy in case of rollback
                $bakPath = "$destExe.bak"
                if (Test-Path $destExe) { Copy-Item $destExe $bakPath -Force }
                Copy-Item $newExe.FullName $destExe -Force
                Write-Log "UPDATE: Replaced $upCoin daemon exe with v$upVersion (backup: $bakPath)"

                # Record the new installed version
                $installedVersionsPath = Join-Path $RuntimeRoot 'data\installed-versions.json'
                $versions = @{}
                if (Test-Path $installedVersionsPath) {
                    try {
                        $jsonData = Get-Content -Raw $installedVersionsPath | ConvertFrom-Json
                        $jsonData.PSObject.Properties | ForEach-Object { $versions[$_.Name] = $_.Value }
                    } catch {}
                }
                $versions[$upCoin] = $upVersion
                $versions | ConvertTo-Json -Compress | Out-File $installedVersionsPath -Encoding UTF8 -Force

                Write-UpdateStatus 'done' "Updated to v$upVersion"
                Write-Log "UPDATE: $upCoin successfully updated to v$upVersion. Daemon will restart on next watchdog cycle."

                # Cleanup
                Remove-Item $UpdateRequestPath -Force -ErrorAction SilentlyContinue
                Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

                # Re-resolve DOGE2 exe path in case it changed
                if ($upCoin -eq 'doge2') {
                    try { $Doge2Exe = Resolve-Doge2ExePath } catch {}
                }

            } catch {
                Write-Log "UPDATE ERROR: $($_.Exception.Message)"
                Write-UpdateStatus 'error' $_.Exception.Message
                Remove-Item $UpdateRequestPath -Force -ErrorAction SilentlyContinue
                Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    # Refresh state after any restart actions so runtime status reflects current reality.
    $lc2Proc = Get-LC2ManagedProcesses
    $doge2Proc = Get-Doge2ManagedProcesses
    $proxyProc = Get-ProxyManagedProcesses
    $managedStratumPorts = Get-ManagedStratumPorts
    $dashPort = Get-ManagedDashboardPort

    Write-LiveStatus -lc2Proc $lc2Proc -lc2RpcOk $lc2RpcOk -doge2Proc $doge2Proc -doge2RpcOk $doge2RpcOk -proxyProc $proxyProc -managedStratumPorts $managedStratumPorts -dashPort $dashPort

    Start-Sleep $CheckInterval
}
