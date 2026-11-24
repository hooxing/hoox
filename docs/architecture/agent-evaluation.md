# Agent 评测

本文面向维护评测集、批量运行和发布质量门槛的开发者，说明执行身份、故障恢复和结果的事实来源。管理接口见[评测管理 API](../reference/admin-evaluations.md)。

## 执行与恢复

评测集属于一个 AgentDefinition，并维护单调递增的内容版本。修改评测集时版本递增；批次在锁定评测集的同一事务中固定版本和用例快照。发布门槛在锁定评测集后核对当前版本与完整批次快照版本一致，旧版本的通过结果不能满足新内容的门槛。删除评测集和发起批次都在持久化事务中核对路径 Agent 归属，不匹配按不存在处理。

发起批次需要 `run_content.read`；批次固定执行者、个人 Tenant、目标 Revision 和各用例当时的输入、附件引用与断言。`operator` 可管理结构、查看结果，但不能读取正文或发起重放。数据库仅向 Admin Control 授予结构列和结果追加权限；用例输入、附件及执行快照只通过按管理员身份脱敏的投影视图或经过租约验证的命令视图读取，评测结果不开放 UPDATE/DELETE。账号必须处于 active 才能发起新的 Run 或读取正文证据；账号/Membership 失效不撤销已受理批次的取消与对账能力。

Admin Control API 在进程内轮询数据库，不使用 Scheduler 或单独的调度角色。数据库串行化并发名额分配，以 `SKIP LOCKED` 锁定候选用例；`starting` 和 `running` 均占用全局及本批次名额。接手过期租约只更换 token 并递增 generation，不重新分配 Run ID。锁定批次后方可取消或更新汇总；过期执行者不能写回结果。

控制面不持有 Runtime 数据库凭据。它通过已配置的 API 服务地址发送短期租约命令。API 在执行者的个人 Tenant 中复核租约、身份、Membership 和预留 Run ID，从库中取得命令，不接受调用方指定输入、Revision 或取消目标。撤销 Membership 或禁用账号后，受理命令不再创建 Run；受限清理命令仍绑定原批次、Tenant、预留 Run ID、claim token 和 generation，可取消既有 Run，或将因身份失效而无法启动的用例结算为未知并释放并发名额。受理事务创建隐藏 Thread、Workspace、`origin=evaluation` Run、指定 Revision 和 Skill 快照，并写入常规队列；不写 Playground Mock。传输失败（包括提交后丢失响应）不意味着 Run 失败：重领后按原 ID 对账。取消先终结排队用例，再以原发起人身份取消已经受理的 Run。

评测 Run 的 Artifact 不进入普通 Thread 历史文件索引。普通资源和历史文件入口都使用 `normal`、`api` 来源白名单；由于普通 Run RLS 会隐藏评测来源，不能用“查不到评测 Run”作为允许访问的反向判断。普通 Webhook 在事件入队、领取和发送许可处也使用同一来源白名单，评测来源不投递；升级时既有评测 Outbox 项被禁用。

### 命令授权与普通路径成本

评测 RLS 使用 `CASE` 检查事务级 `app.evaluation_batch`；普通会话未设置批次或批次为空时，不执行评测授权子查询。命令范围通过非相关的 `ARRAY(SELECT ...)` 转为按需执行的 InitPlan，避免将评测命令连接变成随外层 Thread、Run、Revision、Definition 或快照候选逐行执行的相关子计划。执行计划仍包含尚未执行的评测 InitPlan，不能将此保证解读为完全消除规划成本；回归测试检查 custom/generic 预备计划中的评测表实际执行次数为零，不依赖墙钟时间。

`evaluation_run_command` 仍是授权事实源，逐语句核对发起人、Tenant、批次、claim token、generation、有效租约和任务状态；身份失效或取消只隐藏用例正文，保留原命令范围内的清理能力。批次变量只负责短路，不能单独授权；planned Run 绑定、评测来源隐藏及快照的 Revision、摘要和完整内容校验均保持不变。命令查询复用批次主键和用例任务的批次前缀索引，不新增索引、角色、会话配置或业务 Routine；InitPlan 不跨语句缓存租约或账号状态。

## 取证和质量门槛

Run 失败记为失败。成功 Run 的最终回复、工具调用来自最终 Attempt 的持久事件，Artifact 名称和类型只取成功发布的元数据。读取复用 Run 浏览器的正文权限和事务审计，操作者为发起人，原因是「评测结算」；读取证据前再次确认发起账号处于 active。权限不足、证据缺失、读取失败或依赖未启用的模型评分均记为未知，不当作断言通过。正则断言限制表达式与证据长度，并在可超时终止的 Worker Thread 中执行；Worker 超时、失败或被终止均记为未知，不阻塞 Admin Control API 主事件循环。通过率以全部用例为分母；发布事务只接受目标 Revision 满足当前评测集内容版本门槛的完整评测结果。

手工用例可以引用执行者个人空间内可访问的 Artifact 或固定 `resourceId + versionId`；不以评测身份读取其他 Tenant 的源文件。真实 Thread 导入、受保护附件副本和模型评审调用未启用。
