# ADR-0135：主模型输出上限有界续跑与失败现场保留

- 状态：已接受（试验分支）
- 日期：2026-08-09
- 决策者：Runtime 团队
- 关联任务/PR：`feat/context-auto-compaction`
- 关联决策：ADR-0069、ADR-0133、ADR-0134
- 替代关系：仅替代 ADR-0069 第 10 条中“所有失败均 terminate 当前可变缓存”的绝对规则；其他失败与取消语义不变

## 背景

最新长任务 `run_f2018cc0-55e2-4ab3-a4d7-01b4a4ec2309` 在 2026-08-09 18:14:57（Asia/Shanghai）完成第 117 次主模型调用时，以 `message.completed.stopReason=length` 结束。该轮没有最终正文或工具调用，主要输出预算消耗在 reasoning；Worker 只把 `stop` 视为完成，因此将已经完整落库的 `length` 终态映射成通用 `PROTOCOL` 失败。

同一 Run 的压缩并未失败：窗口 7 至 15 共提交 9 个 `applied` checkpoint，最后一次压缩也在主模型 length 终态之后成功把约 27,200 token 压到约 2,596 token。故障属于主模型单轮输出预算耗尽，不是上下文压缩失败。

失败终态随后沿用 ADR-0069 的旧规则关闭 Thread Sandbox。该 Sandbox 内的修改尚未形成 Workspace Revision，下一次 Run 只能 cold create，导致用户看到目录被重置，且没有 revision 可以重新物化未提交工作。对于普通协议损坏，关闭可变缓存仍是安全默认；但对于已确认的模型输出长度耗尽，直接销毁现场会把可恢复的长任务变成不可恢复失败。

## 决策驱动因素

- `length` 是 Provider 的正常终止原因，不应与畸形事件、重复工具调用等协议损坏混为一谈；
- 续跑必须有界，不能把输出上限变成无限 Provider 调用；
- 每次模型调用仍必须经过数据库双栅栏许可，不能在 Worker 内绕过副作用授权；
- 如果一次续跑仍然耗尽输出预算，Run 可以失败，但 Thread Sandbox 中的未提交工作应保留供下一 Run 接续；
- 普通失败、取消、物化失败和真正的协议异常仍需失败关闭，避免复用无法证明安全的缓存。

## 备选方案

### 方案 A：只提高 `MODEL_MAX_OUTPUT_TOKENS`

实现最小，也能降低本次 8,192 token 测试上限导致的失败概率，但任何固定上限仍可能被 reasoning 或超长回答耗尽，且无法解决失败后现场被销毁的问题。

### 方案 B：把 `length` 当作成功

Run 不再报错，但用户可能拿不到最终答复，工具工作也可能尚未完成；这会制造虚假成功，因此拒绝。

### 方案 C：自动续跑一次，并只为重复 `length` 失败保留 Thread Sandbox

第一次 `length` 后注入固定、无请求级动态数据的续跑提示，通过独立 `model_continue` 许可再调用一次；第二次仍为 `length` 时维持失败终态，但通过 Thread Sandbox terminal pause/handoff 保留现场。其他失败继续 terminate。

## 选择

选择方案 C：

1. Worker 在已持久化 `message.completed(length)` 后，最多自动续跑一次；同一 Run 不形成无界重试。
2. 续跑使用固定 call ID `${attemptId}/model/output-limit/1` 和 `model_continue` 许可。PostgreSQL 与测试持久层只有在本 Attempt 已存在对应 length 事件、阶段仍为 `model_execution_started` 时才允许签发。
3. 续跑提示固定要求模型从当前状态继续：未完成则继续使用工具，已完成则只给出简洁最终答复，并禁止重复已完成步骤。
4. 如果续跑以 `stop` 完成，继续原有 Workspace 验证、提交和 Thread Sandbox terminal 流程。
5. 如果续跑再次以 `length` 完成，Run 仍以 `PROTOCOL` 失败，避免在本次改动中扩展稳定错误码和客户端契约；但若启用了 Thread Sandbox reuse，则失败终态提交 pause/handoff intent，而不是走旧 close。
6. 只有“失败 + `PROTOCOL` + 当前最后模型终态为 `length` + 持有 Thread Sandbox lease”满足现场保留条件。取消、Provider 错误、事件拒绝、工具协议错误、Workspace 冲突和其他失败仍按 ADR-0069 terminate。
7. 运行配置恢复使用 `.env` 中 16,384 token 的主模型与压缩输出预算；有界续跑是固定上限之外的恢复层，不替代合理的模型预算。

## 理由

该选择把正常的 Provider 长度终止从协议损坏中分离出来，同时保留双栅栏和幂等副作用边界。一次固定续跑足以覆盖“reasoning 用尽首轮预算、只差最终答复”的常见情形，成本和延迟有明确上界。重复 `length` 后保留 Sandbox，可以让用户在下一 Run 中继续已有文件和进程状态；条件严格限定在可解释的长度终止，不扩大普通失败缓存复用风险。

## 影响

### 正面影响

- 主模型首轮 reasoning 耗尽输出预算时，任务可自动获得一次完成机会；
- 续跑仍由 durable `model_continue` permit 授权，可审计且不可重复签发；
- 重复长度耗尽不再销毁未提交工作，下一 Run 可连接同一 Thread Sandbox；
- 压缩 checkpoint 与主模型输出预算的故障边界更清晰。

### 负面影响与成本

- 最坏情况下每个 Run 增加一次主模型调用和相应成本、延迟；
- 重复 `length` 仍暂时使用通用 `PROTOCOL` 错误码，客户端不能仅凭 code 区分真正协议错误；
- 保留的 Sandbox 可能包含半完成修改，下一 Run 必须把它视为待继续的工作现场，而不是已提交 Workspace Revision。

### 安全、数据与运维影响

- 固定续跑提示不包含用户、Thread、Run、附件或路径动态数据，不破坏模型缓存稳定约束；
- 数据库只根据当前 Attempt 的 durable length 事件和固定 call ID 放行续跑，Worker 不能伪造任意 `model_continue`；
- 未提交 Sandbox 仍不是长期事实源；pause retention 到期后仍可能被 Scheduler 回收，重要成果最终必须形成 Workspace Revision；
- 普通失败和取消仍 terminate，不改变现有失败关闭基线。

## 验证

- Worker 单元测试：首轮 `length`、第二轮 `stop` 时只签发一次 `model_continue`，Run 成功且 Sandbox 正常 pause；
- Worker 单元测试：连续两次 `length` 时 Run 失败，但 terminal mutation 携带 Thread Sandbox command，lifecycle effect 执行一次且旧 registry settle/close 不发生；
- 持久层与类型检查：`model_continue` 只在 durable length 事件和固定 call ID 匹配时授权，既有 steer/correction 规则保持通过；
- 实际开发 Worker：恢复 16,384 token 输出预算后重跑复杂长任务，观察 trace 中首次 `length` 后出现 `/model/output-limit/1` 调用，并确认失败时 Session 为 paused/handed-off 而非 terminated。

## 可逆性与回退

代码可回退本 ADR 对应提交，恢复“length 直接 PROTOCOL + 失败 terminate”。不涉及 schema 迁移或不可逆数据变换；已生成的 `model_continue` permit 和 pause effect 按既有幂等规则自然过期或收敛。若现场保留造成错误复用，可先关闭 `THREAD_SANDBOX_SESSION_REUSE_ENABLED`，再回退 Worker 逻辑。

## 后续工作

- 评估新增独立稳定错误码（如 `MODEL_OUTPUT_LIMIT`），避免重复 length 与真实协议错误共用 `PROTOCOL`；
- 采集续跑成功率、额外 token、延迟与重复 length 比例，决定是否按模型能力调整续跑次数；
- 明确 UI 对“保留了未提交现场，可继续任务”的提示。

## 实施记录

- 2026-08-09：在 `feat/context-auto-compaction` 分支实现一次有界主模型续跑、数据库许可校验和重复 length 的 Thread Sandbox terminal pause。
