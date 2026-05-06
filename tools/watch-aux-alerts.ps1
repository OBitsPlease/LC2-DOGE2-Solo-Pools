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

  $alertFile = Join-Path (Split-Path -Parent $LogPath) 'aux-alerts.log'
  Add-Content -Path $alertFile -Value "[$stamp] $Line"

  if ($Beep) {
    try { [console]::Beep(1200, 250) } catch {}
  }

  if ($Popup) {
    try {
      Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
      [void][System.Windows.MessageBox]::Show($Line, 'LC2 DOGE2 Alert')
    } catch {}
  }
}

if (-not (Test-Path $LogPath)) {
  Write-Host "Waiting for log file: $LogPath"
  while (-not (Test-Path $LogPath)) {
    Start-Sleep -Seconds 1
  }
}

$patterns = @(
  'aux-candidate-hit',
  'aux-submit-attempt',
  'aux-submit-rejected',
  'aux-submit-accepted',
  'aux-submit-retry-attempt',
  'aux-submit-retry-accepted',
  'aux-submit-retry-rejected',
  'block-found',
  'block-rejected'
)

Write-Host "Watching $LogPath"
Write-Host "Matching events: $($patterns -join ', ')"

Get-Content -Path $LogPath -Tail $Tail -Wait | ForEach-Object {
  $line = $_
  foreach ($p in $patterns) {
    if ($line -match [regex]::Escape($p)) {
      Write-AlertLine $line
      break
    }
  }
}
