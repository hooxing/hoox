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
| `process-runtime` | 严格进程配置、信号、排空、关闭和健康状态语义 |
| `prompt-builder` | 可审计、可复现的系统提示词组装 |
| `context-policy` | 上下文选择、截断和压缩策略 |
| `tool-router` | 工具鉴权、路由、审计和错误归一化 |
| `sandbox` | CubeSandbox 厂商 SDK 适配 |
| `workspace` | Thread 私有工作区及版本快照 |
| `resource` | 跨 Thread 资源和不可变版本 |
| `artifact` | Agent 明确发布的最终交付物 |
| `testing` | Fake、夹具和跨包测试工具，仅供测试使用 |

应用依赖共享包时，必须通过 pnpm Workspace 依赖显式声明，不能使用跨目录相对导入。共享进程包不拥有业务依赖，也不提供测试 Fake 作为生产默认值。

## 配置安全

- 真实 `.env` 只保存在开发者机器并由 Git 忽略。
- 新增或删除环境变量时，必须同步修改 `.env.example` 和 `scripts/env-contract.mjs`。
- 示例中的数据库密码、访问密钥、模板 ID、模型地址和模型 ID 必须保持为明显占位值。
- CI 只使用 `.env.example` 执行静态 Compose 展开，不连接 PostgreSQL、MinIO、CubeSandbox 或模型服务。

服务进程先用各应用的 `select*ProcessEnvironment` 从 `process.env` 投影声明键，再严格解析。禁止把完整宿主环境直接交给解析器，也禁止为缺失的 `RUNTIME_ENV` 回退到 development。API 的 `DEV_AUTH_ENABLED=true` 只允许 development/test；生产环境必须使用真实身份装配器。配置错误只记录变量名与稳定分类，不能记录值。

## 进程启动与关闭

`runtime-ts/apps/api`、`agent-worker` 和 `scheduler` 只提供类型化配置与薄启动入口。没有真实 `ServiceAssemblyFactory` 时固定拒绝启动；当前骨架不代表 PG Worker Repository、Run dispatch、清理消费者、生产身份或真实模型已经完成。

装配器按业务接收顺序实现 `stopAccepting`，将数据库连接池、HTTP listener、消费者和遥测等资源按确定顺序登记。关闭时先停止接收，再等待 `lifecycle.track()` 登记的在途操作，最后串行关闭资源。资源错误只上报稳定名称；库不调用 `process.exit`。部署平台的强制终止宽限期必须大于 `PROCESS_SHUTDOWN_TIMEOUT_MS`。

进程骨架专项校验：

```powershell
corepack pnpm test:process-runtime
corepack pnpm test:process:container
```

第一条在 Windows/Linux 运行相同单元与入口测试；第二条需要 Docker，构建 Linux 非 root 最小镜像并验证配置、就绪和关闭顺序。

## PostgreSQL 角色 bootstrap

业务 Schema 迁移不能替代数据库级 bootstrap。首次准备专用数据库时，由不进入应用进程的 Database Admin 完成以下一次性操作：

1. 创建无 `SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS/REPLICATION` 的 Migrator 与 Runtime 登录角色，并保证两者都没有任何上游角色成员关系；Runtime 即使设置为 `NOINHERIT` 也不能保留可 `SET ROLE` 的成员关系；
2. 从 `PUBLIC`、Migrator 和 Runtime 撤销目标数据库的全部权限，再只向 Migrator 和 Runtime 授予 `CONNECT`；Runtime 不得通过 `PUBLIC` 获得 `CREATE` 或 `TEMPORARY`；
3. 创建专用业务 Schema，并只让 Migrator 成为该 Schema owner；Database Admin 继续作为数据库 owner；
4. 确认 Runtime 不是数据库、Schema、表或序列 owner；Migrator 不是数据库 owner，且只拥有配置的业务 Schema；
5. 分别写入本机忽略文件中的 `DATABASE_BOOTSTRAP_URL`、`MIGRATION_DATABASE_URL`、`DATABASE_URL`、`DATABASE_RUNTIME_ROLE`、`DATABASE_MIGRATOR_ROLE` 与 `DATABASE_SCHEMA`。Bootstrap URL 只用于本地权限集成测试或受控运维，不能进入服务进程。

`pnpm db:migrate:up` 会在任何 DDL 前同时验证 Runtime、当前 Migrator、Schema owner 与精确 `search_path`，并拒绝 Runtime 的目标 Schema `CREATE`、数据库 `TEMPORARY`、Migrator 对无关 Schema 的有效 `CREATE`、额外非系统 ownership、任何 routine default ACL 记录及任何目标 Schema routine。Schema migration、迁移记录、最小 ACL bootstrap 和结束白名单断言共用同一事务。首版 routine manifest 为空；runner 完全不修改 routine 的全局或局部 default ACL，并在迁移 SQL 后、提交前再次断言目标 routine 集合仍为空，任何 migration 创建 routine 都会整体回滚。bootstrap 撤销 Runtime 和 `PUBLIC` 在业务 Schema、全部业务表、迁移表及 sequence 上的权限，并对逐表全部 DML/DDL、routine `EXECUTE` 及数据库、Schema 有效权限执行白名单断言。未来引入函数、过程或聚合前，必须单独设计 manifest 并显式审查 `SECURITY DEFINER`、owner、参数、固定 `search_path` 和调用权限。`pnpm db:migrate:down` 只在 development/test 加显式破坏开关时工作；down SQL、ACL 回收和结束断言同样共用一个事务，任一步失败都整体回滚。down 不修改 routine default ACL，也不会删除角色或回滚 Database Admin bootstrap。

## HTTP API 开发边界

`runtime-ts/apps/api` 使用 `createApiApp` 显式注入身份、Repository、时钟、ID、HMAC 游标密钥环和探针等端口。测试用 `Fastify.inject` 而不监听网络端口。`AuthContextResolver` 只返回已验证 principal，之后仍必须用 PostgreSQL Membership 解析 `TenantScope`；不得读取 `x-tenant-id` 构造 scope。游标密钥必须来自密钥管理配置，不能使用仓库内常量；最短 32 字节。codec 必须注入可信时钟、签发 TTL 和最大 TTL；轮换按“先同时读取新旧 key、再切换 active、等待旧 key 签发游标的 `expiresAt` 与最大 TTL 都失效、最后移除旧 key”进行。

当前 `ThreadCreationPort` 和 `EnqueueOutboxPort` 只有契约与测试 Fake。在后续 PostgreSQL idempotency/outbox 事务适配完成前，禁止用“Thread 后写 Workspace”或“Run 后发队列”的顺序调用装配生产 create 路由。生产 capability 合并前必须以两个独立 PG 连接覆盖首次并发竞争，并覆盖 COMMIT 成功但响应丢失后的幂等读回。只有 `createApiCreateCapability` 同时签发两个原子端口时才注册 POST；签发和 App 创建都会快照能力，运行中替换对象无效。不注入能力时服务保持可读、可归档、可取消且 `/ready` 正常。`ArchiveThreadCommandPort` 已有 PostgreSQL 适配，必须保持 Membership `FOR SHARE`→Thread `FOR UPDATE` 锁序、事务内角色重验和数据库单调时间，禁止退化为 API 层 Repository 读改写。

Runtime 对 Membership 只有 SELECT、INSERT 和恒定 `lock_marker` 的单列 UPDATE，不允许表级 UPDATE，也不允许更新 `status`、`role`、租户/用户关联、ID 或创建时间。`lock_marker` 由 CHECK 约束为 `false`，只用于满足 PostgreSQL `FOR SHARE` 的列权限前提。不得把它改造成业务状态；成员变更必须由独立权限边界完成。

0003 才引入 `lock_marker`。ACL bootstrap 与白名单断言必须按数据库实际列集合工作，partial down 到 0002 时不能引用该列，再次 up 到 0003 后必须恢复单列权限。新增版本相关 ACL 时必须同时增加真实 PostgreSQL 的 `最新→旧版→最新` 往返测试。

公开错误中，Schema、超限、畸形 JSON、危险原型键和游标错误统一为 400 `INVALID_REQUEST`；非 `application/json` 的创建请求为 415 `UNSUPPORTED_MEDIA_TYPE`。不能把 Fastify/AJV 的内部错误消息直接返回给客户端。

## 提交前检查

1. 行为变化有测试。
2. 架构或兼容性取舍写入 `docs/decisions`。
3. 关键边界、不变量和失败语义有必要的中文注释。
4. `pnpm check` 通过。
5. `git status` 中没有 `.env`、构建产物或无关文件。
