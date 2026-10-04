# 工具调用模式

本文面向维护 Worker、后台运行设置和工具恢复协议的开发者，说明正常模式与实验 PTC 模式的当前边界。配置操作见[配置参考](../reference/configuration.md)，选择依据见 [ADR-20261003011415](../decisions/20261003011415-ptc-mode-and-durable-dispatch-journal.md)。

## 模式与生效时机

后台“运行设置”中的工具调用模式保存为 `toolCallingMode`：`native` 是正常模式和默认值；`ptc` 是实验模式。旧配置缺字段解释为正常模式，服务和数据库均拒绝非法枚举、非字符串及额外配置字段；数据库约束兼容缺字段的历史 Revision，保存时不改写历史配置。模式与其他运行设置使用同一保存、版本和审计流程，不新增环境变量或旁路开关。

Worker 首次为 Run 解析运行配置时持久化快照；尚未建立快照的排队 Run 会采用当时的 active 配置，不是在 API 创建 Run 时就固定。已有快照的 Run、恢复 Attempt 和该 Run 的子 Agent 沿用快照模式。模式参与 Session 工厂缓存键和工具能力兼容身份；切换不会复用另一模式的 Session 能力集合。

## 模型与执行边界

正常模式向模型公开既有工具。PTC 只公开 `run_code({code})`，参数说明包含按工具名称和 Schema 键排序生成的固定 SDK。代码是支持顶层 `await` 和 `return` 的异步 JavaScript 函数体，通过 `tools[工具名](参数)` 调用实际工具。SDK 不包含 Tenant、Run、Thread、附件或动态工作目录。

每次程序使用 fresh QuickJS WASM runtime/context，不继承上次变量，只暴露工具命名空间与 `console.log`，没有宿主 `process`、`require`、文件或网络能力。不使用宿主动态函数执行生成代码。工具能力仍由当前 Agent 的既有 allowlist 和受控实现决定，不借 PTC 增加权限。

固定执行限额为 30 秒、32 MiB guest heap、64 次工具调用和 64 KiB 日志与返回值合计输出。时间包含等待工具。工具调用按提交顺序串行；未 await 的已提交调用也必须收束，不能成为后台任务。取消或超时后不再启动排队调用，并等待在途工具收束后释放 VM；该等待不是对外部副作用的强制回滚，也不保证不可取消的外部操作在 30 秒内完成。

工具返回内容块与结构化 details，普通工具错误脱敏后可在程序内捕获。边界只接受无损 JSON，拒绝访问器、危险属性、特殊对象及有损数值。命名空间、JSON、内存、输出和调用限额失败会终止程序。持久化状态未知或冲突不能靠 guest try/catch 绕过继续执行。

只有日志和最终 return 自动进入模型结果；中间工具数据不会逐次进入模型 Rollout。程序故意打印或返回的数据仍会进入模型上下文，因此 PTC 不是自动脱敏器。

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
