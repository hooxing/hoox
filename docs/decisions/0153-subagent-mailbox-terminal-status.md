# ADR-0153：SubAgent mailbox 显式携带终态与错误码

- 状态：已接受
- 日期：2026-08-12
- 决策者：Cube Runtime 维护者
- 关联任务/PR：`fix/subagent-control-contract`
- 替代关系：补充 ADR-0122 与 ADR-0127

## 背景

SubAgent mailbox 只用 `final_answer` 与 `error` 区分成功和非成功结果。Turn 持久层已经区分 `completed`、`interrupted` 与 `failed`，也保存错误码，但父 Agent 通过 `wait_agent` 收到的 `error` 消息无法判断是主动中断还是执行失败，只能解析自然语言 payload。

## 决策驱动因素

- 父 Agent 应基于结构化事实而不是文本猜测终态；
- mailbox 必须保留幂等重放和数据库审计能力；
- 普通 Agent 间消息不能伪装为终态；
- 兼容现有 `message`、`final_answer`、`error` kind。

## 备选方案

### 方案 A：只在内存返回值中增加状态

数据库仍缺少对应事实，重放与审计不完整，不采用。

### 方案 B：把 kind 改为 completed、interrupted 和 failed

判别清晰，但会直接替换现有协议值并扩大兼容成本，暂不采用。

### 方案 C：保留 kind，并增加 terminal status 与 error code

`final_answer` 固定对应 `completed`；`error` 必须对应 `interrupted` 或 `failed`，并携带错误码；`message` 不携带终态。

## 选择

采用方案 C。模型可见更新使用判别联合；持久 mailbox 新增 `terminal_status` 和 `error_code`，数据库约束三类消息的合法组合。

## 理由

该方案在不改变现有 kind 的前提下补齐机器可判定的结束语义，并让内存返回、持久记录与 Agent Turn 事实保持一致。

## 影响

### 正面影响

- 父 Agent 可以可靠区分完成、中断和失败；
- 错误码成为可审计的结构化字段；
- 非法 kind/status 组合由数据库拒绝。

### 负面影响与成本

- 新增两列和一个检查约束；
- 所有 mailbox 写入必须提供符合 kind 的终态形状。

### 安全、数据与运维影响

不增加权限。迁移会把旧 `final_answer` 回填为 `completed`，把无法精确判断来源的旧 `error` 保守回填为 `failed/LEGACY_SUBAGENT_ERROR`，再启用形状约束。该回填不改写 payload。

## 验证

- Supervisor 测试断言成功消息包含 `status: completed`；
- 中断测试断言错误消息包含 `status: interrupted` 与 `errorCode: INTERRUPTED`；
- migration 测试检查列和合法组合约束；
- 执行 run-contracts、persistence 与 Agent Worker 类型检查及受影响测试。

## 可逆性与回退

down migration 可删除新增列和约束；回退后父 Agent 会再次失去中断与失败的结构化区分。

## 后续工作

- 无。

## 实施记录

- 2026-08-12：增加 mailbox 终态、错误码和数据库约束。
