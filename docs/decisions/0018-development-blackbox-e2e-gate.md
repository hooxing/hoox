# ADR-0018：开发黑盒纵向 Gate 与 Thread 原子创建

## 状态

已接受（仅开发/测试 Gate）。

## 背景

M4 需要在真实 PostgreSQL、真实 HTTP 端口和 RLS 事务上验证最小纵向路径，但此阶段不能把 Faux Pi、开发身份或 Fake Sandbox 误接入生产。此前 API 已有原子 Run+Dispatch Outbox 创建能力，Thread 与初始 Workspace 却缺少同事务的生产端口，导致黑盒路径只能依赖测试预置数据。

## 决策

1. 新增 `PgThreadCreation` 与 `api_thread_idempotency_records`。它在固定成员资格校验、Thread、空 Workspace 和 Thread 幂等记录之间使用同一个租户事务；相同幂等键只能重放同一 Thread，不同请求摘要统一冲突。
2. 开发身份解析器只接受 `Bearer dev-user-a` 与 `Bearer dev-user-b` 两个固定本地选择器。构造器在 `production` 直接拒绝；进程环境解析器仍要求 `DEV_AUTH_ENABLED=true` 时显式提供两组主体，并由共享环境解析器拒绝生产开启。
3. 黑盒 Gate 必须经由 Fastify `listen()` 的真实回环 HTTP 端口，而非 `inject()`；持久层使用隔离 PostgreSQL schema、受限 runtime role 与 RLS。测试覆盖用户 A 创建/同键重放、用户 B 猜测 ID 统一 `not_found`、ready 依赖失败不泄漏底层错误、Run Dispatch→Worker→Pi adapter→终态，以及重新构造 Scheduler 后不重复执行已终态 Run。
4. CI 在 Linux PostgreSQL service 上运行该 Gate。模型路径使用 Pi adapter 的 `fauxProvider` 与 `PiWorkerSessionFactory`，并断言 model_start permit 已消费；不是 `ScriptedAgentSession` 替身。`FakeSandboxGateway` 仅由 `@cube-runtime/sandbox/testing` 显式子路径导出，生产主入口不导出 Fake；应用 production 入口仍保持 `ASSEMBLER_MISSING` fail-closed，不能把测试 Fake 静默带入部署路径。
5. 本 Gate 的无 Artifact 场景仅验证 `ArtifactPublicationPort` 的完成前检查：没有声明 Artifact 时 Run 可安全成功，API 不伪造可下载链接。真实 MinIO 上传、预览与 Artifact 发布留在后续交付物切片。
6. Worker 正常完成时会在同一 cleanup 状态机中关闭 Sandbox；测试随后运行真实 PG cleanup consumer，确认没有可领取残留并检查 Faux Sandbox 已 kill。此用例不是 CubeSandbox 0.6 兼容性验收。

## 明确不在本 Gate 中的事项

- 不启动可部署的 API/Worker 生产装配器；当前只有 Scheduler cleanup 有其独立的封闭生产装配路径。
- 不调用真实模型、真实 CubeSandbox 0.6 或生产 MinIO。它们只能通过已有显式 opt-in smoke 命令执行，不能进入 CI 默认路径。
- 不把进程 `SIGTERM` drain 伪装为本纵向用例已经覆盖：该行为仍由 `process-runtime` 容器 Gate 验证。API/Worker 形成真实生产装配器后，应新增独立进程级黑盒测试，把 drain 与在途 Worker 许可边界一起覆盖。
- Dispatch 进程崩溃发生在“已领 Outbox、尚未调用 Worker”之间的恢复，已有 PG Outbox generation/lease 契约覆盖；本 Gate 以第二个 dispatcher tick 证明终态 Run 不会被再次启动，而不声称模拟了所有崩溃时序。

## 后果

黑盒 Gate 把当前可证实范围限定为“Linux 开发/测试模式的真实 HTTP+PG+Pi adapter（Faux Provider）纵向链路”。这提高了后续真实 CubeSandbox、模型与对象存储接入时的回归基线，但不等同于 production readiness。任何将开发身份、Faux Provider 或 Fake Sandbox 引入生产装配的变更，均应被视为 ADR 违反。
