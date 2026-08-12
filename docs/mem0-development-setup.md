# Mem0 Platform 开发准备

当前只使用 Mem0 Platform 验证长期记忆抽取，不上传生产数据。运行时接入完成前，配置保持关闭不会产生任何外部请求。

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

`@cube-runtime/memory` 已包含 Mem0 Platform V3 提交、事件查询、不可逆 scope 映射和两级异步消费者核心。PostgreSQL Outbox、Run 终态登记、检索以及向最新 user message 注入记忆仍需后续切片接入；在此之前打开环境变量不会让 Agent 自动使用记忆。
