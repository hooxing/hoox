# ADR-0051：Workspace 物化失败的脱敏诊断

- 状态：已接受
- 日期：2026-07-29

## 背景

真实 Worker 在模型启动前将 Workspace 物化失败统一收敛为 `WORKSPACE_CONFLICT`。这个公开错误码不能携带数据库驱动异常、Sandbox 标识、对象键、路径或 Provider 响应，因此仅靠 Run 事件无法区分可复现的装配/依赖故障。

## 决策

`ManifestWorkspaceRuntime` 在受信边界按阶段包装失败：读取当前 head、打开 Workspace、空基线快照、基线列举、基线释放和 Materializer。Worker 保留 API 和持久化 Run 事件的稳定 `WORKSPACE_CONFLICT` 语义，并在本地日志中仅输出固定阶段或固定分类。日志不包含原始 error message、stack、路径、对象键、URL、租户或凭据。

真实复现确认 Worker 曾把含 `/` 的路径式字符串传给 Workspace operation journal；该协议字段只允许字母、数字、点、下划线、冒号和连字符。Worker 统一改用稳定的冒号分隔键：`<attemptId>:workspace:materialize` 与 `<attemptId>:workspace:publish:<round>`。不放宽全局 operationKey 字符集，避免路径语义重新进入幂等键边界。

## 影响

运维可借助本地 Worker 日志定位物化边界，外部调用方、数据库事实和错误协议均不扩大可观察信息。该诊断可在不改变失败关闭行为的前提下继续保留；如果未来引入受审计的结构化日志，应迁移同一固定分类而非原始异常。

## 验证

`workspace-runtime.test.ts` 断言读取 head 失败只抛固定阶段，`run-worker.test.ts` 断言物化失败仍然 cleanup 并返回 `WORKSPACE_CONFLICT`，且日志只含固定阶段分类。

## 可逆性

可移除本地日志和阶段包装而不影响持久化协议；移除前应确认已有等价的脱敏结构化观测。
