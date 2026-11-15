[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$CoreOnly,
  [switch]$IncludeSkill,
  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $repo ".env"
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

function Test-HttpEndpoint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Test-DevelopmentProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Pattern
  )

  try {
    return $null -ne (Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object { $_.CommandLine -match $Pattern } |
      Select-Object -First 1)
  } catch {
    Write-Host "[警告] 无法检查已有进程，将按未启动处理：$($_.Exception.Message)" -ForegroundColor Yellow
    return $false
  }
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
foreach ($commandName in @("node", "corepack")) {
  if ($null -eq (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "未找到必需命令：$commandName"
  }
}

Set-Location -LiteralPath $repo
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null

$apiHost = Get-DotEnvValue -Name "API_LISTEN_HOST" -DefaultValue "127.0.0.1"
$apiPortText = Get-DotEnvValue -Name "API_LISTEN_PORT" -DefaultValue "3001"
$adminControlHost = Get-DotEnvValue -Name "ADMIN_CONTROL_LISTEN_HOST" -DefaultValue "127.0.0.1"
$adminControlPortText = Get-DotEnvValue -Name "ADMIN_CONTROL_LISTEN_PORT" -DefaultValue "3003"
$apiPort = 0
$adminControlPort = 0
if (-not [int]::TryParse($apiPortText, [ref]$apiPort) -or $apiPort -lt 1 -or $apiPort -gt 65535) {
  throw "API_LISTEN_PORT 不是有效端口"
}
if (-not [int]::TryParse($adminControlPortText, [ref]$adminControlPort) -or $adminControlPort -lt 1 -or $adminControlPort -gt 65535) {
  throw "ADMIN_CONTROL_LISTEN_PORT 不是有效端口"
}

$healthApiHost = if ($apiHost -in @("localhost", "::1")) { "127.0.0.1" } else { $apiHost }
$healthAdminControlHost = if ($adminControlHost -in @("localhost", "::1")) { "127.0.0.1" } else { $adminControlHost }
$apiBaseUrl = "http://${healthApiHost}:$apiPort"
$adminControlBaseUrl = "http://${healthAdminControlHost}:$adminControlPort"
if (-not $SkipBuild) {
  Write-Host "[1/5] 构建工作区" -ForegroundColor Cyan
  Invoke-CheckedNative { corepack pnpm build } "工作区构建失败"
} else {
  Write-Host "[1/5] 已跳过构建" -ForegroundColor Yellow
}

Write-Host "[2/5] 检查 .env 配置的 PostgreSQL、S3、CubeSandbox 与模型服务" -ForegroundColor Cyan
Invoke-CheckedNative {
  node runtime-ts/apps/agent-worker/dist/development-preflight-main.js
} ".env 外部服务预检失败，请检查 PostgreSQL、S3、CubeSandbox 与模型配置"

if ($CoreOnly -and $IncludeSkill) {
  throw "-CoreOnly 与 -IncludeSkill 不能同时使用"
}

Write-Host "[3/5] 选择启动范围" -ForegroundColor Cyan
if ($IncludeSkill) {
  $startSkillServices = $true
} elseif ($CoreOnly) {
  $startSkillServices = $false
} else {
  $startSkillServices = $true
}
if ($startSkillServices) {
  Write-Host "[包含] 将启动平台管理服务" -ForegroundColor Green
} else {
  Write-Host "[跳过] 按 -CoreOnly 省略平台管理服务" -ForegroundColor Yellow
}

$apiEntry = (Join-Path $repo "runtime-ts\apps\api\dist\development-main.js").Replace("'", "''")
$workerEntry = (Join-Path $repo "runtime-ts\apps\agent-worker\dist\development-main.js").Replace("'", "''")
$schedulerEntry = (Join-Path $repo "runtime-ts\apps\scheduler\dist\development-main.js").Replace("'", "''")
$adminControlEntry = (Join-Path $repo "runtime-ts\apps\admin-control-api\dist\development-main.js").Replace("'", "''")
$services = @(
  [pscustomobject]@{
    Name = "API"
    Command = "& node '$apiEntry'"
    HealthUrl = "$apiBaseUrl/live"
    Port = $apiPort
    ProcessPattern = "(@hoox[\\/]api|apps[\\/]+api|dev:api)"
  },
  [pscustomobject]@{
    Name = "Agent Worker"
    Command = "& node '$workerEntry'"
    HealthUrl = $null
    Port = $null
    ProcessPattern = "(@hoox[\\/]agent-worker|apps[\\/]+agent-worker|dev:worker)"
  },
  [pscustomobject]@{
    Name = "Scheduler"
    Command = "& node '$schedulerEntry'"
    HealthUrl = $null
    Port = $null
    ProcessPattern = "(@hoox[\\/]scheduler|apps[\\/]+scheduler|dev:scheduler)"
  },
  [pscustomobject]@{
    Name = "Web"
    Command = "corepack pnpm --filter `"@hoox/web`" dev"
    HealthUrl = "http://127.0.0.1:4173"
    Port = 4173
    ProcessPattern = "(@hoox[\\/]web|apps[\\/]+web|dev:web|vite(?:\\.js)?[^\\r\\n]*--port\\s+4173)"
  }
)
if ($startSkillServices) {
  $services += @(
    [pscustomobject]@{
      Name = "Admin API"
      Command = "& node '$adminControlEntry'"
      HealthUrl = "$adminControlBaseUrl/live"
      Port = $adminControlPort
      ProcessPattern = "(@hoox[\\/]admin-control-api|apps[\\/]+admin-control-api|dev:admin-control:api)"
    },
    [pscustomobject]@{
      Name = "Admin Web"
      Command = "corepack pnpm --filter `"@hoox/admin-web`" dev"
      HealthUrl = "http://127.0.0.1:4174/admin/"
      Port = 4174
      ProcessPattern = "(@hoox[\\/]admin-web|apps[\\/]+admin-web|dev:admin:web|vite(?:\\.js)?[^\\r\\n]*--port\\s+4174)"
    }
  )
}

$servicesToStart = @()
$reusedServices = @()
foreach ($service in $services) {
  $isRunning = $false
  if ($null -ne $service.HealthUrl) {
    $isRunning = Test-HttpEndpoint -Url $service.HealthUrl
  }

  $processExists = Test-DevelopmentProcess -Pattern $service.ProcessPattern
  if (-not $isRunning -and $processExists -and $null -ne $service.HealthUrl) {
    Write-Host "[等待] $($service.Name) 进程已存在，等待端点就绪" -ForegroundColor Yellow
    $isRunning = Wait-HttpEndpoint -Name $service.Name -Url $service.HealthUrl -TimeoutSeconds 15
    if (-not $isRunning) {
      throw "$($service.Name) 进程已存在，但健康端点未就绪。请先检查已有进程窗口。"
    }
  } elseif (-not $isRunning -and $processExists) {
    $isRunning = $true
  }

  if ($isRunning) {
    Write-Host "[复用] $($service.Name) 已运行" -ForegroundColor Green
    $reusedServices += $service.Name
    continue
  }

  if ($null -ne $service.Port) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $service.Port -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -ne $listener) {
      throw "$($service.Name) 需要的端口 $($service.Port) 已被 PID $($listener.OwningProcess) 占用，但对应健康端点不可用。脚本不会自动终止已有进程。"
    }
  }

  $servicesToStart += $service
}

Write-Host "[4/5] 启动缺失的开发进程" -ForegroundColor Cyan
$powerShellExecutable = Get-PowerShellExecutable
$startedProcesses = [ordered]@{}
$escapedRepo = $repo.Replace("'", "''")
foreach ($service in $servicesToStart) {
  $escapedTitle = $service.Name.Replace("'", "''")
  $windowLines = @(
    "Set-Location -LiteralPath '$escapedRepo'",
    "`$Host.UI.RawUI.WindowTitle = 'Hoox - $escapedTitle'",
    $service.Command,
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
  $startedProcesses[$service.Name] = $process.Id
}
[ordered]@{
  launched = $startedProcesses
  reused = $reusedServices
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $runtimeDirectory "pids.json") -Encoding utf8

Write-Host "[5/5] 等待 HTTP 服务就绪" -ForegroundColor Cyan
$allReady = $true
foreach ($service in $services | Where-Object { $null -ne $_.HealthUrl }) {
  if (-not (Wait-HttpEndpoint -Name $service.Name -Url $service.HealthUrl)) {
    $allReady = $false
  }
}
if (-not $allReady) {
  throw "至少一个开发服务未在超时时间内就绪，请查看对应进程窗口。"
}

if (-not $NoBrowser) {
  Start-Process "http://127.0.0.1:4173/app"
  if ($startSkillServices) {
    Start-Process "http://127.0.0.1:4173/admin/"
  }
}

Write-Host "开发环境已全部启动。" -ForegroundColor Green
Write-Host "主工作台：http://127.0.0.1:4173/app"
Write-Host "API：$apiBaseUrl"
if ($startSkillServices) {
  Write-Host "Admin Web：http://127.0.0.1:4173/admin/"
}
Write-Host "启动状态：$(Join-Path $runtimeDirectory 'pids.json')"
