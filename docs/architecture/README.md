# 架构文档

架构文档从仓库 HEAD 的视角解释系统边界、运行关系和关键不变量。需要追溯为什么选择某个方案时，再进入相关 ADR。

| 文档 | 什么时候阅读 | 回答的问题 |
| --- | --- | --- |
| [架构总览](overview.md) | 第一次理解 Hoox 或评估跨模块改动时 | 系统上下文、领域关系、运行链路和可靠性原则是什么 |
| [仓库导览](repository-map.md) | 准备修改代码或新增模块时 | 应修改哪个应用或共享包，依赖边界是什么 |
| [身份、账号与会话](identity-and-session.md) | 接入登录方式、维护账号映射或排查会话时 | Better Auth、Hoox 账号、Cookie、业务 Session 和后台配置如何分工 |
| [Thread 连续上下文](thread-continuity.md) | 修改 Thread、Run、输入、Compaction、恢复或 Sandbox 生命周期时 | 连续上下文由谁持久化，何时压缩、恢复和释放 |
| [Agent 协作与 Todo](agent-collaboration.md) | 修改子 Agent、协作控制面或任务计划展示时 | Agent 能调用哪些协作工具，隔离、并发、持久化和 Todo 约束是什么 |
| [工具调用模式](tool-calling-modes.md) | 切换正常/PTC 或修改程序化工具执行时 | 模式如何固定、安全边界、内部审计与恢复限制是什么 |
| [Sandbox Provider](sandbox-providers.md) | 配置、扩展或排查 CubeSandbox/E2B 时 | Provider 如何选择、路由和标识，ResourceFS 与失败边界是什么 |
| [Skill Runtime](skill-runtime.md) | 修改 Skill Center、Run 快照、Prompt 注入或市场资源时 | Skill 属于谁，如何固定版本、加载指令并保持权限边界 |
| [团队协作](team-collaboration.md) | 修改团队、成员、团队任务、文件或 Tenant Skill 时 | 空间如何授权，成员退出、分支发布和跨空间复制如何处理 |
