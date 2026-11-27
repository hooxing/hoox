# Workspace、Resource 与交付物

本文面向修改文件工具、Workspace 发布、附件、云盘或交付物的开发者，说明三类文件事实的所有权和不变量。历史文件目录与 API 见[历史文件与 ResourceFS](../reference/history-files.md)，预览与引用见[文件预览](../reference/file-preview.md)，Sandbox 侧能力见 [Sandbox Provider](sandbox-providers.md)。

## 三类文件事实

| 事实 | 归属 | 语义 |
| --- | --- | --- |
| Workspace Revision | Thread | Thread 私有工作区的不可变快照；head 只能由持有 Workspace 租约的 Run 推进 |
| Resource / ResourceVersion | Tenant | 可跨 Thread 发现、导入和引用的不可变版本；用户上传与 Agent 交付都会形成 ResourceVersion |
| Artifact | Run | Agent 主动交付给用户的结果，只能绑定已验证的 ResourceVersion 与 stable Blob |

Sandbox 临时文件、长期资源和用户交付物不能混用身份。历史文件不会默认全部传给模型或 Sandbox；同一 Thread 连续工作不重复导入自己的文件；跨 Thread 复用必须稳定、可审计且不改写来源历史。

## Workspace 清单与物化

- Workspace 清单在物化前拒绝绝对路径、路径穿越和平台歧义；相同逻辑清单产生相同 digest 和操作顺序。
- 文件引用绑定 stable Blob 的不可复用 incarnation 与精确物理键。物化复用提示不代表租户授权或 Blob 完整性已经通过。
- 物化严格保持 `verify → remove → ensure → write` 顺序；Sandbox 中的 symlink、特殊文件、截断文件和超配额内容都不能成为可信 previous。
- 应用核心不获得宿主工作目录读写能力，大文件处理有单次内存和总量上限。
- Workspace 默认忽略 `node_modules` 等依赖目录，避免把可重建内容写入 Revision。

## 快照时机与采集

Workspace Revision 是 Sandbox 暂停或回收后仍能恢复文件的唯一副本，只在 Sandbox 即将离开当前 Run 时生成：

- 用过 Sandbox 的 Run 在模型收口后、Run 终态前快照 `/workspace`。Thread Sandbox 复用开启且队列中已有未取消的 follow-up 时跳过快照：终态事务把仍在运行的 Sandbox 直接交接给下一个 Run，文件随 Sandbox 延续，由最终暂停或关闭前的那个 Run 一并快照。waiting 收口、非 Thread 复用的 Sandbox 和 follow-up 查询失败时一律照常快照。
- 快照内容与当前 head 的清单 digest 相同时不形成新 Revision，候选以 `superseded` 释放，Run 以 `workspace_unchanged` 收口。因此 `workspace_unchanged` 与 `run_workspace_results.outcome='unchanged'` 只表示“本 Run 未提交新 Revision”，不保证 Sandbox 中的文件没有变化。
- 交接时 Session 的 `materialized_revision_id` 仍指向当前 head，Sandbox 可能包含该基线之后尚未快照的改动。复用与 head 校验不受影响；但这些改动在快照前只存在于 Sandbox 中：后续 Run 失败或进入恢复导致 Sandbox 被关闭，或者 follow-up 在查询之后被取消使 Sandbox 带着未快照改动暂停并在复用前过期，这些改动都会丢失。失败或取消的 Run 本身不提交 Revision，这一点不变。
- 采集只发一次 Sandbox 命令：受控 helper 以 dirfd 相对原语遍历 `/workspace`，在同一命令内读出全部普通文件内容并返回 base64，读前读后 fingerprint 不一致即失败关闭。Worker 在进程内保存这份不可变快照（总量受 Workspace 字节配额约束），后续 hash、比对与上传都读取内存副本，不再逐文件回到 Sandbox。只有相对 head 新增或变更的文件才上传为候选 Blob；未变更文件复用 head 的精确 incarnation。不同内容的候选以有界并发上传，内容相同的文件共享同一 content-addressed lifecycle，因此在同组内串行；任一上传失败后不再启动新上传，并等已启动的上传结束后才失败。
- Workspace 适配器不再单独连接 Sandbox：网关识别 Run 在 acquire 时取得的、由自己创建且 ID 与可信 binding 一致的 Handle，直接复用其 SDK 连接；伪造或不匹配的 Handle 照常走 connect 与 Provider 状态校验。同一 Session 内 materialize 与 verify 共用一个已打开的适配器；适配器每次调用仍重验 session、generation 与 scope。打开适配器不发远端命令：只读操作每次都以 `O_DIRECTORY|O_NOFOLLOW` 打开根目录并逐级 dirfd 相对访问，根缺失或类型漂移即失败关闭；openat2 能力探测推迟到首次写入前且每个适配器只做一次，因此不受支持的模板仍在任何写入副作用前以已知错误拒绝。

## 候选与原子交接

Sandbox 快照产生的新文件先形成 Attempt 级 candidate：

```text
building → prepared → committed
    │          │
    └──────────┴→ released
```

- `begin` 在 SERIALIZABLE 事务内锁定有效 Attempt、Run claim 与 Workspace 租约并核对 parent head。
- 把 Blob 引用标为 stable 与写入 candidate 文件在同一事务完成，不留下“已 stable、未归属 candidate”的窗口。
- `prepare` 要求清单中的每个文件来自本 candidate 的 uploaded 引用，或与 parent revision 同路径同 incarnation。
- 最终在同一 RuntimeMutation 中写入 revision、manifest、文件行，推进 head 并把 candidate 标为 committed。发布失败、修正轮次、终态和租约过期恢复都会释放未提交 candidate；`released` 是不可逆状态，不计入 GC 可达引用。

## 用户附件与 ResourceFS

- 上传形成 ResourceVersion；对象存储是权威来源，Sandbox 缓存可丢弃且不能反向修改 Resource。上传名称在持久化前规范化。
- Agent 通过 `/resources`、`/history`、`/thread-files` 等稳定只读路径访问文件，只有打开时才把内容传入 Sandbox。Agent 可见路径不依赖 Thread、Resource、Version ID，Sandbox 不持有对象存储凭据或物理对象键。
- 当前轮附件只以文件名和 `/resources/...` 路径写入最新 user turn；system、developer/harness prompt 与工具 Schema 不注入文件名、路径或目录内容。
- 视觉模型在首轮、follow-up 和 steer 中解析当前 user turn 的图片附件，由 Worker 从 stable Blob 校验读取后直接交给模型；Base64 只存在于 Worker 内存和 Provider 请求，不写入数据库。纯文本模型只接收路径事实。
- 个人与团队空间的边界与 Tenant/RLS/Blob 引用边界一致。个人任务使用团队文件必须导入为个人 ResourceVersion 副本，不能原地改写 `tenant_id`。

## 交付物

- 用户要求生成或提供文件时，模型须在写完最终文件后调用 `deliver_file`；仅写入 Workspace 或回复文件路径不会创建用户可见交付物。工具成功后工作台显示文件卡片并提供安全预览/下载。目录、symlink 和特殊文件不会成为交付物，文件不存在返回可修正错误。
- Tool call ID 是幂等身份来源。Artifact、Resource、ResourceVersion 与内部 deliverable key 由 Runtime 确定性生成，模型不能提交这些字段。
- Runtime 计算大小、SHA-256 与保守 media type，未知或主动内容默认 `application/octet-stream`。字节先经 Blob 提交协议形成 stable 引用，再在单一事务中创建 Resource、ResourceVersion、deliverable Artifact 与 `published` 结算；只有读回 published 事实后工具才返回成功。
- 必需发布失败时 Run 保持未完成，Agent 以新版本修正；摘要不同的重复命令不能改写不可变发布。
- 启用历史文件系统时，普通任务与 API 任务的正式交付物（包括 `deliver_file`）在发布结算的同一事务中登记到所属空间的任务历史。关闭开关时不登记，重放也不补录已发布的交付物。Playground、评测、`diagnostic`、`trace` 与未发布 Workspace 文件不进入云盘。

## 下载与预览

- 下载不相信客户端提供的对象键、媒体类型、文件名或签名参数；签发后再次读取并逐字段确认授权修订与 Blob 绑定，任何漂移按 404 失败关闭。
- 对象写入记录首次写入的 `Content-Type`，复制时保留；媒体类型不参与内容身份，同一物理对象可被不同类型的业务引用复用。普通 S3 下载仍以授权引用覆盖响应类型；OSS 不发送响应类型覆盖，实际类型来自对象元数据。OSS 仅在存储类型与期望类型完全一致且为 PNG、JPEG、GIF、WebP 或 PDF 时允许内联，类型不一致或危险类型均回退为附件，不通过重写共享对象元数据修正单个引用。
- Blob 与 Skill 发布的条件首写默认使用 `If-None-Match: *`，OSS 使用 `x-oss-forbid-overwrite: true`；HTTP 412 或 HTTP 409 `FileAlreadyExists` 均表示已存在，必须沿用内容校验后幂等收敛，不能改成无条件覆盖。readiness 只 HEAD 固定哨兵对象，200/404 就绪，其余失败，不要求 Bucket 管理权限。
- 预签名地址有效期最长 300 秒，Bucket 保持私有。交付物默认 `attachment`；只有安全文本、常见图片和 PDF 可以 inline 预览，HTML、SVG、XML 等主动内容只能下载。
- 用户只能看到正式 deliverable，诊断与轨迹 Blob 不进入下载界面。未知数据库、对象存储或签名异常不泄漏私有消息、对象键或签名 URL。
