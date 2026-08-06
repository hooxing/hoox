# ADR-0120：SubAgent 历史继承的单一来源

- 状态：已接受
- 日期：2026-08-06
- 决策者：Runtime 团队
- 关联任务/PR：修复 `fork_turns=none` 的 Child Session 错误读取 root Thread Context
- 替代关系：细化 ADR-0117 的独立 Agent 上下文语义，不替代其余结论

## 背景

SubAgent 与 root Agent 使用独立模型会话，但 root 可以在 `spawn_agent` 时通过 `fork_turns` 选择性提供历史：`none` 不继承，
正整数继承最近若干轮，`all` 继承全部可用父历史。`AgentSupervisor` 已按该参数从父 Agent 当前内存历史生成 Child history。

通用 Pi Session factory 原本在没有显式 `threadActiveHistory` 时自动从 Thread Context 重建历史。这个回退适合 root Session，
但 Child 的 `fork_turns=none` 也会表现为“没有传入历史”，两种语义无法区分。结果是 Child 错误读取 root Thread Context；
在 Context 尚不可用时，Child 甚至会在模型启动前以 `THREAD_CONTEXT_UNAVAILABLE` 失败。

## 决策驱动因素

- Child 会话必须与 root 会话分离，`none` 要表示真正的空历史；
- root 选择的 `fork_turns` 必须是 Child 历史范围的唯一控制入口；
- root Session 仍需要现有 Thread Context 恢复与压缩能力；
- 不为当前语义增加新的持久字段或动态 system prompt；
- 后续 Child turn 继续使用 Child 自己累积的历史，而不是重新读取 root Context。

## 备选方案

### 方案 A：Child history 只接受 AgentSupervisor 的显式快照

Pi Session factory 识别 `agentKind=subagent`：有显式 `threadActiveHistory` 就使用，没有就保持空历史，不调用通用 Thread Context
重建和 root compaction。root Session 保持原回退逻辑。

优点是 `fork_turns` 语义直接、上下文边界清晰，不需要数据迁移。缺点是 Child 不会自动吸收 spawn 之后 root 新增的历史，
父子协作需要通过任务描述、follow-up 和 mailbox 完成。

### 方案 B：为 `none` 增加一个显式空历史对象

AgentSupervisor 可以为 `none` 构造空的 `ThreadActiveHistoryV1`，借此阻止 factory 回退。该方案会让“未提供”和“显式为空”
依赖一个人工占位摘要，还要求所有 Session factory 调用方持续维护这一区分，容易再次出现旁路。

### 方案 C：Child 始终读取 root Thread Context，再对历史做裁剪

可以复用统一恢复路径，但 `none` 仍会先访问不应访问的父上下文，且 Context 中的持久轮次不等同于 spawn 时父 Agent 当前
会话快照，无法稳定实现正整数继承。

## 选择

采用方案 A，并固定以下边界：

1. `AgentSupervisor` 是 Child 初始历史的唯一来源，根据 root 传入的 `fork_turns` 生成不可变快照；
2. Pi Session factory 对 `agentKind=subagent` 禁止缺省 Thread Context 回退：未传 `threadActiveHistory` 即为空历史；
3. Child 收到的显式历史仍进入既有 Pi history 装配，`none`、正整数和 `all` 保持同一工具接口；
4. root Session 继续使用 Thread Context 恢复、shadow 校验和运行时压缩；
5. Child 完成一轮后，由 `AgentSupervisor` 把该轮追加到 Child 自己的内存历史，follow-up 不重新读取 root Context。

## 理由

`fork_turns` 是 root 对 Child 上下文授权的显式选择。让 Session factory 在 Child 没有快照时自行回退，会把“用户选择不继承”
误解释为“调用方忘记提供”，破坏独立会话边界。按 Agent 身份关闭回退后，控制权仍位于 spawn 工具协议，且无需改变 Provider
消息结构、Sandbox 共享关系或持久化 schema。

## 影响

### 正面影响

- `fork_turns=none` 的 Child 从空历史稳定启动，不依赖 root Thread Context 可用性；
- 正整数和 `all` 仍能由 root 选择性继承父历史；
- Child 的模型上下文独立，而 Sandbox、Attempt fence 和工具权限仍按既有设计共享或受控。

### 负面影响与成本

- Child 不自动获得 spawn 后 root 新增的消息；需要 root 发送 follow-up 才能补充任务事实；
- Session factory 需要保留 root/Child 的显式分支，新增 Agent kind 时必须重新审阅历史来源。

### 安全、数据与运维影响

该决策收窄 Child 可见历史，不扩大 Tenant、Sandbox 或工具权限；不新增持久字段和迁移。部署需要重启 Agent Worker。

## 验证

- Pi Session factory 测试使用真实格式的 Child identity 和 `fork_turns=none` 输入，断言 Thread Context 重建器没有被调用，
  同时验证 Child 工具 call ID 仍按 Agent/Turn 命名空间转换；
- AgentSupervisor 既有测试覆盖 `none`、正整数、`all` 的父历史裁剪和 Child follow-up 历史追加；
- 开发 API 真实 Run 使用 `fork_turns=none` 启动 Child，验证 Child 模型启动、共享 Sandbox 写入/读取及 final mailbox 交付成功。

## 可逆性与回退

代码可直接回退，不涉及数据转换；回退后历史快照仍可读取，但 `none` 会再次错误触发 root Thread Context 回退。若临时回退，
应关闭 SubAgent 创建或要求调用方只在 root Context 已稳定时使用显式继承，直到重新部署修复。
