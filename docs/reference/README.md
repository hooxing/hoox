# 参考文档

参考文档用于查找当前仓库的参数、协议、路径和可观察行为，不要求按顺序阅读。

| 文档 | 什么时候阅读 | 回答的问题 |
| --- | --- | --- |
| [配置参考](configuration.md) | 配置 API、Worker、Scheduler、存储、模型或 Sandbox 时 | 有哪些环境变量、默认值、必填范围和秘密边界 |
| [命令参考](commands.md) | 启动、迁移、校验或执行外部服务 Gate 时 | 应运行哪个命令，前置条件和影响范围是什么 |
| [Development API 契约](development-api.md) | 开发 Web 或本地集成时 | 当前 development HTTP 接口、身份和错误契约是什么 |
| [历史文件与 ResourceFS](history-files.md) | 浏览个人历史交付物或在 Sandbox 中读取历史文件时 | 查询窗口、分页、虚拟目录、所有权和数据边界是什么 |
| [Todo Write](todo-write.md) | 实现或调用 `todo_write` 时 | 输入约束、全量快照、持久化和恢复语义是什么 |

文中的路径、命令、端口、变量和协议必须与当前代码、配置及测试保持一致。
