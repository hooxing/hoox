# 命令参考

所有命令默认在仓库根目录执行。使用 `corepack pnpm` 可以确保采用 `package.json` 固定的 pnpm 版本。

## 安装与构建

| 命令 | 用途 |
| --- | --- |
| `corepack pnpm install --frozen-lockfile` | 按锁文件安装依赖，不允许隐式更新 |
| `corepack pnpm build` | 按 Workspace 拓扑构建所有支持构建的包 |
| `corepack pnpm clean` | 清理 TypeScript 构建状态 |
| `corepack pnpm format` | 使用 Biome 写入格式修复 |
| `corepack pnpm format:check` | 只检查格式 |
| `corepack pnpm lint` | 执行 Biome lint |
| `corepack pnpm typecheck` | 构建并执行根与各包类型检查 |

## 测试与工程 Gate

| 命令 | 访问外部服务 | 适用场景 |
| --- | --- | --- |
| `corepack pnpm test` | 否 | 构建并运行普通 Vitest 测试 |
| `corepack pnpm check` | Compose 配置解析 | 格式、lint、类型、测试、构建和 development 配置检查 |
| `corepack pnpm check:clean-workspace` | Compose 配置解析 | 从无 `dist` 状态执行完整工程 Gate |
| `corepack pnpm test:process-runtime` | 否 | API、Worker、Scheduler、Skill Admin 的进程生命周期 |
| `corepack pnpm test:process:container` | Docker | Linux 最小容器进程 Gate |
| `corepack pnpm test:pi-prompt:container` | Docker | Pi Prompt 与能力清单容器 Gate |

日常小改动执行受影响包测试、`format:check`、`lint` 和类型检查即可；跨 Workspace 依赖、构建、发布或无法确定影响范围时执行完整 Gate。

## 配置

| 命令 | 用途 |
| --- | --- |
| `corepack pnpm config:check` | 校验 `.env.example` 与 development Compose 契约 |
| `corepack pnpm config:check:production` | 校验 production 环境变量示例与契约 |

校验器只允许输出变量名和稳定错误分类，不能输出真实值。

## 数据库

| 命令 | 用途 |
| --- | --- |
| `corepack pnpm db:migrate:up` | 执行向前迁移 |
| `corepack pnpm db:migrate:down` | 显式允许破坏性回退；只用于受控环境 |
| `corepack pnpm dev:identity:provision` | 幂等初始化两个 development 身份及个人 Tenant |
| `corepack pnpm thread:legacy-anchor` | 执行历史 Thread anchor 维护入口 |

数据库角色 bootstrap 见[开发指南](../development.md)。不要对共享或生产数据库执行 development 黑盒和破坏性 down。

## 启动 Development

| 命令 | 进程 |
| --- | --- |
| `corepack pnpm dev:api` | API，默认 `127.0.0.1:3001` |
| `corepack pnpm dev:worker:check` | 只读探测 PostgreSQL、S3、Sandbox 和模型后退出 |
| `corepack pnpm dev:worker` | Agent Worker |
| `corepack pnpm dev:scheduler` | Scheduler |
| `corepack pnpm dev:web` | 用户 Web，`127.0.0.1:4173` |
| `corepack pnpm dev:skill-admin:api` | Skill Admin API，默认 `127.0.0.1:3002` |
| `corepack pnpm dev:skill-admin:web` | Skill Admin Web，`127.0.0.1:4174` |
| `corepack pnpm dev:trajectory` | 内部轨迹查看器 |

Windows 已完成首次配置后推荐使用：

```powershell
.\scripts\start-development.ps1 -CoreOnly
```

可选参数：

- `-IncludeSkill`：同时启动 Skill Admin API 和 Web。
- `-SkipBuild`：跳过工作区构建，只适用于已有最新 `dist`。
- `-NoBrowser`：服务就绪后不打开浏览器。

脚本不会启动或修改 PostgreSQL、CubeSandbox、模型服务和代理，只会复用健康进程并为缺失的应用打开 PowerShell 窗口。

## 真实集成与冒烟

这些命令可能创建外部资源。CubeSandbox、Pi+Cube 和 PostgreSQL 黑盒要求显式开关；E2B 冒烟以显式配置真实 E2B 凭据作为启用条件。

### CubeSandbox 生命周期

```powershell
$env:REAL_CUBE_SMOKE = "1"
corepack pnpm test:cube:real
Remove-Item Env:REAL_CUBE_SMOKE
```

### E2B 生命周期

```powershell
corepack pnpm test:e2b:real
```

该命令直接读取 `.env` 或进程环境中的 `E2B_API_KEY`、`E2B_DOMAIN` 和 `E2B_TEMPLATE_ID`，会创建真实 Sandbox 并在 `finally` 中清理。不要在命令参数或日志中输出凭据。

### Pi 与 CubeSandbox 纵向链路

```powershell
$env:REAL_PI_CUBE_SMOKE = "1"
corepack pnpm test:pi-cube:real
Remove-Item Env:REAL_PI_CUBE_SMOKE
```

该 Gate 使用真实 Sandbox，但模型侧使用 Faux Provider，不需要外部模型凭据。

### PostgreSQL M4 黑盒

```powershell
$env:RUN_PG_RUN_WORKER_INTEGRATION = "true"
corepack pnpm test:integration:m4
Remove-Item Env:RUN_PG_RUN_WORKER_INTEGRATION
```

该命令会使用管理连接创建、迁移和清理隔离角色与 Schema，只能指向专用测试数据库。

### MinIO 集成

```powershell
$env:RUN_MINIO_INTEGRATION = "true"
node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run runtime-ts/packages/persistence/src/s3-minio.integration.test.ts
Remove-Item Env:RUN_MINIO_INTEGRATION
```

## Skill 开发

| 命令 | 用途 |
| --- | --- |
| `corepack pnpm dev:skill:publish:pptx` | 发布固定的 development PPTX fixture，不得进入生产目录 |
| `corepack pnpm dev:skill:publish:csv-pdf` | 发布仓库维护的 CSV-to-PDF Skill |

## 评测

```powershell
corepack pnpm eval:gaia:native -- --limit 3
```

该入口输出未评分的 Runtime 能力证据，不包含 GAIA 标准答案，也不是官方分数。见[GAIA 说明](../verification/gaia-native-evaluation.md)。

## 供应链与 Production Gate

```powershell
corepack pnpm supply-chain:check
corepack pnpm license:check
corepack pnpm release:check
corepack pnpm test:production-api:container
corepack pnpm test:production-scheduler:container
corepack pnpm test:production-worker:container
```

`corepack pnpm check:production` 串联上述 production 配置、供应链、发布契约和三个容器 Gate。这些命令需要 Docker，但仍不能替代真实基础设施 readiness。见[生产就绪说明](../operations/production-readiness.md)。
