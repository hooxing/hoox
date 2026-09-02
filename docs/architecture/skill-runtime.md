# Skill Runtime

本文面向修改 Skill Center、Run 快照、Prompt 注入或 Skill 资源读取的开发者，说明当前实现的所有权、加载路径和安全边界。历史目标设计见[Skill Center 接入规范](../archive/specs/skill-center-and-runtime-integration.md)，最终取舍以相关 ADR 和当前代码为准。

## 事实源与所有权

- Skill 目录和版本元数据由 PostgreSQL 管理，版本正文与包文件保存于私有 Blob/Object Store；Worker 本地目录不是事实源。
- 目录内容只能由管理员或受信发布流程写入。普通 API Runtime 可以浏览和安装，但没有发布权限。
- 安装关系属于当前 Tenant。个人空间与每个团队空间分别维护自己的安装集合；新团队不会继承成员的个人 Skill。
- 团队 Owner/Admin 可以管理团队安装，Member 可以读取并在团队 Run 中使用已启用版本。
- 安装固定精确版本并由用户显式升级，不自动跟随目录中的推荐版本。

当前 HTTP 表面使用 `GET /v1/skills` 浏览目录，并通过 `/v1/me/skills` 及其 `/:canonicalKey` 子路径读取、安装、配置和卸载当前认证 Tenant 的 Skill。路径中的 `me` 不表示跨 Tenant 的全局用户安装；实际作用域始终来自服务端认证后的 `TenantScope`。

## Run 快照

创建 Run 时，Persistence 在事务边界内读取当前 Tenant 已启用且可用的安装，并写入不可变 `RunSkillSnapshot`。Worker 只读取该快照，不在执行或恢复时反查最新安装状态。

因此：

- Run 创建后升级、停用或卸载 Skill，不改变该 Run 的名称、版本、摘要或恢复结果；
- 无法形成完整快照时，Run 创建失败关闭，不能创建目录不确定的 Run；
- 仍被 Run 快照、Invocation 或审计引用的版本内容不能因卸载而删除；
- 被硬撤销或完整性校验失败的版本不能静默替换为其他版本。

## 模型可见目录与加载路径

System Prompt 契约由 `@hoox/prompt-builder` 的 `RUNTIME_PROMPT_VERSION` 和 Golden Test 管理。仅当快照非空时，末尾才包含 `AVAILABLE_SKILLS`，每项只暴露经过校验的调用名称和一句描述；完整 `SKILL.md`、Blob 引用、数据库 ID、Tenant ID、Run ID 和内部摘要都不进入该目录。

完整指令有两条加载路径：

1. **显式调用**：Slash 或请求中的结构化 `skillInvocation` 在首次模型请求前加载固定版本，并注入 `runtime.skill_instruction.v1`；加载失败不能退化为普通请求继续执行。
2. **自然语言触发**：模型只能把 `AVAILABLE_SKILLS` 中的精确名称传给固定 `skill` 工具。工具从同一 Run 快照读取正文，失败时返回受控错误，模型不能根据目录描述猜测完整工作流。

读取 Skill 指令只经过数据库和 BlobStore，不领取 Sandbox。Skill 也不能修改 Platform Harness、工具 Schema、Tenant 身份、用户授权或外部副作用许可。

## 公开市场与 Sandbox

公开目录通过只读 ResourceFS 投影到 `/resources/skills`。模型可以在已安装目录没有合适项且任务确有需要时浏览市场文件，但浏览不建立安装关系，未安装名称不能传给 `skill` 工具。

只有后续任务实际调用 Sandbox 文件或命令工具时，Runtime 才按既有延迟获取规则创建或复用 Thread Sandbox，并物化所需只读资源。Skill 包中的脚本不是受信平台代码，是否执行仍由普通工具授权、路径边界和副作用规则决定。

## 当前限制

- 不支持开放式第三方发布、Git 仓库同步或自动升级。
- Skill 只能提供指令和资源，不能动态增加工具、MCP Server、模型权限或平台身份。
- 加载 Skill 不会自动启动子 Agent、后台任务或脚本。
- 团队 Skill 已按 Tenant 隔离，但审批、灰度升级、团队自建发布和紧急下架流程尚未形成正式产品契约。

## 变更检查

修改本能力时至少同时核对：

- `@hoox/skill` 的领域契约与包校验；
- `@hoox/persistence` 的目录、Tenant 安装、Run 快照、Invocation 与数据库角色；
- `@hoox/prompt-builder` 的 Prompt 版本、目录排序、转义和摘要稳定性；
- `@hoox/pi-adapter` 的显式指令与 `skill` 工具恢复语义；
- API/Web 的当前 Tenant 选择、角色授权和稳定错误；
- ResourceFS 的只读市场投影、Blob 完整性与延迟 Sandbox 行为。

关键决策见 [ADR-0094](../decisions/0094-skill-center-user-installation.md)、[ADR-0095](../decisions/0095-skill-runtime-snapshot-and-lazy-materialization.md)、[ADR-0107（公开 Skill 市场）](../decisions/0107-public-skill-market-virtual-filesystem.md)、[ADR-0112](../decisions/0112-managed-skill-admin-publication.md)、[统一后台 API 决策](../decisions/20260821115221-unified-admin-api-process.md)和[团队工作空间决策](../decisions/0139-team-workspace-and-snapshot-boundary.md)。
