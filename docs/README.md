# Hoox 文档中心

本目录帮助读者理解和维护 Hoox 的**当前行为**。架构约束和不变量以 `architecture/` 下的现状文档为准；计划、Spike 和验证记录只保存实施顺序或时点证据，不能代替当前架构、参考和运维说明。

## 按任务阅读

| 你要完成的任务 | 入口 |
| --- | --- |
| 判断仓库当前能做什么、离生产使用还缺什么 | [项目状态](project-status.md) |
| 评估或升级首个公开版本，确认已知限制与兼容性 | [v0.1.0 版本说明](releases/v0.1.0.md) · [变更记录](../CHANGELOG.md) |
| 理解系统边界、领域关系和主运行链路 | [架构总览](architecture/overview.md) · [架构文档索引](architecture/README.md) |
| 理解 Run 执行、双栅栏、重试与恢复 | [Run 执行与恢复](architecture/run-execution-and-recovery.md) |
| 理解数据库、RLS、角色与迁移边界 | [持久化与数据库边界](architecture/persistence-and-database.md) |
| 理解多轮 Thread、输入、压缩、恢复与 Sandbox 保留 | [Thread 连续上下文](architecture/thread-continuity.md) |
| 理解子 Agent、控制工具、共享 Sandbox 与 Todo | [Agent 协作与 Todo](architecture/agent-collaboration.md) |
| 理解 CubeSandbox/E2B 的选择、路由与限制 | [Sandbox Provider](architecture/sandbox-providers.md) |
| 理解 Skill 的安装、Run 快照、加载与资源边界 | [Skill Runtime](architecture/skill-runtime.md) |
| 理解团队、成员、任务发布和跨空间文件边界 | [团队协作](architecture/team-collaboration.md) |
| 准备本地环境并启动开发工作台 | [开发环境准备](development.md) |
| 查找代码应修改的位置 | [仓库导览](architecture/repository-map.md) |
| 配置服务、运行命令或调用 Development API | [配置参考](reference/configuration.md) · [命令参考](reference/commands.md) · [Development API](reference/development-api.md) |
| 配置 Tenant Webhook 或实现事件接收端 | [Webhook 参考](reference/webhooks.md) |
| 理解个人历史文件和 ResourceFS 路径 | [历史文件与 ResourceFS](reference/history-files.md) |
| 理解 `todo_write` 协议和持久化语义 | [Todo Write](reference/todo-write.md) |
| 部署、发布或排查运行问题 | [运维文档](operations/README.md) · [维护者文档](maintainers/README.md) |
| 理解 Hoox 的产品方向与可定制 Agent 平台的目标契约 | [可定制 Agent 平台规范](specs/custom-agent-platform.md) · [实施计划](plans/20261119-custom-agent-platform.md) |
| 设计 MCP Server 或外部工具接入 | [MCP 与外部工具接入规范](specs/mcp-and-external-tool-integration.md) |
| 了解尚未完成的战略方向或有效实施计划 | [项目路线](roadmap.md) · [实施计划](plans/README.md) |
| 查看实验或验收的时点证据 | [Spike](spikes/README.md) · [验证与评测](verification/README.md) |

## 文档类型

| 类型 | 目录或文件 | 权威范围 |
| --- | --- | --- |
| 当前说明 | `architecture/`、`development/`、`reference/`、`operations/`、`maintainers/`、`project-status.md` | 描述仓库 HEAD 的行为、接口、维护和限制；`architecture/` 同时承载关键设计约束 |
| 目标规范 | `specs/` | 描述跨模块能力必须满足的目标与约束，并明确实现状态 |
| 实施计划 | `plans/` | 只保存仍可能指导后续工作的草案、进行中或阻塞计划 |
| 战略方向 | `roadmap.md` | 只保存尚未完成的方向和阶段 Gate，不维护任务账本 |
| 时点证据 | `verification/`、`spikes/`、`releases/` | 记录特定提交、环境或时间点的实验、验收与版本发布范围，不替代当前说明 |

## 分类入口

- [架构](architecture/README.md)
- [开发专题](development/README.md)
- [参考](reference/README.md)
- [运维](operations/README.md)
- [维护者](maintainers/README.md)
- [功能规范](specs/README.md)
- [实施计划](plans/README.md)
- [Spike](spikes/README.md)
- [验证与评测](verification/README.md)

## 维护原则

- 根 README 只负责项目定位、最短启动路径和入口导航。
- 当前行为写入主题文档，并由代码、配置和测试验证；不要求读者通过计划或提交历史拼装现状。
- 一个事实只保留一个主要归属，其他文档只保留完成局部任务所需的摘要和链接。
- 影响架构边界的决定直接更新 `architecture/` 中对应的现状文档，不另建决策账本；历史讨论以 Git 历史为准。
- 计划完成、被替代或放弃后，先把最终行为写入当前说明，再删除计划并更新全部入链。
- 命令、路径、端口、环境变量和版本必须能从当前仓库验证。
- 不在文档、示例、日志或截图中写入真实凭据、生产数据和内部服务秘密。

文档分类、生命周期和写作规则以 [`docs/AGENTS.md`](AGENTS.md) 为准。
