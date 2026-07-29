# 2026-07-30 Workspace Artifact 端到端验证记录

状态：通过（人工真实环境验证）

本记录的人工验证使用真实 PostgreSQL、MinIO、API、Worker 与 Web；不包含预签名 URL、对象键、令牌或 Artifact 正文。

## 原始 Workspace Artifact 闭环

- Thread：`thread_1e7c9c08-bac4-4566-9080-75c255a7dd12`
- 首个 Run：`run_7237224e-f15e-4ee3-8a74-34fcc79f84d1`，状态 `succeeded`
- Artifact：`artifact_fb9118de2b7a38bf04c0423f065f1b723e006768a0535e88e2857b3d604c88f4`
- Artifact 为 28 B 的 `text/plain; charset=utf-8`；preview 与 download 均为 HTTP 200，二者字节与原内容的 SHA-256 均为 `b6724672aa6bfd75900164896f37e1f74a482ab85b63eceba077a0ed6e8f6eb7`。
- Workspace 初始发布 Revision：`revision-3e86d2540b9fa93355bc2145560bf9e27563c812fe7d3cb6f87115a7e14ba6cf`，manifest digest：`63c96ddabef6365c01b12c12ba26240ed01c4948c51b1cda6aeb8084bf753ac5`。
- 同 Thread 的后续 Run `run_c48956b3-262b-4148-b70a-134d5d249f73` 成功物化该 Revision，产生 Revision `revision-37fac251920a22bfa7a381b40662462d466a119a9ddf49ec30b676d8f94573ca`，parent 为前述 Revision，digest 不变。

## 恶意文本安全预览

- Thread：`thread_d84d7c69-72ce-4e2b-af97-34601ae2fa95`
- Run：`run_d5d1fd44-bdb1-4add-930b-1dfb79e3243d`，状态 `succeeded`
- Artifact：`artifact_e3aa1ad3e6b75ad6cd42ba7bb610ed7e3f85353cf13fdddb28a3647eb2922261`
- 该 `.txt` Artifact 含脚本型 HTML payload。preview API 返回受鉴权 JSON `text`、不含 `url`，并返回 `Cache-Control: no-store`、`Pragma: no-cache`、`X-Content-Type-Options: nosniff`。
- preview HTTP 响应本身是 JSON envelope，不能与下载对象逐字节比较。复核时先提取 `data.text`，按 UTF-8 编码计算 SHA-256；该值与 download 34 B 对象的 SHA-256 均为 `0d239cb60ef9b7af6c7181e21cd738e5e79d589324a71a3d37abd0e307c3905d`。
- 在 Web `http://127.0.0.1:4174/` 点击预览后，文本显示在 `<pre>`；DOM 检查确认预览容器内 `scriptCount=0`，即 payload 没有成为 HTML/脚本节点。

去敏后的原始复核字段如下；`text` 内容、认证信息、对象 URL 与对象键均省略：

```text
preview: status=200, disposition=preview, hasText=true, hasUrl=false,
         cacheControl=no-store, pragma=no-cache, nosniff=nosniff,
         utf8(data.text).sha256=0d239cb60ef9b7af6c7181e21cd738e5e79d589324a71a3d37abd0e307c3905d
download: status=200, bytes=34,
          sha256=0d239cb60ef9b7af6c7181e21cd738e5e79d589324a71a3d37abd0e307c3905d
```

可复核步骤：在已认证的开发 API 会话中请求该 Run 的 preview 与 download；对 preview JSON 的 `data.text` 执行 UTF-8 编码后取 SHA-256，再对 download 返回的原始字节取 SHA-256。两个摘要应与上面的字段一致。

## 自动化证据

- `runtime-ts/apps/api/src/app.test.ts`：UTF-8 文本 JSON preview、无 URL、缓存/嗅探响应头、过大与非 UTF-8 失败关闭、旧 charset/bare MIME 拒绝，以及 PNG inline URL 回归。
- `runtime-ts/apps/web/src/api.test.ts` 与 `runtime-ts/apps/web/src/main.test.tsx`：受控 UTF-8 预览契约与恶意文本只作为 `<pre>` 文本节点渲染。
- `runtime-ts/packages/persistence/src/s3-blob-store.test.ts`：Artifact download 的受控 attachment delivery 参数。
- `tests/integration/postgres-artifact.integration.test.ts`：真实 PostgreSQL permit、Attempt 版本推进、fence/lease/claim/终态拒绝与毫秒时间精度。
