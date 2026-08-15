# ADR-20260815214527：内部无损事件与逻辑轨迹记录分层

## 状态

已接受，2026-08-15。补充 ADR-20260815193622；不改变内部原始事件的采集、文件格式、敏感数据边界和 development-only 约束。

## 背景

内部轨迹首版将每个 `InternalTrajectoryEventV1` 一对一转换成页面记录。真实 Run 中一次 Chat Completions SSE 调用会产生数百个 Pi `message_update`，包括 thinking、text 和 tool-call 参数增量；页面因此把一次 Assistant 生成拆成数百行。工具的 `tool_execution_start`、update、end 以及随后进入模型历史的 `toolResult` message 也被重复展示。

DeepSeek Harness 同样使用 Chat Completions + SSE，并持久保存 `assistant/chunk*`；其差异不在 Provider 协议，而在客户端按 `(turn, step)` 将 chunk 更新到同一个 Assistant 状态，最终只发布一个逻辑节点。当前 Cube adapter 只迁移了账本外观和事件分类，没有迁移该聚合不变量。

## 决策驱动因素

- 内部诊断必须继续无损保存每个 Pi chunk、顺序和精确时刻；
- 主账本应表达模型生成、工具执行和用户输入等业务步骤，而不是传输帧；
- 聚合后仍必须能定位原始 sequence 范围、事件数量、首个增量时刻、最终消息和完整工具结果；
- 不能依赖 Responses 或 Chat Completions 的特定 wire 事件名，聚合边界应来自 Pi Session 协议；
- 历史不完整或中断轨迹仍应生成可诊断记录，不能因为缺少 start/end 静默消失。

## 备选方案

### 方案 A：采集时只保存最终 Assistant 消息

页面最简单，但会丢失 chunk 顺序、TTFT、工具参数增量和中断位置，违背“内部无损轨迹”的首要目标。

### 方案 B：保留原始事件，前端按相邻行临时折叠

不改服务端协议，但搜索、时间线、统计、分页和检查器仍以错误的记录粒度工作；多个并发工具或缺失边界也容易被错误折叠。

### 方案 C：原始账本与逻辑投影分层

原始文件保持逐事件不可变；`@cube-runtime/trajectory` 使用 Pi message/tool 生命周期生成稳定的逻辑记录，查看器只消费逻辑投影，并在详情中保留原始范围和聚合证据。

## 选择

采用方案 C：

1. `message_start(role=assistant)` 打开一次 Assistant 生成；后续 `message_update` 只更新该生成的计数、最后 partial 和首 token；`message_end(role=assistant)` 以最终 message 收口。
2. 一个 Assistant 生成只产生一个 `assistant_generation` 记录，记录 `sequence`、`sequenceEnd`、`rawEventCount`、update type 计数、首个增量相对 message_start 的耗时、最终 message、usage 和 stop reason。
3. `tool_execution_start/update/end` 按 `toolCallId` 聚合为一个 `tool_execution` 记录；最终工具结果保存在详情中。对应 `toolResult` message 不再重复显示；若缺少匹配工具生命周期，则保留 fallback tool-result 记录。
4. `turn_*` 和 `agent_*` 仅作为边界、轮次和耗时证据，不再成为主账本业务行。Runtime `session_created`、`prompt`、`steer` 及未知诊断事件仍可形成独立记录。
5. 聚合只影响 `DeepSeekTrajectoryProjection`。`trajectory-event-*.json`、Session log 下载和模型 wire 文件完全不变。
6. 统计同时公开 `events`（原始事件数）和 `records`（逻辑记录数）；页面明确显示“步骤”和“原始事件”。Run 列表存在内部轨迹时只统计内部事件，不再与 Runtime 镜像重复相加。

## 理由

该方案与 DeepSeek Harness 的“raw chunks for replay, assembled node for UI”一致，同时保持 Cube Runtime 的 Pi 原始事件格式和独立诊断边界。聚合发生在共享 trajectory 包，因此时间线、搜索、检查器、测试和未来其他查看器使用同一事实，而不是各自在前端猜测。

## 影响

### 正面影响

- 数千个流式 chunk 不再淹没主账本；
- 一次模型调用、一次工具调用分别对应一条可读记录；
- 详情可直接查看原始 sequence 范围、chunk 数、首个增量相对 message_start 的耗时、最终消息和工具结果；
- Chat Completions、Responses 或其他 Provider 只要投影为相同 Pi Session 生命周期，页面语义保持一致。

### 负面影响与成本

- 投影器需要维护 Assistant 和并发工具的临时状态；
- 页面记录 sequence 由单值扩展为首尾范围，消费者必须区分逻辑记录数与原始事件数；
- 当前逻辑详情不复制全部 chunk 正文列表，逐 chunk 检查仍需使用 Session log 原始文件，以避免 API 响应再次复制数千条内容。

## 安全与数据

不新增采集字段、网络端点或生产装配。聚合详情只引用已存在的最终 message、工具 start/update/end 和统计元数据；原始敏感内容仍受原有本地诊断开关、回环监听和文件访问限制约束。

## 验证

- trajectory 单元测试覆盖 Assistant 多 chunk 聚合、sequence 范围、原始计数、首个增量时刻、usage 和最终文本；
- 工具测试覆盖 start/update/end 聚合、toolResult 去重、失败标记和缺失 start fallback；
- viewer 测试覆盖内部事件数优先于 Runtime 镜像，避免列表重复计数；
- 使用真实 7,283-event Run 验证 7,052 个 `message_update` 不再逐行显示，并检查 23 次 Assistant 生成与 33 次工具执行的逻辑记录。

## 可逆性

回退 trajectory 聚合器和页面字段即可恢复一对一展示，不需要迁移原始 JSON、数据库或公开 API。已生成的无损事件文件在两种投影下都可读取。
