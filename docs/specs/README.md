# 功能规范

本目录只保存仍需要作为目标契约维护、且尚不能由当前说明完整表达的跨模块规范。

| 规范 | 状态 | 什么时候阅读 | 回答的问题 |
| --- | --- | --- | --- |
| [可定制 Agent 平台规范](custom-agent-platform.md) | 草案 | 理解 Hoox 的产品方向，或设计 Agent 定义、提示词分层、外部工具、Headless API、Playground、评测与观测时 | Hoox 要成为什么样的平台，AgentDefinition 与 Run 快照、Operator 指令、工具接入方式、公开 API、测试与观测必须满足哪些约束，还有哪些待决问题 |
| [MCP 与外部工具接入规范](mcp-and-external-tool-integration.md) | 草案 | 设计、评审或实施 MCP Server 与其他外部工具接入时 | 能力如何注册、发布与固定 Run 快照，工具 schema、授权与网络出口边界是什么，失败语义、凭据、观测和验收要求是什么 |

已经完成或被实现演进替代的规范在迁入当前说明后删除，历史版本以 Git 历史为准；当前行为从
[架构文档](../architecture/README.md)、[参考文档](../reference/README.md)和代码测试进入。
