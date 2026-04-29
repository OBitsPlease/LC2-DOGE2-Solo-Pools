$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $ProjectRoot

if (-not (Test-Path (Join-Path $ProjectRoot 'dist'))) {
    New-Item -Path (Join-Path $ProjectRoot 'dist') -ItemType Directory | Out-Null
}
$distDir = Join-Path $ProjectRoot 'dist'

$pkgCmd = Get-Command npx -ErrorAction SilentlyContinue
if (-not $pkgCmd) {
    throw 'npx not found. Install Node.js 20+ first.'
}

$pkgJson = Get-Content -Raw -Path (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$appVersion = $pkgJson.version

Write-Host 'Cleaning old installer builds from dist...'
Get-ChildItem -Path $distDir -File -Filter 'LC2-DOGE2-Solo-Miner-Setup*.exe' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host 'Building Windows executable with pkg...'
& npx pkg src/index.js --target node18-win-x64 --output dist/lc2-solo-proxy-windows.exe
if ($LASTEXITCODE -ne 0) { throw 'pkg build failed.' }

$isccCandidates = New-Object System.Collections.Generic.List[string]

# Prefer PATH-discoverable compiler first (works with Chocolatey shims on CI).
foreach ($cmd in @('iscc.exe', 'iscc', 'ISCC.exe', 'ISCC')) {
    $resolved = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($resolved -and $resolved.Source) {
        $isccCandidates.Add($resolved.Source)
    }
}

# Then try common install locations.
foreach ($p in @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles(x86)\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:ChocolateyInstall\bin\iscc.exe",
    "$env:ChocolateyInstall\lib\innosetup\tools\iscc.exe",
    "C:\ProgramData\chocolatey\bin\iscc.exe",
    "C:\ProgramData\chocolatey\lib\innosetup\tools\iscc.exe"
)) {
    if ($p) { $isccCandidates.Add($p) }
}

$iscc = $isccCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) {
    throw 'Inno Setup compiler (ISCC.exe) not found. Install Inno Setup 6 first.'
}

Write-Host "Building installer (version $appVersion)..."
& $iscc "/DAppVersion=$appVersion" "installer\windows\LC2Doge2SoloMiner.iss"
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup build failed.' }

Write-Host "Installer build complete: dist\LC2-DOGE2-Solo-Miner-Setup-$appVersion.exe"
