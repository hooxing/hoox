# 架构文档

架构文档从仓库 HEAD 的视角解释系统边界、运行关系和关键不变量，是理解当前设计约束的主要入口。影响架构边界的决定直接更新对应文档，不另建决策账本；历史讨论以 Git 历史为准。

| 文档 | 什么时候阅读 | 回答的问题 |
| --- | --- | --- |
| [架构总览](overview.md) | 第一次理解 Hoox 或评估跨模块改动时 | 系统上下文、领域关系、运行链路和可靠性原则是什么 |
| [仓库导览](repository-map.md) | 准备修改代码或新增模块时 | 应修改哪个应用或共享包，依赖边界是什么 |
| [Run 执行与恢复](run-execution-and-recovery.md) | 修改 Worker、Attempt、外部副作用许可、取消或恢复路径时 | Run 与 Attempt 如何分层，双栅栏、重试、UNKNOWN 和恢复规则是什么 |
| [持久化与数据库边界](persistence-and-database.md) | 新增表、Repository、迁移或数据库角色时 | PostgreSQL 与对象存储如何分工，RLS、角色、幂等与 Outbox 约束是什么 |
| [Workspace、Resource 与交付物](workspace-and-files.md) | 修改文件工具、Workspace 发布、附件、云盘或交付物时 | 三类文件事实归谁所有，如何原子发布、引用和下载 |
| [Prompt、上下文预算与模型交互](prompt-and-model-io.md) | 修改提示词、工具描述、记忆注入、预算或模型适配时 | 哪些内容可以进入固定前缀，信任分层和模型绑定规则是什么 |
| [运行事件与对话展示](run-events-and-presentation.md) | 修改事件、SSE、对话渲染或诊断数据时 | 事件如何持久化、推送和投影，诊断数据有哪些边界 |
| [后台控制面与运行配置](admin-control-plane.md) | 修改后台配置、凭据或 Worker 配置读取时 | 配置如何版本化、加密和按 Run 固定，未配置时进程如何表现 |
| [Agent 定义、版本与 Run 快照](agent-definition.md) | 修改 Agent 配置、Revision、导入导出或 Run 绑定时 | Definition 与 Revision 如何生效、配置引用如何保持安全 |
| [身份、账号与会话](identity-and-session.md) | 接入登录方式、维护账号映射或排查会话时 | Better Auth、Hoox 账号、Cookie、业务 Session 和后台配置如何分工 |
| [Thread 连续上下文](thread-continuity.md) | 修改 Thread、Run、输入、Compaction、恢复或 Sandbox 生命周期时 | 连续上下文由谁持久化，何时压缩、恢复和释放 |
| [Agent 协作与 Todo](agent-collaboration.md) | 修改子 Agent、协作控制面或任务计划展示时 | Agent 能调用哪些协作工具，隔离、并发、持久化和 Todo 约束是什么 |
| [Agent 评测](agent-evaluation.md) | 管理评测集、评测用例或发布门槛时 | 评测数据归属、断言证据和评测结果如何持久化与授权 |
| [工具调用模式](tool-calling-modes.md) | 切换正常/PTC 或修改程序化工具执行时 | 模式如何固定、用户展示和安全错误、内部审计与恢复限制是什么 |
| [Sandbox Provider](sandbox-providers.md) | 配置、扩展或排查 CubeSandbox/E2B 时 | Provider 如何选择、路由和标识，ResourceFS 与失败边界是什么 |
| [Skill Runtime](skill-runtime.md) | 修改 Skill Center、Run 快照、Prompt 注入或市场资源时 | Skill 属于谁，如何固定版本、加载指令并保持权限边界 |
| [团队协作](team-collaboration.md) | 修改团队、成员、团队任务、文件或 Tenant Skill 时 | 空间如何授权，成员退出、分支发布和跨空间复制如何处理 |
