[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$CoreOnly,
  [switch]$IncludeSkill,
  [switch]$NoBrowser
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$cliArgs = @()
if ($SkipBuild) { $cliArgs += "--skip-build" }
if ($CoreOnly) { $cliArgs += "--core-only" }
if ($IncludeSkill) { $cliArgs += "--include-skill" }
if ($NoBrowser) { $cliArgs += "--no-browser" }
Push-Location $repo
try {
  & corepack pnpm dev:up @cliArgs
  if ($LASTEXITCODE -ne 0) { throw "开发环境启动失败，退出码：$LASTEXITCODE" }
} finally { Pop-Location }
