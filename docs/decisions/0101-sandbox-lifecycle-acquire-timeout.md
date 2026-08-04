# ADR-0101：Sandbox acquire 显式使用 Lifecycle 超时

- 状态：已接受
- 日期：2026-08-04
- 决策者：Runtime 维护者
- 关联任务/PR：PPTX Skill 首次命令触发 `SANDBOX_UNKNOWN` 修复
- 替代关系：细化 ADR-0069 的 Sandbox lifecycle 外部调用边界

## 背景

Worker 已把 Thread Sandbox lifecycle 超时配置为 90 秒，但装配 `CubeSandboxGateway` 时仍把普通操作
默认超时固定为 5 秒。冷创建与重新连接没有传显式 timeout，因此继承了 5 秒上限；最近一次测试 Run
的 create effect 在约 5.6 秒后进入 `unknown`，没有取得 provider sandbox ID，Attempt 随后进入
`SANDBOX_UNKNOWN/recovery_required`。

Gateway 的 5 秒默认值还服务于 readiness 等短操作，不能简单全局提高。创建、连接、暂停、关闭属于
lifecycle 操作，应统一服从已有的 lifecycle timeout。

## 决策

- `CubeSandboxSessionRegistry.acquire/create/connect` 调用 Gateway 时显式传入
  `lifecycleTimeoutMs`；
- 普通 Gateway 默认操作超时仍保持 5 秒，readiness 与非 lifecycle 调用不受影响；
- pause/kill 继续使用同一个 lifecycle timeout；
- 超时后的 UNKNOWN 语义不变：Runtime 不会在结果不确定时盲目重试创建。

## 理由

在调用点显式区分 lifecycle 和普通操作，使 90 秒配置真正覆盖全部 acquire 路径，同时保留快速预检。
这比提高 Gateway 全局默认值更窄，也避免命令、探针等操作意外等待 90 秒。

## 影响

- 正常但耗时超过 5 秒的 Sandbox 冷创建或连接不再被提前判为 UNKNOWN；
- 真正超过 lifecycle timeout 的不确定结果仍会进入既有隔离与恢复流程；
- 不修改数据库 schema 或已持久化的 UNKNOWN effect；已经失败的 Run 不会自动重放。

## 验证

- 单元测试在 Gateway 默认值为 5 秒、lifecycle 配置为 90 秒时，断言 create/connect 收到显式
  90 秒；
- Agent Worker typecheck、相关 Worker 回归测试、格式和 lint 通过。

## 可逆性与回退

修改仅影响调用参数，可直接回退；回退后慢于 5 秒的创建会再次产生 UNKNOWN。

## 实施记录

- 2026-08-04：create/acquire/connect 统一显式传入 lifecycle timeout。
