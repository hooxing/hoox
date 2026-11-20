# 仓库导览

本页回答“一个改动应该放在哪里”。路径以仓库根目录为基准；更细的设计约束见对应包文档和[架构文档](README.md)。

## 顶层目录

| 路径 | 内容 | 维护边界 |
| --- | --- | --- |
| `runtime-ts/apps/` | 可部署进程和前端应用 | 只做协议适配、依赖装配和进程入口 |
| `runtime-ts/packages/` | 领域、契约、运行时编排与基础设施模块 | 不通过跨目录相对路径绕过包边界 |
| `runtime-ts/managed-skills/` | Hoox 自维护的 Skill | 必须保留明确许可证和可重复发布方式 |
| `runtime-ts/vendor/` | 固定版本的第三方源码 | 必须有 `LICENSE`、`SOURCE.md`，派生修改还需 `PATCHES` |
| `docs/` | 当前文档、架构约束、计划和验证记录 | 当前说明与时点证据必须明确区分 |
| `deploy/` | Demo 部署、生产配置示例与 Sandbox 镜像 | 样例不是可直接上线的共享秘密文件 |
| `scripts/` | 开发、CI、配置校验与 Demo 发布 | 脚本错误不得输出秘密值 |
| `tests/` | 跨包、集成和黑盒验证 | 外部服务测试必须显式开启并隔离清理 |
| `third_party/` | 非 vendored 依赖的许可证和来源补充 | 不作为运行时源码导入 |

## 可部署应用

| 应用 | 主要职责 | 典型入口 |
| --- | --- | --- |
| `@hoox/api` | HTTP API、身份、TenantScope、读取投影和命令装配 | `runtime-ts/apps/api` |
| `@hoox/agent-worker` | Run 领取、模型执行、工具调用和完成收敛 | `runtime-ts/apps/agent-worker` |
| `@hoox/scheduler` | 清理、恢复、定时任务和标题生成 | `runtime-ts/apps/scheduler` |
| `@hoox/web` | 用户工作台 | `runtime-ts/apps/web` |
| `@hoox/admin-control-api` | 模型、记忆、配置、统计及 Skill 路由的统一管理 API | `runtime-ts/apps/admin-control-api` |
| `@hoox/admin-web` | 后台管理界面 | `runtime-ts/apps/admin-web` |
| `@hoox/trajectory-web` | development 内部轨迹查看器 | `runtime-ts/apps/trajectory-web` |

`api`、`agent-worker` 和 `scheduler` 是生产 Runtime 的三个核心进程。后台管理面使用独立身份；统一 Admin API 内部继续隔离 Admin Control 与 Skill Publisher 的数据库角色和发布凭据。`@hoox/skill-admin-api` 是由统一进程装配的 Skill 路由模块，不是独立部署进程。Trajectory Viewer 属于内部诊断工具，不是公开产品入口。

### HTTP API 内部入口

`runtime-ts/apps/api/src/app.ts` 负责 Fastify 配置、依赖快照、请求认证与通用中间件装配，并按顺序挂载路由。新增或修改端点时，按职责进入 `runtime-ts/apps/api/src/routes/`：账号和首次安装在 `auth.ts`、`installation.ts`，Thread 与 Run 命令和查询在 `threads-and-runs.ts`，事件分页和 SSE 在 `run-events.ts`，交付物在 `artifacts.ts`。历史文件、上传、Skill、团队、定时任务、个性化及模型报文诊断分别由同目录的对应模块注册。ResourceFS 仍由 `resource-filesystem-http.ts` 在独立的 Fastify 插件作用域内注册，以隔离其请求体解析规则。

租户认证的 HTTP 入口在 `request-auth.ts`，通用请求日志和错误信封在 `http-middleware.ts`；路由负责协议校验和调用服务端口，不替代共享包的领域授权或持久化规则。

## 共享包

### 领域与公开契约

| 包 | 职责 |
| --- | --- |
| `@hoox/domain` | Tenant、Thread、Run、Workspace 等领域实体、品牌类型和状态机不变量 |
| `@hoox/protocol` | HTTP DTO、事件、错误信封和运行时 Schema |
| `@hoox/protocol-mapper` | Domain 到 Protocol 的显式投影和公共错误归一化 |
| `@hoox/run-contracts` | Worker 执行所需端口、事实和运行期契约，并拥有 Runtime 事件、受控 Rollout 投影、Thread 历史格式与 Sandbox 端口类型 |

### Runtime 编排

| 包 | 职责 |
| --- | --- |
| `@hoox/pi-adapter` | `pi-ai` Provider/模型绑定、`pi-agent-core` 工具循环、工具选择与 PTC 包装、流式事件与 Runtime 恢复适配 |
| `@hoox/prompt-builder` | 稳定、可审计的系统提示词组装 |
| `@hoox/context-policy` | 上下文预算、选择、截断和压缩策略 |
| `@hoox/tool-router` | 全部 Agent 工具的定义、参数 Schema、授权调用、Sandbox 副作用、受控回执与安全失败投影 |
| `@hoox/automation` | Thread 定时任务领域与运行契约 |
| `@hoox/memory` | Memory 端口和作用域边界 |
| `@hoox/thread-title` | Thread 标题生成契约与纯逻辑 |
| `@hoox/trajectory` | 内部轨迹模型、转换和展示数据 |

### 文件、资源与沙箱

| 包 | 职责 |
| --- | --- |
| `@hoox/workspace` | Workspace 清单、Revision、租约和安全物化计划 |
| `@hoox/resource` | Resource 发现、预览、导入和版本语义 |
| `@hoox/artifact` | Artifact 发布、完成门和下载授权语义 |
| `@hoox/sandbox` | CubeSandbox、E2B 等 Provider 适配与 Session 生命周期 |
| `@hoox/skill` | Skill 包、版本、目录和运行时选择边界 |

### 基础设施

| 包 | 职责 |
| --- | --- |
| `@hoox/persistence` | PostgreSQL Repository、事务、迁移、Outbox 和 S3/MinIO Blob 适配 |
| `@hoox/process-runtime` | 严格配置、生产 HTTP/TLS 传输解析、开发回环监听约束、健康状态、信号、排空和进程关闭 |
| `@hoox/identity` | 身份供应商配置；`@hoox/identity/auth` 提供认证端口与生产 JWT 校验，不加载 better-auth 与数据库驱动 |

## 常见改动落点

| 改动 | 首选位置 | 同步检查 |
| --- | --- | --- |
| 新领域不变量 | `packages/domain` 或对应领域包 | rehydrate、错误映射、领域测试、架构文档 |
| 新 HTTP 字段或错误码 | `packages/protocol`、`protocol-mapper`、`apps/api` | Schema、兼容性、API 测试和参考文档 |
| 新工具 | `packages/tool-router` 与所需端口 | 能力清单、审计、Sandbox 边界、工具测试 |
| 新模型 Provider | `packages/pi-adapter` | 配置契约、能力元数据、流式与失败测试 |
| 新 Sandbox Provider | `packages/sandbox` | Session 持久化、Scheduler、生产配置和真实冒烟 |
| 新数据库事实 | `packages/persistence` | migration、RLS、角色权限、往返测试和架构文档 |
| 新后台协调任务 | `apps/scheduler` 与共享领域包 | 租约、幂等、Tenant 分片和 readiness |
| 新用户页面 | `apps/web` | 只使用公开协议，不直接依赖 Repository |
| 新后台管理能力 | `admin-control-api`、`admin-web` 与对应共享包 | 独立身份、领域授权、数据库角色和秘密边界 |
| 新 Skill 发布能力 | `skill-admin-api` 路由模块、`admin-control-api` 装配、`packages/skill` | 审核状态机、Skill Publisher 数据库角色和对象存储权限 |

## 依赖规则

- 应用可依赖共享包；共享包不得依赖应用入口。
- Domain 与 Protocol 有意解耦，转换只能经过 `protocol-mapper`。
- 应用和包不能绕过 `tool-router` 直接执行宿主机命令或读写宿主机工作目录。
- PostgreSQL、S3、Sandbox 和模型 SDK 都应位于适配器边界，不进入纯领域代码。
- 跨包依赖使用 pnpm Workspace 声明，不使用越目录相对导入。
- 契约层不得依赖实现层：`run-contracts` 不依赖 `pi-adapter`、`sandbox`、`persistence` 或 `tool-router`。Thread 历史格式从 `@hoox/run-contracts/thread-history` 导入；`@hoox/pi-adapter/thread-history` 与 `@hoox/sandbox` 的同名类型只是兼容重导出。
- 工具实现只在 `tool-router`。`pi-adapter` 依赖 `tool-router` 选择和注册工具，运行时依赖中不得出现 `sandbox` 或 `persistence`；新增工具不能在模型适配器内直接调用 Sandbox。
- 应用之间不互相依赖；唯一例外是 `admin-control-api` 装配 `skill-admin-api` 路由模块。多个进程共用的认证、传输解析等能力下沉到 `identity`、`process-runtime` 等共享包。
- `corepack pnpm deps:check`（已纳入 `pnpm check`）校验上述依赖方向，并要求生产源码导入的每个包都在本包 `dependencies` 中声明，不能依赖 pnpm 提升。新增例外须同时修改 `scripts/validate-workspace-dependencies.mjs` 与本节。
- 管理 Web 和控制 API 从 `@hoox/protocol/pi-model-catalog` 共用公开模型快照与查询；Protocol 根入口不加载快照。修改目录来源时更新 `scripts/generate-admin-pi-model-catalog.mjs`，执行 `pnpm admin:pi-catalog:generate` 与 `pnpm admin:pi-catalog:check`，不手工编辑生成文件。
- Pi 生产能力限于 `pi-ai` 与 `pi-agent-core`；不经 `pi-coding-agent` 装配 Session、设置或宿主资源发现。工具按 `AgentTool` 注册，业务授权和持久观察仍属于 Runtime；恢复顺序与屏障见 [Thread 连续上下文](thread-continuity.md)。
- `vendor` 代码不能成为不受审查的复制区；版本、许可证、来源和修改必须可追踪。

## 当前复杂度热点

以下位置承担较多跨领域职责，修改前应先阅读测试和相关架构文档：

- `@hoox/persistence`：数据库、Outbox、Blob 生命周期和多个领域 Repository 的集中实现；已按职责拆分[子入口](persistence-and-database.md#包入口)，但仍是同一个包。
- `@hoox/agent-worker`：模型、工具、上下文、Sandbox、Artifact 和恢复语义的装配中心。`RunWorker.execute` 只串联 Attempt 阶段（领取、会话建立、模型循环、Workspace 校验、waiting/succeeded 收口与失败收敛），各阶段是 `run-worker.ts` 内的私有方法；Sandbox 懒准备（`run-worker-sandbox-preparation.ts`）、事件持久化流水线与 turn 安全点（`run-worker-event-pipeline.ts`）、计时装配（`run-worker-timing.ts`），以及事件构造、Outbox、持久事实回读比对、Workspace 失败分类、执行状态迁移与资源探测，都分别位于同目录的 `run-worker-*.ts`。持久化、授权与终态收敛（`applyMutation`、`authorizeEffect`、`finishStopped` 等）仍由 `RunWorker` 持有，通过绑定当前上下文的操作接口交给这些模块。
- `@hoox/run-contracts`：连接 Worker 编排与多个执行端口；它不依赖实现包，但仍依赖 `context-policy`、`skill`、`workspace` 等领域包，不是零依赖类型包。
- `@hoox/admin-control-api` 对控制面和 Skill 路由的统一装配：新增复用前应确认是否应下沉到共享包，并保持两套数据库权限边界。

这些说明不是要求立即拆包，而是提醒维护者避免继续扩大隐式耦合。

## 测试位置

- 包内单元与契约测试通常与源码共置。
- 应用入口和进程生命周期测试位于对应 `apps/*/src`。
- `tests/integration/` 保存真实 PostgreSQL 等跨进程黑盒。
- 真实 Sandbox、模型或 MinIO 测试默认关闭，必须通过显式环境变量启用。

命令和适用范围见[命令参考](../reference/commands.md)。
