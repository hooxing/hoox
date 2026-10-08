# 工具调用模式

本文面向维护 Worker、后台运行设置和工具恢复协议的开发者，说明正常模式与实验 PTC 模式的当前边界。配置操作见[配置参考](../reference/configuration.md)，选择依据见 [ADR-20261003011415](../decisions/20261003011415-ptc-mode-and-durable-dispatch-journal.md)。

## 模式与生效时机

后台“运行设置”中的工具调用模式保存为 `toolCallingMode`：`native` 是正常模式和默认值；`ptc` 是实验模式。旧配置缺字段解释为正常模式，服务和数据库均拒绝非法枚举、非字符串及额外配置字段；数据库约束兼容缺字段的历史 Revision，保存时不改写历史配置。模式与其他运行设置使用同一保存、版本和审计流程，不新增环境变量或旁路开关。

Worker 首次为 Run 解析运行配置时持久化快照；尚未建立快照的排队 Run 会采用当时的 active 配置，不是在 API 创建 Run 时就固定。已有快照的 Run、恢复 Attempt 和该 Run 的子 Agent 沿用快照模式。模式参与 Session 工厂缓存键和工具能力兼容身份；切换不会复用另一模式的 Session 能力集合。

## 后台工具选择

后台“运行设置”的工具选择保存为可选 `enabledTools` 启用名单，覆盖文件与命令、技能与任务交付、智能体协作工具。缺字段的旧配置保留全工具行为；显式空数组关闭全部业务工具，仍可文字答复。保存后无需重启，选择与模式在同一 Run 快照中固定；已有快照、恢复与该 Run 的子 Agent 不受后续保存影响。关闭工具不会停止已创建的定时任务或已启动的子任务，不能用作即时撤权。

正常模式只注册启用工具；PTC SDK 和程序内执行映射使用同一集合，强行调用关闭的名称不能进入工具实现、授权或副作用。子 Agent 的工具集合为平台名单与委派名单的交集，不能通过委派扩大平台能力。勾选仅允许既有实现，未装配对应服务的工具仍不可用。关闭 `skill` 时不再恢复或显式加载技能说明，但不会删除历史对话中已经出现的内容。

`run_code` 是 PTC 的隔离编排入口，`collapse_process_for_final_answer` 是正常模式的展示机制，不在业务开关中。全部关闭时，PTC 保留纯计算程序入口，但 tools 命名空间为空，不能获得宿主文件、命令或网络能力。

工具开关不是沙箱文件 ACL：保留 `exec_command` 时仍可通过命令读写文件，关闭文件工具不能替代沙箱隔离。后台显示该限制。共享工具目录、规范化规则和数据库约束拒绝未知、重复及非数组选择；选择顺序不改变能力缓存或模型 Schema。工具新增必须同步目录、受控执行和[用户展示契约](../decisions/20261004184828-tool-user-presentation-contract.md)；已显式保存的名单不自动启用新增工具。长期取舍见[后台工具选择决策](../decisions/20261008150709-admin-tool-selection-and-run-snapshot.md)。

## 模型与执行边界

正常模式向模型公开当前实际启用工具。PTC 只公开 `run_code({code})`，参数说明包含按工具名称和 Schema 键排序生成的固定 SDK。代码是支持顶层 `await` 和 `return` 的异步 JavaScript 函数体，通过 `tools[工具名](参数)` 调用实际工具。SDK 不包含 Tenant、Run、Thread、附件或动态工作目录。

每次程序使用 fresh QuickJS WASM runtime/context，不继承上次变量，只暴露工具命名空间与 `console.log`，没有宿主 `process`、`require`、文件或网络能力。不使用宿主动态函数执行生成代码。工具能力仍由当前 Agent 的既有 allowlist 和受控实现决定，不借 PTC 增加权限。

固定执行限额为 30 秒、32 MiB guest heap、64 次工具调用和 64 KiB 日志与返回值合计输出。时间包含等待工具。工具调用按提交顺序串行；未 await 的已提交调用也必须收束，不能成为后台任务。取消或超时后不再启动排队调用，并等待在途工具收束后释放 VM；该等待不是对外部副作用的强制回滚，也不保证不可取消的外部操作在 30 秒内完成。

工具返回内容块与结构化 details，普通工具错误脱敏后可在程序内捕获。边界只接受无损 JSON，拒绝访问器、危险属性、特殊对象及有损数值。命名空间、JSON、内存、输出和调用限额失败会终止程序。持久化状态未知或冲突不能靠 guest try/catch 绕过继续执行。

只有日志和最终 return 自动进入模型结果；中间工具数据不会逐次进入模型 Rollout。程序故意打印或返回的数据仍会进入模型上下文，因此 PTC 不是自动脱敏器。

## 用户可见工具信息与错误处理

正常和 PTC 共用 `pi-adapter` 的受限展示投影与工作台组件。文件调用显示操作和相对工作目录的路径，命令调用显示 `user_facing_purpose`，技能调用显示技能名，协作和定时任务显示受控操作名称。外层程序显示“编排工具调用”；内部调用分别保留开始、运行、完成和失败状态。外层程序成功不会把已捕获的子调用失败改成成功。

展示事件只包含明确允许的摘要和长度受限的字段，不包含完整参数、程序源码、命令、消息正文或业务输出。用途和文件名不是自动脱敏结果，调用方不得将凭据写入这些可见字段。展示事件不会逐次进入模型 Rollout，也不能把路径、用途等动态事实注入固定提示词或工具 Schema。历史事件没有摘要或诊断字段时采用通用状态，不回填旧事件。

失败事件的 `failure` 包含安全 `code` 与固定中文 `message`；未知异常使用 `TOOL_FAILED` 和通用提示，不透出异常栈、底层日志或诊断字段。PTC 程序捕获受控工具错误后可以读取 `error.code`、`error.toolName` 与 `error.message`：

```javascript
try {
  await tools.read({ path: "/workspace/example-missing.txt" });
} catch (error) {
  console.log({ code: error.code, toolName: error.toolName });
}
```

工具报错不保证副作用尚未发生；是否再次调用必须结合任务状态和受控审计判断，不自动重试。持久化未知仍会阻断程序续行，不能通过捕获错误绕过。

所有 PTC 工具调用都传一个 JSON 对象，无参调用也写成 `tools.list_agents({})`。`exec_command` 的非零退出码保留在 `result.details.exit_code`，不是工具异常的判据；不要用 `; true` 掩盖退出码。`wait_agent` 后续读取使用返回的 `nextAfterSequence`，重复传 0 会重放历史；消息追加的时序与 steer 行为见[智能体协作](agent-collaboration.md)。

新增或修改工具时必须同时设计模型出口和用户展示，维护用途/对象投影、安全失败及历史兼容测试。长期选择见[工具用户展示契约决策](../decisions/20261004184828-tool-user-presentation-contract.md)。

## durable 子调用与恢复

外层 `run_code` 继续形成 Rollout 的 `tool_call → tool_result` 对。每个内部调用在真实 `tool.started` 后、任何授权和副作用前持久化自己的开始事实，且逐次使用原工具授权、Sandbox 准备和受控回执，不共享外层许可。

内部事实写入独立 `runtime_ptc_dispatches` journal，完整绑定 Tenant、Thread、Run、Attempt、agentThread、执行双栅栏及未闭合父调用。结果引用同租户 stable/trace Blob，保存固定受控回执，不保存程序源代码或完整工具业务输出。相同幂等键同正文允许 replay，不同正文冲突；未知写入使用同键收敛重试。

内部 journal 不注入模型历史，也不改变 Thread Context 的工具配对语义。外层调用未闭合时，恢复仍返回 `requires_tool_reconciliation`，不得自动重跑程序。维护者可通过仓储 `listPtcDispatchesByParent` 读取该父调用的审计证据；该只读核对不授权重试已执行的副作用。

内部开始或回执状态未知时，即使外层失败回执已闭合，Worker 仍将 Attempt 转入 `recovery_required`；普通再投递不会创建新 Session。Rollout 的纯投影只检查模型调用配对，其 `ready` 不代表内部 journal 已核对或允许继续执行。恢复辅助入口必须保留调用方的续行保护与工具 allowlist；人工恢复也必须先核对未收敛的内部事实，不能仅凭外层闭合恢复模型。

## 实验限制与回退

- PTC 不提供可选的 `collapse_process_for_final_answer` 展示工具，其既有协议要求模型直接发出独占的工具 turn；内部调用不能伪造这一事实。正常的最终答复不受影响。
- 图片内容块仅作为程序数据；内部读图结果不会自动变成模型视觉输入。需要依赖这类工具返回图片推理的任务使用正常模式。
- 尚无真实模型成本、正确率和多模态等价性结论；正常模式仍是默认，不把单元测试当作收益证明。
- 后台切回正常模式仅影响之后首次建立快照的 Run。已有 PTC Run 需保留 PTC 运行时代码和 migration 0066，直到安全排空和核对完成；不要删除 journal 或倒退已执行 migration。
- 运行设置 Revision 一旦保存模式字段，migration 0067 拒绝降级到不支持该字段的约束，包括值为 `native` 的 Revision；切回正常模式不等于删除历史事实。

- 含 `enabledTools` 的任何运行设置 Revision 都会阻止 migration 0068 降级，包括空名单。重新全选工具不删除历史配置，回滚代码必须保留该字段的支持。
