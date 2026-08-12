# ADR-0152：开发阶段使用 Mem0 Platform 的异步记忆边界

## 状态

已接受。

## 背景

Runtime 需要验证跨 Thread 的长期记忆，但当前仍处于开发阶段。直接自建 Mem0 会先引入 Python 服务、向量存储和额外运维工作，难以快速验证记忆抽取与召回质量；直接把 Mem0 调用放进回答链路，又会让第三方延迟和故障改变 Run 的终态语义。

Mem0 Platform V3 的 `add` 接口本身异步返回 `event_id`。平台没有承载本项目 Tenant 权限真源的能力，平台 API Key 也不能替代 Runtime 的授权边界。对话可能包含用户数据、内部资源 ID 和提示词，因此开发期不能把完整运行轨迹无差别发送到外部服务。

## 决策

1. 开发阶段允许使用 Mem0 Platform 验证记忆能力；只允许合成或脱敏数据，生产数据与秘密值不得上传。
2. 回答链路只在本地事务登记 durable Outbox。独立消费者稍后提交 Mem0；提交成功只表示平台接受任务，必须继续按 `event_id` 确认 `SUCCEEDED`。
3. Provider 只接受用户与助手的可见消息，不接受 system/developer prompt、工具 Schema、思考内容或工具原始输出。
4. Tenant、User、Thread 和 Run 的内部 ID 在离开 Runtime 前使用独立 HMAC Key 做不可逆、带类型域隔离的映射。API Key 与 scope HMAC Key 不得复用。
5. 个人 Tenant 映射为个人记忆 scope；团队 Tenant 映射为团队共享 scope。成员授权仍由 Runtime 判定，Mem0 不成为权限真源。
6. Provider 调用必须使用 HTTPS、固定请求和响应字节上限、硬超时，并且不得把上游响应正文写入错误或日志。
7. 当前提交只建立供应商无关的异步消费者契约和 Mem0 Platform V3 适配器。Outbox 表、Run 终态登记、检索与 user message 注入在后续切片中接入；在这些边界完成前不得宣称记忆功能已经上线。

## 备选方案

### 直接在 Run 完成后等待 Mem0

实现最短，但会把外部服务可用性引入回答完成路径，拒绝。

### 立即自托管 Mem0

数据边界更可控，但会在尚未验证效果前增加 Python、向量存储和部署复杂度，暂缓。

### 上传完整 Thread、工具输出与模型提示

信息最多，但明显扩大隐私、提示注入和秘密泄露面，拒绝。

## 影响

- 开发者只需要 Mem0 Platform 开发项目的 API Key，以及独立生成的 scope HMAC Key。
- 两级异步会产生“本地已登记、平台已接受、平台已完成”三个不同状态，持久层必须分别表达。
- Mem0 请求超时可能发生在平台已经接受之后；后续 Outbox 设计必须保留来源 Run ID，并把重复提交视为需要观测的结果未知边界。
- Provider 可被后续自托管实现替换，领域层不依赖 Mem0 SDK 或 Python 运行时。

## 验证

- 单元测试覆盖内部 ID 不出站、团队 scope 稳定、事件状态确认、HTTPS、字节上限、错误正文不泄露，以及 `PENDING` 不误记为完成。
- 真实线上验证只能使用专用开发项目和合成对话；验证结束后删除测试记忆并轮换临时 Key。

## 可逆性

删除 Mem0 Provider 或关闭后续功能开关即可停止所有外发；供应商无关契约可以保留给自托管实现。HMAC 映射不可逆，轮换 HMAC Key 会形成新的外部 scope，必须按显式迁移处理。
