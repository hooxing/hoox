# ADR-0055：模型网络报文诊断的受限保存

## 背景

维护 OpenAI-compatible `/chat/completions` 时，仅保存 Pi 的 payload 对象无法证明真正送往
Provider 的 UTF-8 字节，也无法复现 SSE 分片、非 2xx、断流或中止。与此同时，prompt 与回复
可能含租户敏感内容，Authorization、Cookie 和代理凭据绝不能进入诊断面。

## 决策

- 诊断默认关闭，只有 `MODEL_WIRE_TRACE_ENABLED=true` 才安装受 `AsyncLocalStorage` 约束的
  fetch 拦截器；拦截器还必须同时匹配配置的 Provider origin、base path 和
  `POST /chat/completions`，不捕获 Sandbox、S3、探针或其他 HTTP。
- 对每个命中的请求构造唯一 outbound `Request`，从其 clone 读取并持久化最终 Fetch application
  body bytes，再把同一对象交给真实 fetch；不以 `onPayload` 或 `JSON.stringify` 重建请求，也不把
  HTTP header、TCP framing 或 Content-Encoding 前的线路字节称为 request body。
- Response 以 clone 并行消费，保留 HTTP content-decoding 后、SSE 解析前的应用可见 response body
  bytes（不是 TCP 分片、chunk framing 或 Content-Encoding 前的线路字节）。上限后保存精确前缀并标为 `truncated`；Abort/断流、非 2xx
  和 Blob/DB 结果未知均留下状态，且不改变模型调用结果。
- 正文进入现有 trace Blob 生命周期；`model_wire_trace_records` 先保存不可变命令摘要，再以复合
  外键绑定 reference 的 stable/state/purpose、摘要、大小、lifecycle、incarnation 与物理键。
  相同 tenant/attempt/model turn/transport attempt/part 的完整同命令只重放，不同命令稳定冲突；
  它启用 RLS，且不属于 Artifact/Resource 搜索目录。
- 维护者读取入口必须经过既有认证、Membership/RLS 与 Run 归属校验，并只允许读取该表引用的
  trace Blob；不得根据普通 Artifact id 或全文搜索发现这些报文。

## 影响与验证

该功能增加了显式数据保留面和对象存储成本，因此部署默认不采集。每条索引带有由
`MODEL_WIRE_TRACE_RETENTION_DAYS` 派生的过期时间。生产清理以租户级幂等命令批量 claim 到期记录，
使用 `SKIP LOCKED` 与持久 processing lease 避免和在途上传竞争；事务先写最小到期墓碑、
再删除由完整身份约束的专属 trace reference 与索引。删除前把完整 stable 身份写入清理 item；
清理 consumer 随后显式调用既有 GC。共享 lifecycle 尚有其他引用时以 `still_referenced` 安全完成，
零引用时必须完成物理对象删除后才把清理命令标为 completed；失败或 `in_progress` 保留 item 重试。
COMMIT 响应未知时，写入与清理都只按原命令摘要读回事实名义收敛。测试覆盖最终请求/SSE 字节、
非 2xx、上限截断、持久化失败不改变
Response，以及索引幂等、引用释放、共享 lifecycle、跨租户隔离与迁移 up/down/up。

到期墓碑不含正文、HTTP 状态、run/thread 或物理键，只保留 tenant、attempt/turn/part、命令摘要与
Blob operation 摘要身份。它与 `blob_commits` 的永久幂等事实同寿命，不能按普通 retention 删除；
否则旧 key 会命中已完成但引用已释放的 commit snapshot，并重新产生不可收敛引用。容量核算因此按
“每个被清理报文一条固定大小幂等事实”计入审计存储，而不是误宣称所有索引元数据都会物理归零。

## 可逆性

关闭开关立即停止新增采集。保留清理消费者合入前，production 对 enabled=true 失败关闭；迁移 down 仅用于受控开发回滚；生产
删除前须先完成引用可达性审计。
