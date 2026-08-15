# ADR-20260815232211：内部轨迹标题与性能统计语义

## 状态

已接受，2026-08-15。补充 ADR-20260815182655、ADR-20260815193622 与 ADR-20260815214527；能力仅用于本地维护者诊断，不进入用户产品界面。

## 背景

内部轨迹文件以 Run 为目录主键，因此查看器只能显示 `run_*`，维护者难以把轨迹与实际对话对应起来。Thread 标题保存在 Runtime API 的租户数据中，不属于无损轨迹事件；直接把标题复制进每个轨迹事件会引入动态重复数据，也会改变只追加诊断账本的职责。

同时，现有页脚把整个 Attempt 的跨度标为“LLM”，并只展示缓存读取 token 数，无法回答模型实际流式生成速度和缓存利用程度。轨迹已有 Assistant `message_start/message_end` 边界及最终 usage，可以在不修改原始记录的前提下派生这些指标。

## 决策驱动因素

- 左侧列表优先展示可辨识的对话标题，同时必须保留 Run ID 以便定位文件和日志；
- 轨迹文件系统和 Runtime API 任一侧不可用时，不得拖垮另一侧；
- development 身份凭据不得发送给浏览器或写入轨迹；
- 指标必须有稳定、可测试的分母，且不得把完整请求延迟误称为解码速度；
- 不把 Thread、Run 等请求级动态数据注入模型 prompt。

## 备选方案

### 方案 A：Worker 在每个轨迹事件中复制 Thread 标题

读取快，但标题会重复写入数千个事件，重命名后历史语义不明确，并扩大敏感数据面和写入耦合。

### 方案 B：查看器直接连接数据库并跨租户查询

查询次数少，但需要高权限数据库角色，绕过现有租户授权边界，不适合本地诊断工具。

### 方案 C：查看器服务端通过回环 development API 解析 Run 元数据

复用现有授权读取契约，浏览器只接收标题和 Thread ID；短期缓存减少枚举成本，API 失败时退回 Run ID。

## 选择

采用方案 C，并规定：

1. `trajectory-web` 服务端只接受无凭据的回环 HTTP Runtime API origin；默认读取本地 API 端口。
2. 服务端使用仓库现有的 development fixture 身份读取个人和团队 Tenant 的 Thread/Run 列表，建立 `runId -> {threadId,title}` 映射；结果缓存 5 秒。
3. development 凭据仅存在于服务端请求头，不返回浏览器、不写日志；任一身份、Tenant 或整个 API 失败时按可用结果降级，最终回退显示 Run ID。
4. 列表和页头以 Thread 标题为主，Run ID 作为次级诊断信息和提示保留；标题搜索同时匹配标题与 Run ID。
5. `modelDurationMs` 定义为所有逻辑 `assistant_generation` 的 `message_start` 到 `message_end` 时长之和。
6. `outputTokensPerSecond = outputTokens / (modelDurationMs / 1000)`。它表示已观察到的 Assistant 流解码吞吐，不包含首包之前的完整 Provider 请求等待；无有效时长时为 `null`。
7. `cacheHitRate = cacheReadTokens / (inputTokens + cacheReadTokens)`。没有可参与计算的输入 token 时为 `null`。缓存写入 token 单独保留，不进入本次命中率分母。
8. 页面分别展示 Attempt 总耗时、LLM 流时长、输出速率、缓存读取 token 与缓存率，避免原先把总耗时标成 LLM 耗时。

## 理由

该方案保持无损轨迹账本与可变业务元数据分离，复用 API 的租户边界且不把开发身份暴露给前端。性能指标完全由已持久化的逻辑边界和 usage 派生，可重复计算，不要求 Provider 使用 Responses 或 Chat Completions 的某一种协议。

## 影响

### 正面影响

- 维护者可以直接按对话标题定位轨迹，同时仍能复制和核对 Run ID；
- Runtime API 暂时不可用不会影响原始轨迹浏览；
- token/s 与缓存率具有明确公式，可用于比较运行和定位缓存退化；
- 修正“LLM 耗时”等于整个 Attempt 跨度的误导展示。

### 负面影响与成本

- 每次缓存刷新需要枚举 development 身份可见的 Thread 及其 Run；当前适用于本地诊断规模，不是生产查询设计；
- token/s 不包含完整请求等待和 TTFT，不能替代 Provider 端延迟指标；
- 标题反映缓存刷新时 Runtime API 的当前值，不是轨迹创建时的历史快照。

## 安全与数据

查看器继续只监听回环地址。Runtime API origin 拒绝 HTTPS 外部地址、非回环主机、URL 凭据、路径、查询和片段，避免把 development Authorization 头发送到非本机。API 响应只向浏览器增加 `threadId` 和 `title`；原始轨迹、模型 wire 和 Session log 的读取边界不变。

## 验证

- trajectory 包测试覆盖模型流时长、输出 token/s 和缓存率公式；
- trajectory-web 测试覆盖个人/团队 Tenant 映射、缓存、非回环拒绝、API 失败回退，以及列表/详情标题增强；
- 类型检查、格式、Lint、受影响包测试和构建全部通过后提交；
- 使用真实本地 Run 验证标题、总耗时、LLM 流时长、token/s 与缓存率页面展示。

## 可逆性

可移除 metadata provider 装配并让 API 恢复只返回 Run ID；轨迹文件和 Runtime 数据无需迁移。三个派生统计字段可从投影接口和前端移除，不影响原始事件。由于本决策不写入生产数据，也不修改持久化 schema，回退完全可逆。
