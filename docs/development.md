# 开发指南

本页提供从克隆仓库到启动本地工作台的主路径。架构和实现不变量见[架构总览](architecture/overview.md)与[维护者开发边界](maintainers/runtime-development-boundaries.md)。

## 前置环境

- Windows PowerShell 5.1 或 PowerShell 7；一键启动脚本当前依赖 Windows 进程与端口能力。
- Node.js `24.18.0`。
- Corepack 与 pnpm `10.15.1`。
- Docker Compose v2，用于 MinIO 和容器 Gate。
- 专用 PostgreSQL 17 数据库。
- 执行任务前需要可用 Sandbox Provider：CubeSandbox、E2B 或腾讯云 AGS，可在启动后的后台接入。
- 可选的线上 OpenAI-compatible 模型；可在首次运行页面之后配置，不要求本地模型。

`package.json#engines.node` 是 Node.js 运行时版本契约，`.node-version`、`.nvmrc`、CI 和 Docker 镜像必须与其一致；CI 直接读取 `.node-version`。`@types/node` 使用 npm 已发布的相同主版本，并与其他依赖一样精确固定。执行 `corepack pnpm toolchain:check` 可检查这些约束。

## 1. 获取依赖

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
```

如果 Corepack 或 Node 版本不匹配，先修正工具链，不要用全局浮动版本覆盖仓库声明。

## 2. 创建本地配置

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少准备以下类别：

- PostgreSQL Runtime、Migrator、Worker Coordinator、Team Coordinator、Admin Control 和 Skill Publisher 连接；
- MinIO/S3；
- 稳定的 `MODEL_CREDENTIAL_ENCRYPTION_KEY`；模型 endpoint、API Key、模型 ID 与能力可留到后台配置；
- development 身份、签名密钥和 Tenant ID；
- API、Worker 与 Scheduler 的本地监听及轮询参数。

模型、沙箱、记忆和标题策略在启动后的后台配置，无需在 `.env` 中预填供应商密钥。完整分组见[配置参考](reference/configuration.md)。`.env` 被 Git 忽略，不得提交、截图或粘贴到公开 Issue。

### PostgreSQL bootstrap 与迁移

业务迁移不能创建集群级登录角色。首次准备专用数据库时，由 Database Admin：

1. 创建互不相同且没有角色成员关系的 Migrator、Runtime、Skill Publisher、Admin Control、Worker Coordinator 和 Team Coordinator 登录角色；
2. 撤销目标数据库对 `PUBLIC` 和应用角色的默认权限，只按需授予 `CONNECT`；
3. 创建专用业务 Schema，并只让 Migrator 成为 Schema owner；
4. 确认其他常驻角色不是数据库、Schema、表、序列或 routine owner；
5. 将连接和角色名写入本机 `.env`。

完成一次性数据库与 Schema 准备后，日常拉取包含新增应用角色的代码时运行：

```powershell
pnpm db:setup
```

该命令让仓库根 `.env` 覆盖长驻终端中的旧数据库变量，先通过 `DATABASE_BOOTSTRAP_URL` 补齐当前数据库缺少的应用登录角色，再对同一数据库执行迁移。补齐过程可重复执行，不修改已存在角色的密码或属性；如果角色被同一 PostgreSQL 集群中的其他数据库依赖，会在任何角色创建和迁移 DDL 前失败并报告具体角色与数据库。只需检查角色状态时可单独运行 `pnpm db:roles:bootstrap`。

精确权限、不变量和迁移器校验见[维护者开发边界](maintainers/runtime-development-boundaries.md#postgresql-角色-bootstrap)。数据库角色属于整个 PostgreSQL 集群，同一集群的开发、预览和生产数据库应使用不同角色集合。

## 3. 启动本地对象存储

```powershell
docker compose -f docker-compose.dev.yml --env-file .env up -d
docker compose -f docker-compose.dev.yml --env-file .env ps
```

Compose 只管理 MinIO，不启动 PostgreSQL、CubeSandbox、E2B 或模型服务。

默认入口：

- S3 API：`http://127.0.0.1:19000`
- MinIO Console：`http://127.0.0.1:19001`

实际端口以 `.env` 为准。

## 4. 检查外部服务

将 `.env` 加载到当前 PowerShell，供显式冒烟和集成测试使用：

```powershell
Get-Content .env | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
  $name, $value = $_.Split('=', 2)
  Set-Item -Path "Env:$name" -Value $value
}
```

检查基础端点：

```powershell
$database = [Uri]$env:DATABASE_URL
Test-NetConnection -ComputerName $database.Host -Port $database.Port
Invoke-WebRequest -UseBasicParsing "$($env:S3_ENDPOINT)/minio/health/live"
if ($env:CUBESANDBOX_API_URL) {
  Invoke-RestMethod "$($env:CUBESANDBOX_API_URL.TrimEnd('/'))/health"
}
```

如果默认 Provider 为 E2B，则按 E2B 配置和真实冒烟验证，不执行 CubeSandbox 健康请求。

## 5. 执行数据库迁移

```powershell
corepack pnpm db:migrate:up
```

默认关闭固定开发身份，首次管理员在启动后的页面显式创建。需要隔离测试身份时，才启用 `DEV_AUTH_ENABLED=true` 并执行 `corepack pnpm dev:identity:provision`；该命令幂等，已存在数据必须与配置的 User、个人 Tenant 和 owner Membership 完全匹配，否则失败关闭。

## 6. 执行 Worker 预检

```powershell
corepack pnpm dev:worker:check
```

预检只读访问真实 PostgreSQL、S3，并在沙箱已配置时检查 Sandbox；有模型配置时额外发送受限 `chat/completions` 请求，无模型时跳过模型探测。不启动 polling，也不领取 Run。基础依赖和角色配置错误会阻止启动。

## 7. 启动工作台

推荐启动包含管理面的完整拓扑：

```powershell
.\scripts\start-development.ps1
```

默认拓扑包含 Admin API、Admin Web，以及：

- API；
- Agent Worker；
- Scheduler；
- Web。

Scheduler 是完整开发拓扑的必需进程，负责 Sandbox cleanup、生命周期 effect、定时任务和可选标题生成。只启动 API、Web 与 Worker 会留下未消费的后台工作。

首次启动后访问 `http://127.0.0.1:4173/admin/`，创建管理员邮箱和密码，再在模型页面填写线上模型地址、API Key 和模型，选择“保存并使用”。Worker 无模型时保持运行且不领取任务，配置后自动恢复；无需重新启动。账号和模型保存在数据库中，后续启动显示登录页面。不要删除安装状态来重跑向导。

生产或非直接回环安装必须设置至少 32 字节的 `INSTALLATION_SETUP_TOKEN`，并在页面输入令牌；生产基础秘密与反向代理仍须按部署规范准备。

`-IncludeSkill` 保留为兼容参数；已经完成配置且不需要管理面时可使用：

```powershell
.\scripts\start-development.ps1 -CoreOnly
```

macOS/Linux 可分别运行 `pnpm dev:api`、`pnpm dev:admin-control:api`、`pnpm dev:scheduler`、`pnpm dev:worker`、`pnpm dev:web` 和 `pnpm dev:admin:web`；统一从 `http://127.0.0.1:4173/admin/` 进入首次配置。

其他参数：

```powershell
.\scripts\start-development.ps1 -SkipBuild
.\scripts\start-development.ps1 -NoBrowser
```

脚本会复用已经健康的服务，只为缺失应用打开新的 PowerShell 窗口；不会启动或修改外部 PostgreSQL、Sandbox、模型和代理。

## 本地入口

| 服务 | 默认地址 |
| --- | --- |
| 用户工作台 | `http://127.0.0.1:4173/app` |
| API live | `http://127.0.0.1:3001/live` |
| API ready | `http://127.0.0.1:3001/ready` |
| Admin Web | `http://127.0.0.1:4173/admin/` |
| Admin API live | `http://127.0.0.1:3003/live` |
| Admin API ready | `http://127.0.0.1:3003/ready` |
| Trajectory Viewer | `http://127.0.0.1:4188` |

监听端口可由 `.env` 或命令参数覆盖。development 服务应保持回环监听。

## 手动启动

需要独立观察日志时，在不同终端运行：

```powershell
corepack pnpm dev:api
corepack pnpm dev:worker
corepack pnpm dev:scheduler
corepack pnpm dev:web
corepack pnpm dev:admin-control:api
corepack pnpm dev:admin:web
```

统一 Admin API 在同一个 3003 listener 提供模型、记忆、配置、统计与 Skill 管理路由，共用管理身份，但在进程内继续使用 Admin Control 和 Skill Publisher 两套数据库连接；Skill 发布对象存储也保持独立凭据。详细边界见[维护者开发边界](maintainers/runtime-development-boundaries.md#管理员-skill-上架)与[统一后台 API 决策](decisions/20260821115221-unified-admin-api-process.md)。轨迹查看命令见[命令参考](reference/commands.md)。

## 提交前验证

文档改动至少执行：

```powershell
corepack pnpm format:check
corepack pnpm lint
```

代码或行为改动按范围增加类型检查和测试。跨工作区依赖、构建、发布或影响不明确时执行：

```powershell
corepack pnpm check:clean-workspace
```

真实外部服务和 production 容器 Gate 不会由普通单元测试静默执行，具体入口见[命令参考](reference/commands.md)。

## 停止本地 MinIO

```powershell
docker compose -f docker-compose.dev.yml --env-file .env down
```

除非明确需要删除开发数据，否则不要使用 `down -v`。PostgreSQL、Sandbox 和模型不由该 Compose 管理，应按各自部署方式停止。

## 常见问题

### 一键启动提示缺少 `.env`

一键脚本只服务于已经完成首次配置的环境。先复制 `.env.example` 并完成迁移、身份初始化和 Worker 预检。

### API live 正常但 ready 失败

`/live` 只表示进程存在；`/ready` 会探测当前装配声明的数据库角色和外部依赖。查看对应进程日志，但不要输出连接串和密钥。

### Web 可以打开但 Run 不执行

确认 Agent Worker 和 Scheduler 都已运行，`dev:worker:check` 通过，Worker Coordinator 使用独立角色，并且后台已保存启用模型（或配置完整的部署回退模型）。

### Sandbox 无法访问 `/resources`

CubeSandbox 0.6+ 需要在 Cubelet 节点安装 `runtime-resourcefs` Volume driver，并通过受控 HTTPS ResourceFS 数据面访问 API。见 [`deploy/cube-resource-volume/README.md`](../deploy/cube-resource-volume/README.md) 和[维护者开发边界](maintainers/runtime-development-boundaries.md)。
