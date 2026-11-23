# Agent 评测

本文面向维护评测集、批量运行和发布质量门槛的开发者，说明执行身份、故障恢复和结果的事实来源。管理接口见[评测管理 API](../reference/admin-evaluations.md)。

## 执行与恢复

评测集属于一个 AgentDefinition。发起批次需要 `run_content.read`；批次固定执行者、个人 Tenant、目标 Revision 和各用例当时的输入、附件引用与断言。`operator` 可管理结构、查看结果，但不能读取正文或发起重放。

Admin Control API 在进程内轮询数据库，不使用 Scheduler 或单独的调度角色。数据库串行化并发名额分配，以 `SKIP LOCKED` 锁定候选用例；`starting` 和 `running` 均占用全局及本批次名额。接手过期租约只更换 token 并递增 generation，不重新分配 Run ID。锁定批次后方可取消或更新汇总；过期执行者不能写回结果。

控制面不持有 Runtime 数据库凭据。它通过已配置的 API 服务地址发送短期租约命令。API 在执行者的个人 Tenant 中复核租约、身份、Membership 和预留 Run ID，从库中取得命令，不接受调用方指定输入、Revision 或取消目标。受理事务创建隐藏 Thread、Workspace、`origin=evaluation` Run、指定 Revision 和 Skill 快照，并写入常规队列；不写 Playground Mock。传输失败（包括提交后丢失响应）不意味着 Run 失败：重领后按原 ID 对账。取消先终结排队用例，再以原发起人身份取消已经受理的 Run。

## 取证和质量门槛

Run 失败记为失败。成功 Run 的最终回复、工具调用来自最终 Attempt 的持久事件，Artifact 名称和类型只取成功发布的元数据。读取复用 Run 浏览器的正文权限和事务审计，操作者为发起人，原因是「评测结算」。权限不足、证据缺失、读取失败或依赖未启用的模型评分均记为未知，不当作断言通过。通过率以全部用例为分母；发布事务只接受目标 Revision 满足门槛的完整评测结果。

手工用例可以引用执行者个人空间内可访问的 Artifact 或固定 `resourceId + versionId`；不以评测身份读取其他 Tenant 的源文件。真实 Thread 导入、受保护附件副本和模型评审调用未启用。
