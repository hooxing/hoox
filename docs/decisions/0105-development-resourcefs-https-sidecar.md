# ADR-0105：开发环境 ResourceFS 最小 HTTPS Sidecar

- 状态：已接受
- 日期：2026-08-04
- 决策者：Runtime 团队
- 关联任务/PR：VM 内 Resource Volume Plugin 无法连接 Windows loopback API
- 替代关系：补充 ADR-0103

## 背景

开发 API 按安全边界只监听 Windows `127.0.0.1`。Cubelet 位于 VMware 虚拟机，Resource Volume Plugin 的
WebDAV endpoint 必须通过 HTTPS 访问宿主机。实机诊断确认插件、rclone、FUSE 与签名密钥均正确，但配置的宿主
HTTPS 端口没有监听者，导致所有带附件 Sandbox 在 Volume attach 阶段失败。直接把完整 API 绑定到虚拟网卡会把
认证、Thread、Run 等无关路由一并暴露，不能接受。

## 备选方案

### 将开发 API 改为虚拟网卡监听

部署简单，但扩大 API 攻击面并破坏 loopback-only 的既有开发边界。

### 让 Volume Plugin 绕过 TLS 直接访问宿主 API

需要放宽 endpoint 契约和传输安全，且能力令牌会在虚拟网络中明文传输。

### 增加只代理 ResourceFS 路径的 HTTPS Sidecar

Sidecar 绑定指定虚拟网卡地址，以独立证书终止 TLS，只把 `/v1/resource-filesystem` 及子路径转发到固定
loopback HTTP upstream。

## 选择

选择第三种方案。`scripts/development-resourcefs-proxy.mjs`：

- 启动时强制显式提供监听地址、端口、loopback upstream、TLS 私钥和证书路径；
- upstream 只允许 `127.0.0.1`、`localhost` 或 `::1` 的 HTTP 地址；
- 只允许精确 ResourceFS 根路径或其 `/` 子路径，其他请求返回稳定 404 且不触达 API；
- 保留 WebDAV 方法、查询、正文和 Authorization，删除 hop-by-hop 与来路伪造的 forwarding headers；
- 上游不可达时返回不含连接细节的稳定 502；
- TLS 私钥、开发 CA、证书和运行日志只放在被忽略的 `.arts`，不得提交；VM 只安装 CA 公钥证书。

## 理由

该边界恢复了 Volume Plugin 所需的数据面，又没有把整个 API 或宿主文件系统暴露给 VM。固定 loopback upstream
和路径 allowlist 同时限制 SSRF 与路由扩张；独立 CA 让 rclone 继续执行标准证书校验。

## 影响

### 正面影响

- 含附件任务可重新挂载只读 `/resources`；
- API 仍保持 loopback-only；
- Sidecar 不接触 ResourceFS 签名密钥，只透明转发短时能力头。

### 负面影响与成本

- 本地开发增加一个必须随 API 运行的 Sidecar 进程；
- 首次配置需要生成开发 CA/证书并把 CA 公钥安装到 Cubelet 节点信任库。

### 安全、数据与运维影响

- 日志禁止记录请求头、URL 能力值和上游响应正文；
- 证书私钥不得进入仓库；
- Sidecar 停止时附件任务明确失败，无附件的一次性 Sandbox 仍按 ADR-0103 隔离故障域。

## 验证

- 单元测试覆盖路径 allowlist、前缀碰撞、WebDAV 方法/查询/正文/授权头转发、forwarding header 清理与稳定 502；
- VM 使用系统 CA 校验访问 Sidecar，未带能力时快速返回 401，证明 TLS、路由与宿主 API 连通；
- 真实 Cube Volume 冒烟创建带 `/resources` mount 的 Sandbox，执行 mount/read 探针后销毁成功。

## 可逆性与回退

停止 Sidecar 并从 VM 信任库移除对应开发 CA 即可回退；没有数据库迁移。回退后应关闭 Thread Session reuse，
仅允许 ADR-0103 的无附件一次性 Sandbox 路径，不得把附件任务静默降级。

## 后续工作

- 将 Sidecar 进程纳入本地开发进程管理器，避免宿主重启后遗漏启动；
- 生产环境继续使用受管理的 TLS 入口，不复用开发 CA 或私钥。

## 实施记录

- 2026-08-04：Sidecar、开发证书信任和真实 Resource Volume 冒烟验证完成；重新启用本地 Thread Session reuse。
