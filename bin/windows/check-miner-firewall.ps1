param(
    [switch]$FixRules,
    [string]$InstallRoot = "C:\Program Files\LC2 DOGE2 Solo Miner"
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-Section([string]$title) {
    Write-Host ""
    Write-Host "=== $title ===" -ForegroundColor Cyan
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-RuleExistsForProgram([string]$ruleName, [string]$programPath, [string]$direction, [string]$protocol, [string]$portField, [string]$portValue) {
    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if (-not $rule) { return $false }

    foreach ($r in @($rule)) {
        if ($r.Enabled -ne 'True' -or $r.Direction -ne $direction -or $r.Action -ne 'Allow') { continue }

        $app = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $r
        if ($app.Program -ne $programPath) { continue }

        $port = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $r
        if ($port.Protocol -ne $protocol) { continue }

        if ($portField -eq 'LocalPort' -and $port.LocalPort -eq $portValue) { return $true }
        if ($portField -eq 'RemotePort' -and $port.RemotePort -eq $portValue) { return $true }
    }

    return $false
}

function Ensure-Rule(
    [string]$ruleName,
    [string]$programPath,
    [string]$direction,
    [string]$protocol,
    [string]$localPort,
    [string]$remotePort
) {
    $exists = $false

    if ($localPort) {
        $exists = Get-RuleExistsForProgram -ruleName $ruleName -programPath $programPath -direction $direction -protocol $protocol -portField 'LocalPort' -portValue $localPort
    } elseif ($remotePort) {
        $exists = Get-RuleExistsForProgram -ruleName $ruleName -programPath $programPath -direction $direction -protocol $protocol -portField 'RemotePort' -portValue $remotePort
    }

    if ($exists) {
        Write-Host "OK     $ruleName" -ForegroundColor Green
        return
    }

    Write-Host "MISSING $ruleName" -ForegroundColor Yellow

    if (-not $FixRules) { return }

    if ($localPort) {
        New-NetFirewallRule -DisplayName $ruleName -Direction $direction -Action Allow -Program $programPath -Protocol $protocol -LocalPort $localPort | Out-Null
    } elseif ($remotePort) {
        New-NetFirewallRule -DisplayName $ruleName -Direction $direction -Action Allow -Program $programPath -Protocol $protocol -RemotePort $remotePort | Out-Null
    }

    $created = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($created) {
        Write-Host "ADDED   $ruleName" -ForegroundColor Green
    } else {
        Write-Host "FAILED  $ruleName" -ForegroundColor Red
    }
}

function Test-TcpEndpoint([string]$targetHost, [int]$port, [int]$timeoutMs = 2500) {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($targetHost, $port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($timeoutMs, $false)) {
            return $false
        }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        if ($client) {
            try { $client.Close() } catch {}
        }
    }
}

$dogeExe = Join-Path $InstallRoot 'bin\doge2\Dogecoin2-v0.0.7-Windows64-Wallet\dogecoin2-v0.0.7-win64\dogecoin2d.exe'
$lc2Exe  = Join-Path $InstallRoot 'bin\lc2\litecoinIId.exe'

Write-Host "LC2/DOGE2 Firewall and Connectivity Check" -ForegroundColor Cyan
Write-Host "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "InstallRoot: $InstallRoot"
Write-Host "FixRules: $FixRules"

if (-not (Test-IsAdmin)) {
    Write-Host "WARNING: Not running as Administrator. Rule creation may fail." -ForegroundColor Yellow
}

Write-Section "Program Paths"
if (Test-Path $dogeExe) { Write-Host "DOGE2 daemon found: $dogeExe" -ForegroundColor Green } else { Write-Host "DOGE2 daemon missing: $dogeExe" -ForegroundColor Red }
if (Test-Path $lc2Exe)  { Write-Host "LC2 daemon found: $lc2Exe" -ForegroundColor Green } else { Write-Host "LC2 daemon missing: $lc2Exe" -ForegroundColor Red }

Write-Section "Required Firewall Rules"
# DOGE2 P2P 22656
Ensure-Rule -ruleName 'LC2Doge2 DOGE2 In 22656'  -programPath $dogeExe -direction 'Inbound'  -protocol 'TCP' -localPort '22656' -remotePort ''
Ensure-Rule -ruleName 'LC2Doge2 DOGE2 Out 22656' -programPath $dogeExe -direction 'Outbound' -protocol 'TCP' -localPort '' -remotePort '22656'

# LC2 P2P 9223
Ensure-Rule -ruleName 'LC2Doge2 LC2 In 9223'  -programPath $lc2Exe -direction 'Inbound'  -protocol 'TCP' -localPort '9223' -remotePort ''
Ensure-Rule -ruleName 'LC2Doge2 LC2 Out 9223' -programPath $lc2Exe -direction 'Outbound' -protocol 'TCP' -localPort '' -remotePort '9223'

# Stratum ports for miners on LAN
Ensure-Rule -ruleName 'LC2Doge2 Proxy In 3333' -programPath (Join-Path $InstallRoot 'dist\lc2-solo-proxy-windows.exe') -direction 'Inbound' -protocol 'TCP' -localPort '3333' -remotePort ''
Ensure-Rule -ruleName 'LC2Doge2 Proxy In 3334' -programPath (Join-Path $InstallRoot 'dist\lc2-solo-proxy-windows.exe') -direction 'Inbound' -protocol 'TCP' -localPort '3334' -remotePort ''

Write-Section "Outbound Reachability to DOGE2 Bootstrap Nodes"
$bootstrap = @(
    @{ Host = '207.154.229.211'; Port = 22656 },
    @{ Host = '164.92.188.197'; Port = 22656 },
    @{ Host = '45.76.147.160'; Port = 22656 },
    @{ Host = '31.220.96.220'; Port = 22656 },
    @{ Host = '45.76.148.54'; Port = 22656 },
    @{ Host = '139.84.229.188'; Port = 22656 },
    @{ Host = '45.77.233.130'; Port = 22656 }
)

$reachableCount = 0
foreach ($node in $bootstrap) {
    $ok = Test-TcpEndpoint -targetHost $node.Host -port $node.Port -timeoutMs 3000
    if ($ok) {
        $reachableCount++
        Write-Host "REACHABLE   $($node.Host):$($node.Port)" -ForegroundColor Green
    } else {
        Write-Host "UNREACHABLE $($node.Host):$($node.Port)" -ForegroundColor Red
    }
}

Write-Section "Port Isolation Test (is port 22656 specifically blocked?)"
Write-Host "Testing if bootstrap IPs are reachable on standard ports vs port 22656..."
$testIps = @('207.154.229.211', '164.92.188.197', '31.220.96.220')
foreach ($ip in $testIps) {
    $on80  = Test-TcpEndpoint -targetHost $ip -port 80 -timeoutMs 3000
    $on443 = Test-TcpEndpoint -targetHost $ip -port 443 -timeoutMs 3000
    $onP2P = Test-TcpEndpoint -targetHost $ip -port 22656 -timeoutMs 3000
    $state80  = if ($on80)  { "OPEN" } else { "closed" }
    $state443 = if ($on443) { "OPEN" } else { "closed" }
    $stateP2P = if ($onP2P) { "OPEN" } else { "closed/blocked" }
    $color = if ($onP2P) { "Green" } else { "Yellow" }
    Write-Host "  $ip  port 80=$state80  port 443=$state443  port 22656=$stateP2P" -ForegroundColor $color
}

Write-Section "General Internet Connectivity"
$internetTargets = @(
    @{ Host = 'www.microsoft.com'; Port = 443 },
    @{ Host = 'www.cloudflare.com'; Port = 443 },
    @{ Host = '1.1.1.1'; Port = 443 }
)
$internetOk = 0
foreach ($t in $internetTargets) {
    $ok = Test-TcpEndpoint -targetHost $t.Host -port $t.Port -timeoutMs 3000
    if ($ok) {
        $internetOk++
        Write-Host "  REACHABLE   $($t.Host):$($t.Port)" -ForegroundColor Green
    } else {
        Write-Host "  UNREACHABLE $($t.Host):$($t.Port)" -ForegroundColor Yellow
    }
}
if ($internetOk -gt 0) {
    Write-Host "Internet appears available ($internetOk/$($internetTargets.Count) connectivity checks passed)." -ForegroundColor Green
} else {
    Write-Host "Internet connectivity appears down or heavily filtered (0/$($internetTargets.Count) checks passed)." -ForegroundColor Red
}

# Check for any third-party AV/security processes that might block traffic
Write-Section "Security Software Check"
$foundAv = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $name = $_.Name.ToLower()
    $name -like '*defender*' -or $name -like '*avast*' -or $name -like '*norton*' -or $name -like '*mcafee*' -or $name -like '*bitdefender*' -or $name -like '*malwarebytes*' -or $name -like '*eset*' -or $name -like '*avg*' -or $name -like '*kasp*' -or $name -like '*bdagent*' -or $name -like '*mbam*'
})
if ($foundAv.Count -gt 0) {
    Write-Host "Security processes found:" -ForegroundColor Yellow
    $foundAv | Sort-Object -Property Name -Unique | ForEach-Object {
        $nameLower = $_.Name.ToLower()
        if ($nameLower -like '*defender*') {
            Write-Host "  $($_.Name) (PID $($_.Id)) - built-in Microsoft Defender (normal)" -ForegroundColor Gray
        } else {
            Write-Host "  $($_.Name) (PID $($_.Id)) - may enforce outbound filtering" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "No obvious third-party security processes detected." -ForegroundColor Green
}

Write-Section "Summary"
Write-Host "Reachable bootstrap nodes: $reachableCount / $($bootstrap.Count)"
if ($reachableCount -eq 0) {
    Write-Host ""
    Write-Host "All bootstrap nodes UNREACHABLE on port 22656. Possible causes:" -ForegroundColor Red
    Write-Host "  1. ISP is blocking outbound TCP 22656 (common with some ISPs)" -ForegroundColor Yellow
    Write-Host "  2. Router has outbound firewall blocking high ports" -ForegroundColor Yellow
    Write-Host "  3. Security/antivirus software blocking the DOGE2 daemon" -ForegroundColor Yellow
    Write-Host "  4. DOGE2 bootstrap nodes are offline" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "To isolate the cause, check the Port Isolation Test above:" -ForegroundColor Cyan
    Write-Host "  - If port 80/443 also blocked = IP routing issue" -ForegroundColor Cyan
    Write-Host "  - If only 22656 blocked = ISP or router blocking that port specifically" -ForegroundColor Cyan
    Write-Host "  - If nothing blocked but peers still =0 = DOGE2 daemon network issue" -ForegroundColor Cyan
} elseif ($reachableCount -lt $bootstrap.Count) {
    Write-Host "Partial reachability. Some seed nodes are blocked/offline." -ForegroundColor Yellow
} else {
    Write-Host "All bootstrap nodes reachable from this PC." -ForegroundColor Green
}

Write-Host ""
Write-Host "Tip: Run with -FixRules to auto-create missing Windows Firewall rules." -ForegroundColor Cyan
