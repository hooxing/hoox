# ADR-0102：确定性 Sandbox 创建失败直接终止 Run

- 状态：已接受
- 日期：2026-08-04
- 决策者：Runtime 团队
- 关联任务/PR：ResourceFS Volume attach 失败排障与队列释放

## 背景

CubeMaster 在创建 Sandbox 时可能明确返回 Volume Plugin attach 失败，例如
`RESOURCEFS_VOLUME_PLUGIN_FAILED`。原 Gateway 把除鉴权和不存在之外的所有创建错误都登记为
`UNKNOWN`，Worker 随后把 Attempt 留在 `recovery_required`。这种语义适用于网络中断或超时导致的
“成功响应可能丢失”，却不适用于控制面已经明确拒绝创建且对账确认不存在 Sandbox 的情况。

同一问题也存在于模型上下文预算的确定性拒绝：当前 Attempt 已经不能继续，但进入人工恢复不会改变输入，
还会让 Thread 串行队列持续被未终止 Run 占用。

## 备选方案

### 所有创建失败继续登记 UNKNOWN

最保守，但会制造不存在的孤儿 Sandbox 恢复任务，并阻塞同一 Thread 的后续 Run。

### 所有 CubeAPI HTTP 错误都视为确定失败

实现简单，但代理层的 502、503、504 仍可能发生在服务端已经创建资源之后，不能据此证明副作用未发生。

### 只收敛可识别的确定拒绝

保留网络失败和普通 5xx 的 UNKNOWN 语义；仅在 CubeMaster 给出稳定、可识别的 ResourceFS attach 拒绝，
且按 create request metadata 对账没有发现 Sandbox 时，返回确定失败。

## 决策

选择“只收敛可识别的确定拒绝”：

- Sandbox 错误边界把 CubeMaster 的 `RESOURCEFS_VOLUME_PLUGIN_FAILED` 映射为内部稳定码
  `RESOURCE_VOLUME_FAILED`，不向 Agent 或用户暴露上游私有错误文本；
- Gateway 仍执行三次 request metadata 对账。若找到迟到创建的 Sandbox，按既有协议清理；若没有找到，
  `RESOURCE_VOLUME_FAILED` 直接返回，不登记 lifecycle UNKNOWN；
- 网络失败、超时和未识别的普通 CubeAPI 5xx 继续登记 UNKNOWN，并由恢复流程处理潜在孤儿资源；
- Worker 在尚未取得 Sandbox 时收到确定性 `SANDBOX_FAILED`，直接把 Attempt 与 Run 标记为 `failed` 并
  释放执行栅栏；Thread Sandbox 与一次性 Sandbox 使用相同终态语义；
- 模型返回确定性 `context_too_large` 时同样终止 Run。若此前已经创建 Sandbox，则先走既有 cleanup；
  如果 cleanup 结果未知，仍优先保留恢复语义。

## 理由

恢复状态只应用于外部副作用结果未知、持久化结果未知或存在可执行恢复动作的情况。明确失败不是恢复任务；
把它终止能够让调度器继续处理同一 Thread 后续消息，同时不会降低对真正迟到创建 Sandbox 的防泄漏保护。

`RESOURCE_VOLUME_FAILED` 只存在于 Sandbox 适配边界。Worker 继续对外使用 `SANDBOX_FAILED`，避免上层协议
依赖 Cube 部署细节。

## 影响

- ResourceFS 插件配置或数据面故障会显示为当前 Run 失败，不再把 Thread 永久停在排队状态；
- 该改动只修正错误分类和终态收敛，不会让损坏的 Volume Plugin 自动恢复；部署方仍需检查 Cubelet 的
  root 配置、HTTPS endpoint、签名密钥、rclone/FUSE 依赖和插件日志；
- 确定性上下文超限不会自动重试相同输入。未来若实现可验证的上下文重建，应新增显式重建状态机，而不是
  重新使用 `recovery_required`。

## 验证

- Sandbox 单元测试覆盖 CubeMaster 明确拒绝、三次对账无资源、无 UNKNOWN 事件；
- Worker 单元测试覆盖一次性与 Thread Sandbox 创建确定失败均提交 `failed` 并释放栅栏；
- Worker 单元测试覆盖 `context_too_large` 提交终态且释放栅栏；
- 既有网络超时与 acquire UNKNOWN 测试继续验证 Run 保持 running、Attempt 进入恢复并持久化生命周期事实。

## 可逆性与回退

删除专用错误映射并恢复 Worker 的 `requireRecovery` 分支即可回到原行为，不涉及数据库迁移。若未来 Cube API
提供结构化错误码，应以结构化字段替换当前受限消息匹配，并保持本 ADR 的确定失败判定原则。
