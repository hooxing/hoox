# CubeSandbox Agent Runtime

这是多租户 Agent Runtime 的 TypeScript Monorepo。旧 Python 原型仅作为行为参考，不是本仓库的运行时依赖，也不做数据兼容。

## 当前状态

仓库已实现并测试 Tenant、Thread、Run、Workspace、Resource、Artifact 等领域边界，以及 PostgreSQL 持久化与 RLS、HTTP API 协议、Run/Worker 状态机、CubeSandbox 适配、MinIO 对象存储和进程生命周期等能力。实现仍处于开发阶段：API 与 Agent Worker 已提供只面向本地 development 的真实 PostgreSQL、真实模型、真实 CubeSandbox 常驻装配，但固定开发身份不属于生产认证，因此不能把开发服务当作产品服务。

当前最有价值的运行方式是执行工程 Gate、真实 CubeSandbox 冒烟和 PostgreSQL M4 黑盒测试，并通过 CubeSandbox、MinIO 自带的控制台观察外部资源。

迁移完成后，用显式且可重复执行的命令初始化 `.env` 中两个开发身份，再启动开发 API：

```powershell
corepack pnpm dev:identity:provision
corepack pnpm dev:api
Invoke-RestMethod "http://$($env:API_LISTEN_HOST):$($env:API_LISTEN_PORT)/live"
Invoke-RestMethod "http://$($env:API_LISTEN_HOST):$($env:API_LISTEN_PORT)/ready"
```

`dev:identity:provision` 仅允许 `RUNTIME_ENV=development` 且 `DEV_AUTH_ENABLED=true`，通过 Runtime 数据库角色、正式 Tenant Repository、事务和 RLS 创建两个个人 Tenant 及 owner Membership；A/B 必须同时使用不同 User 和不同 Tenant，重复执行会验证并保留完全匹配的聚合，发现占用或关系冲突会失败关闭。`THREAD_CURSOR_SIGNING_KEYS` 格式为逗号分隔的 `kid:base64url-key`，每个 key 解码后必须为 32 到 64 字节。开发凭据只接受 `Bearer dev-user-a` 和 `Bearer dev-user-b`；它们是本机 fixture 选择器，不是认证方案，因此 API 只允许监听字面回环地址 `127.0.0.1`、`::1` 或 `localhost`，其中 `localhost` 会直接规范化为 `127.0.0.1`，不会经过 DNS 或接受其他 hostname。服务不会在启动时偷偷创建 Tenant 或 Membership，缺少开发身份数据时业务请求会返回 404。

## 开发 Agent Worker

完成数据库迁移和开发身份初始化后，在另一个 PowerShell 启动真实 Worker：

```powershell
corepack pnpm dev:worker:check
corepack pnpm dev:worker
```

两条命令都只接受 `RUNTIME_ENV=development`。前者会依次只读探测真实 PostgreSQL、MinIO、CubeSandbox 与
模型 Provider 后退出，不会启动 polling 或领取 Run；后者使用同一装配持续轮询 PostgreSQL dispatch。它不会使用内存队列、
Fake Sandbox 或 Faux Provider。`AGENT_WORKER_TENANT_ID` 必须等于
`DEV_AUTH_USER_A_TENANT_ID`，因此用 `Bearer dev-user-a` 创建的 Thread/Run 会被同一 Worker 消费。

模型 Provider 必须兼容 OpenAI `/models`。开发模式强制从
`MODEL_CONTEXT_WINDOW` 和 `MODEL_MAX_OUTPUT_TOKENS` 读取 Pi 的预算，并只要求 `/models` 返回配置的
`MODEL_ID`；不要把预算值猜测为 Provider 元数据。生产模式保持更严格的预算元数据匹配策略，且本仓库
不提供生产 Worker 入口。

当前 Workspace revision 发布尚未接通。为了不把 Sandbox 文件伪装为已保存的成果，纯聊天提示可以正常
结束；任何让模型写入非空 `/workspace` 的 Run 都会失败关闭并进入恢复路径。Artifact 发布也尚未可用，
因此 Web 体验请使用不要求写工作区或下载 Artifact 的纯聊天提示。

## 开发基线

- Node.js 24.18.0 LTS
- pnpm 10.15.1
- TypeScript 5.9.3
- PostgreSQL 17（复用本机已有实例中的专用数据库）
- MinIO（由 `docker-compose.dev.yml` 管理）
- CubeSandbox（通过官方 Node SDK 接入）

## Windows PowerShell 启动与检查

以下命令均在仓库根目录执行。先从 `.env.example` 创建只保存在本机的 `.env`，再填写自己的 PostgreSQL 角色、CubeSandbox 模板及其他配置；不要把真实凭据提交到 Git。

```powershell
Copy-Item .env.example .env
# 使用本地编辑器填写 .env

# 将 .env 注入当前 PowerShell，供后续真实冒烟和集成测试使用。
Get-Content .env | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
  $name, $value = $_.Split('=', 2)
  Set-Item -Path "Env:$name" -Value $value
}

corepack pnpm install --frozen-lockfile
docker compose -f docker-compose.dev.yml --env-file .env up -d
docker compose -f docker-compose.dev.yml --env-file .env ps
```

检查 PostgreSQL TCP 端点、MinIO 和 CubeSandbox API。端口和 URL 均读取当前 `.env`，不需要把值写进命令：

```powershell
$database = [Uri]$env:DATABASE_URL
Test-NetConnection -ComputerName $database.Host -Port $database.Port
Invoke-WebRequest -UseBasicParsing "$($env:S3_ENDPOINT)/minio/health/live"
Invoke-RestMethod "$($env:CUBESANDBOX_API_URL.TrimEnd('/'))/health"
```

对已经按 [`docs/development.md`](docs/development.md) 完成角色与 Schema bootstrap 的专用数据库执行迁移，然后构建并运行从无 `dist` 开始的完整工程 Gate：

```powershell
corepack pnpm db:migrate:up
corepack pnpm dev:identity:provision
corepack pnpm build
corepack pnpm check:clean-workspace
```

真实 CubeSandbox 冒烟默认关闭，必须显式开启；它会创建 Sandbox，检查命令、代码、文件和暂停恢复，并在 `finally` 中清理所创建的 Sandbox：

```powershell
$env:REAL_CUBE_SMOKE = "1"
corepack pnpm test:cube:real
Remove-Item Env:REAL_CUBE_SMOKE
```

M4 PostgreSQL 黑盒会使用 `.env` 中的数据库管理连接创建、迁移和清理隔离的测试角色与 Schema；只应对专用开发数据库执行：

```powershell
$env:RUN_PG_RUN_WORKER_INTEGRATION = "true"
corepack pnpm test:integration:m4
Remove-Item Env:RUN_PG_RUN_WORKER_INTEGRATION
```

Pi + Cube 的真实纵向冒烟同样默认关闭。它可以从 Windows Worker 连接 Linux CubeSandbox；这里的“真实”是指连接真实 CubeSandbox 的纵向链路，模型侧使用 Pi Faux Provider，不调用外部模型，也不需要真实模型凭据：

```powershell
$env:REAL_PI_CUBE_SMOKE = "1"
corepack pnpm test:pi-cube:real
Remove-Item Env:REAL_PI_CUBE_SMOKE
```

完成观察后停止本仓库管理的 MinIO：

```powershell
docker compose -f docker-compose.dev.yml --env-file .env down
```

不要使用 `down -v`，除非明确需要删除 MinIO 开发数据。CubeSandbox 和 PostgreSQL 不由该 Compose 文件管理，应按各自部署方式停止。

## 可查看的入口

- CubeSandbox Web 控制台：`.env` 中的 `CUBESANDBOX_WEB_URL`
- CubeSandbox API 健康端点：`CUBESANDBOX_API_URL` 后加 `/health`
- MinIO Console：`http://127.0.0.1:<MINIO_CONSOLE_HOST_PORT>`
- MinIO S3 API：`.env` 中的 `S3_ENDPOINT`（宿主端口由 `MINIO_HOST_PORT` 指定）

这些入口只用于查看 CubeSandbox 与对象存储状态，并不是本项目的产品 Web UI。

## 文档与目录边界

- [开发指南](docs/development.md)
- [实施路线与阶段 Gate](docs/roadmap.md)
- [架构决策索引与记录规则](docs/decisions/README.md)
- [Python 原型参考行为清单](docs/python-prototype-reference.md)

`runtime-ts/apps` 保存可部署进程入口，`runtime-ts/packages` 保存运行时模块，`runtime-ts/vendor` 只保存经过版本固定和许可证审查的第三方源码。CubeSandbox SDK 的固定来源见 [`runtime-ts/vendor/cubesandbox-sdk/SOURCE.md`](runtime-ts/vendor/cubesandbox-sdk/SOURCE.md)。
