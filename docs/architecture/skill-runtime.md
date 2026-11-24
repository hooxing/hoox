# Skill Runtime

本文面向修改 Skill Center、Run 快照、Prompt 注入或 Skill 资源读取的开发者，说明当前实现的所有权、加载路径和安全边界。最终行为以本文和当前代码为准。

## 事实源与所有权

- Skill 目录和版本元数据由 PostgreSQL 管理，版本正文与包文件保存于私有 Blob/Object Store；Worker 本地目录不是事实源。
- 目录内容由平台 Skill 管理员或经命名空间授权的发布者写入。普通 API Runtime 可以浏览和安装，但没有发布权限。
- 安装关系属于当前 Tenant。个人空间与每个团队空间分别维护自己的安装集合；新团队不会继承成员的个人 Skill。
- 团队 Owner/Admin 可以管理团队安装，Member 可以读取并在团队 Run 中使用已启用版本。
- 安装固定精确版本并由用户显式升级，不自动跟随目录中的推荐版本。

当前 HTTP 表面使用 `GET /v1/skills` 浏览目录，并通过 `/v1/me/skills` 及其 `/:canonicalKey` 子路径读取、安装、配置和卸载当前认证 Tenant 的 Skill。路径中的 `me` 不表示跨 Tenant 的全局用户安装；实际作用域始终来自服务端认证后的 `TenantScope`。

## 管理发布

管理员在后台上传文件或目录，经包校验后预览，再直接发布到技能中心。页面按目录唯一身份 `canonicalKey` 展示最新申请，上传更新会创建新包；版本由服务端根据操作者和幂等键生成，网络重试保持稳定，页面不要求填写版本或经过提交、复核。最新待发布包不代表原已发布包被下架，原目录和安装继续有效；管理员仍可从最新上传详情“下架当前已发布内容”，该操作不会发布或修改新上传。发布自动推荐新包，但已有安装仍固定原精确版本，需要用户显式升级。

平台 Skill 管理员可以创建命名空间并授予或撤销发布者授权；授权记录授予者、时间和操作审计。当前 Skill ID 没有命名空间语义，因此新发布使用 `namespace.skill-name` 规范键，首个点号前的部分是命名空间，命名空间采用小写字母、数字、下划线和连字符，最长 63 个字符。既有不带前缀的规范键保留为平台管理的 Skill，不自动归入某个发布者空间。

发布者只能读取和操作已授权命名空间中的申请，并且只能提交自己创建的申请；发布与撤回可由该命名空间的其他授权发布者执行。命名空间授权允许用户通过后台登录及会话身份解析，以访问 Skill 自助发布入口，但不会附赠控制面或其他后台领域角色；各管理 API 仍独立鉴权。授权撤销后立即失去后台会话准入和发布访问能力。服务层检查命名空间授权，PostgreSQL RLS 再按当前用户和授权关系过滤申请、目录与版本写入；跨命名空间和无权限访问统一隐藏为 404。发布者不能创建命名空间、管理授权、审核申请或访问其他管理台路由。平台 Skill 管理员仍可管理所有命名空间和 Skill。

所有上传仍经过完整 Skill 包校验；数据库发布角色也不能绕过目录作用域。已发布 Skill 保持 `restricted` 信任状态，Skill 声明的工具与能力仍受平台白名单和 Agent 选择约束，发布权限不会扩展工具权限。历史提交、复核接口仍兼容；已有审核者和审核结果保留，直接发布不会伪造审核者。驳回或撤销的申请不能原地恢复，更新需要新建申请。撤销时页面说明后果并确认一次：被撤销的内容不能继续执行，当前推荐包被撤销后停止该技能的新安装；包和历史引用不删除。发布 API 与权限错误见[Skill 发布参考](../reference/skill-publishing.md)。

包结构与完整性校验不等于恶意软件或脚本行为分析，Skill 不因此获得平台信任或额外工具权限。发布的幂等、并发和迁移边界见[维护者开发边界](../maintainers/runtime-development-boundaries.md)及[后台控制面与运行配置](admin-control-plane.md)。

## Run 快照

受理 Run 或预留 follow-up 候选时，Persistence 根据同一事务写入的 [Agent Revision 快照](agent-definition.md) 解析自带的精确 `(skillId, version)`，不要求 Tenant 先安装，也不跟随推荐版本。自带 Skill 用 `canonicalKey` 作为调用名。只有 `includeTenantSkills` 为真时才叠加当前 Tenant 已启用的安装；按精确调用名冲突时自带版本优先，Tenant 别名不受不同调用名的覆盖。两个自带引用若产生相同调用名，则配置不可用。

合并结果写入不可变 `RunSkillSnapshot`，条目来源为 `agent` 或 `tenant`。已有快照只含 Tenant 安装，补记 `tenant` 不改变原摘要。Worker 在执行、恢复和启动子 Agent 时使用该 Run 的同一份快照，不反查最新安装或 Revision。

因此：

- Run 创建后升级、停用或卸载 Skill，不改变该 Run 的名称、版本、摘要或恢复结果；
- Agent 自带版本缺失、已撤销或入口与包的持久元数据校验失败时，Run 受理回滚，API 返回 `409 AGENT_REVISION_UNAVAILABLE`；即使存在同名的可用 Tenant 安装，也不回退。受理事务不读取对象存储，Skill 加载时仍校验实际读取的内容；
- 目录超过 64 项、保留的 Tenant 安装不可用或显式调用名称不在合并目录中时，不创建 Run；
- 仍被 Run 快照、Invocation 或审计引用的版本内容不能因卸载而删除；
- 被硬撤销或完整性校验失败的版本不能静默替换为其他版本。

降级到不识别 Skill 来源的版本前，应排空含 Agent 自带 Skill 的 Run；旧 Runtime 无法验证这类快照的摘要。

## 模型可见目录与加载路径

System Prompt 契约由 `@hoox/prompt-builder` 的 `RUNTIME_PROMPT_VERSION` 和 Golden Test 管理。仅当快照非空时，末尾才包含 `AVAILABLE_SKILLS`，每项只暴露经过校验的调用名称和一句描述；来源、完整 `SKILL.md`、Blob 引用、数据库 ID、Tenant ID、Run ID 和内部摘要都不进入模型可见目录；仅改变来源不改变 Prompt 字节。

完整指令有两条加载路径：

1. **显式调用**：Slash 或请求中的结构化 `skillInvocation` 在首次模型请求前加载固定版本，并注入 `runtime.skill_instruction.v1`；加载失败不能退化为普通请求继续执行。
2. **自然语言触发**：模型只能把 `AVAILABLE_SKILLS` 中的精确名称传给固定 `skill` 工具。工具从同一 Run 快照读取正文，失败时返回受控错误，模型不能根据目录描述猜测完整工作流。

读取 Skill 指令只经过数据库和 BlobStore，不领取 Sandbox。Skill 也不能修改 Platform Harness、工具 Schema、Tenant 身份、用户授权或外部副作用许可。

## 公开市场与 Sandbox

公开目录通过只读 ResourceFS 投影到 `/resources/skills`。模型可以在已安装目录没有合适项且任务确有需要时浏览市场文件，但浏览不建立安装关系，未列入 Run 快照的名称不能传给 `skill` 工具。

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

相关边界见[后台控制面与运行配置](admin-control-plane.md)和[团队协作](team-collaboration.md)。
