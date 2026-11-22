# 参考文档

参考文档用于查找当前仓库的参数、协议、路径和可观察行为，不要求按顺序阅读。

| 文档 | 什么时候阅读 | 回答的问题 |
| --- | --- | --- |
| [Webhook](webhooks.md) | 注册 Tenant 回调或实现接收端时 | 可订阅哪些事件、如何验签、如何按至少一次语义去重？ |
| [HTTP 工具](http-tools.md) | 编写业务方 HTTP 工具接收端或维护 Hoox HTTP Transport 时 | 请求签名格式、受控 OpenAPI 导入范围与失败语义是什么 |
| [配置参考](configuration.md) | 配置 API、Worker、Scheduler、存储、模型或 Sandbox 时 | 有哪些环境变量、默认值、必填范围和秘密边界 |
| [命令参考](commands.md) | 启动、迁移、校验或执行外部服务 Gate 时 | 应运行哪个命令，前置条件和影响范围是什么 |
| [Development API 契约](development-api.md) | 开发 Web 或本地集成时 | 当前 development HTTP 接口、身份和错误契约是什么 |
| [公开 API v1](public-api.md) | 以服务凭据接入 Hoox 时 | 哪些 v1 路由属于兼容契约，如何认证、续连事件和处理幂等？ |
| [历史文件与 ResourceFS](history-files.md) | 浏览个人历史交付物或在 Sandbox 中读取历史文件时 | 查询窗口、分页、虚拟目录、所有权和数据边界是什么 |
| [文件预览与选区引用](file-preview.md) | 维护交付文件预览或向 Agent 引用内容时 | 浏览器支持范围、大小屏交互、版本绑定与安全边界是什么 |
| [Todo Write](todo-write.md) | 实现或调用 `todo_write` 时 | 输入约束、全量快照、持久化和恢复语义是什么 |
| [品牌资产](brand-assets.md) | 修改工作台、管理台、站点图标或对外材料时 | 哪些文件是品牌真源、各版本如何使用以及哪些图形关系必须保持 |
| [UI 主题 Token](ui-theme.md) | 迁移或新增 Web、Admin Web 界面时 | 共享主题真源、语义角色、消费规则和当前迁移边界是什么 |

文中的路径、命令、端口、变量和协议必须与当前代码、配置及测试保持一致。
