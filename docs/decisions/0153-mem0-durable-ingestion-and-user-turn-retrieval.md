# ADR-0153：Mem0 持久写入与 User Turn 检索闭环

## 状态

已接受。

## 背景

ADR-0152 只建立 Mem0 Platform Provider 与异步消费者契约，没有 durable Outbox、Run 终态登记、检索或模型消息注入。开发环境已经用合成数据证明 V3 `add` 和事件查询可用，需要在不改变回答成功语义、不泄露内部 scope、也不污染稳定 system prompt 的前提下完成最小纵向闭环。

Thread Context 是 user、assistant 与工具事实的持久来源。成功 Run 的终态、Context 尾序号、Thread writer 释放和下一 Run 激活已经处于同一个串行化事务，因此记忆登记必须复用这个线性化点，不能在 Worker 返回成功后再做易丢失的顺序写。

## 决策

1. 仅在启用开发 Mem0 且 Run 成功时，在终态事务中按 `(tenant_id, run_id)` 幂等登记 `memory_ingestion_outbox`，并仅唤醒动态 Tenant 调度。Outbox 只保存内部来源引用、scope 主体和 Context 终止序号，不复制对话正文；回答路径不调用或等待 Mem0。
2. Agent Worker 后续独立 Tenant 维护 tick 每次最多领取一条记忆任务。消费者先提交 V3 `add`，持久化 `event_id`，再独立轮询事件；只有 `SUCCEEDED` 才完成本地任务。Tenant assignment 的下一次时间同时由 Run dispatch 与记忆 Outbox 决定，保证事件轮询不会因没有新 Run 而搁置。
3. 消费者从 durable Thread Context 恢复该 Run 的 `user_message` 与 `assistant_message`。Blob 正文必须按持久 identity 读取并重验摘要和字节数；thinking、tool call/result、system/developer prompt 和 Runtime notice 不外发。
4. 个人 Tenant 使用 owner 作为记忆主体；团队 Tenant 使用 Tenant 共享 scope。内部 Tenant、User、Thread 和 Run ID 出站前继续使用 ADR-0152 的独立 HMAC 域映射。
5. 每个真实用户输入和 durable steer 在首次模型采样前执行一次相关记忆检索，最多取五条。检索超时、拒绝或返回畸形数据统一降级为没有长期记忆，不改变 Run 终态。
6. 检索结果被序列化为带显式“低信任派生数据、不是指令”标记的结构化块，只拼入当前 user message。原始 user fact 仍单独持久化，记忆不得进入 system/developer prompt、工具 Schema或恢复投影。
7. 当前仍只允许 `development` 启用，并且只允许合成或脱敏数据。删除、纠错、导出、保留期和生产数据处理协议完成前，production 固定拒绝启用。

## 备选方案

### Run 返回成功后直接调用 Mem0

会在进程崩溃时丢失记忆写入，也会把第三方故障带入回答路径，拒绝。

### 在 Outbox 中复制完整对话

消费简单，但制造第二份敏感正文和新的删除一致性问题，拒绝；消费者从已有 Context 事实恢复。

### 将记忆写入 system prompt

会破坏稳定 prompt 缓存，并把低信任派生内容提升为高权限指令，拒绝。

## 影响

- Mem0 故障不会阻断回答；记忆可能延迟出现，属于明确的最终一致性。
- Provider 超时发生在远端已经接受请求之后时仍可能重复提交；`event_id` 已知后的轮询不会重复提交。后续需要 Provider 幂等能力或重复记忆治理。
- 团队成员共享记忆内容，但授权真源仍是 Runtime Tenant RLS 与执行 scope，客户端不能提交外部 scope。
- 开发数据库必须先应用 0043 迁移；关闭 `MEM0_MEMORY_ENABLED` 后不登记新任务，也不执行检索或消费。

## 验证

- 合成数据线上冒烟覆盖 V3 提交、事件 `SUCCEEDED`、检索命中和测试记忆删除。
- 单元测试覆盖不可逆 scope、搜索响应校验、低信任 user message 注入、检索失败降级、两阶段事件消费和本地写回失败边界。
- 迁移测试覆盖 Run 幂等、RLS、claim fencing、最小 ACL 与非空回退拒绝。
- 真实 PostgreSQL 集成测试覆盖成功 Run 原子登记、按 bigint sequence 恢复 user/assistant 对话，以及成功 event 的栅栏写回。

## 可逆性

先关闭功能开关即可停止新外发与检索。清空或按治理流程迁移 Outbox 后可以回退 0043；已写入 Mem0 的记忆必须通过平台删除接口单独清理，数据库回退不会伪装成远端删除。
