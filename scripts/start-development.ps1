[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$CoreOnly,
  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $repo ".env"
$composeFile = Join-Path $repo "docker-compose.dev.yml"
$runtimeDirectory = Join-Path $repo ".tmp\development-runtime"

function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command,
    [Parameter(Mandatory = $true)]
    [string]$FailureMessage
  )

  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage，退出码：$LASTEXITCODE"
  }
}

function Get-PowerShellExecutable {
  $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
  if ($null -ne $pwsh) {
    return $pwsh.Source
  }

  $windowsPowerShell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($null -ne $windowsPowerShell) {
    return $windowsPowerShell.Source
  }

  throw "未找到 pwsh.exe 或 powershell.exe"
}

function Get-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$DefaultValue
  )

  $matchedLine = Get-Content -LiteralPath $environmentFile |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=(.*)$" } |
    Select-Object -Last 1
  if ($null -eq $matchedLine) {
    return $DefaultValue
  }

  $value = $matchedLine.Split("=", 2)[1].Trim()
  if ($value.Length -ge 2) {
    $first = $value.Substring(0, 1)
    $last = $value.Substring($value.Length - 1, 1)
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
      $value = $value.Substring(1, $value.Length - 2)
    }
  }
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $DefaultValue
  }
  return $value
}

function Wait-HttpEndpoint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [int]$TimeoutSeconds = 60
  )

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        Write-Host "[就绪] $Name -> $Url" -ForegroundColor Green
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ([DateTimeOffset]::UtcNow -lt $deadline)

  Write-Host "[超时] $Name -> $Url" -ForegroundColor Red
  return $false
}

if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
  throw "缺少 $environmentFile。该脚本仅用于已经完成首次配置的开发环境。"
}
if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
  throw "缺少 $composeFile"
}

foreach ($commandName in @("node", "corepack", "docker")) {
  if ($null -eq (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "未找到必需命令：$commandName"
  }
}

Set-Location -LiteralPath $repo
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null

Write-Host "[1/5] 启动 MinIO" -ForegroundColor Cyan
Invoke-CheckedNative {
  docker compose --env-file .env -f docker-compose.dev.yml up -d
} "MinIO 启动失败"

if (-not $SkipBuild) {
  Write-Host "[2/5] 构建工作区" -ForegroundColor Cyan
  Invoke-CheckedNative { corepack pnpm build } "工作区构建失败"
} else {
  Write-Host "[2/5] 已跳过构建" -ForegroundColor Yellow
}

Write-Host "[3/5] 执行 Worker 启动前检查" -ForegroundColor Cyan
Invoke-CheckedNative {
  node runtime-ts/apps/agent-worker/dist/development-preflight-main.js
} "Worker 启动前检查失败"

$apiHost = Get-DotEnvValue -Name "API_LISTEN_HOST" -DefaultValue "127.0.0.1"
$apiPortText = Get-DotEnvValue -Name "API_LISTEN_PORT" -DefaultValue "3001"
$skillAdminHost = Get-DotEnvValue -Name "SKILL_ADMIN_LISTEN_HOST" -DefaultValue "127.0.0.1"
$skillAdminPortText = Get-DotEnvValue -Name "SKILL_ADMIN_LISTEN_PORT" -DefaultValue "3002"
$apiPort = 0
$skillAdminPort = 0
if (-not [int]::TryParse($apiPortText, [ref]$apiPort) -or $apiPort -lt 1 -or $apiPort -gt 65535) {
  throw "API_LISTEN_PORT 不是有效端口"
}
if (-not [int]::TryParse($skillAdminPortText, [ref]$skillAdminPort) -or $skillAdminPort -lt 1 -or $skillAdminPort -gt 65535) {
  throw "SKILL_ADMIN_LISTEN_PORT 不是有效端口"
}

$services = [ordered]@{
  "API" = "node runtime-ts/apps/api/dist/development-main.js"
  "Agent Worker" = "node runtime-ts/apps/agent-worker/dist/development-main.js"
  "Scheduler" = "node runtime-ts/apps/scheduler/dist/development-main.js"
  "Web" = "corepack pnpm --filter `"@cube-runtime/web`" dev"
}
if (-not $CoreOnly) {
  $services["Skill Admin API"] = "node runtime-ts/apps/skill-admin-api/dist/development-main.js"
  $services["Skill Admin Web"] = "corepack pnpm --filter `"@cube-runtime/admin-web`" dev"
}

$ports = @($apiPort, 4173)
if (-not $CoreOnly) {
  $ports += @($skillAdminPort, 4174)
}
$occupiedListeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in $ports }
if ($occupiedListeners) {
  $description = $occupiedListeners |
    Sort-Object LocalPort, OwningProcess -Unique |
    ForEach-Object { "端口 $($_.LocalPort)（PID $($_.OwningProcess)）" }
  throw "开发端口已被占用：$($description -join '、')。脚本不会自动终止已有进程。"
}

Write-Host "[4/5] 启动开发进程" -ForegroundColor Cyan
$powerShellExecutable = Get-PowerShellExecutable
$startedProcesses = [ordered]@{}
$escapedRepo = $repo.Replace("'", "''")
foreach ($entry in $services.GetEnumerator()) {
  $escapedTitle = $entry.Key.Replace("'", "''")
  $windowLines = @(
    "Set-Location -LiteralPath '$escapedRepo'",
    "`$Host.UI.RawUI.WindowTitle = 'Cube Runtime - $escapedTitle'",
    $entry.Value,
    "if (`$LASTEXITCODE -ne 0) { Write-Host '进程异常退出，退出码：'`$LASTEXITCODE -ForegroundColor Red }"
  )
  $windowCommand = $windowLines -join [Environment]::NewLine
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($windowCommand))
  $process = Start-Process `
    -FilePath $powerShellExecutable `
    -ArgumentList @("-NoLogo", "-NoExit", "-NoProfile", "-EncodedCommand", $encodedCommand) `
    -WorkingDirectory $repo `
    -WindowStyle Normal `
    -PassThru
  $startedProcesses[$entry.Key] = $process.Id
}
$startedProcesses | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDirectory "pids.json") -Encoding utf8

Write-Host "[5/5] 等待 HTTP 服务就绪" -ForegroundColor Cyan
$healthApiHost = if ($apiHost -in @("localhost", "::1")) { "127.0.0.1" } else { $apiHost }
$apiBaseUrl = "http://${healthApiHost}:$apiPort"
$healthChecks = @(
  [ordered]@{ Name = "API live"; Url = "$apiBaseUrl/live" },
  [ordered]@{ Name = "API ready"; Url = "$apiBaseUrl/ready" },
  [ordered]@{ Name = "Web"; Url = "http://127.0.0.1:4173" }
)
if (-not $CoreOnly) {
  $healthSkillAdminHost = if ($skillAdminHost -in @("localhost", "::1")) { "127.0.0.1" } else { $skillAdminHost }
  $skillAdminBaseUrl = "http://${healthSkillAdminHost}:$skillAdminPort"
  $healthChecks += @(
    [ordered]@{ Name = "Skill Admin API live"; Url = "$skillAdminBaseUrl/live" },
    [ordered]@{ Name = "Skill Admin API ready"; Url = "$skillAdminBaseUrl/ready" },
    [ordered]@{ Name = "Skill Admin Web"; Url = "http://127.0.0.1:4174" }
  )
}

$allReady = $true
foreach ($healthCheck in $healthChecks) {
  if (-not (Wait-HttpEndpoint -Name $healthCheck.Name -Url $healthCheck.Url)) {
    $allReady = $false
  }
}
if (-not $allReady) {
  throw "至少一个开发服务未在超时时间内就绪，请查看新打开的进程窗口。"
}

if (-not $NoBrowser) {
  Start-Process "http://127.0.0.1:4173"
  if (-not $CoreOnly) {
    Start-Process "http://127.0.0.1:4174"
  }
}

Write-Host "开发环境已全部启动。" -ForegroundColor Green
Write-Host "主 Web：http://127.0.0.1:4173"
Write-Host "API：$apiBaseUrl"
if (-not $CoreOnly) {
  Write-Host "Skill Admin Web：http://127.0.0.1:4174"
}
Write-Host "进程 PID：$(Join-Path $runtimeDirectory 'pids.json')"
