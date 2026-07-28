# ADR-0032：Runtime Rollout 到 Pi 的恢复投影

- 状态：已接受
- 日期：2026-07-28
- 关联：ADR-0029、ADR-0030、M5-04

## 背景

Pi `AgentSession` 是 Worker 进程内的短生命周期模型执行器。它的本地 Session 文件、内部 entry 格式和 compaction 状态都不能成为重启、换机或多租户恢复依据。ADR-0030 已确定 PostgreSQL Rollout 是事实源；本 ADR 定义怎样从其 checkpoint 和 tail 事实重新创建一个全新 Pi Session。

## 决策

1. 公开恢复入口不接受调用者提交期望身份或任意 facts。它从实际 Pi Model、可信 Prompt Builder、本次真实 Tool Schema 和 Skill 分区派生 `modelId`、`modelCompatibilityHash`、`promptPolicyHash`、`toolSchemaHash`、`skillManifestHash`，再调用 PostgreSQL `loadRecovery`。数据库返回 `compatibility_mismatch/rebuild_attempt` 时原样停止；loaded 分支仍逐项复核同一快照中的记录身份。
2. checkpoint 的 `projection` 仅接受 `schemaVersion=1`、同 checkpoint ID 的受控 user/assistant 文本数组。checkpoint 和 `replacement_history` 只改变模型看到的窗口；不会删除、覆盖或改写 Rollout entry。
3. 恢复器重算每条 entry 的 `bodyDigest` 与 checkpoint 的 `projectionDigest`，检查 checkpoint window、replacement history 单调前缀和 tail 原始顺序。输入不得先排序掩盖数据库协议错误。
4. checkpoint 之后的事实按连续 sequence 重放。user/assistant 的有界文本加入受控投影；waiting/terminal 保持 Worker 状态事实；tool call 与紧邻、同 call ID 的 tool result 必须严格配对。
5. 若 tail 最后存在未配对 tool call，公开入口返回携带 call ID、sequence 和 `reconcile_external_effect` 动作的 `requires_tool_reconciliation`。可信 Worker 必须先根据外部副作用事实补齐或关闭 Attempt；恢复器此时不创建 Session，绝不伪造 tool result，也不把 Tool body 伪装成 assistant 文本。
6. 平台 Harness 和 capability manifest 始终由当前可信 Builder 与实际 Pi custom tools 重建。Tenant、Skill、User 等低信任上下文继续走 `runtime.untrusted_context.v1` custom entry（Provider user role），不能进入 system role。
7. 创建成功路径总是调用 `createSafePiSession` 新建内存 Session；不读、不写、不依赖 Pi Session 文件。Pi compaction 保持 `enabled=false`，窄 Controller 不暴露 `compact`。
8. 格式和事实损坏错误只公开稳定错误码，不包含 Rollout body、工具参数、路径、凭据或内部 ID。Session 尚未创建时无资源需释放；创建后发生 capability 验证失败时沿用 `createSafePiSession` 的 dispose 边界。

## 影响

这增加了 checkpoint schema 版本和恢复投影器的维护成本，但把 Pi 依赖升级、模型策略变更和工具能力漂移收敛在可审计的边界。未来压缩算法可生成新的 checkpoint/replacement history；它不能修改本 ADR 的事实保留和工具配对要求。

## 验证

- 五项 identity 逐项不兼容测试；
- 错误 tool result、跳号、未配对尾部和损坏 checkpoint 测试；
- checkpoint + tail 的确定性重建测试；
- Linux Faux Pi 由恢复投影创建新 Session，并断言 compaction 仍关闭、Controller 无 `compact`。
