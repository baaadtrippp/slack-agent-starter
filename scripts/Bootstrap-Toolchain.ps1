$ErrorActionPreference = 'Stop'

$nodeVersion = '26.13.0'
$pnpmVersion = '12.16.1'
$gitleaksVersion = '8.30.1'
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchiveSha256 = 'dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a'
$gitleaksArchiveName = "gitleaks_$($gitleaksVersion)_windows_x64.zip"
$gitleaksArchiveSha256 = 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'
$toolchainRoot = Join-Path $env:LOCALAPPDATA 'slack-agent-starter/toolchains'
$nodeDirectory = Join-Path $toolchainRoot "node-v$nodeVersion-win-x64"
$pnpmDirectory = Join-Path $toolchainRoot "pnpm-$pnpmVersion"
$gitleaksDirectory = Join-Path $toolchainRoot "gitleaks-$gitleaksVersion"
$archivePath = Join-Path $toolchainRoot $nodeArchiveName

New-Item -ItemType Directory -Force -Path $toolchainRoot | Out-Null

if (-not (Test-Path (Join-Path $nodeDirectory 'node.exe'))) {
  Invoke-WebRequest `
    -Uri "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName" `
    -OutFile $archivePath

  $actualSha256 = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $nodeArchiveSha256) {
    throw "Node archive checksum mismatch: expected $nodeArchiveSha256, received $actualSha256"
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $toolchainRoot
  Remove-Item -LiteralPath $archivePath
}

$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
$npmCommand = Join-Path $nodeDirectory 'npm.cmd'
$pnpmCommand = Join-Path $pnpmDirectory 'pnpm.cmd'

$pnpmEntryPoint = Join-Path $pnpmDirectory 'node_modules\pnpm\bin\pnpm.cjs'
if (-not (Test-Path $pnpmCommand) -or -not (Test-Path $pnpmEntryPoint)) {
  $originalPath = $env:PATH
  try {
    $env:PATH = "$nodeDirectory;$env:PATH"
    & $npmCommand install --global --prefix $pnpmDirectory "pnpm@$pnpmVersion"
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm installation exited with code $LASTEXITCODE"
    }
  } finally {
    $env:PATH = $originalPath
  }
}

$gitleaksExecutable = Join-Path $gitleaksDirectory 'gitleaks.exe'
if (-not (Test-Path $gitleaksExecutable)) {
  $gitleaksArchivePath = Join-Path $toolchainRoot $gitleaksArchiveName
  Invoke-WebRequest `
    -Uri "https://github.com/gitleaks/gitleaks/releases/download/v$gitleaksVersion/$gitleaksArchiveName" `
    -OutFile $gitleaksArchivePath

  $actualGitleaksSha256 = (Get-FileHash -Algorithm SHA256 $gitleaksArchivePath).Hash.ToLowerInvariant()
  if ($actualGitleaksSha256 -ne $gitleaksArchiveSha256) {
    throw "Gitleaks archive checksum mismatch: expected $gitleaksArchiveSha256, received $actualGitleaksSha256"
  }

  New-Item -ItemType Directory -Force -Path $gitleaksDirectory | Out-Null
  Expand-Archive -LiteralPath $gitleaksArchivePath -DestinationPath $gitleaksDirectory
  Remove-Item -LiteralPath $gitleaksArchivePath
}

& $nodeExecutable --version
if ($LASTEXITCODE -ne 0) { throw 'Pinned Node validation failed.' }
& $nodeExecutable $pnpmEntryPoint --version
if ($LASTEXITCODE -ne 0) { throw 'Pinned pnpm validation failed.' }
& $gitleaksExecutable version
if ($LASTEXITCODE -ne 0) { throw 'Pinned Gitleaks validation failed.' }

Write-Host 'Toolchain installed without modifying the user or machine PATH.'
Write-Host 'Dot-source scripts/Use-Toolchain.ps1 in each PowerShell session.'
