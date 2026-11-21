# Agent 定义、版本与 Run 快照

本文面向修改 Agent 配置、Thread 绑定、Run 创建或 Worker 恢复的开发者，说明版本选择的生效时机与失败边界。[后台控制面与运行配置](admin-control-plane.md#run-快照)拥有平台运行配置快照；本文拥有 Run 的 Agent 版本绑定。

## 所有权与生效时机

- AgentDefinition 归平台所有。Tenant 只能使用管理员发布且向它开放的 Agent。Thread 创建后不能换绑 AgentDefinition；Thread 不绑定具体 Revision。既有 Thread 默认绑定内置 Agent。
- 工作台通过 `GET /v1/agents` 获取当前 Tenant 可用的已发布展示信息；仅返回名称、简介、头像、欢迎语和建议问题，不返回 Operator 指令或草稿。新建 Thread 可选择其中一个 Agent，未指定时绑定 `agent_default`；只有多个可用 Agent 时才显示选择控件。Thread 列表与对话头部以 Thread 的 `agentDefinitionId` 对应当前可用 Agent 名称。
- 新建 Thread 选择的 Agent 若 RLS 不可见（不存在、跨 Tenant、不在可用范围或已停用），统一返回 `404 NOT_FOUND`，不区分原因。若定义仍可见但没有可用的已发布 Revision，则返回 `409 AGENT_REVISION_UNAVAILABLE`。已有 Thread 发起 Run 时由 A3 按相同 409 错误码失败关闭。
- Revision 发布后正文不可改写。发布新 Revision 改变后续 Run 的选择，不修改既有 Run 的内容；停用 Definition 只阻止后续 Run。
- 受理 Run 时在同一事务内写入 `RunAgentSnapshot`、`RunSkillSnapshot` 和其他受理事实。快照保存 Thread 绑定、Revision ID、内容摘要及完整内容（包括外部工具版本引用，不含外部工具凭据）。可转成 follow-up 的 steer 候选在输入受理时一起固定两个快照，实际转入队列时不重新解析。
- 当前 Revision 不可见、不是已发布状态或内容无法验证时，持久化返回 `agent_revision_unavailable`。自带的精确 Skill 版本缺失、撤销或校验不通过时，持久化抛出 `AGENT_REVISION_UNAVAILABLE`。两种情况均不创建 Run，也不留下部分写入；已经受理的相同幂等键仍可读回原结果。

## 执行与失败边界

- 每个 Attempt 领取时校验同一份快照。Worker 重启、恢复和子 Agent 都不反查当前 Revision。快照缺失或摘要不匹配时以 `AGENT_SNAPSHOT_INVALID` 停止，不用默认 Agent 修补历史 Run。升级前已受理但未结束的 Run 没有这一快照，部署前应先排空。
- 紧急撤销是独立的持久事实。Worker 在领取、续租和停止检查读取撤销；许可签发、消费也拒绝该 Revision。已经发出的调用不能撤回。持有执行栅栏的 Worker 在后续安全点持久化 `AGENT_REVISION_REVOKED`，不等待清理结果，也不换绑其他 Revision；无法证明执行权时仍使用既有恢复协议。
- `platform_default` 模型和工具仍由平台配置控制。显式固定模型使用 `providerKey + providerRevision + modelId` 精确引用；解析必须命中对应已保存 Revision 和模型条目，否则失败关闭，绝不退回 active 或平台默认模型。显式内置工具清单只保留平台允许且实际存在的工具；子 Agent 还受父 Agent 的委派边界约束。Operator 指令来自快照，Revision 摘要只进入 Prompt 审计和恢复身份，不进入模型可见前缀。
- Agent 自带 Skill 的精确版本引用随 Agent 快照固定，并按 Revision 的 `includeTenantSkills` 合并为该 Run 的可调用目录；冲突裁决与失败语义见 [Skill Runtime](skill-runtime.md#run-快照)。长期记忆支持显式开关或跟随平台设置；默认 Agent 的新 Revision 跟随平台，兼容改造前的平台记忆行为。Sandbox 的 `kill` 不允许暂停或交接，但 `pause` 不扩大平台的保留权限。
- `sandboxTemplateId` 当前没有执行装配；快照出现非默认模板引用时以 `AGENT_CONFIGURATION_UNSUPPORTED` 失败关闭，不静默使用默认模板。外部工具白名单由后台选择视图提供，Agent Revision 写入和发布时重新校验引用仍指向已发布且未撤销的版本；Worker 按 Run 快照授权读取、凭据解析与 Session 装配由 B5 完成。客户端工具仍未接入。
- Worker 只在当前 Tenant/Run 的 Agent 快照作用域内读取额外的模型配置版本；端口不写运行快照，不读取其他未发布配置。模型条目必须已启用，且凭据必须能用 Worker 的平台密钥解密。引用缺失、不匹配或凭据不可用时，Worker 在创建模型 Session 前以 `PROVIDER` 失败，不使用 active 或部署模型。
