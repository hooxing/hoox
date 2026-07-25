# 开发指南

## 前置版本

- Node.js `24.18.0`
- pnpm `10.15.1`
- Docker Compose v2（只在校验和本地基础设施中使用）

版本同时固定在 `package.json`、`.node-version`、`.nvmrc` 和 CI 中。依赖版本必须精确锁定，不能使用 `^`、`~` 或浮动标签。

## 常用命令

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm config:check
```

`pnpm check` 按上述顺序执行完整校验。格式修复使用 `pnpm format`。配置校验只读取可提交的 `.env.example`，不会读取真实 `.env`；错误也只能输出变量名，不能输出值。

## Workspace 边界

### 可部署应用

| 路径 | 边界 |
| --- | --- |
| `runtime-ts/apps/api` | HTTP/SSE 协议适配和依赖装配 |
| `runtime-ts/apps/agent-worker` | Agent 执行循环和运行协调 |
| `runtime-ts/apps/scheduler` | 回收、清理等可重试后台工作 |
| `runtime-ts/apps/web` | 浏览器应用入口，只消费公开协议 |

### 共享包

| 包 | 唯一职责 |
| --- | --- |
| `domain` | Tenant、Thread、Run 等领域实体与不变量 |
| `protocol` | API、事件和进程间消息契约 |
| `protocol-mapper` | Domain 与 Protocol 的显式映射及公共错误归一化 |
| `persistence` | PostgreSQL 仓储、事务与迁移适配 |
| `prompt-builder` | 可审计、可复现的系统提示词组装 |
| `context-policy` | 上下文选择、截断和压缩策略 |
| `tool-router` | 工具鉴权、路由、审计和错误归一化 |
| `sandbox` | CubeSandbox 厂商 SDK 适配 |
| `workspace` | Thread 私有工作区及版本快照 |
| `resource` | 跨 Thread 资源和不可变版本 |
| `artifact` | Agent 明确发布的最终交付物 |
| `testing` | Fake、夹具和跨包测试工具，仅供测试使用 |

共享包目前只声明编译和发布边界，不包含业务实现。`pi-adapter` 由独立任务建立，但已被 Workspace 通配规则覆盖。应用将来依赖共享包时，必须通过 pnpm Workspace 依赖显式声明，不能使用跨目录相对导入。

## 配置安全

- 真实 `.env` 只保存在开发者机器并由 Git 忽略。
- 新增或删除环境变量时，必须同步修改 `.env.example` 和 `scripts/env-contract.mjs`。
- 示例中的数据库密码、访问密钥、模板 ID、模型地址和模型 ID 必须保持为明显占位值。
- CI 只使用 `.env.example` 执行静态 Compose 展开，不连接 PostgreSQL、MinIO、CubeSandbox 或模型服务。

## PostgreSQL 角色 bootstrap

业务 Schema 迁移不能替代数据库级 bootstrap。首次准备专用数据库时，由不进入应用进程的 Database Admin 完成以下一次性操作：

1. 创建无 `SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS/REPLICATION` 的 Migrator 与 Runtime 登录角色；
2. 从 `PUBLIC`、Migrator 和 Runtime 撤销目标数据库的 `CREATE`，只保留必要的 `CONNECT`；
3. 创建专用业务 Schema，并只让 Migrator 成为该 Schema owner；Database Admin 继续作为数据库 owner；
4. 确认 Runtime 不是数据库、Schema、表或序列 owner，也没有可继承或可 `SET ROLE` 到的高权限成员关系；
5. 分别写入本机忽略文件中的 `DATABASE_BOOTSTRAP_URL`、`MIGRATION_DATABASE_URL`、`DATABASE_URL` 与 `DATABASE_RUNTIME_ROLE`。Bootstrap URL 只用于本地权限集成测试或受控运维，不能进入服务进程。

`pnpm db:migrate:up` 会先验证完整 Runtime 角色闭包，再执行 Schema migration，最后单独运行可重复的最小 ACL bootstrap。`pnpm db:migrate:down` 只在 development/test 加显式破坏开关时工作，并撤销 Runtime 在当前 Schema 的动态 ACL；它不会删除角色、重新开放数据库 `CREATE` 或回滚 Database Admin bootstrap。

## 提交前检查

1. 行为变化有测试。
2. 架构或兼容性取舍写入 `docs/decisions`。
3. 关键边界、不变量和失败语义有必要的中文注释。
4. `pnpm check` 通过。
5. `git status` 中没有 `.env`、构建产物或无关文件。
