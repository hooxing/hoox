# ADR-0053：Workspace Artifact 的受限预览媒体类型

- 状态：已接受
- 日期：2026-07-30

## 决策

Workspace 文件发布为 Artifact 时默认使用 `application/octet-stream`。仅以 `.txt` 结尾的相对路径可被推导为 `text/plain; charset=utf-8`；推导结果同时写入 Blob reference、ResourceVersion 与 Artifact publication。HTML、SVG、Markdown、未知扩展名和其他主动内容一律保持二进制交付。

规范 UTF-8 纯文本 preview 不签发对象存储 URL：API 在受鉴权边界内以 BlobStore 全量校验读取，限制为 1 MiB，并以 fatal UTF-8 解码后返回 JSON `text`。API 对 Artifact delivery JSON 设置 `Cache-Control: no-store`、`Pragma: no-cache` 与 `X-Content-Type-Options: nosniff`。Web 仅将该字段写入 React `<pre>` 文本节点；不导航、不会回退到对象 URL。裸 `text/plain` 和其他 charset 一律不支持 preview，只保留 download。图片和 PDF 仍使用独立的 inline URL 策略，生产对象存储 origin 的安全响应头须单独审查。

## 理由

仅按文件名推导 `text/plain` 不能阻止对象存储、浏览器或代理的 MIME 嗅探。将文本内容留在 API JSON 响应中，配合严格 UTF-8、大小上限、禁止缓存和 DOM 文本节点，可避免用户内容被手工导航或当作活动 HTML 执行。

## 验证

自动化测试覆盖 `.txt` 正向以及 HTML、SVG、未知扩展名负向；API 覆盖 JSON 文本 preview、无 URL、缓存/嗅探响应头、旧 charset/bare MIME 拒绝、过大/非 UTF-8 失败关闭和 PNG inline URL；Web 覆盖恶意文本不生成脚本节点；S3 与 PostgreSQL 测试覆盖受控 delivery 与持久化边界。

人工真实 PostgreSQL、MinIO、API、Worker 与 Web 证据见 [2026-07-30 Workspace Artifact 端到端验证记录](../verification/2026-07-30-workspace-artifact-e2e.md)。该记录与自动化测试分开陈述，不将人工结果表述为自动化验证。
