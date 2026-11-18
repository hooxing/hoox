# Mem0 Platform 开发准备

当前只使用 Mem0 Platform 验证长期记忆抽取与召回，不上传生产数据。配置保持关闭不会产生任何外部请求。

## 需要准备的内容

1. 在 Mem0 Platform 创建一个只供本仓库开发使用的 Project。
2. 为该 Project 创建 API Key。不要把 Key 发到聊天、Issue、日志或提交中。
3. 在本机生成一个与 API Key 不同的随机 scope HMAC Key，至少 32 字节。它用于在数据离开 Runtime 前不可逆映射内部 Tenant、User、Thread 和 Run ID。
4. 把根目录 `.env.example` 复制为未跟踪的 `.env`，设置：

```dotenv
MEM0_MEMORY_ENABLED=true
MEM0_API_BASE_URL=https://api.mem0.ai/
MEM0_API_KEY=<开发 Project API Key>
MEM0_SCOPE_HMAC_KEY=<独立随机密钥，至少 32 字节>
MEM0_REQUEST_TIMEOUT_MS=5000
```

## 数据约束

- 只使用合成或脱敏对话。
- 不提交 system/developer prompt、工具 Schema、思考内容和工具原始输出。
- 不提交密钥、令牌、生产地址凭据、真实客户资料或生产数据。
- 真实联调完成后从 Mem0 控制台删除测试记忆；临时 Key 不再使用时立即撤销。

## 当前实现状态

`@hoox/memory` 已包含 Mem0 Platform V3 提交、事件查询、检索、不可逆 scope 映射和两级异步消费者。基线迁移中的 `memory_ingestion_outbox` 提供 PostgreSQL Outbox；成功 Run 在终态事务只登记任务并唤醒后台调度，后续独立维护 tick 才调用 Mem0，回答路径不会等待第三方。每个真实用户输入会检索最多五条相关记忆，并将带低信任标记的结构化内容拼入当前 user message，不进入 system prompt。

启用前必须先执行数据库迁移：

```powershell
corepack pnpm db:migrate:up
```

当前仍未提供面向用户的记忆查看、纠错、删除与导出接口，因此只允许合成或脱敏开发数据，production 固定拒绝启用。
