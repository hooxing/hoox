# ADR-20260827143000：声明推理能力的模型默认启用思考

- 状态：已接受
- 日期：2026-08-27
- 决策者：Runtime 维护者
- 关联 Issue / PR：OpenAI-compatible 推理模型运行请求兼容修复
- 替代：无
- 被替代：无

## 背景

后台模型目录已经把 `reasoning` 作为已发布模型能力保存。Worker 创建 Pi Session 时却只对固定的 DeepSeek V4 Flash 模型启用 thinking，其他模型即使声明 `reasoning: true` 仍统一使用 `off`。

2026-08-27 的 Demo 运行 `run_612b7772-aac2-429c-9208-38f70ee8a390` 已证明 tokenizer 降级正常生效并进入 Provider 转发，但 Z.AI 的 `GLM-5.3-Flash` 收到 `thinking: { type: "disabled" }` 后返回 HTTP 400、错误码 `1210`，说明失败发生在上游推理模式约束而非 tokenizer 或 CD。使用同一请求改为启用 thinking 后，上游返回 HTTP 200。

## 约束

- 不新增管理员需要理解的 thinking level 配置。
- 已发布模型的 `reasoning` 能力是 Runtime 的事实输入，Worker 不应再维护仅覆盖单一模型的启用白名单。
- 非推理模型继续发送关闭或省略思考参数，不能无条件打开 thinking。
- DeepSeek V4 的专用 payload 归一化、历史重放字段和 tokenizer 固定资源保持不变。

## 决策

1. Pi Session 的默认思考等级由当前绑定模型的 `reasoning` 能力决定：`reasoning: true` 使用 `high`，否则使用 `off`。
2. DeepSeek V4 Flash 继续固定使用 `high`，并保留专用协议归一化。
3. 不新增后台 thinking level 字段；管理员只声明模型是否具备推理能力。
4. Provider 特定 wire 结构继续由 Pi 的 OpenAI-compatible 兼容层根据 `baseUrl`、模型协议和 thinking level 生成。

## 理由

模型目录已经明确表达推理能力，Session 默认值应消费该事实，而不是再用模型 ID 白名单覆盖。这样既能兼容 Z.AI 等强制思考模型，也不会影响 `reasoning: false` 的普通聊天模型，并避免把 Provider 协议细节暴露给管理员。

## 影响

- 声明 `reasoning: true` 的任意 OpenAI-compatible 模型会默认启用高等级思考。
- 未声明推理能力的模型行为保持不变。
- 强制思考模型不再因为 Worker 主动发送 disabled 而在首轮请求失败。

## 验证

- 单元测试覆盖 DeepSeek、未知推理模型和普通模型的默认 thinking 等级。
- `@hoox/pi-adapter` 与 `@hoox/agent-worker` 执行测试、类型检查和构建。
- Demo CD 后用真实 Z.AI Provider 重新运行并核对上游响应及 Run 终态。
