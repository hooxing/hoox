# ADR-0092：ResourceFS Attach 验证真实数据面

- 状态：已接受
- 日期：2026-08-03
- 决策者：Runtime 维护者
- 关联任务/PR：修复上传文件读取耗尽 Sandbox 生命周期
- 替代关系：补充 ADR-0079 与 ADR-0082 的 Attach 就绪条件

## 背景

Cube ResourceFS Volume Plugin 原先只等待 `mountpoint` 成立便返回 `host_path`。FUSE 条目存在只能证明内核
接受了挂载，不能证明 rclone 仍健康，也不能证明 Cubelet 到 Runtime ResourceFS WebDAV 端点可达。真实故障
中，普通 Sandbox 命令和本地 ResourceFS 读取均正常，但挂载 `/resources` 后第一次打开上传文件会一直阻塞；
Runtime API 没收到对应请求，最终一次 `read` 消耗完整个 120 秒 Sandbox 生命周期，后续工具全部不可用。

同一问题也会让已失效但仍被 `mountpoint` 识别的 FUSE 条目被后续 Attach 永久复用。Worker 目前只探测 Cube
Volume 管理 API，无法从管理面证明宿主挂载的数据面健康。

## 决策驱动因素

- Attach 成功必须表示 Sandbox 随后可以实际访问 `/resources`，不能只表示存在 FUSE 条目；
- 远端不可达时应在创建 Sandbox 阶段有限失败，不能让模型工具等待到 Sandbox 到期；
- 复用长期 Tenant Volume 时应能自动修复没有既有使用者的残留挂载；
- 多个 Sandbox 正在共享挂载时，Attach 不得擅自卸载其数据面；
- readiness 不得输出 bearer capability、资源目录或上游错误正文。

## 备选方案

### 方案 A：继续只检查 mountpoint

没有额外请求，但会把失效 FUSE 和不可达 WebDAV 误报为就绪，故障只能在模型工具阶段暴露。

### 方案 B：由 Worker 创建探针 Sandbox 后读取 `/resources`

可以覆盖完整链路，但需要额外 Sandbox 生命周期、Tenant 资源样本和 Worker 状态协调；而所有调用方仍可能绕过
该探针直接使用不健康 Volume。

### 方案 C：Volume Plugin 在 Attach 内验证远端与挂载视图

插件使用本次 Attach 的同一短期 capability 执行有界 `rclone lsf`，再对 FUSE 根目录执行有界枚举。已有挂载
失败且 `refCount=1` 时先卸载再重建；存在既有使用者时失败关闭，不破坏共享挂载。

## 选择

采用方案 C：

1. Attach 在返回 `host_path` 前，用同一 WebDAV endpoint 和 capability 执行 `rclone lsf`；连接超时 5 秒、
   I/O 超时 10 秒，禁用额外重试，输出全部丢弃。
2. 对已存在和刚创建的 FUSE 挂载都执行最多 10 秒的根目录枚举，避免把“仅有 mountpoint”当作可用。
3. 已有挂载探测失败时，只有 `refCount=1` 才允许卸载并重建；更高 refCount 直接失败。
4. 新挂载探测失败时，卸载 FUSE、终止本次 rclone 并让 Attach 失败，不向 Cube 返回 `host_path`。
5. 插件在 root 管理的 Tenant 日志目录以 `0600` 文件记录 rclone PID。Detach 在 refCount 归零时先卸载
   FUSE，再校验 PID 对应进程的完整命令身份并有界终止，不能假设 lazy unmount 会让 rclone 自行退出；
   rclone 可执行路径的默认值在 Attach/Detach 共用的配置加载阶段完成，避免 Detach 在卸载后因未初始化变量中断。

## 理由

数据面就绪事实只有 Volume Plugin 能在返回挂载路径前原子建立。远端直探可区分 WebDAV/网络故障，FUSE
枚举可继续发现残留挂载；二者组合避免把错误延迟到模型执行阶段。`refCount=1` 限制保留共享挂载安全边界。

## 影响

### 正面影响

- ResourceFS 端点不可达时 Sandbox 创建会快速、明确失败；
- 没有既有使用者的失效 FUSE 可在下一次 Attach 自动恢复；
- 单次上传文件读取不再消耗整个 Sandbox 生命周期并连锁破坏后续工具。

### 负面影响与成本

- 每次 Attach 增加一次受控 WebDAV 根目录请求和一次宿主挂载枚举；
- endpoint 暂时不可达时不能依赖 rclone 目录缓存继续创建新 Sandbox；
- 已有使用者共享坏挂载时不会自动卸载，需要运维先收敛 refCount。

### 安全与运维影响

- capability 只通过进程环境传给 rclone，探针输出和上游正文不进入 Hook 输出；
- Cubelet 必须安装 coreutils `timeout`，并能从宿主网络访问配置的 HTTPS ResourceFS endpoint；
- 本地开发 API 若只监听 `127.0.0.1`，不能直接作为远端 Cubelet endpoint，必须提供受保护且可达的代理。

## 验证

- 契约测试固定远端探针、超时、单次重试、挂载枚举、refCount 修复边界和失败清理；
- ShellCheck 与格式、lint、TypeScript 测试继续通过；
- 目标 Cube 节点部署后，以已知 Tenant Volume 创建 Sandbox，读取上传文件并验证 Runtime API 出现对应
  ResourceFS 请求；故障注入不可达 endpoint 时，Attach 应在有界时间失败且不返回 `host_path`。

## 可逆性与回退

本变更不修改 Resource、Blob、Volume ID 或数据库。可回退插件脚本，但会重新允许坏挂载误报就绪；回退前
应先恢复 endpoint 并清空残留 FUSE。探针超时可在后续根据节点网络指标调整，不影响持久数据。

## 实施记录

- 2026-08-03：增加远端 WebDAV 与 FUSE 双探针、残留挂载有条件自愈和失败清理。
- 2026-08-03：真实回归发现 `fusermount3 -uz` 后 rclone 仍可存活；增加受信 PID 记录、进程身份校验和
  Detach 有界回收。
- 2026-08-03：修复 Detach 未初始化 rclone 可执行路径导致 FUSE 已卸载但后台进程与 PID 文件残留。
