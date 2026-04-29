# DOGE2 Connectivity Diagnostic Script
# Purpose: Identify why DOGE2 won't establish peer connections
# Run on test PC as Administrator

param(
    [string]$DataDir = "$env:APPDATA\Dogecoin2",
    [int]$RpcPort = 22655
)

Write-Host "=== DOGE2 P2P Connectivity Diagnostic ===" -ForegroundColor Cyan
Write-Host "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

# 1. Check daemon logs
Write-Host "[1] Checking DOGE2 daemon logs..." -ForegroundColor Yellow
$logDir = "$env:LOCALAPPDATA\LC2 DOGE2 Solo Miner\logs"
$outLog = "$logDir\doge2-out.log"
$errLog = "$logDir\doge2-err.log"

if (Test-Path $outLog) {
    Write-Host "DOGE2 stdout (last 20 lines):" -ForegroundColor Green
    Get-Content $outLog -Tail 20
} else {
    Write-Host "No stdout log found at $outLog" -ForegroundColor Red
}

Write-Host ""
if (Test-Path $errLog) {
    Write-Host "DOGE2 stderr (last 20 lines):" -ForegroundColor Green
    Get-Content $errLog -Tail 20
} else {
    Write-Host "No stderr log found at $errLog" -ForegroundColor Red
}

Write-Host ""

# 2. Test RPC getnetworkinfo
Write-Host "[2] Querying DOGE2 getnetworkinfo via RPC..." -ForegroundColor Yellow

$rpcUser = "doge2rpc"
$rpcPass = "Doge2RpcPass2026!"
$cred = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("${rpcUser}:${rpcPass}"))
$headers = @{"Authorization" = "Basic $cred"}

try {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort/" `
        -Method Post `
        -Headers $headers `
        -Body '{"jsonrpc":"1.0","id":"1","method":"getnetworkinfo","params":[]}' `
        -ContentType "application/json" `
        -TimeoutSec 5

    if ($result.result) {
        Write-Host "Network Info:" -ForegroundColor Green
        Write-Host "  Version: $($result.result.version)"
        Write-Host "  Subversion: $($result.result.subversion)"
        Write-Host "  Listening: $($result.result.listening)"
        Write-Host "  Local Services: $($result.result.localservices)"
        Write-Host "  Connections: $($result.result.connections)"
        Write-Host "  Networks:" -ForegroundColor Cyan
        $result.result.networks | ForEach-Object {
            Write-Host "    - $($_.name): reachable=$($_.reachable) proxy=$($_.proxy)"
        }
    } else {
        Write-Host "RPC error: $($result.error)" -ForegroundColor Red
    }
} catch {
    Write-Host "RPC call failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# 3. Test connectivity to bootstrap nodes
Write-Host "[3] Testing connectivity to bootstrap nodes..." -ForegroundColor Yellow

$bootstrapNodes = @(
    "207.154.229.211:22656",    # Doge1.doge2.org
    "164.92.188.197:22656",     # Doge2.doge2.org
    "45.76.147.160:22656",      # Doge3.doge2.org
    "31.220.96.220:22656",      # America
    "45.76.148.54:22656",       # Asia
    "139.84.229.188:22656",     # Africa
    "45.77.233.130:22656"       # Australia
)

foreach ($node in $bootstrapNodes) {
    $host, $port = $node -split ':'
    $tcp = New-Object System.Net.Sockets.TcpClient
    $async = $tcp.BeginConnect($host, $port, $null, $null)
    $wait = $async.AsyncWaitHandle.WaitOne(3000, $false)
    
    if ($wait -and $tcp.Connected) {
        Write-Host "  ✓ $node - REACHABLE" -ForegroundColor Green
        $tcp.Close()
    } else {
        Write-Host "  ✗ $node - UNREACHABLE" -ForegroundColor Red
        $tcp.Close()
    }
}

Write-Host ""

# 4. Check dogecoin2.conf
Write-Host "[4] Checking dogecoin2.conf bootstrap configuration..." -ForegroundColor Yellow
$confFile = "$DataDir\dogecoin2.conf"
if (Test-Path $confFile) {
    $addnodes = @(Get-Content $confFile | Select-String "^addnode=" | Measure-Object).Count
    Write-Host "Found $addnodes addnode entries in config" -ForegroundColor Green
    Write-Host "Bootstrap section:" -ForegroundColor Cyan
    Get-Content $confFile | Select-String -Pattern "# Managed bootstrap|addnode=", "^addnode=" -Context 0, 0
} else {
    Write-Host "Config not found at $confFile" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Diagnostic Complete ===" -ForegroundColor Cyan
Write-Host "If all nodes show UNREACHABLE, network/firewall is blocking P2P connections."
Write-Host "If nodes are REACHABLE but peers=0, DOGE2 daemon has a network issue."
Write-Host ""
