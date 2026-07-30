# ADR-0058：面向模型的单一文件交付工具

- 状态：已接受
- 日期：2026-07-30

## 背景

模型原先需要先调用 `declare_deliverables`，再调用带有幂等键、Artifact ID、声明键、用途和来源联合结构的
`publish_artifact`。Workspace 文件调用成功只代表服务端接受发布意图，真正的 ResourceVersion 和 Artifact 要等
Run 完成阶段结算。模型既无法理解这些内部身份，也会把“接受意图”误认为文件已经可下载；声明缺失还会触发
额外模型修正轮次。

本阶段优先保证 Agent 能直接选择 CubeSandbox 中的文件并完成交付。页面刷新方式、对象键、Workspace Revision、
ResourceVersion 和 Artifact replacement 都不是模型应当控制的协议字段。

## 备选方案

1. 保留两个旧工具，只缩短描述。改动最小，但模型仍需构造内部身份，成功语义仍晚于工具回执。
2. 让 `publish_artifact` 自动补声明。减少一次调用，却继续暴露历史参数和“意图已接受”中间态。
3. 新增 `deliver_file(path, name?)`，由 Runtime 读取、持久化和发布，只有 published 事实提交后才成功。

选择第三种。

## 决策

- 新 Run 的模型工具只暴露 `exec_command` 与 `deliver_file`；前者承担命令、Python 和文件读写，后者承担
  交付。`deliver_file` 输入只有 `/workspace` 下的 Sandbox 绝对 `path` 与可选展示
  `name`。工具描述固定为：

  > 将 CubeSandbox 中已经生成的文件作为本次任务的交付文件提供给用户。仅当文件已成功保存为可下载交付物时返回成功。

  描述不声称模型可以观察页面状态。
- Tool Router 用当前 ExecutionScope、Attempt 与 Sandbox registry capability 打开 CubeSandbox Workspace，读取普通
  文件二进制流。不存在立即返回可修正的 `FILE_NOT_FOUND`；目录、symlink 或特殊文件不会被当成交付物。
- Tool call ID 是幂等身份来源。Artifact、Resource、ResourceVersion 与内部 deliverable key 均由 Runtime 确定性
  生成；模型不能提交这些字段。
- Runtime 计算 size、SHA-256 和基于文件名的保守 media type。未知或主动内容默认
  `application/octet-stream`。
- 字节先走既有 PostgreSQL Blob commit/promotion 状态机形成 resource-purpose stable reference，随后在单一 PG 事务
  中创建 Resource、ResourceVersion、deliverable Artifact 与 `published` settlement。工具只有在该事务读回 published
  事实后才返回 `download_ready=true`。
- 既有 Artifact/Resource 表、下载和列表读侧继续使用；旧工具和旧 intent 表暂不删除，避免破坏历史记录和旧 API。
- Run 完成不再调用声明检查或生成 Artifact 修正反馈。`deliver_file` 自身失败已在同一模型工具轮次给出可修正错误。

## Codex 对齐 TODO

- `deliver_file` 是产品交付能力，不是 Codex `exec_command` 的对应工具；无需与 Codex 参数完全一致。
- 新 Session、rollout recovery 与生产装配已经删除旧 `artifactToolRouter` 接线；旧数据库表和读侧 API 继续保留。
- TODO(codex-alignment)：`exec_command` 尚缺 PTY、yield/后台 session、`write_stdin`、独立 cwd、精确 tokenizer
  预算、超时部分输出、可恢复 transcript 与可选 shell/login/TTY 参数；这些差异不得宣称已经对齐 Codex。
- Blob 上传当前仍使用既有小对象内存上限。若后续需要大文件，应增加可恢复流式上传，而不是扩大模型参数。

## 影响与验证

- 模型工具数量减少，发布成功与用户可下载事实一致。
- stable Blob 已完成但最终事务失败时，Runtime 先锁定 exact reference，并确认没有 ResourceVersion/Artifact 绑定后
  才把引用持久化为 `released`，再按固定物理身份触发 GC。若 PG COMMIT 实际成功但响应丢失，规范引用检查返回
  `still_referenced`，不得删除对象；若 GC 暂时失败，`released` 事实允许后续恢复，不会把远端对象重新视为可达。
- continuation window 只保护 Router 在许可消费后立即开始首个 Sandbox 副作用；Sandbox 读取和 Blob promotion 可以超过
  该短窗口。最终发布事务改用 PG `lockExecutionBoundary` 锁后重验 run、attempt、permit、claim 与 lease。
- PG COMMIT unknown 且规范读回不可用时，Router 投影 `PUBLICATION_RESULT_UNKNOWN`、`fatal=true`；清理结果
  unknown 则投影 `CLEANUP_RESULT_UNKNOWN`、`fatal=true`。Tool 层必须先形成 durable failed `tool_result`，再拒绝
  continuation，使 Attempt 进入 recovery，绝不能把它们伪装成可修正 `PUBLICATION_FAILED` 后继续下一次 Provider。
- `abandon` 失败不再静默吞掉。PG 中的 exact `blob_reference` 本身是恢复 anchor：Worker 周期扫描 `deliver-*` 的
  `released` 引用，以及超过五分钟仍未绑定 ResourceVersion/Artifact 的 stable 引用；领取时在租户事务中锁定并
  原子转为 `released`，随后按固定 incarnation/physical key 重试 GC。GC 再次失败时保留 anchor 给下一 poll；仍在
  正常发布窗口内的 stable 引用不会被提前领取。
- 自动化测试覆盖模型描述、只允许 `path/name`、绝对 Workspace 路径、`FILE_NOT_FOUND`、published 回执，以及 Run
  completion 不再调用旧门。
- production/development 共用同一装配；Linux Worker 纵向 Gate 使用当前 `exec_command → deliver_file` 工具链、
  真实 Router、PostgreSQL/MinIO publication，并通过下载授权 URL 读回同一字节。
- Worker 的 Artifact 下载 TTL 与其 BlobStore 预签名上限共用同一 60 秒常量；应用服务不得使用高于对象存储
  策略的默认 TTL，否则已发布 Artifact 会在 presign 阶段被错误投影为依赖不可用。

## 可逆性

可以停止注册 `deliver_file` 并恢复旧工具，但已经发布的 ResourceVersion 与 Artifact 是合法既有事实，不回滚或删除。
新实现没有删除旧表和旧 API，因此回退不需要数据迁移。
