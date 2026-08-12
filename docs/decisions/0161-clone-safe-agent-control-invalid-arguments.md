# ADR-0161：控制工具非法参数标记必须跨结构化克隆保留

## 背景

Pi 在 `prepareArguments` 返回后，会在 schema 校验中对参数执行 `structuredClone`。子 Agent 控制工具此前把非法参数的一次性 token 保存在不可枚举的 Symbol 属性中；结构化克隆会丢弃该属性，导致 `execute` 无法识别占位参数，并把 UUID、占位任务和占位工具清单当成真实业务输入执行。

这使缺失必填 `fork_turns` 的 `spawn_agent` 静默创建了任务为 UUID、工具为 `read` 的子 Agent，违反了“非法参数只形成 durable 失败回执，不触碰业务端口”的边界。

## 决策

控制工具的非法参数标记改为可跨结构化克隆保留的协议：

- 包含字符串字段的 schema 使用带固定内部前缀的一次性 token 作为占位字段值；
- `execute` 从克隆后的字段中恢复 token，并通过 bridge 的 pending 集合完成一次性消费；
- 仅包含数值字段或空对象的 schema 使用与顺序执行绑定的内部 FIFO token 队列；
- 所有控制工具继续以 schema 合法的占位对象进入执行阶段，以便先形成 durable `tool_call/tool_result` 失败事实；
- 占位参数被识别后必须抛出 `AGENT_CONTROL_INVALID_ARGUMENTS`，不得调用 Supervisor 控制端口。

## 影响

- 缺失 `fork_turns`、`after_sequence` 或其他非法参数不再静默执行。
- 内部 token 仍不会进入正常控制端口或持久业务快照。
- FIFO 标记依赖控制工具的 `sequential` 执行模式；若未来恢复并行执行，必须为无字符串字段的 schema 增加可序列化的专用标记字段或调整工具框架。

## 验证

- 测试在 `prepareArguments` 后执行 `structuredClone`，再调用 `execute`。
- 缺失 `fork_turns` 与 `after_sequence` 均形成 durable failed 回执，且不调用控制端口。
- 合法控制调用继续通过。

## 可逆性

可回退为 Symbol 标记，但在当前 Pi 校验路径下会重新出现非法参数静默执行业务操作的问题，因此不可安全回退。
