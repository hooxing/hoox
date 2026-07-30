# ADR-0055：模型网络报文诊断的受限保存

## 背景

维护 OpenAI-compatible `/chat/completions` 时，仅保存 Pi 的 payload 对象无法证明真正送往
Provider 的 UTF-8 字节，也无法复现 SSE 分片、非 2xx、断流或中止。与此同时，prompt 与回复
可能含租户敏感内容，Authorization、Cookie 和代理凭据绝不能进入诊断面。

## 决策

- 诊断默认关闭，只有 `MODEL_WIRE_TRACE_ENABLED=true` 才安装受 `AsyncLocalStorage` 约束的
  fetch 拦截器；拦截器还必须同时匹配配置的 Provider origin、base path 和
  `POST /chat/completions`，不捕获 Sandbox、S3、探针或其他 HTTP。
- 对每个命中的请求构造唯一 outbound `Request`，从其 clone 读取并持久化最终 body bytes，再把
  同一对象交给真实 fetch；不以 `onPayload` 或 `JSON.stringify` 重建请求。
- Response 以 clone 并行消费，保留 HTTP content-decoding 后、SSE 解析前的应用可见 response body
  bytes（不是 TCP 分片、chunk framing 或 Content-Encoding 前的线路字节）。上限后保存精确前缀并标为 `truncated`；Abort/断流、非 2xx
  和 Blob/DB 结果未知均留下状态，且不改变模型调用结果。
- 正文进入现有 trace Blob 生命周期；`model_wire_trace_records` 仅保存 tenant/run/attempt/turn/part
  索引、摘要、大小、HTTP 状态与持久化状态，并启用 RLS。它不属于 Artifact/Resource 搜索目录。
- 维护者读取入口必须经过既有认证、Membership/RLS 与 Run 归属校验，并只允许读取该表引用的
  trace Blob；不得根据普通 Artifact id 或全文搜索发现这些报文。

## 影响与验证

该功能增加了显式数据保留面和对象存储成本，因此部署默认不采集。每条索引带有由
`MODEL_WIRE_TRACE_RETENTION_DAYS` 派生的过期时间。当前分支尚未包含已过期索引删除和 Blob 引用
释放的生产清理消费者，故不得在生产启用；启用前必须补齐该闭环。测试覆盖 `/v1/chat/completions`
的最终请求字节、SSE 字节、非 2xx、上限截断，以及持久化失败不改变 Response。后续删除 Run/tenant
时必须先删除该索引引用并按 Blob lifecycle 的可达性规则回收对象，不得绕过 GC。

## 可逆性

关闭开关立即停止新增采集。保留清理消费者合入前，production 对 enabled=true 失败关闭；迁移 down 仅用于受控开发回滚；生产
删除前须先完成引用可达性审计。
