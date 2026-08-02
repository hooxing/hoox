# Cube ResourceFS Volume Plugin 部署

该插件面向 CubeSandbox 0.6 及以上版本。Runtime 为每个 Tenant 创建一个长期 Cube Volume，创建
Sandbox 时把它绑定到 `/resources`；Cubelet 在宿主机按需挂载只读 WebDAV ResourceFS，再由 Cube 的
virtiofs 暴露给 microVM。Sandbox 模板不再安装 rclone/FUSE，也不需要 `/dev/fuse`、对象存储凭据或
ResourceFS bearer token。

## 节点安装

在 CubeMaster 和每个 Cubelet 节点安装 `resourcefs-volume-plugin.sh` 到 root 可执行路径。在每个
Cubelet 安装 rclone、FUSE3、OpenSSL 和 coreutils；CubeMaster 只执行 create/destroy，不需要 rclone。
将 `resourcefs-volume.conf.example` 复制为 `/etc/cubesandbox/resourcefs-volume.conf`，替换 HTTPS
端点和签名密钥，确认 `RESOURCEFS_VOLUME_BASE_DIR` 与 Cubelet 的 `volume_plugin_base_dir` 相同，并设置
`root:root 0600`。签名密钥必须与 API 的
`RESOURCE_FILESYSTEM_SIGNING_KEY` 完全一致，配置文件不得进入镜像或 Git。

CubeMaster `conf.yaml`：

```yaml
volume_plugins:
  - name: runtime-resourcefs
    type: binary
    binary_path: /usr/local/libexec/cubesandbox/resourcefs-volume-plugin.sh
```

Cubelet `config.toml`：

```toml
[plugins."io.cubelet.internal.v1.storage"]
  volume_plugin_base_dir = "/data/cube-shared/volume"

[[plugins."io.cubelet.internal.v1.storage".volume_plugins]]
  name = "runtime-resourcefs"
  type = "binary"
  binary_path = "/usr/local/libexec/cubesandbox/resourcefs-volume-plugin.sh"
```

两侧重启后，把 Worker 的 `CUBESANDBOX_RESOURCE_VOLUME_DRIVER` 设为同一个 driver 名。Worker
readiness 会只读探测 `/volumes`，从而拒绝 Cube 0.6 以下的平台；首次真实 Run 才会幂等创建 Tenant
Volume。Volume 只是视图选择器，destroy hook 绝不删除 Resource 或 Blob。

## 上线 Gate

在目标 Cube 节点完成以下验证后再承载用户流量：

1. 使用 Runtime Worker 创建 Sandbox，确认 Cube Volume attach 成功且 `/resources` 可枚举；
2. 打开一个文件，确认字节来自当前 Tenant 的稳定 ResourceVersion，且 Sandbox 内写入失败；
3. 同 Tenant 两个 Sandbox 共享宿主机 mount，不同 Tenant 不能互读；
4. pause/resume 后路径仍可读，最后一个 Sandbox kill 后 detach 卸载宿主机 FUSE；
5. Sandbox 内不存在 rclone 进程、bearer token、MinIO 凭据或宿主机物理对象键；
6. 轮换签名密钥时先清空/重建宿主机挂载，再撤销旧密钥，避免旧 mount 在缓存未命中时失败。

排障时注意：Cubelet 的 binary Detach 不传 `--volume-base-dir`。插件只接受 Attach 返回的精确
`metadata.mount_dir`，并以 root 配置中的 `RESOURCEFS_VOLUME_BASE_DIR` 重建路径；不要从 metadata 接受任意
宿主机路径。
