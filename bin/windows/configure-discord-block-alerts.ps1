$ErrorActionPreference = 'Stop'

$runtimeRoot = Join-Path $env:LOCALAPPDATA 'LC2 DOGE2 Solo Miner'
$dataDir = Join-Path $runtimeRoot 'data'
$configPath = Join-Path $dataDir 'discord-alerts.json'

Write-Host 'LC2 Discord Block Alert Setup' -ForegroundColor Cyan
Write-Host 'The webhook is stored only in your local runtime data directory.' -ForegroundColor DarkGray
Write-Host 'Do not paste the webhook into chat, source files, screenshots, or logs.' -ForegroundColor Yellow
Write-Host ''

$secureWebhook = Read-Host 'Paste the Discord webhook URL (input is hidden)' -AsSecureString
$webhookPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureWebhook)
try {
    $webhookUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($webhookPtr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($webhookPtr)
}

if ($webhookUrl -notmatch '^https://(canary\.|ptb\.)?(discord(?:app)?\.com)/api/webhooks/') {
    throw 'That does not look like a Discord webhook URL.'
}

$mention = Read-Host 'Optional Discord mention, for example <@USER_ID> or <@&ROLE_ID> (Enter for none)'
$config = [ordered]@{
    enabled = $true
    webhookUrl = $webhookUrl
    mention = $mention
    notifyOn = @('accepted', 'confirmed', 'orphaned', 'rejected', 'rpc-error', 'resubmitted')
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$config | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8

$payload = @{
    content = if ($mention) { $mention } else { $null }
    allowed_mentions = @{ parse = if ($mention) { @('users', 'roles') } else { @() } }
    embeds = @(@{
        title = 'LC2 block alerts enabled'
        description = 'This is a configuration test. Future LC2 block events will include status and locally saved evidence.'
        color = 3066993
        timestamp = (Get-Date).ToUniversalTime().ToString('o')
    })
} | ConvertTo-Json -Depth 8

try {
    Invoke-RestMethod -Uri $webhookUrl -Method Post -ContentType 'application/json' -Body $payload | Out-Null
    Write-Host ''
    Write-Host 'Discord test alert sent successfully.' -ForegroundColor Green
    Write-Host "Local config: $configPath"
    Write-Host "Incident files: $(Join-Path $runtimeRoot 'alerts\incidents')"
} catch {
    Write-Host ''
    Write-Host 'The local config was saved, but Discord rejected the test request.' -ForegroundColor Red
    throw
}
