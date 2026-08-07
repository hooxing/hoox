# ADR-0128：ResourceFS 隐藏 Thread 父目录的 WebDAV 可遍历性

- 状态：已接受
- 日期：2026-08-07
- 决策者：Runtime 团队
- 关联任务/PR：修复 personal Thread 固定文件入口导致的 Sandbox 失败
- 替代关系：修正 ADR-0120 中“隐藏稳定 Thread 视图不参与根目录枚举”的实现假设；“只枚举有文件 Thread”与本地空目录回退由 ADR-0129 修正

## 背景

真实 Cube Volume 黑盒发现，ResourceFS HTTP 可以对
`/resources/.thread-files/<threadId>/files` 执行精确 PROPFIND，但 rclone WebDAV VFS 不会直接跳过父目录查找。
它必须先从根目录枚举到 `.thread-files`，再从该目录枚举到 `<threadId>`，才能让 Sandbox 内的 `stat(2)`、
`open(2)` 和软链接解析成功。

原实现刻意不在根 PROPFIND 中返回 `.thread-files`，也不在隐藏根下返回 Thread ID。结果是 FUSE 中
`/resources/history` 正常存在，而 `/resources/.thread-files` 永远表现为 `ENOENT`。Worker 在准备
`/thread-files` 固定入口时因此失败关闭，Run 最终进入 `SANDBOX_FAILED`。没有附件的新 Thread 也会触发该问题，因为原命令
错误地要求远端稳定目录必须存在。

## 决策驱动因素

- `/thread-files` 必须在真实 rclone/FUSE 中具备原生目录语义，不能只在 HTTP 单元测试中可达；
- Agent-facing 路径不能包含 Thread ID；
- personal Tenant 的空 Thread 应获得空的 `/thread-files`，不能因为没有附件而使整个 Run 失败；
- 不复制 Blob，不向 Sandbox 暴露对象存储凭据或物理对象键；
- team Tenant 仍不得获得个人历史投影；
- Thread ID 不是授权 capability，真正边界继续由 Tenant Volume capability、RLS 和 Blob 引用提供。

## 备选方案

### 继续隐藏所有 WebDAV 父目录条目

拒绝。HTTP 精确路径虽然可解析，但 rclone VFS 无法遍历，真实 Sandbox 中固定入口不可用。

### 为每个 Sandbox 或 Thread 创建独立 Volume

拒绝。它会破坏 Tenant 级 Volume 的资源模型，并使 Volume、FUSE/rclone mount、缓存和恢复状态随 Thread 数量增长。

### 在 Sandbox 中复制当前 Thread 的全部文件

拒绝。它会把按需读取退化为预下载，增加网络、磁盘和大文件启动延迟，也产生新的清理与一致性状态。

### 枚举受限隐藏父目录，并为空 Thread 提供本地空目录

采用。WebDAV 根返回 dot 目录 `.thread-files`；本 ADR 首版让隐藏根只枚举 personal Tenant 中已经存在历史文件关系的 Thread ID，不加载
ResourceVersion 或 Blob。Worker 仍只用可信领取快照拼接内部目标，并把它映射为 Agent-facing `/thread-files`。若当前 Thread
没有历史文件关系，Worker 创建只读空目录；后续同一 Sandbox 出现首个附件时，允许把仍为空的本地目录原子替换为稳定软链接。

## 决策

1. personal Tenant 启用历史 Catalog 时，ResourceFS 根 PROPFIND 同时返回 `history` 和 `.thread-files`。dot 目录在普通
   `ls` 中仍隐藏，但满足 WebDAV/FUSE 父目录解析要求。
2. `HistoryFilesystemCatalog` 增加只返回有文件 Thread ID 的查询。查询使用
   `thread_history_file_entries(tenant_id, thread_id, ...)` 索引，不连接 ResourceVersion、Blob 或对象键。
3. `.thread-files` 的 depth-1 PROPFIND 返回上述 Thread 目录；其下仍只提供固定 `files` 子目录和只读文件节点。
4. team Tenant 返回能力不存在；同一 personal Tenant 内的 Thread ID 枚举不是新增授权边界。模型只获得 `/thread-files` 软链接，
   Harness 不注入 Thread ID 或隐藏路径。
5. 当前 Thread 没有文件时，Worker 创建模式为 `0555` 的本地空 `/thread-files`。若复用 Sandbox 后目标出现，只允许在目录仍为空时
   删除并替换为软链接；非空目录、普通文件、错误软链接继续失败关闭。
6. `/history` 最近六个月语义目录规则不变。已知旧语义路径在 rclone 父目录缓存下的精确可达性仍需后续独立解决，本 ADR 不扩大
   历史发现窗口。

后续真实“空 Thread 首次上传附件并复用暂停 Sandbox”黑盒证明，第 2、5 项仍会让 rclone 缓存动态父目录。
ADR-0129 因此改为预声明全部 personal Thread，并取消本地空目录作为正常路径。

## 影响

### 正面影响

- 真实 Cube Sandbox 可以解析稳定内部 Thread 路径；
- 无附件任务不再因缺少远端目录而失败；
- 当前附件仍通过同一 Tenant Volume 按需读取，不复制数据；
- `/thread-files` 对模型保持固定、无 ID 的原生目录体验。

### 成本与限制

- 首次解析隐藏根时需要枚举当前 personal Tenant 中有历史文件关系的 Thread ID；该查询不读取文件正文，但长期需要性能观测；
- `ls -a /resources` 可以看到 `.thread-files`，主动进入后可看到同一 personal Tenant 的内部 Thread ID。personal Tenant 当前只有一个
  用户，且 Thread ID 不是授权 capability；团队 Tenant 启用前必须重新评估成员可见性；
- rclone 的短期目录缓存仍可能延迟刚新增的目录条目，缓存失效机制和更严格的新附件黑盒 Gate 继续作为后续运维工作。

## 验证

- ResourceFS HTTP 测试覆盖根 dot 目录、隐藏 Thread 父目录和 team Tenant 关闭语义；
- Persistence 单元测试覆盖仅查询历史关系索引、不连接 Blob/ResourceVersion；
- Worker 测试覆盖空目录回退、空目录向软链接升级和异常对象失败关闭；
- 真实 Cube 黑盒验证 `/history`、空 `/thread-files`、有文件 `/thread-files` 和 Agent `exec_command`。

## 回退与可逆性

关闭 `HISTORY_FILESYSTEM_ENABLED` 会同时停止历史投影和 Worker 固定入口。代码回退只删除隐藏父目录枚举和空目录回退，不改变数据库
关系、ResourceVersion 或 Blob。若团队能力启动前需要更强成员隔离，应以新 ADR 替代本决策并引入 user/team scope capability。
