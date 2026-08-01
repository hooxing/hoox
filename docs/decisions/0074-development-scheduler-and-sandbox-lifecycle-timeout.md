# ADR-0074：开发 Scheduler 常驻与 Sandbox lifecycle 专用超时

- 状态：已接受
- 日期：2026-08-01

## 背景

Thread Sandbox 的 pause/terminate 正常路径由 Agent Worker 发起；结果不确定时，由 Scheduler 对 `sandbox_lifecycle_effects` 做状态对账。真实 docx 回归中，文件已经成功交付，但 pause 使用了 Cube 普通操作的 5 秒默认超时：Provider 在 5 秒内未返回，effect 被正确隔离为 `unknown`。由于开发环境没有可启动的 Scheduler 入口，页面会长期停留在“正在暂停/正在对账”，已经实际 paused 的 Sandbox 也无法回写为 `paused`。

`THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS` 已存在且默认 90 秒，但此前只用于数据库 transition wait，没有传给 Worker 的 pause/kill 调用。

## 约束

- 普通命令的短超时不能被无意放大；模型工具执行与 lifecycle 控制是不同的故障边界。
- 不确定的远端副作用不能直接重试；必须由 Scheduler 先 inspect，再决定收敛动作。
- Scheduler 仍按单 Tenant 消费，不能绕过 RLS 扫描所有租户。
- 开发工作台的 user-a、Worker 与 Scheduler 必须使用同一 Tenant。

## 备选

1. 保持 5 秒 pause 超时，仅把 UI 改成“对账中”。这能改善文案，但没有消费者时状态永远不能收敛。
2. 把 CubeGateway 的所有操作默认超时统一改为 90 秒。实现简单，但会同时放大普通命令、文件和探针的等待时间。
3. 为 settle 单独传入 lifecycle timeout，并补齐开发 Scheduler 常驻入口。正常 pause 获得合理时间，不确定结果仍由 durable effect 对账。
4. Worker 在 pause 超时后立即重试。远端第一次调用可能已经成功，直接重试违反未知副作用不重放原则。

## 决策

选择方案 3：

- `CubeSandboxSessionRegistry` 单独持有 lifecycle timeout；pause 与 kill 显式使用它，普通命令继续保留 5 秒默认值。
- 生产/开发 Worker 装配把 `THREAD_SANDBOX_LIFECYCLE_TIMEOUT_MS` 传入 registry。
- Scheduler 增加 development 入口和根级 `dev:scheduler` 命令。
- `.env.example` 的 `SCHEDULER_TENANT_ID` 与本地 user-a/Worker 的 `tenant_a` 对齐。
- Web 在 Run 已终态但 Sandbox 仍为 `pausing`/`resuming` 时继续短轮询，直到进入稳定态；`unknown` 不做无限短轮询。

## 影响

正面影响：正常 pause 不再因 5 秒固定值过早进入 UNKNOWN；确实不确定的 effect 能由本地 Scheduler 持续对账；页面最终能显示 `Sandbox 已暂停`。

负面影响：完整开发拓扑多一个常驻进程；pause/kill 的最坏等待时间增加到显式 lifecycle timeout，但不会影响模型普通工具调用。

安全与运维：Scheduler 仍使用 runtime role 和明确 Tenant；开发者启动 API、Worker、Web 时还需启动 `pnpm dev:scheduler`。多 Tenant 环境需要按部署拓扑为每个授权 Tenant 配置消费者，不能把开发默认值复制到生产。

## 验证

- 单元测试证明 registry 的 pause 收到 90 秒 lifecycle timeout，而不是 5 秒普通操作超时。
- Web 单元测试证明终态 Run 会继续追踪 Sandbox 瞬时态，并在稳定态或 UNKNOWN 停止短轮询。
- Scheduler 进程入口、配置契约和完整 `pnpm check` 通过。
- 真实 docx 回归确认 Run 成功、Artifact 可下载；对 UNKNOWN effect 运行 Scheduler 后，数据库 Session 从 `unknown` 收敛为 `paused`。

## 可逆性

代码入口和专用超时可直接回退；回退后不会改变既有表结构，但开发环境会重新失去自动对账。已经写入的 UNKNOWN/succeeded lifecycle effect 是审计事实，不应删除或改写；由 Scheduler 继续按既有协议收敛。
