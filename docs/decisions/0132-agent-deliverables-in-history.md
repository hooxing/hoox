# ADR-0132：Agent 正式交付物进入个人历史云盘

- 状态：已接受（试验分支）
- 日期：2026-08-08
- 决策者：Runtime 团队
- 关联任务/PR：`test/cloud-drive-history-files`
- 关联决策：ADR-0016、ADR-0130、ADR-0131

## 背景

个人历史目录首版只在用户提交附件时写入 `thread_history_file_entries`，关系类型被数据库限制为
`user_attachment`。Agent 通过 `publish_artifact` 正式发布的 deliverable 已经形成稳定
`Resource/ResourceVersion` 与对象存储事实，但没有进入云盘和 Sandbox `/history`，造成用户上传文件与
Agent 交付文件存在两套发现体验。

不能把整个 Workspace 自动同步到云盘。Workspace 包含临时文件、中间产物、缓存以及 diagnostic/trace，
自动暴露会污染长期资源目录并扩大保留成本。正式 `deliverable` 是 Agent 已明确声明、通过完成门禁并完成发布结算的
用户交付边界，适合作为长期历史文件。

Artifact ResourceVersion 当前复用 `workspace` purpose 的 Stable Blob。若为了进入 ResourceFS 再复制为
`resource` Blob，会增加对象存储、网络和 GC 成本，也会产生两份内容身份。

## 决策

1. 仅当 `HISTORY_FILESYSTEM_ENABLED=true` 且 Artifact purpose 为 `deliverable` 时，在 Artifact 发布结算的
   同一数据库事务中写入个人任务历史目录。`diagnostic`、`trace` 和未发布 Workspace 文件不进入云盘。
2. 历史关系新增 `agent_deliverable` 类型，并记录 `source_artifact_id`。数据库通过生成的
   `source_artifact_purpose='deliverable'` 与复合外键约束 Artifact、Thread 和 purpose 必须一致；
   `user_attachment` 继续要求 `first_receipt_id`，两类来源互斥。
3. deliverable 与用户附件共享 `thread_history_directories.directory_name` 和
   `thread_history_file_entries.directory_entry_name`。目录使用任务语义标题；文件使用 Resource 原名；冲突继续采用
   `-2`、`-3`，文件序号位于扩展名前。
4. 若 deliverable 是任务中的第一个长期文件，Worker 使用与附件接收相同的目录创建与 Tenant 命名锁逻辑。
   标题仍在生成时创建 pending 目录，由既有标题完成流程原子改名。
5. ResourceFS 不复制 Blob。查询以 `resource_versions.blob_purpose` 连接 Stable Blob，允许读取
   `resource` 与 `workspace` 两种来源，并把真实 purpose 带入下载和 Cube Volume 读取授权。
6. 迁移 `0040_agent_deliverable_history` 回填个人 Tenant 中已经结算为 `published` 的历史 deliverable。
   已有任务目录保持不变；只有交付物而没有用户附件的任务才新建目录。
7. 云盘 API、`@` 文件选择和 Sandbox `/history` 继续读取同一个历史关系事实。选择历史 deliverable 后，
   Agent 仍获得不可变 `/resources/<resourceId>/<versionId>/<name>` 路径。

## 影响

### 正面影响

- 用户上传文件与 Agent 正式交付文件使用同一云盘、搜索、下载和 Sandbox 浏览体验；
- 不同步 Workspace 临时内容，长期目录保持可解释；
- Artifact Blob 原地复用，没有额外对象复制和网络传输；
- 发布与历史索引同事务提交，不会出现 Artifact 已成功但云盘关系静默缺失的半状态；
- 关系保留 Artifact 来源，后续可以增加“Agent 交付”标识、版本折叠和审计能力。

### 成本与限制

- ResourceFS 需要支持 `workspace` purpose 的 Stable Blob，并把 purpose 纳入二次授权比较；
- 历史表中的 `first_attached_at/last_attached_at` 对 deliverable 表示发布时间，字段名保留以避免本次扩大迁移范围；
- 替换发布会作为新的不可变 ResourceVersion 入口保留，当前不会自动隐藏旧交付版本；
- 团队 Tenant 仍不建立个人历史目录关系，后续团队云盘按独立权限模型实现。

## 验证

- 单元测试覆盖仅 deliverable 入库、diagnostic/trace 排除、个人 Tenant 限制、目录创建和文件重名；
- ResourceFS 测试覆盖 `workspace` Stable Blob 的云盘解析与动态 purpose 连接；
- API 测试覆盖 workspace-purpose 历史文件下载授权；
- 迁移测试覆盖 Artifact/Thread/purpose 复合来源约束、既有 deliverable 回填和可逆删除；
- PostgreSQL 事务验证执行 up/down，并检查回填目录、文件关系和 Blob purpose。

## 可逆性

down 迁移删除 `agent_deliverable` 历史关系与因此产生的空目录，恢复
`user_attachment + first_receipt_id` 单一来源约束。Artifact、ResourceVersion、Workspace Stable Blob 和原有下载能力
不被删除。应用层可关闭 `HISTORY_FILESYSTEM_ENABLED` 停止新增关系，但已建立的历史关系仍保持可读。
