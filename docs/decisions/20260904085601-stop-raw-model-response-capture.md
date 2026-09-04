# ADR-20260904085601：停止原始模型响应采集与轨迹展示

- 状态：已接受
- 日期：2026-09-04
- 替代关系：部分替代 [ADR-0055](0055-model-wire-trace-diagnostics.md) 的原始 response 采集与镜像要求，以及 [ADR-20260818001636](20260818001636-converge-model-wire-diagnostics-to-internal-viewer.md) 中保留全部原始模型报文采集和内部展示的范围。
- 当前说明：[Development 诊断指南](../maintainers/diagnostics.md)

## 背景

内部轨迹已经保存模型思考、完整回复、Tool Call 和工具结果。`/trajectory/` 的 `response complete` 额外展示相同调用的原始 SSE；继续保存逐片报文增加敏感数据副本、响应流旁路消费和存储成本，维护者不需要依赖它判断请求与返回内容。

## 备选与选择

1. 只隐藏按钮：保留全部采集成本，无法满足停止存储的要求。
2. 只丢弃状态为 `complete` 的 response：仍需读取整个响应以判断采集状态，截断和异常报文仍形成第二份正文。
3. 停止全部原始 response 正文采集，保留 request 和结构化轨迹，查看器同时拒绝历史 response：选择此方案，直接移除重复数据来源。

## 决策与边界

- Worker 不再 clone 或旁路读取 Provider Response，不调用持久化端口保存原始 response 正文，因此 PostgreSQL/MinIO 和 development 本地镜像均不再新增此类正文。
- 最终 Fetch request 字节、请求上限、模型轮次和传输重试身份不变。模型回复、思考、工具参数和结果仍走既有轨迹事件链路。
- Fetch 返回 Response 前的拒绝/中止仍记录无正文失败类别，不替换原始错误。收到 Response 后直接交还 Provider；后续流消费和失败语义由原消费方负责。
- 内部查看器列表和正文读取共用 request 白名单，任何状态的旧 response 文件均不可通过该入口读取。
- 不删除历史文件、数据库行或 Blob，不修改已执行/已提交迁移；[ADR-0056](0056-model-wire-trace-safe-reading.md) 的服务端授权读取协议及旧 response 读取兼容性继续有效。已有索引与对象仍按原 retention/GC 处理，本地镜像仍无自动清理保证。

## 影响

新增运行无需为原始响应建立第二个流消费者和敏感正文副本。代价是无法再用新运行的 wire trace 逐字节复现 SSE 分片或非 2xx 正文；运行结果和工具调用仍可由轨迹诊断。采集开关、认证、权限、请求保留和生产失败关闭边界不变。

## 验证

- transport 测试确认只持久化 request、不调用 Response.clone，成功、非 2xx、断流与取消仍维持调用方语义。
- 真实 Pi transport 测试覆盖工具循环、自动重试与并发 Attempt，不再产生 response 正文记录。
- 查看器测试确认历史 response 不列出且不可读取，request、思考、回复和工具事件仍可查看，旧文件未删除。

## 可逆性

可回退采集和查看器代码以恢复后续 response 采集与历史展示，不需要数据库迁移。停采期间的原始响应字节不可追溯补回；禁止把结构化轨迹重编码后声称为原始报文。
