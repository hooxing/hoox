# ADR-0030：Runtime Rollout 与 Checkpoint 事实源

- 状态：已接受
- 日期：2026-07-28
- 关联：M5-03

## 背景与约束

Pi Session 的本地文件面向单进程体验，不能提供多租户隔离、并发序号、数据库事务、重启换机恢复和长期协议兼容证明。Runtime 又必须保留 user、assistant、tool call/result、waiting 与 terminal 原始事实，同时允许 Context Policy 用摘要替换模型看到的窗口。

首版只执行 root Agent，但持久身份不能把 Agent Thread 维度省掉，否则加入子 Agent 时需要改写历史主键。Prompt 构造、压缩算法和 Worker 完整接线不属于本切片。

## 备选方案

### 方案 A：继续把 Pi Session 文件作为事实源

实现短，但文件锁、容灾、RLS、跨 Worker 接管、Schema 演进和审计都需另造一套机制；本地文件与 PostgreSQL Run 状态还会形成双事实源。

### 方案 B：只保存可变的当前消息数组

读取简单，但压缩会物理覆盖历史，无法证明工具结果来源，也不能安全恢复未配对的尾部 Tool Call。

### 方案 C：PostgreSQL 仅追加事实流 + 仅追加 Checkpoint（选择）

Runtime entry 永不更新或删除。Checkpoint 保存模型投影、窗口边界与 replacement history；它只替换后续模型输入，不替换事实。大 Tool 输出的完整内容进入 Stable Blob，entry 只保存有界摘要和引用。

## 决策

1. PostgreSQL `runtime_rollout_entries` 是 Rollout 唯一事实源；Pi Session 文件不参与恢复判定。
2. 事实主键包含 Tenant/Thread/Run/Attempt/Agent Thread/sequence。首版通过 `agent_kind = root` 明确限制，而不是删除 Agent 维度。
3. entry 通过自引用复合外键声明真实前驱：sequence 从 0 开始且无间隙；Tool Call 后只能紧跟同 call ID 的 Tool Result；Terminal 后不能再追加。允许事务结束时保留未配对 Tool Call，供外部副作用恢复后补齐结果。
4. Repository 以 scope advisory transaction lock 串行分配 sequence。append/checkpoint 的命令摘要必须由 Repository 对规范化实际 payload 重算，调用方不能提交摘要；同键异正文返回冲突。
5. Stream 固化 model identity、model compatibility、prompt policy、tool schema 与 skill manifest 的 SHA-256 兼容身份。恢复时不允许静默改用不兼容策略。
6. Checkpoint 是仅追加投影。`replacement_history` 规范化成每个 Stream 唯一的仅追加前缀，Checkpoint 只能推进前缀长度，不能清空或改写历史；entry 不删除。Window 起点不能是 Tool Result，through 不能是 Tool Call，且连续 Checkpoint 的 window/through 只能单调前进。
7. body 上限 16 KiB。完整大 Tool Result 使用 `stable/trace` Blob reference；截断摘要必须带完整 Blob 引用。
8. 所有表强制 Tenant RLS。写 Repository 在事务内对 active Membership 持有 `FOR SHARE` 行锁到提交，使 revoke 的 UPDATE 必须在线性化点之后生效；恢复读取使用带 Membership 条件的单 SQL snapshot，避免只读流量制造 row-lock WAL。Runtime 角色只有 SELECT/INSERT，没有 UPDATE/DELETE/TRUNCATE。
9. 恢复调用必须提交期望的 model、model compatibility、prompt policy、tool schema 和 skill manifest 身份；任一不匹配均返回 `compatibility_mismatch/rebuild_attempt`，禁止静默恢复。
10. 首版数据库以 `(tenant_id, attempt_id)` 唯一约束保证每个 Attempt 只有一个 root Stream；Agent Thread ID 仍进入复合事实主键，为未来子 Agent 保留位置。

## 影响

正面影响：重启或换 Worker 可从 Checkpoint 与尾部事实恢复；原始事实可审计；工具调用配对和单调序号同时受数据库约束；模型投影演进不会破坏历史。

负面影响：事实量持续增长，需要后续归档/保留策略；advisory lock 让同一 Agent Stream 的 append 串行；兼容身份变化需要显式新 Attempt 或迁移决策。

## 安全与运维

- Blob 引用必须指向同租户 Stable trace 对象，防止跨租户或 staged 对象被当作完整事实。
- RLS 只负责 Tenant 隔离，active Membership 的对象级 ACL 由窄 Repository 在事务内重验。
- 监控应记录幂等摘要冲突、未配对 Tool Call 尾部年龄、Checkpoint 滞后和恢复尾部长度，但不得记录正文或凭据。

## 验证证据

- 迁移 up/down 与 Runtime ACL manifest 检查；
- 直接 SQL 负例覆盖跳号、伪造前驱、错误 Tool Result 和 Terminal 后追加；
- 真实 PostgreSQL 覆盖并发 append、幂等冲突、未配对尾部、Checkpoint 后重启重读及 Membership 撤销；
- TypeScript build/typecheck 与差异检查。

## 可逆性

在未写入生产事实前可 down 0011 完整移除。写入生产后，down 会永久删除审计事实，只允许开发/测试环境执行；生产替代方案必须新增迁移和 ADR，先导出 entry、checkpoint 与 Blob reachability，再切换读取路径。
