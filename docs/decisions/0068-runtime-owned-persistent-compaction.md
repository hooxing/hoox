# ADR-0068：Runtime 持久 Compaction 实施边界

- 状态：已接受（阶段 4）
- 日期：2026-07-31
- 关联：实施总计划阶段 4、ADR-0064、ADR-0065、能力 Spike
- 范围：Runtime Compaction；不包含 Sandbox 跨 Run 复用或 pause/resume lifecycle

## 背景

ADR-0065 只冻结了候选语义，不能直接替代实施规范。阶段 1 至 3 已提供 Thread 单写者、
激活时延迟绑定、Thread Context 事实流和 awaited turn 安全边界。阶段 4 需要在不删除原始事实、
不重新启用 Pi compaction 的前提下，把压缩结果变成可审计、可重启恢复的 Runtime 事实。

## 选择

1. Pi `compaction.enabled` 永久保持 `false`；Runtime 在首次 Turn 前和每个完整 `turn_end`
   之后评估 compaction。Turn 内安全点必须先持久化完整 assistant 及全部 tool results，才允许
   下一次 Provider 请求。
2. 当前 `/chat/completions` 兼容分支把事实层独立的 `compactionHandoff` 映射成带固定
   “低信任、不是用户原话”前缀的 wire `user` message。该 mapping 进入 Prompt/兼容身份；
   未来 Provider 原生 item 不改变事实 kind。
3. token 计量针对最终 Provider 可见 message 形状。模型 tokenizer 可注入；当前可信绑定缺少
   精确 tokenizer 时使用 UTF-8 byte 上界，并把 tokenizer identity 写入 checkpoint，禁止低估。
4. 首版 replacement 是一个 handoff 加从最近真实 user 边界开始的完整尾部。最近 user 原文
   整条保留；边界前的 assistant/tool call/result 必须完整成组，不能切断 provenance。
5. 每个 checkpoint 不可变并记录 window、previous checkpoint、源范围、完整 source/replacement
   digest、兼容和策略 digest、tokenizer、前后 token、local/remote path。replacement 按 item
   规范化；tool result 通过可延迟外键指回含真实 callId 的 assistant item。
6. 提交事务锁定 Thread execution head，复核 Run claim、Workspace lease、Attempt scope、
   source history digest 和 window CAS；同一事务追加 `compaction_checkpoint` 原始 fact、写入
   checkpoint/items 并推进 stream。数据库提交成功后才安装内存 history。
7. 恢复选择 `through_sequence <= requested` 的最新兼容 checkpoint，校验完整 window 链与
   replacement digest，再重放原始 tail。找不到兼容 checkpoint 时从原始 facts 全量重建；
   compatibility 变化不能安装旧摘要。
8. local 分支使用同一受信 ModelRuntime、固定 system prompt、低信任 JSON 输入、`tools=[]`、
   `maxRetries=0` 和超时；remote 是显式 capability 分支，配置为 remote 但未注入能力时启动失败，
   不静默回退 local。
9. compactor 超时、非法结果、目标 token 未达到、CAS/提交冲突时保留旧 history。fence 丢失是
   Attempt 级失败，不能继续 Provider 请求。提交结果未知以同一 operation 重读/重试一次。

## 迁移与兼容顺序

迁移顺序固定为 `0021 facts → 0022 history audit → 0023 input routing → 0024 compaction`。
`0024` 先扩展 fact kind，再加 stream window cursor，随后创建 checkpoint、replacement items、
链外键、索引与 RLS。已有 checkpoint 的库禁止 down；回退只关闭新 checkpoint 创建，读取路径
仍识别已有 checkpoint。原始 facts 和 Stable Blob identity 不更新、不删除。

## Feature Flag 与参数

`THREAD_CONTEXT_COMPACTION_ENABLED` 默认关闭，并强制依赖 serial queue、V2 write 和 V2 read。
以下均为部署参数，不是永久协议常量：

- `THREAD_CONTEXT_COMPACTION_PATH=local|remote`
- `THREAD_CONTEXT_COMPACTION_SOFT_LIMIT_PERCENT`
- `THREAD_CONTEXT_COMPACTION_TARGET_PERCENT`
- `THREAD_CONTEXT_COMPACTION_RECENT_USER_TOKENS`
- `THREAD_CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS`
- `THREAD_CONTEXT_COMPACTION_TIMEOUT_MS`

开关只控制创建；关闭后仍恢复既有 checkpoint。默认样例值仅用于灰度起点。

## Test Gate

- 三次连续 replacement 的 source/window 链单调，数据库 receipt 后在线 cursor 才推进；
- restart 读取同一 checkpoint+tail 得到与在线相同 digest；兼容身份变化回退原始 facts；
- tool call/result provenance 完整，最近真实 user 原文逐字保留；
- compactor、目标校验、CAS、数据库失败均保持旧 history；fence 丢失失败关闭；
- checkpoint 前后原始 fact 数量、body digest 和 Blob identity 不变；
- wire trace 证明 compactor `tools=[]`，handoff 为明确低信任映射，Pi compaction 仍关闭。

## 可逆性

代码可通过 Feature Flag 停止创建 checkpoint；schema 一旦含 checkpoint 数据只能向前迁移。
不允许用删除 checkpoint 或原始 facts 的方式回滚。本文接受时 Stage 5 尚未实现；后续实现见 ADR-0069。
