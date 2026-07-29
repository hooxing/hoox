# ADR-0053：Workspace Artifact 的受限预览媒体类型

- 状态：已接受
- 日期：2026-07-30

## 决策

Workspace 文件发布为 Artifact 时默认使用 `application/octet-stream`。仅以 `.txt` 结尾的相对路径可被推导为 `text/plain; charset=utf-8`；推导结果同时写入 Blob reference、ResourceVersion 与 Artifact publication。HTML、SVG、Markdown、未知扩展名和其他主动内容一律保持二进制交付。

## 理由

API 的 inline preview 只信任被动媒体类型。有限白名单让文本报告可预览，同时避免基于用户可控文件名把 HTML 或 SVG 作为活动内容交给浏览器。

## 验证

单元测试覆盖 `.txt` 正向以及 HTML、SVG、未知扩展名负向；真实 Workspace→Artifact Run 通过 preview 与 download 的逐字节 SHA-256 比对。
