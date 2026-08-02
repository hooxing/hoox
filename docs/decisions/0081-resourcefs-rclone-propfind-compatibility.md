# ADR-0081：ResourceFS 兼容 rclone 无媒体类型的 PROPFIND

- 状态：已接受
- 日期：2026-08-02
- 决策者：Runtime 团队
- 关联任务/PR：Cube ResourceFS Volume Plugin 真实部署 Gate
- 替代关系：补充 ADR-0079

## 背景

Cubelet 宿主机已按 ADR-0079 使用 rclone 1.74 WebDAV mount。真实 attach 能建立 FUSE mount，但首次列
目录返回 415：rclone 的 `PROPFIND` 请求携带 XML body 和 `Content-Length`，却不发送 `Content-Type`。
Fastify 5 会在路由 handler 之前拒绝这种请求，所以 ResourceFS 的 capability 校验和目录查询均未执行。

## 决策驱动因素

- 选定的 Cube Volume 客户端必须能直接列举 `/resources`；
- 不能为了 WebDAV 兼容而放宽普通 JSON API 或二进制上传的媒体类型契约；
- ResourceFS 是只读边界，PROPFIND body 当前不参与目录授权或查询语义；
- 单次 XML body 仍需有明确大小上限。

## 备选方案

### 方案 A：要求 rclone 强制补发 Content-Type

可通过全局 header 参数修改当前客户端，但把服务兼容性绑定到部署参数；其他 WebDAV 客户端仍可能触发
同一失败，而且 header 会附加到并非 XML 的 GET 请求。

### 方案 B：在 ResourceFS 路由作用域兼容缺失或未知媒体类型

对 ResourceFS 的 body 统一按最多 64 KiB 文本读取，PROPFIND handler 继续忽略 body，仅按 capability、
Depth 和路径返回只读目录。解析器不传播到其他 API 路由。

### 方案 C：全局注册兜底解析器

实现最少，但会扩大所有 API 的内容类型接受面，与上传和 JSON 路由的失败关闭契约冲突。

## 选择

采用方案 B。ResourceFS 路由放入 Fastify 封装作用域，在该作用域注册 XML 解析器和 64 KiB 的兜底文本
解析器。普通 API 继续使用原有 JSON/二进制媒体类型检查。

## 理由

PROPFIND 在当前协议中只表达“列出这个已授权路径”，服务并不解释客户端提交的属性选择 XML，因此兼容
缺失的媒体类型不会改变授权或数据语义。封装作用域把兼容面限制在只读 ResourceFS，避免将 rclone 的
客户端特性泄漏到公共写 API。

## 影响

- rclone 无需额外 header 即可挂载并在首次目录读取时通过；
- ResourceFS PROPFIND 会读取最多 64 KiB 的未知媒体类型 body，超限仍由 Fastify 拒绝；
- GET、HEAD、OPTIONS、上传和 JSON API 的媒体类型行为不变。

## 验证

- HTTP 契约测试发送带 XML body、`Content-Length` 且无 `Content-Type` 的 PROPFIND，必须返回 207；
- 完整 `pnpm check` 验证封装注册没有改变其他 API；
- 目标 Cube 节点重新 attach 后，Sandbox 内必须能列目录、读取已知文件且写入失败。

## 可逆性与回退

可移除 ResourceFS 作用域兜底解析器，并在 rclone mount 命令固定注入 XML Content-Type。该变更不涉及
数据迁移、Volume 身份或 capability 格式。

## 后续工作

- ResourceFS 拆为独立服务时保留同一兼容测试。

## 实施记录

- 2026-08-02：在 CubeSandbox 0.6 与 rclone 1.74 的真实 attach 中验证触发条件并实施。
