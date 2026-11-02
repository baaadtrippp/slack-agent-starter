$nodeVersion = '26.13.0'
$pnpmVersion = '12.16.1'
$gitleaksVersion = '8.30.1'
$toolchainRoot = Join-Path $env:LOCALAPPDATA 'slack-agent-starter/toolchains'
$nodeDirectory = Join-Path $toolchainRoot "node-v$nodeVersion-win-x64"
$pnpmDirectory = Join-Path $toolchainRoot "pnpm-$pnpmVersion"
$gitleaksDirectory = Join-Path $toolchainRoot "gitleaks-$gitleaksVersion"
$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
$pnpmCommand = Join-Path $pnpmDirectory 'pnpm.cmd'
$gitleaksExecutable = Join-Path $gitleaksDirectory 'gitleaks.exe'

$missingTools = @(
  $nodeExecutable,
  $pnpmCommand,
  $gitleaksExecutable
) | Where-Object { -not (Test-Path -LiteralPath $_) }

if ($missingTools.Count -gt 0) {
  throw "Pinned toolchain is missing: $($missingTools -join ', '). Run scripts/Bootstrap-Toolchain.ps1 first."
}

$env:PATH = "$nodeDirectory;$pnpmDirectory;$gitleaksDirectory;$env:PATH"

node --version
pnpm --version
gitleaks version
