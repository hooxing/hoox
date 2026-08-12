# ADR-0160：wait_agent 强制显式传入 mailbox 游标

## 背景

`wait_agent` 已返回 `nextAfterSequence`，但输入 `after_sequence` 仍是可选字段并默认取 0。实测中父 Agent 首次等待后正确拿到游标 1，后续启动新 turn 时却遗漏该字段，于是再次从 0 读取，结果同时收到旧的中断消息和新的完成消息。

可选游标让“读取全部历史”和“忘记推进游标”无法区分。重复消息虽然没有破坏数据库事实，但会增加模型误判终态、重复汇报或重复处理的风险。

## 决策

`wait_agent.after_sequence` 改为必填非负整数：

- 首次等待显式传 `0`；
- 后续等待传上一次返回的 `nextAfterSequence`；
- 缺失字段经 schema 参数桥形成 durable 失败回执，不再静默回退到 0。

`timeout_ms` 继续保持可选，默认 30 秒。

## 影响

- 工具调用方必须维护并显式提交 mailbox 游标。
- 旧模型若遗漏字段会收到可纠正的参数错误，而不是重复读取历史消息。
- 不改变 mailbox 的保存范围、序号语义和 `nextAfterSequence` 返回结构。

## 验证

- Pi Adapter 测试覆盖缺失 `after_sequence` 时 schema 桥拒绝并写入失败回执。
- 既有首次等待使用 `after_sequence: 0` 的行为继续有效。

## 可逆性

可恢复为 optional 并默认 0，但会重新引入遗漏字段与主动回读历史不可区分的问题。
