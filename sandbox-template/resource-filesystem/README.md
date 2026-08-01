# Resource 虚拟目录模板叠加层

本模板在现有 Agent Sandbox 镜像上增加 `rclone` 与 FUSE3。Worker 在每次创建或恢复
Sandbox 时，把 API 内置的只读 WebDAV Resource 边界挂载到 `/resources`。目录项立即可见，
文件内容在进程首次打开时由 rclone VFS 拉取并缓存在 Sandbox 临时目录中。

构建时必须显式传入已经过供应链审核的基础镜像：

```bash
docker build \
  --build-arg BASE_IMAGE=<现有-agent-sandbox-image@sha256:...> \
  --build-arg RCLONE_IMAGE=<rclone/rclone:1.71.2@sha256:...> \
  -t <registry>/agent-sandbox-resource-fs:<version> \
  sandbox-template/resource-filesystem
```

随后用该镜像构建 CubeSandbox Template，并把新的 Template ID 配置到
`CUBESANDBOX_TEMPLATE_ID`。运行环境必须向 Sandbox 提供 `/dev/fuse`；若 Provider 禁止
FUSE，Worker 会在模型启动前失败关闭，不会退化为把全部 Resource 预下载进 Sandbox。
两个基础镜像都必须使用审核过的 digest，禁止只传可漂移 tag；现有基础镜像需为支持
`apt-get` 的 Debian/Ubuntu 系。

安全边界：

- `/resources` 只读且位于 `/workspace` 之外，不参与 Workspace 发布。
- Sandbox 仅持有绑定 Tenant、Sandbox ID 与短 TTL 的 Resource capability，不持有 MinIO 凭据。
- capability 到期或 Sandbox 恢复时，Worker 会重新挂载并签发新 capability。
- 当前 WebDAV 路由随 API 进程部署；后续可拆为独立子模块，但路径和 capability 契约保持不变。
