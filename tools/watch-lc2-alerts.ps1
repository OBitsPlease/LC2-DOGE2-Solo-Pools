param(
  [string]$LogPath = "$env:LOCALAPPDATA\LC2 DOGE2 Solo Miner\logs\multi-asic-diagnostic.log",
  [switch]$Beep,
  [switch]$Popup,
  [int]$Tail = 0
)

$ErrorActionPreference = 'Stop'

function Write-AlertLine {
  param([string]$Line)

  $stamp = Get-Date -Format o
  Write-Host "[$stamp] $Line"

  $alertFile = Join-Path (Split-Path -Parent $LogPath) 'lc2-alerts.log'
  Add-Content -Path $alertFile -Value "[$stamp] $Line"

  if ($Beep) {
    try { [console]::Beep(950, 250) } catch {}
  }

  if ($Popup) {
    try {
      Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
      [void][System.Windows.MessageBox]::Show($Line, 'LC2 Block Alert')
    } catch {}
  }
}

if (-not (Test-Path $LogPath)) {
  Write-Host "Waiting for log file: $LogPath"
  while (-not (Test-Path $LogPath)) {
    Start-Sleep -Seconds 1
  }
}

# LC2-focused events emitted by stratum-server diagnostics
$patterns = @(
  'block-found',
  'block-rejected',
  'block-submit-rpc-error'
)

Write-Host "Watching $LogPath"
Write-Host "Matching LC2 events: $($patterns -join ', ')"

Get-Content -Path $LogPath -Tail $Tail -Wait | ForEach-Object {
  $line = $_

  # Keep this watcher scoped to LC2 so DOGE2 activity does not trigger alerts.
  if ($line -notmatch '"symbol":"LC2"') {
    return
  }

  foreach ($p in $patterns) {
    if ($line -match [regex]::Escape($p)) {
      Write-AlertLine $line
      break
    }
  }
}
