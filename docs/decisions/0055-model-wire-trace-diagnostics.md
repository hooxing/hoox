# ADR-0055：模型网络报文诊断的受限保存

- 状态：部分已替代
- 日期：2026-07-30
- 替代关系：[ADR-20260904085601](20260904085601-stop-raw-model-response-capture.md) 停止原始 response 正文采集和镜像；请求采集、无正文 transport 失败、权限、持久化和历史数据清理边界仍有效。

## 背景

维护 OpenAI-compatible `/chat/completions` 时，仅保存 Pi 的 payload 对象无法证明真正送往
Provider 的 application request body bytes，也无法复现 SSE 分片、非 2xx、断流或中止。与此同时，prompt 与回复
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
  和 Blob/DB 结果未知均留下状态，且不改变模型调用结果。Abort 分类同时检查 outbound
  `Request.signal.aborted`，因此自定义非 `DOMException` reason 也记录为正文不可读，并向调用方原样抛回该 reason。
- 正文进入现有 trace Blob 生命周期；`model_wire_trace_records` 先保存不可变命令摘要，再以复合
  外键绑定 reference 的 stable/state/purpose、摘要、大小、lifecycle、incarnation 与物理键。
  相同 tenant/attempt/model turn/transport attempt/part 的完整同命令只重放，不同命令稳定冲突；
  它启用 RLS，且不属于 Artifact/Resource 搜索目录。
- development 且开关启用时，同步 best-effort 镜像每个已捕获正文到项目固定根目录
  `model-wire-traces/<runId>/<attemptId>/`。目录只能由已验证的 context 与固定根派生；文件名稳定包含
  model turn、transport attempt、part、capture status，并保留 request JSON 或 response SSE 原始字节。
  文件先在目标目录以 0600 临时文件完整写入并同步，再用不覆盖的 hard link 原子发布；同字节重放成功，
  异字节冲突保留原文件。项目目录先解析成受信 real root，再逐级创建并核对 mirror root、run 与 attempt；
  任一级 symlink、junction、非目录 reparse 重定向、realpath 越界或目标文件链接都失败关闭。Linux 额外使用
  `O_DIRECTORY | O_NOFOLLOW` 打开的目录句柄，并经 `/proc/self/fd/<fd>` 完成后续逐级打开与文件发布，
  使检查后的路径名替换不会改变已经固定的父目录 inode。镜像失败被隔离，不能使权威持久化降级为 capture failure。
- 维护者读取入口必须经过既有认证、Membership/RLS 与 Run 归属校验，并只允许读取该表引用的
  trace Blob；不得根据普通 Artifact id 或全文搜索发现这些报文。

## 影响与验证

该功能增加了显式数据保留面和对象存储成本，因此部署默认不采集。每条索引带有由
`MODEL_WIRE_TRACE_RETENTION_DAYS` 派生的过期时间。生产清理以租户级幂等命令批量 claim 到期记录，
使用 `SKIP LOCKED` 与持久 processing lease 避免和在途上传竞争；事务先写最小到期墓碑、
再删除由完整身份约束的专属 trace reference 与索引。删除前按不可变 operation/sha256/size 查找全部
stable trace reference，把完整身份写入清理 item；即使进程已在 Blob completed 后、索引 finalize 前
退出，也禁止出现“删 reference 却无 GC outbox”。
非终态 `blob_commits` 先由 retention recovery 从 durable snapshot 收敛。`upload_pending` 可能仍有 PUT
在途，因此绝不终结：consumer 只按 operation 重建固定 staging 身份并幂等删除，保留 record/commit 锚点；
`staged` 才可 CAS 到 `cleanup_pending`，reference commit/promotion 之后则继续到 stable/completed，再走相同
stable outbox。恢复真正失败时原 cleanup command 不落库；成功但仍是 upload_pending 的 deferred 记录不阻塞
同批 terminal 记录，且 live record 以 `retention_recovery_at` 公平轮转，不能由最老一批永久占满。
每条已删 record 的永久墓碑也是 deterministic staging sweep 锚点；production 必须周期调用 `resumePending`，
按 `staging_swept_at NULLS FIRST` 公平 claim 并重删所有关联 commit（包括 completed/abandoned）的 staging key，
从而清除在 record 删除甚至 abandoned 之后才落下的迟到 PUT。墓碑 sweep 的 deferred/retry 不阻断同租户
已释放 stable GC；只有 completed/abandoned 或无 commit 的 live record 才能进入删除事务。
清理 consumer 随后显式调用既有 GC。共享 lifecycle 尚有其他引用时以 `still_referenced` 安全完成，
零引用时必须完成物理对象删除后才把清理命令标为 completed；失败或 `in_progress` 保留 item 重试。
COMMIT 响应未知时，写入与清理都只按原命令摘要读回事实名义收敛。测试覆盖最终请求/SSE 字节、
非 2xx、上限截断、持久化失败不改变
Response，以及索引幂等、引用释放、共享 lifecycle、跨租户隔离与迁移 up/down/up。

项目目录镜像只是本机开发排障副本，不具备租户 ACL、Web/API 读取、retention、Blob lifecycle 或备份语义；
PG/MinIO 仍是 UI、授权、保留和清理的唯一权威存储。production 装配永远不创建该镜像，即使未来允许生产
采集开关；测试还覆盖镜像磁盘失败不影响权威端口、固定路径不能被 context 逃逸、root/run/attempt 上的
Windows junction 与 WSL/Linux symlink，以及原子幂等冲突不覆盖。

Node core 当前没有跨平台 `openat`，Windows 也未公开 `FILE_FLAG_OPEN_REPARSE_POINT` 或目录句柄相对创建接口。
因此 Windows 采用逐级 `lstat`、`realpath` 等值、受信 real root containment，并在临时文件创建、hard link
发布前后重复核验；这能拒绝静态 symlink/junction 和会改变 realpath 的重定向 reparse point，但不能证明抵抗
具有同一开发账户目录写权限的恶意进程在核验间实施的瞬时替换，也无法识别 realpath 不变且 Node 不报告为
symbolic link 的非重定向 reparse tag。该剩余限制只存在于默认关闭的本机开发副本；Linux 缺少 `/proc/self/fd`
或 no-follow flags 时直接放弃镜像，不回退到易受竞态影响的路径写入。Linux 目录句柄会在发布前后反查并要求
仍等于最初逐级打开的 realpath；Node 仍没有阻止同一开发账户在两次核验之间 rename 已打开目录的原语，因而
不能把本地副本提升为面对同账户恶意进程的安全存储。以上任一异常都只放弃镜像，PG/MinIO 权威诊断仍继续。

到期墓碑不含正文、HTTP 状态、run/thread 或物理键，只保留 tenant、attempt/turn/part、命令摘要与
Blob operation 摘要身份。它与 `blob_commits` 的永久幂等事实同寿命，不能按普通 retention 删除；
否则旧 key 会命中已完成但引用已释放的 commit snapshot，并重新产生不可收敛引用。容量核算因此按
“每个被清理报文一条固定大小幂等事实”计入审计存储，而不是误宣称所有索引元数据都会物理归零。

## 可逆性

关闭开关立即停止新增采集和本地镜像。`model-wire-traces/` 可在 Worker 停止后由开发者手动删除，不影响
PG/MinIO 权威记录。保留清理消费者合入前，production 对 enabled=true 失败关闭；迁移 down 仅用于受控开发回滚；生产
删除前须先完成引用可达性审计。
