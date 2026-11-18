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

- 模型通过 `deliver_file` 交付 `/workspace` 下的普通文件；目录、symlink 和特殊文件不会成为交付物，文件不存在返回可修正错误。
- Tool call ID 是幂等身份来源。Artifact、Resource、ResourceVersion 与内部 deliverable key 由 Runtime 确定性生成，模型不能提交这些字段。
- Runtime 计算大小、SHA-256 与保守 media type，未知或主动内容默认 `application/octet-stream`。字节先经 Blob 提交协议形成 stable 引用，再在单一事务中创建 Resource、ResourceVersion、deliverable Artifact 与 `published` 结算；只有读回 published 事实后工具才返回成功。
- 必需发布失败时 Run 保持未完成，Agent 以新版本修正；摘要不同的重复命令不能改写不可变发布。
- 启用历史文件系统时，deliverable 在发布结算的同一事务中写入个人任务历史目录；`diagnostic`、`trace` 与未发布 Workspace 文件不进入云盘。

## 下载与预览

- 下载不相信客户端提供的对象键、媒体类型、文件名或签名参数；签发后再次读取并逐字段确认授权修订与 Blob 绑定，任何漂移按 404 失败关闭。
- 预签名地址有效期最长 300 秒，Bucket 保持私有。交付物默认 `attachment`；只有安全文本、常见图片和 PDF 可以 inline 预览，HTML、SVG、XML 等主动内容只能下载。
- 用户只能看到正式 deliverable，诊断与轨迹 Blob 不进入下载界面。未知数据库、对象存储或签名异常不泄漏私有消息、对象键或签名 URL。
