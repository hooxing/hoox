# ADR-0056：模型网络报文诊断的安全读取与原始字节呈现

- 状态：已接受
- 日期：2026-07-30

## 背景

ADR-0055 决定保存最终 `/chat/completions` 请求正文和 Provider 应用可见的原始响应正文。
这些内容可以区分“模型生成了错误工具参数”和“工具内部失败”，但同时可能包含完整 Prompt、
工具参数以及下一轮请求中模型可见的工具回执。普通 Artifact/Resource 下载、全文搜索或对象存储
预签名 URL 均不适合作为读取入口。

单条请求或响应还可能被截断、不可读、返回非 2xx，甚至存在 SDK HTTP 重试。读取协议不能把
“模型轮次”和“同一轮的传输尝试”混为一谈，也不能把截断请求声称为合法 JSON。

## 决策

- 新增 Run 嵌套的诊断元数据接口。每条记录公开 `attemptId`、`modelTurn`、
  `transportAttempt`、request/response part、采集/持久化状态、`captureErrorCode`、HTTP 状态、
  SHA-256、字节数、截断状态和过期时间。列表每页最多返回调用方请求的 500 条，并返回
  绑定 Tenant/User/Thread/Run 的复合排序游标、`hasMore` 和 `nextCursor`；Web 可显式继续加载，
  同时避免响应 schema 因无界记录数转为 500。非空尾页仍返回最后一条的复合排序游标，活跃 Run
  据此从已加载尾部追取新增记录，并在新增突发超过一页时持续推进；`hasMore` 只表示当前位置后是否
  还有已存在页。游标不是授权能力，
  每一页都重新执行完整授权。时间排序统一到 JSON 游标可无损表达的毫秒，再以复合身份打破并列。
- 读取先复用现有认证、Tenant Membership/RLS 与 Thread/Run 归属校验。只读投影在同一
  `REPEATABLE READ` 快照中，将诊断索引的完整 Blob 身份与 `blob_references`、active lifecycle、
  active/current incarnation 逐项绑定；过期、缺失、非 stable、非 trace purpose 或任一摘要/大小/
  incarnation/physical key 不一致都对外统一为 404。
- API 只通过受校验的 `BlobStore.getBytes` 读取对象，绝不返回对象存储 URL。对象完成全量
  SHA-256/大小校验后，再次读取授权事实；读取期间发生成员撤销、过期、清理或身份漂移时丢弃
  已读字节并返回 404。对象存储或完整性故障返回脱敏的依赖不可用错误。
- request 和 response 正文统一以 `application/octet-stream` 原样交付，附带
  `Cache-Control: private, no-store, no-cache, must-revalidate`、`Pragma: no-cache`、
  `X-Content-Type-Options: nosniff` 和 `Referrer-Policy: no-referrer`。服务端不解析、重编码或改写
  正文，也不声称截断 request 是合法 JSON。
- Web 按 Attempt、模型轮次及 HTTP 尝试分组，标出重试、非 2xx、截断、采集中止和持久化失败。
  文本视图只作 UTF-8 诊断显示；这里的“原始”特指 Fetch content-decoding 后、SSE 解析前的应用层
  正文字节，不包含 TCP/chunk framing 或 Content-Encoding 前字节。下载保留这些应用层八位字节，
  并同时展示实际字节数和索引 SHA-256。
  页面固定警告正文包含 Prompt、工具参数和模型可见工具回执等敏感信息。
- Header 不在采集端口、索引或读取 DTO 中出现；Authorization、Cookie、对象物理 key 和 S3 URL
  不进入响应。模型网络诊断仍不属于 Artifact、Resource 或搜索目录。

## 影响与验证

诊断面可以直接比较某轮最终请求、Provider 原始响应和 HTTP 重试，定位工具调用参数来自模型还是
工具实现。诊断关闭或旧 API 返回 404 时，Web 保持空态，不影响原有 Run 轮询。

自动化测试覆盖同租户读取、跨租户/Thread/Run 与猜测 Attempt 的统一 404、Blob purpose/state/
SHA/size/incarnation 拒绝、二次授权漂移、对象完整性失败、no-store/nosniff、原始字节不改写，
以及 Web 的模型轮次/重试分组、失败态、敏感提示、原始下载信息、首屏刷新保留已加载后续页和
尾游标追取新记录。

## 可逆性

删除 Web 入口和 API 路由即可停止读取，不改变已有诊断索引与 Blob；关闭 ADR-0055 的采集开关可
停止新增数据。历史正文的删除仍必须通过诊断保留清理器释放引用，并由共享 Blob 生命周期 GC，
不得直接删除对象存储 key。
