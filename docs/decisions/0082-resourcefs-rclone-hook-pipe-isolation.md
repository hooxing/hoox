# ADR-0082：ResourceFS rclone 进程隔离 Volume Hook 输出管道

- 状态：已接受
- 日期：2026-08-02
- 决策者：Runtime 团队
- 关联任务/PR：Cube ResourceFS Volume Plugin 真实部署 Gate
- 替代关系：补充 ADR-0079

## 背景

Cubelet 的 binary Volume driver 使用 Go `exec.Cmd` 收集插件 stdout/stderr，并等待进程退出和两个管道读到
EOF。首版插件执行 `rclone mount --daemon`：FUSE mount 已成功，rclone daemon 却保留了 Hook 输出管道的
写端文件描述符，导致 `cmd.Run()` 永远等不到 EOF。首次 Sandbox 创建停在 Attach，后续同 Volume 创建又
被 Cubelet 的逐卷互斥锁阻塞，CubeAPI 最终均返回 408。

## 决策驱动因素

- Attach 必须在 mount 就绪后返回单个 JSON 并关闭全部 Hook 管道；
- rclone 必须在插件进程退出后继续服务 FUSE；
- 启动失败必须在有限时间内失败关闭，不能遗留无效后台进程；
- Detach 仍由 Cubelet refCount 归零时通过 FUSE 卸载终止 rclone。

## 备选方案

### 方案 A：继续使用 rclone `--daemon`

命令简洁，但真实 rclone 1.74 与 Cubelet `exec.Cmd` 的组合会泄漏管道描述符并永久阻塞 Hook。

### 方案 B：由插件显式后台启动并重定向标准流

移除 `--daemon`，将 rclone 的 stdin、stdout、stderr 全部与 Hook 管道隔离后置于后台；插件轮询 mountpoint，
成功后输出 JSON，进程提前退出或十秒内未挂载则清理并失败。

### 方案 C：改为常驻 RPC 插件

可以自行管理子进程生命周期，但当前问题无需引入 RPC 服务、进程监督和额外发布单元。

## 选择

采用方案 B。rclone 以前台模式作为插件的后台子进程运行，标准输入来自 `/dev/null`，标准输出和错误不继承
Hook 管道，运行日志继续写入每卷的受控日志文件。挂载轮询期间同时检查子进程存活。

## 理由

问题不是 FUSE 或 WebDAV 挂载失败，而是 binary Hook 与 daemon 文件描述符生命周期不兼容。显式标准流
隔离直接消除 `exec.Cmd` 的 EOF 等待条件，同时保留现有 binary 插件、挂载目录与 Detach 契约。

## 影响

- Attach 在 mountpoint 就绪后立即返回，后续同卷创建不再阻塞；
- rclone 由 PID 1 接管，最后一次 Detach 的 `fusermount3 -uz` 使其退出；
- 插件失败路径会等待或终止本次启动的 rclone，不留下未挂载进程。

## 验证

- 部署契约测试禁止恢复 `--daemon`，并要求标准流重定向、PID 记录和存活检查；
- 目标 Cube 节点验证 Attach 后 Cubelet 不再保留 Hook 子进程，Sandbox 创建成功；
- Sandbox 内读取已知 ResourceFS 文件成功，写入失败，Kill 后宿主 FUSE 和 rclone 均退出。

## 可逆性与回退

可回退到已验证不会继承 Hook 管道的独立 RPC mounter；不能直接恢复当前 rclone `--daemon` 调用。该变更
不涉及 Resource、Blob、Volume 身份或 capability 数据迁移。

## 后续工作

- ResourceFS 拆为独立服务时评估由 systemd 管理共享 rclone 进程的必要性。

## 实施记录

- 2026-08-02：在 CubeSandbox 0.6、Go binary driver 与 rclone 1.74 的真实进程文件描述符中确认根因。
