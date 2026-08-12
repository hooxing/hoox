# ADR-0164：wait_agent 明确全局 mailbox 序号允许空洞

## 背景

SubAgent mailbox 在同一 Attempt 内使用全局递增序号。`send_message` 会把 Root 发往子 Agent 的反向消息写入同一 mailbox，因此也占用 sequence；`wait_agent` 只向 Root 返回以 Root 为接收者的更新，不回显反向消息。

由此可能出现 updates 从 sequence 3 直接跳到 5，而数据库中的 sequence 4 是 Root 发往子 Agent 的 message。该空洞是方向过滤结果，不是消息丢失。此前工具描述没有说明这一点，父 Agent容易误判。

## 决策

保持全局 mailbox 序号与现有过滤语义，不增加隐式消费状态，也不为不同方向重新编号。工具契约明确说明：

- `sequence` 属于当前 Attempt 的全局 mailbox；
- 发往子 Agent 的反向消息不会出现在 Root 的 `updates` 中；
- 因方向过滤产生的序号跳跃是合法行为，不表示丢消息；
- 调用方仍直接使用 `nextAfterSequence` 推进游标，不自行要求序号连续。

## 影响

- 不改变数据库、返回结构或游标算法。
- 父 Agent 可正确解释序号空洞，并继续使用 Runtime 返回的游标。
- `send_message` 不会被重复回显到 Root updates。

## 验证

Pi Adapter 测试断言 `wait_agent` 工具描述包含序号允许跳跃且空洞不表示丢消息的说明；Run Contracts 同步记录该不变量。

## 可逆性

可移除说明，但会重新增加父 Agent 将方向过滤误判为消息丢失的风险。
