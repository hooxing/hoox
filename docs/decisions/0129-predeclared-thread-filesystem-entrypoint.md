# ADR-0129：预声明 Thread 文件系统稳定入口

- 状态：已接受
- 日期：2026-08-07
- 决策者：Runtime 团队
- 关联任务/PR：修复空 Thread 首次上传附件后复用 Sandbox 失败
- 替代关系：修正 ADR-0128 中“只枚举有历史文件的 Thread”与本地空 `/thread-files` 回退

## 背景

ADR-0128 解决了 WebDAV 隐藏父目录完全不可遍历的问题，但仍只在
`thread_history_file_entries` 已存在关系时枚举 `.thread-files/<threadId>`。没有附件的 Thread 在首个 Run 中因此没有远端稳定
目录，Worker 会在 Sandbox 根目录创建本地只读空 `/thread-files`。

真实连续运行复现了新的时序：

1. 空 Thread 的 Run 创建并暂停持久 Sandbox，本地 `/thread-files` 为空目录；
2. 用户在下一 Run 首次上传附件，数据库在领取前建立历史文件关系；
3. Worker 恢复同一个 Sandbox，ResourceFS 此时才新增 `.thread-files/<threadId>` 父目录；
4. Cubelet 上持续存在的 rclone/WebDAV mount 仍可能持有“该 Thread 不存在”的目录缓存；
5. Worker 为判断是否把本地空目录升级为软链接而对新路径执行 `stat(2)`，路径解析会延迟甚至占满命令超时；
6. 模型 HTTP 请求尚未开始，Attempt 已因 Sandbox 准备失败进入 `recovery_required`。

新建 Sandbox 的相同路径可以立即访问，证明 Blob、ResourceFS 授权和文件关系本身均正常；失败只出现在“父目录从不存在变为存在”且
复用旧 mount 的边界。稳定路径不能只保证字符串不变，也必须保证其全部父目录拓扑从 Thread 创建起就存在。

## 决策驱动因素

- `/thread-files` 在空 Thread、首次附件和后续附件之间必须保持同一种目录语义；
- 首个附件不能要求刷新 Tenant Volume、重建 FUSE mount 或重启 Sandbox；
- Worker 准备阶段不能为探测最终一致的远端路径阻塞到 Sandbox 命令超时；
- 当前 personal Tenant 隔离、team Tenant 关闭语义和 Agent-facing 无 Thread ID 契约必须保持不变；
- 不复制文件，不预下载 Blob，不向 Sandbox 暴露对象存储凭据。

## 备选方案

### 首个附件后主动刷新 rclone 目录缓存

拒绝。rclone 运行在 Cubelet Volume Plugin 中，Worker 和 Sandbox 不持有其控制面；为单个 Thread 引入跨节点缓存失效协议会扩大部署耦合，
且缓存刷新仍是动态父目录的补偿，不是稳定命名空间。

### 检测本地空目录后终止并重建 Sandbox

拒绝作为常规路径。它会让首次附件必然损失暂停 Sandbox 的内存和进程状态，并增加 Volume attach、Workspace 物化和生命周期恢复成本。

### 保留本地空目录，等 Agent 真正读取附件时再处理

拒绝。用户当前轮已经上传附件时，`/thread-files/<name>` 必须可读；向模型暴露一个已知不完整的目录会把平台一致性错误推迟成工具错误。

### 从 Thread 创建起预声明远端空目录

采用。ResourceFS 的隐藏根枚举 personal Tenant 的全部 Thread，而不是只枚举已有文件关系的 Thread。每个 Thread 从创建起都拥有
`.thread-files/<threadId>/files`；空目录不包含文件，首个附件只在既有 `files` 目录下增加文件节点。

## 决策

1. `HistoryFilesystemCatalog` 的隐藏入口查询改为按 `threads(tenant_id, id)` 枚举全部 personal Thread。
2. `.thread-files/<threadId>/files` 对没有历史文件关系的 Thread 返回成功的空目录。
3. Worker 始终把 `/thread-files` 创建为指向可信当前 Thread 稳定路径的软链接，不再先对远端目标执行 `stat(2)`。
4. 旧 Sandbox 中遗留的本地空 `/thread-files` 仅作为迁移状态处理：确认仍为空后删除并替换为同一软链接；非空目录、普通文件或错误软链接
   继续失败关闭。
5. `/history` 最近六个月发现窗口、文件按需读取、Blob 引用和文件名冲突规则不变。
6. team Tenant 继续返回能力不存在；本期不引入团队成员可见性语义。

## 影响

### 正面影响

- 空 Thread、首个附件和后续附件共享完全相同的远端目录拓扑；
- 首个附件不再依赖 rclone 发现一个新 Thread 父目录；
- Worker 固定入口准备不再对可能陈旧的隐藏目标执行阻塞式存在性探测；
- `/thread-files` 从第一轮起就是稳定软链接，模型无需理解空目录回退或升级状态。

### 成本与限制

- `.thread-files` 的 depth-1 PROPFIND 会枚举 personal Tenant 的全部 Thread，而非只有含文件的 Thread；
- 查询只读取 `threads` 主键索引，不读取历史文件、ResourceVersion、Blob 或对象正文，但仍需观测超大个人 Tenant 的响应大小；
- `ls -a /resources/.thread-files` 可以看到个人 Tenant 的全部内部 Thread ID。Thread ID 不是 capability，且当前 personal Tenant 只有一个用户；
  team Tenant 上线前仍须重新评估成员隔离；
- 已经挂载并缓存旧拓扑的存量 Sandbox 可能需要一次生命周期淘汰；新建或重新创建的 Sandbox 从首次挂载起获得稳定拓扑。

## 验证

- Persistence 测试证明空 Thread 也来自 `threads` 查询，且不连接历史文件或 Blob 表；
- ResourceFS HTTP 测试证明空 Thread 的稳定 `files` 路径返回 207 和空目录；
- Worker 测试证明不再探测远端目标，并能把旧本地空目录升级成软链接；
- 真实 Cube Gate 覆盖：空 Thread 建立软链接、暂停 Sandbox、首次附件出现、恢复后通过同一路径读取文件；
- 全量工程检查继续覆盖格式、Lint、类型、单元测试、构建和环境契约。

## 回退与可逆性

代码回退可恢复为只枚举有文件 Thread，但会重新引入首次附件的动态父目录和 rclone 缓存失败。数据库没有新增表或迁移，Blob、ResourceVersion
和历史关系均不受影响。若全部 Thread 枚举在超大个人 Tenant 中成为瓶颈，应以新的固定分片命名空间或带 Thread capability 的 Volume 协议替代，
不能再次依赖运行中新增父目录。
