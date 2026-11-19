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
| `corepack pnpm toolchain:check` | 校验 Node.js、pnpm、CI 与 Dockerfile 工具链版本契约 |
| `corepack pnpm deps:check` | 校验 Workspace 依赖声明完整且符合[依赖规则](../architecture/repository-map.md#依赖规则) |

## 测试与工程 Gate

| 命令 | 访问外部服务 | 适用场景 |
| --- | --- | --- |
| `corepack pnpm test` | 否 | 构建并运行普通 Vitest 测试 |
| `corepack pnpm test:web:file-preview` | 本地 Vite 与 Chromium | 真实浏览器验证文件预览、选区和大小屏；首次运行前执行 `pnpm exec playwright install chromium --only-shell` |
| `corepack pnpm check` | Compose 配置解析 | 单次拓扑构建后复用产物执行格式、lint、补充类型检查、测试和 development 配置检查 |
| `corepack pnpm check:clean-workspace` | Compose 配置解析 | 删除全部 Workspace `dist` 后执行单次构建的完整工程 Gate |
| `corepack pnpm test:process-runtime` | 否 | API、Worker、Scheduler、统一 Admin API 的进程生命周期 |

日常小改动执行受影响包测试、`format:check`、`lint` 和类型检查即可；跨 Workspace 依赖、构建、发布或无法确定影响范围时执行完整 Gate。

## 配置

| 命令 | 用途 |
| --- | --- |
| `corepack pnpm config:check` | 校验 `.env.example` 与 development Compose 契约 |
| `corepack pnpm config:check:production` | 校验 production 环境变量示例与契约 |
| `corepack pnpm security:audit:production` | 审计生产依赖漏洞（访问 npm registry） |

校验器只允许输出变量名和稳定错误分类，不能输出真实值。

## 数据库

| 命令 | 用途 |
| --- | --- |
| `corepack pnpm db:migrate:up` | 执行向前迁移 |
| `corepack pnpm db:migrate:down` | 显式允许破坏性回退；只用于受控环境 |
| `corepack pnpm dev:identity:provision` | 幂等初始化两个 development 身份及个人 Tenant |

数据库角色 bootstrap 见[开发指南](../development.md)。不要对共享或生产数据库执行 development 黑盒和破坏性 down。

## 启动 Development

| 命令 | 进程 |
| --- | --- |
| `corepack pnpm dev:api` | API，默认 `127.0.0.1:3001` |
| `corepack pnpm dev:worker:check` | 只读探测 PostgreSQL、S3、Sandbox 和模型后退出 |
| `corepack pnpm dev:worker` | Agent Worker |
| `corepack pnpm dev:scheduler` | Scheduler |
| `corepack pnpm dev:web` | 用户 Web，`127.0.0.1:4173` |
| `corepack pnpm dev:admin-control:api` | 统一 Admin API，默认 `127.0.0.1:3003` |
| `corepack pnpm dev:admin:web` | Admin Web，`127.0.0.1:4174` |
| `corepack pnpm dev:trajectory` | 内部轨迹查看器 |

Windows 已完成首次配置后推荐使用：

```powershell
.\scripts\start-development.ps1 -CoreOnly
```

可选参数：

- `-IncludeSkill`：同时启动统一 Admin API 和 Admin Web。
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

### Pi 与 E2B 纵向链路

```powershell
corepack pnpm test:pi-e2b:real
```

该命令构建受影响工作区并读取 `.env` 或进程环境中的 E2B 配置。独立夹具按 Worker 的 E2B 基线建立普通用户拥有的 `/workspace`，再与 Pi+Cube 共用纵向断言，验证两次真实工具执行、逐调用授权、回执返回模型、文件结果和 `agent.settled`，最后销毁 Sandbox。模型侧使用 Faux Provider，不需要外部模型凭据；该 Gate 不经过 PostgreSQL 调度、S3 或本机 Docker。

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
| `corepack pnpm dev:skill:publish:csv-pdf` | 发布仓库维护的 CSV-to-PDF Skill |

## 腾讯云 AGS 真实冒烟

`pnpm test:tencent-ags:real` 从 `.env` 或进程环境读取 `TENCENT_AGS_API_KEY`、`TENCENT_AGS_DOMAIN` 和 `TENCENT_AGS_TEMPLATE_ID`，创建真实沙箱并在 finally 中清理。命令验证命令与 Python、JavaScript 执行、文件读写、状态查询、暂停与恢复、恢复后的文件保留，以及销毁后实例不存在；不打印凭据。该冒烟不代替[完整 Provider 验收](../architecture/sandbox-providers.md#接入与验收)。
