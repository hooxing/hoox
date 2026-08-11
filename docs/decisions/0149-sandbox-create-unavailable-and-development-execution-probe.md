# ADR-0149：区分 Sandbox 确定性不可用与结果未知，并执行开发数据面预检

- 状态：已接受
- 日期：2026-08-11

## 背景

CubeSandbox 管理面可正常返回模板列表，并不代表模板存在健康副本，也不代表 CubeMaster 与 Sandbox 数据面可执行。实际故障中，CubeMaster 明确返回“模板没有健康副本”，Runtime 仍把创建结果归类为 `UNKNOWN`，导致 Attempt 进入 `recovery_required`、Run 保持 `running`。随后工具失败闩锁在下一模型轮次抛出的内部异常又被 Provider gate 统一改写为 `PROVIDER_BINDING_DRIFT`，使子 Agent 邮箱错误与真实 Sandbox 故障不一致。

开发预检此前只调用 Sandbox 列表接口和 Volume 只读探针，因此会在管理面健康、执行面不可用时错误通过。

## 备选方案

1. 所有 CubeSandbox 5xx 都继续按结果未知处理。安全但会把明确未创建的请求长期挂起，也无法向维护者提供可行动的分类。
2. 所有 CubeSandbox 5xx 都按确定性失败处理。可避免挂起，但网络超时或丢失成功响应时可能遗漏已经创建的 Sandbox，破坏泄漏治理不变量。
3. 仅识别上游明确表达“模板无健康副本”的应用错误，其余 5xx 继续对账并保留 `UNKNOWN`；同时保留模型继续闩锁的独立错误类型，并让开发预检执行一次完整 create/command/kill 生命周期。

## 决策

采用方案 3。

- Sandbox 适配层新增稳定码 `CREATE_UNAVAILABLE`，只匹配 CubeMaster 明确报告模板无健康副本或没有健康节点的错误。该错误代表创建未应用，直接返回确定性失败，不登记未知生命周期事件。
- 网络错误、普通 5xx、取消与超时仍执行既有 metadata 对账；无法确认时继续使用 `UNKNOWN`，不放宽泄漏治理。
- Pi 适配层新增 `ModelContinuationRejectedError`，区分工具 Observation 不完整与工具副作用已拒绝。Provider gate 只把真正的 Provider 绑定异常归类为 `PROVIDER_BINDING_DRIFT`，不再覆盖 Runtime 自身的继续闩锁。
- 开发 Worker 预检在管理面和 Volume 探针之后，创建短 TTL Sandbox，执行固定无副作用命令并在 `finally` 中销毁。生产 readiness 仍保持只读，避免健康探针持续创建资源。
- 空白 CubeSandbox API key 归一化为匿名配置 `null`，避免独立 smoke 入口与 Worker 环境解析产生不一致。

## 影响

- 模板容量或健康副本不足会使 Run 确定性失败，不再无故进入恢复态。
- 子 Agent 的工具失败不会再伪装成 Provider 绑定漂移。
- `dev:worker:check` 会真实验证模板调度和数据面，执行面不可用时启动前失败；每次预检会短暂创建一个 Sandbox，并保证尝试清理。
- 生产 readiness 的资源开销和行为不变。

## 验证

- Sandbox 单元测试覆盖无健康副本、未知创建结果、Volume attach 明确失败与空白 API key。
- Pi Session 单元测试覆盖模型继续闩锁错误不会被改写为 Provider 漂移。
- Worker Runtime 单元测试覆盖开发预检的 create/command/kill 和异常清理。
- 受影响包执行测试、typecheck、lint 与格式检查。

## 可逆性

可分别回退 `CREATE_UNAVAILABLE` 映射、模型继续闩锁类型或开发执行预检。回退前必须恢复对应旧语义的测试；不得在没有替代泄漏治理方案时把所有 5xx 改成确定性失败。
