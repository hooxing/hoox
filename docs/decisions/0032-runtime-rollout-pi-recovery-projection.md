# ADR-0032：Runtime Rollout 到 Pi 的恢复投影

- 状态：部分已替代（Pi 内存恢复目标）
- 日期：2026-07-28
- 关联：ADR-0029、ADR-0030、ADR-0031、M5-04

> 部分替代关系：[20260906001531：Pi 内核收敛与共享模型目录](20260906001531-pi-kernel-and-shared-model-catalog.md)。兼容身份、双栅栏、事实顺序、工具 provenance、未配对调用处理和稳定错误继续有效；恢复到 AgentSession 与禁用 Pi 自动压缩的装配方式由直接构造 Agent 消息替代。Runtime 持久压缩的后续决策继续有效。

## 背景

Pi `AgentSession` 是 Worker 进程内的短生命周期模型执行器。它的本地 Session 文件、内部 entry 格式和 compaction 状态都不能成为重启、换机或多租户恢复依据。ADR-0030 已确定 PostgreSQL Rollout 是事实源；本 ADR 定义怎样从 checkpoint 和 tail 事实重建一个全新 Pi Session，并安全恢复 Tool Observation。

## 决策

1. 公开恢复入口不接受调用者提交期望身份、actor/context 或任意 facts。它从实际 Pi Model、可信 Prompt Builder、本次真实 Tool Schema 和 Skill 分区派生五项兼容身份，再凭 RunWorker 当前双栅栏调用 PostgreSQL 的 claim-backed root stream 入口。Repository 在同一事务从 Thread owner 与 active Membership 推导 actor 并幂等开流；Session 工厂随后以返回的可信 context 调用 `loadRecovery`，loaded 分支仍逐项复核同一快照中的记录身份。
2. 开流、每次 append、checkpoint 写入和 recovery 读取都必须在同一数据库语句快照中锁定并复核完整双栅栏：精确 execution attempt、未释放且未过期的 run claim、claim token/epoch、完整 tenant/thread/run/root/workspace/base scope、未过期 workspace write lease、lease root/epoch，以及 active Thread owner Membership。可信 context 冻结这组事实，不能只凭一次开流授权继续写。Session 创建完成前还要再准备一次 observation binding，关闭恢复后接管与模型首次执行之间的窗口。事务 actor 使用统一的 `app.user_id` GUC。
3. 恢复投影固定为 `schemaVersion=2` 的单一有序 `items` 序列。user/assistant turn 与受控 `tool_receipt` 按原始 sequence 交错追加；不存在把 tool item 放进第二个数组后丢失相对顺序的路径。即使没有文本 turn、只有工具事实，投影仍会进入新 Session。
4. checkpoint 必须使用同一 schemaVersion 2、同 checkpoint ID 和有界受控项目。目前 checkpoint 只允许 user/assistant turn；含 tool receipt 的 checkpoint 会拒绝，因为缺少原始 `tool_call + tool_result + stable Blob` 证明。未来若要压缩 Tool 事实，必须扩展 checkpoint provenance，不能信任 checkpoint 内自报的工具正文。
5. 恢复器重算每条 entry 的 `bodyDigest` 与 checkpoint 的 `projectionDigest`，检查 checkpoint window、replacement history 单调前缀和 tail 原始顺序。输入不得先排序掩盖数据库协议错误。
6. tail user/assistant 文本按连续 sequence 加入有序投影。`tool_call` 必须携带受限 `toolName`，并与紧邻、同 call ID 的 `tool_result` 配对。恢复器只接受 ADR-0031 的精确 body schema，重新解析固定回执，验证工具名、成功/失败、Blob reference、摘要、大小、可见字节数、截断标记、原因和安全前缀，然后重建 `tool_receipt`；`modelVisibleBytes` 必须是非负安全整数，禁止字符串等隐式数值转换；`isTruncated=true` 时 observation 必须是严格短于完整回执的合法 UTF-8 安全前缀，`false` 时必须是完整回执。任意额外字段或自报文本均拒绝。
7. 若 tail 最后存在未配对 tool call，返回 `requires_tool_reconciliation`。可信 Worker 必须根据外部副作用事实补齐或关闭 Attempt；恢复器不创建 Session，不伪造 tool result。
8. waiting/terminal 保持 Worker 状态事实。平台 Harness 和 capability manifest 始终由当前可信 Builder 与实际 Pi custom tools 重建；Tenant、Skill、User 等低信任上下文不能进入 system role。
9. 创建成功路径总是调用 `createSafePiSession` 新建内存 Session；不读、不写、不依赖 Pi Session 文件。Pi compaction 保持 `enabled=false`，窄 Controller 不暴露 `compact`。
10. 生产入口在真实 PostgreSQL、S3 bucket、CubeSandbox 和模型目录探针全部成功后才启动 durable dispatch 轮询；每条 claim 在事务外交给 `RunWorker.execute`，再用原 dispatch claim 确认结果。停止接单会阻止下一次 claim，并等待当前执行与确认完成，然后才关闭依赖连接。
11. 格式和事实损坏只公开稳定错误码，不包含 Rollout body、工具参数、路径、凭据或内部 ID。

## 影响

有序投影与 Tool provenance 校验增加了恢复器维护成本，但保证线上模型看到的每个工具事实都可追溯到 PostgreSQL Rollout 和 stable Blob，而不是由 checkpoint 或调用者伪造。未来压缩算法可生成新版本 checkpoint；它不能修改事实保留、工具配对和 Blob 证明要求。

## 验证

- 五项 identity 逐项不兼容测试；
- tool body 额外字段、错误回执、Blob 摘要/大小不一致、错误前驱、跳号、未配对尾部和损坏 checkpoint 测试；
- 文本与 tool receipt 的原序确定性重建，以及 tool-only 恢复测试；
- Linux Faux Pi 由恢复投影创建新 Session，并断言 compaction 关闭、Controller 无 `compact`。
- run claim 释放/过期、workspace lease 过期、接管换 epoch、并发写与 recovery 接管竞态均验证旧 context fail closed；真实 PostgreSQL + MinIO 的 Linux 路径验证 durable dispatch → RunWorker → Pi → stable Trace Blob → Rollout tool pair → terminal acknowledgement。
