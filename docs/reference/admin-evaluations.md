# 评测管理 API

本文面向 Agent 管理员，列出控制面评测集管理路由。路由需要有效后台会话及 Agent 管理权限；所有请求和响应使用后台 API 的标准成功/错误封套。

当前提供评测集与用例读写、删除，评测运行发起/读取/取消和 Revision 对比接口。批次由 Admin Control API 自动执行和结算；从真实 Thread 导入用例和模型评审未启用。评测用例输入和附件引用仅在响应操作者具备 `run_content.read` 时返回；其他角色获得空输入和空附件列表，已有内容不会被其整体保存请求覆盖。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /v1/admin/control/agent-definitions/{definitionId}/evaluations` | 列出该 Agent 的评测集及用例 |
| `PUT /v1/admin/control/agent-definitions/{definitionId}/evaluations` | 整体创建或替换评测集及用例；路径中的 Agent 必须与正文 `definitionId` 相同 |
| `DELETE /v1/admin/control/agent-definitions/{definitionId}/evaluations/{suiteId}` | 删除没有评测运行引用的评测集 |
| `POST /v1/admin/control/agent-definitions/{definitionId}/evaluations/{suiteId}/runs` | 以有 `run_content.read` 的发起人身份，在其个人 Tenant 排队执行指定 Revision |
| `GET /v1/admin/control/agent-definitions/{definitionId}/evaluations/runs` | 列出评测运行摘要 |
| `GET /v1/admin/control/agent-definitions/{definitionId}/evaluations/runs/{runId}` | 查看运行和用例结果 |
| `DELETE /v1/admin/control/agent-definitions/{definitionId}/evaluations/runs/{runId}` | 请求取消运行；排队用例立即取消，活动 Run 异步取消 |
| `GET /v1/admin/control/agent-definitions/{definitionId}/evaluations/compare?leftRunId=…&rightRunId=…` | 对比同一评测集的两个运行 |

附件引用支持 `resourceId + versionId` 和 Artifact。用例断言由结构化 Schema 校验，可配置回复包含文本、回复正则、是否调用指定工具、Artifact 名称或类型以及评审模型最低分。正则限 256 字符，不支持分组、转义且最多一个量词，避免执行不受界定的回溯表达式。

评测集属于单个 AgentDefinition。发布请求可选择评测集与最低通过率；数据库在发布 Revision 的同一事务中校验该草稿 Revision 的最新完整评测结果，不满足门槛时发布事务回滚。摘要中的 `passRate` 是通过数除以总用例数，空批次为 0。详情用 `queued`、`running` 区分未结算用例，`unknown` 表示结果无法确认。

`EVALUATION_POLL_MS` 配置控制面轮询间隔（50–60000 毫秒，默认 1000），`EVALUATION_GLOBAL_CONCURRENCY` 配置跨批次总并发（1–1024，默认 8，各控制面实例应保持一致）。`maxConcurrency` 另行限制单一批次。API 服务地址复用 `ADMIN_CONTROL_IDENTITY_API_URL`，只接受 HTTPS 或本机回环 HTTP。
