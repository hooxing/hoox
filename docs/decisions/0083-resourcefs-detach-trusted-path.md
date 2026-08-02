# ADR-0083：ResourceFS Detach 只使用受信挂载根目录

- 状态：已接受
- 日期：2026-08-02
- 决策者：Runtime 团队
- 关联任务/PR：Cube ResourceFS Volume Plugin 真实部署 Gate
- 替代关系：补充 ADR-0079

## 背景

Cubelet 的 binary Attach 会传 `--volume-base-dir`，Detach 按官方协议只传 volume ID、refCount 和 Attach
返回的 metadata。首版插件却在 Detach 校验空的 `VOLUME_BASE_DIR`，导致 Sandbox 内容读写验证成功后，
Kill 在卸载阶段失败，CubeMaster 返回 130593。真实修正中还发现 `set -e` 会把成功卸载后的
`mountpoint -q && fail` 整体非零状态误判为脚本失败，因此最终检查必须使用显式 `if`。

Detach 必须能重建挂载路径，但不能直接信任 metadata 中的任意宿主机路径，否则损坏或伪造的内部状态可能
让插件卸载超出 ResourceFS 管理范围的 mount。

## 决策驱动因素

- 严格遵守 Cube 0.6 binary Detach 参数契约；
- 卸载目标必须限制在 Cubelet 配置的 Volume 根目录内；
- Attach 与 Detach 必须对同一根目录达成一致；
- 已有未声明根目录的部署应平滑使用 Cube 默认值。

## 备选方案

### 方案 A：从 metadata 解析并直接使用 mount_dir

兼容协议，但把宿主机卸载目标交给持久化 metadata，扩大故障和篡改影响。

### 方案 B：从 root 配置重建路径并精确校验 metadata

配置 `RESOURCEFS_VOLUME_BASE_DIR`，默认使用 Cube 的 `/data/cube-shared/volume`。Attach 要求 Cubelet 传入
相同目录；Detach 按该目录和已验证 volume ID 重建唯一路径，并要求 metadata 与之精确一致。

### 方案 C：忽略 metadata

可以完成当前卸载，但无法检测 Cubelet 持久状态与部署配置漂移。

## 选择

采用方案 B。配置文件仍须 root:root 0600；Detach 不读取未提供的 `--volume-base-dir`，也不接受 metadata
指定其他路径。

## 理由

根目录是节点部署事实，应由 root 配置控制；volume ID 已受字符集和长度校验。两者组合得到唯一可卸载路径，
再与 Attach 返回的 metadata 精确比对，既满足协议又保持失败关闭。

## 影响

- 新增可选 `RESOURCEFS_VOLUME_BASE_DIR`，默认值与 Cube 0.6 一致；
- 非默认 Cubelet `volume_plugin_base_dir` 的部署必须同步配置该值；
- 配置漂移或 metadata 不一致时 Detach 明确失败，不会尝试猜测路径。

## 验证

- 部署契约测试验证默认根目录、metadata 精确校验以及 Detach 不依赖 `VOLUME_BASE_DIR`；
- 目标节点完成 Sandbox 创建、文件读取、只读写入失败、Kill、FUSE 卸载和 rclone 退出全链路验证。

## 可逆性与回退

可改为 RPC 插件并把可信根目录作为服务端配置保留。该变更不涉及 Resource、Blob 或 Cube Volume 数据迁移。

## 后续工作

- 多节点部署工具应校验 Cubelet 与 ResourceFS 插件的根目录配置一致。

## 实施记录

- 2026-08-02：根据 CubeSandbox v0.6.0 官方 binary driver 参数和真实 Kill 失败完成修正。
