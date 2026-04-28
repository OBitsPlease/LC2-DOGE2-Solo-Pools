$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $ProjectRoot

if (-not (Test-Path (Join-Path $ProjectRoot 'dist'))) {
    New-Item -Path (Join-Path $ProjectRoot 'dist') -ItemType Directory | Out-Null
}

$pkgCmd = Get-Command npx -ErrorAction SilentlyContinue
if (-not $pkgCmd) {
    throw 'npx not found. Install Node.js 20+ first.'
}

Write-Host 'Building Windows executable with pkg...'
& npx pkg src/index.js --target node18-win-x64 --output dist/lc2-solo-proxy-windows.exe
if ($LASTEXITCODE -ne 0) { throw 'pkg build failed.' }

$isccCandidates = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles(x86)\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
)

$iscc = $isccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    throw 'Inno Setup compiler (ISCC.exe) not found. Install Inno Setup 6 first.'
}

$pkgJson = Get-Content -Raw -Path (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
$appVersion = $pkgJson.version

Write-Host "Building installer (version $appVersion)..."
& $iscc "/DAppVersion=$appVersion" "installer\windows\LC2Doge2SoloMiner.iss"
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup build failed.' }

Write-Host 'Installer build complete: dist\LC2-DOGE2-Solo-Miner-Setup.exe'
