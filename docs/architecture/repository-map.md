# 仓库导览

本页回答“一个改动应该放在哪里”。路径以仓库根目录为基准；更细的设计原因见对应包文档和[架构决策](../decisions/README.md)。

## 顶层目录

| 路径 | 内容 | 维护边界 |
| --- | --- | --- |
| `runtime-ts/apps/` | 可部署进程和前端应用 | 只做协议适配、依赖装配和进程入口 |
| `runtime-ts/packages/` | 领域、契约、运行时编排与基础设施模块 | 不通过跨目录相对路径绕过包边界 |
| `runtime-ts/managed-skills/` | Hoox 自维护的 Skill | 必须保留明确许可证和可重复发布方式 |
| `runtime-ts/vendor/` | 固定版本的第三方源码 | 必须有 `LICENSE`、`SOURCE.md`，派生修改还需 `PATCHES` |
| `docs/` | 当前文档、决策、计划和验证记录 | 当前说明与历史资料必须明确区分 |
| `deploy/` | 生产配置示例、发布与回滚契约 | 样例不是可直接上线的共享秘密文件 |
| `scripts/` | 开发、CI、配置、供应链和容器 Gate | 脚本错误不得输出秘密值 |
| `supply-chain/` | SBOM、许可证策略与生成证据 | 必须与锁文件和生产闭包保持一致 |
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

## 共享包

### 领域与公开契约

| 包 | 职责 |
| --- | --- |
| `@hoox/domain` | Tenant、Thread、Run、Workspace 等领域实体、品牌类型和状态机不变量 |
| `@hoox/protocol` | HTTP DTO、事件、错误信封和运行时 Schema |
| `@hoox/protocol-mapper` | Domain 到 Protocol 的显式投影和公共错误归一化 |
| `@hoox/run-contracts` | Worker 执行所需端口、事实和运行期契约 |

### Runtime 编排

| 包 | 职责 |
| --- | --- |
| `@hoox/pi-adapter` | `pi-ai` Provider/模型绑定、`pi-agent-core` 工具循环、流式事件与 Runtime 恢复适配 |
| `@hoox/prompt-builder` | 稳定、可审计的系统提示词组装 |
| `@hoox/context-policy` | 上下文预算、选择、截断和压缩策略 |
| `@hoox/tool-router` | 工具能力校验、路由、结果归一化和审计边界 |
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
| `@hoox/process-runtime` | 严格配置、健康状态、信号、排空和进程关闭 |

## 常见改动落点

| 改动 | 首选位置 | 同步检查 |
| --- | --- | --- |
| 新领域不变量 | `packages/domain` 或对应领域包 | rehydrate、错误映射、领域测试、ADR |
| 新 HTTP 字段或错误码 | `packages/protocol`、`protocol-mapper`、`apps/api` | Schema、兼容性、API 测试和参考文档 |
| 新工具 | `packages/tool-router` 与所需端口 | 能力清单、审计、Sandbox 边界、工具测试 |
| 新模型 Provider | `packages/pi-adapter` | 配置契约、能力元数据、流式与失败测试 |
| 新 Sandbox Provider | `packages/sandbox` | Session 持久化、Scheduler、生产配置和真实冒烟 |
| 新数据库事实 | `packages/persistence` | migration、RLS、角色权限、往返测试和 ADR |
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
- 只使用 Thread 历史格式与校验时，从 `@hoox/pi-adapter/thread-history` 导入；`run-contracts` 经此窄入口重导出历史校验，避免 API、Scheduler 随契约加载模型会话和 Provider SDK。Pi 根入口继续兼容，包级依赖声明并未因此移除。
- 管理 Web 和控制 API 从 `@hoox/protocol/pi-model-catalog` 共用公开模型快照与查询；Protocol 根入口不加载快照。修改目录来源时更新 `scripts/generate-admin-pi-model-catalog.mjs`，执行 `pnpm admin:pi-catalog:generate` 与 `pnpm admin:pi-catalog:check`，不手工编辑生成文件。
- Pi 生产能力限于 `pi-ai` 与 `pi-agent-core`；不经 `pi-coding-agent` 装配 Session、设置或宿主资源发现。工具按 `AgentTool` 注册，业务授权和持久观察仍属于 Runtime；恢复顺序与屏障见 [Thread 连续上下文](thread-continuity.md)。
- `vendor` 代码不能成为不受审查的复制区；版本、许可证、来源和修改必须可追踪。

## 当前复杂度热点

以下位置承担较多跨领域职责，修改前应先阅读测试和相关 ADR：

- `@hoox/persistence`：数据库、Outbox、Blob 生命周期和多个领域 Repository 的集中实现。
- `@hoox/agent-worker`：模型、工具、上下文、Sandbox、Artifact 和恢复语义的装配中心。
- `@hoox/run-contracts`：连接 Worker 编排与多个执行端口，命名上的“contracts”不表示它是零依赖类型包。
- `@hoox/admin-control-api` 对控制面和 Skill 路由的统一装配：新增复用前应确认是否应下沉到共享包，并保持两套数据库权限边界。

这些说明不是要求立即拆包，而是提醒维护者避免继续扩大隐式耦合。

## 测试位置

- 包内单元与契约测试通常与源码共置。
- 应用入口和进程生命周期测试位于对应 `apps/*/src`。
- `tests/integration/` 保存真实 PostgreSQL 等跨进程黑盒。
- 真实 Sandbox、模型或 MinIO 测试默认关闭，必须通过显式环境变量启用。

命令和适用范围见[命令参考](../reference/commands.md)。
