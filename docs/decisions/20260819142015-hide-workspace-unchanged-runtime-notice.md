# ADR-20260819142015：用户工作台隐藏 Workspace 未变化审计通知

- 状态：已接受
- 日期：2026-08-19
- 决策者：Runtime 团队
- 关联任务/PR：浏览器批注要求移除“本次运行未产生 Workspace revision”
- 替代关系：细化 ADR-0100 的 `workspace_unchanged` 展示边界

## 背景

Thread Context 会持久化 `workspace_unchanged`，用于证明一次 Run 没有提交 Workspace revision。ADR-0100
已经规定该审计事实不能进入 Provider 上下文，但 Thread 读取 API 仍会把它投影为 Runtime 消息，用户工作台
随后显示“本次运行未产生 Workspace revision。”。普通问候、查询、定时任务等不修改文件的 Run 会频繁产生
该提示；它没有用户行动价值，并暴露内部 Workspace 实现术语。

## 决策驱动因素

- 保留 durable 审计事实及内部查询能力；
- 用户工作台只展示需要用户理解或采取行动的 Runtime 状态；
- 失败、取消、等待和历史缺口等重要状态仍必须可见；
- 不修改 Thread Context Schema、历史数据或 Provider 投影。

## 备选方案

### 方案 A：删除 workspace_unchanged 持久化事实

可以从所有读取路径移除提示，但会破坏审计和恢复证据，不符合 ADR-0100。

### 方案 B：在 Thread 读取 API 中删除该消息

用户工作台不会收到提示，但其他受信任客户端也无法通过该读模型查看审计事实，扩大了行为变化范围。

### 方案 C：仅在用户 Web 展示层过滤

保留数据库和 API 事实，只在 `ThreadTranscript` 的 Runtime 消息展示策略中隐藏精确的无变化提示。失败等
需要关注的消息继续展示。

## 选择

采用方案 C。`shouldDisplayRuntimeContextMessage` 除现有“运行已完成。”外，再过滤精确文本
“本次运行未产生 Workspace revision。”。过滤前统一 `trim`，避免空白差异导致提示重新出现。

## 理由

该事实对审计有价值，但对普通用户没有行动价值。展示层过滤满足最小影响原则，不改变持久化、API 或模型
上下文；精确匹配又不会误隐藏其他包含 Workspace 信息的错误或恢复消息。

## 影响

### 正面影响

- 普通无文件变更 Run 不再在对话中插入内部实现提示；
- 失败和其他需要用户关注的 Runtime 状态保持可见；
- durable 审计事实和内部诊断能力保持不变。

### 负面影响与成本

- 用户 Web 不再直接显示某次 Run 是否产生 revision；该信息需要通过内部诊断或 API 查看；
- 当前过滤依赖稳定的服务端文本，未来若引入结构化 Runtime notice code，应迁移到 code 过滤。

### 安全、数据与运维影响

不修改数据库、API、授权、模型上下文、日志、配置或迁移。只改变 Web 渲染结果。

## 验证

- 工作台组件测试验证“运行已完成。”与“本次运行未产生 Workspace revision。”均不渲染；
- 同一测试验证运行失败提示仍然渲染；
- 执行 Web 测试、类型检查、格式检查与 lint。

## 可逆性与回退

删除新增的精确过滤条件即可恢复展示，没有数据迁移或不可逆影响。

## 后续工作

- 若 Runtime 消息 API 增加稳定 code，Web 应改用 code 决定展示而不是匹配中文文本。

## 实施记录

- 2026-08-19：在用户 Web 展示层隐藏 Workspace 未变化审计提示并补充回归测试。
