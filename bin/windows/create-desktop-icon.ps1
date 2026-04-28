# Creates a Windows Desktop shortcut that launches the full stack via start-miner-stack.ps1

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$launcherPath = Join-Path $projectRoot "bin\windows\start-miner-stack.ps1"

if (-not (Test-Path $launcherPath)) {
    throw "start-miner-stack.ps1 not found at: $launcherPath"
}

$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "LC2 DOGE2 Solo Miner.lnk"

$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherPath`" -OpenDashboard -OpenInfoFile"
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,238"
$shortcut.Description = "One-click start for LC2/DOGE2 solo miner stack"
$shortcut.Save()

Write-Host "Desktop shortcut created: $shortcutPath"
