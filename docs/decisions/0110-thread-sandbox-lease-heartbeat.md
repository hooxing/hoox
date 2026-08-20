# ADR-0110：Run 心跳同步续租 Thread Sandbox

- 状态：已接受
- 日期：2026-08-05


## 背景

启用 Thread Sandbox 复用后，Worker 会为当前 Run 获取独立的 Sandbox 租约。此前周期心跳只续租 Run 写入栅栏，没有续租已经获取的 Sandbox 租约。首次工具调用需要创建 Sandbox 并物化 Workspace；当这一步超过租期时，物化虽已完成，后续 attestation 仍会因租约过期失败，导致命令尚未真正执行就把 Run 标记为需要恢复。

## 决策

- `ThreadSandboxSessionLifecyclePort` 增加受 scope、attempt 与租约令牌约束的 `renew` 操作。
- Worker 心跳在 Run 栅栏续租成功并确认 scope 一致后，同步续租当前 Thread Sandbox。
- Sandbox 续租丢失时停止当前 Worker 并按 `fence_lost` 收敛；持久化不可用时按 `unavailable` 收敛，禁止继续执行工具。
- PostgreSQL 实现只更新仍有效、未释放且通过完整租约栅栏校验的记录，不允许复活已经过期的租约。

## 影响

耗时的 Sandbox 准备、Workspace 物化和后续工具执行不再受单个初始租期限制。Run 与 Sandbox 的所有权仍保持 fail-closed：任一续租失败都会停止执行，而不是绕过 attestation。接口新增方法需要所有 lifecycle 实现显式支持。

## 验证

Worker 单元测试在阻塞 Workspace 物化期间触发心跳，确认 Thread Sandbox 完成续租后仍可 attestation 并成功结束 Run；同时执行相关格式、类型检查和测试。
