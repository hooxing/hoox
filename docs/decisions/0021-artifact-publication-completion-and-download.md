# ADR-0021：Artifact 发布、完成门与授权下载核心

- 状态：已接受
- 日期：2026-07-26
- 决策者：Artifact 交付切片实现
- 关联任务/PR：M4 Artifact 无迁移应用核心
- 替代关系：无

## 背景

领域层已经定义不可变 `ResourceVersion`、只允许 `publishing → published/failed` 的 Artifact，以及失败修正必须创建新 Artifact 的基本规则；Run Worker 也已在成功前调用 `ArtifactPublicationPort`。但 `@cube-runtime/artifact` 仍为空包，尚无可复用的应用语义来回答以下问题：如何声明必需交付物、如何处理发布响应丢失、什么能出现在用户交付列表、以及预签名前后如何重新授权和防止版本漂移。

本切片只建立应用核心和端口，不新增 PostgreSQL migration、HTTP/UI、真实 S3/MinIO 装配，也不实现 Workspace/Resource 上传。现有结构化 `ExecutionScope` 和用户请求 scope 都只是数据，不能自行证明调用者已认证或仍持有执行栅栏。

## 决策驱动因素

- 必需发布失败时 Run 必须保持未完成，让 Agent 用新版本修正后再次完成；
- 相同命令可恢复，摘要不同的重复命令不能悄悄改写不可变发布；
- 用户只能看到正式 Deliverable，Diagnostic/Trace 不得混入下载界面；
- 下载时不能相信客户端提供的对象键、媒体类型、文件名响应头或预签名参数；
- 授权、Artifact、ResourceVersion 和 stable Blob 身份必须抵抗跨租户猜 ID 与并发漂移；
- 未知数据库、对象存储或签名异常不能泄漏私有错误消息、对象键或签名 URL。

## 备选方案

### 方案 A：Run 完成时扫描 Workspace 并自动发布

实现表面简单，但会把过程文件当成交付物，无法表达 required/optional，也会让失败修正和用户界面依赖文件名猜测。

### 方案 B：显式声明 Deliverable，发布不可变引用，下载两次授权确认

Agent 先显式声明结构化交付要求，再调用 `publish_artifact` 绑定 ResourceVersion。数据库适配器负责在一致性事务中固定完整身份和幂等事实；对象存在性验证后发布进入不可逆终态。下载先重新授权并解析固定绑定，预签名后再以授权修订和完整绑定确认一次。

代价是多一次授权读取，且 PostgreSQL 适配器必须实现严格的事务契约和响应丢失 readback。

### 方案 C：签发长期对象 URL 或由客户端传对象键和响应头

调用次数少，但对象键会变成越权能力，长期 URL 无法及时响应 Membership 撤销，任意响应头还会引入文件名和 Content-Disposition 注入风险。

### 方案 D：等待 PG Schema 后再定义应用核心

可以一次写完适配器，但会让 migration 在应用语义未审阅前冻结错误的数据形状，也无法尽早验证 Run Worker 完成门契约。

## 选择

采用方案 B，并明确以下边界：

1. `declareDeliverables` 按 Run 记录稳定键、名称和 `required | optional`。required 的缺失、publishing 或 failed 都返回稳定 `ARTIFACT_NOT_READY`，optional 不阻止完成。
2. Agent 写路径不能只携带普通 `ExecutionScope`。应用核心以私有构造器、冻结对象和进程内签发登记，把既有 `ConsumedExternalEffectAuthorization` 收窄为 `ArtifactExecutionAuthorization`；同形 HTTP JSON 不能伪造该能力。授权携带 permit ID、完整 scope、Run claim token/epoch、Workspace root/lease epoch、Attempt version、`tool_execution`、call/tool/args digest 和签发/消费时间。服务逐字段检查工具名和原始工具参数摘要；Repository 在 declare、begin、finish 与响应未知 readback 中都收到同一授权，并必须对照数据库 permit、consume、双栅栏和 Attempt 事实重新校验。类实例只阻断普通结构伪造，不替代持久授权。
3. 收窄授权及每次 declare/begin、finish、响应未知 readback 前都使用同一来源的单调时钟检查 continuation 窗口，默认实现是 `performance.now()`。`elapsed = now - consumedAtMonotonicMs` 小于零、等于或超过 `maxContinuationDelayMs` 时全部 fail-closed 为 `ARTIFACT_NOT_AUTHORIZED`；禁止用 `Date.now()` 替代。数据库 wall-clock 的 issued/consumed/expires 只验证时间关系和持久事实，不能替代进程内 continuation 限制。
4. 所有写命令使用项目共享的键排序、数组保序 canonical JSON 摘要。摘要包含版本、kind、完整稳定 scope、幂等键及全部规范化业务输入；不包含随机 permit ID、expiresAt 等易变授权字段，授权由上一条独立验证。相同键的任一稳定字段变化都必须冲突。
5. `publishArtifact` 接受 Artifact/ResourceVersion ID、名称、用途和声明键。Repository 必须在单个事实源事务中重新验证 running Run、授权 scope 归属、不可变 ResourceVersion、replacement 链、幂等摘要，并固定 `Artifact → ResourceVersion → stable Blob incarnation/physical key/hash/size/media type`。
6. 发布对象验证失败后，本 Artifact 只能进入 failed；同一记录不能重启发布。修正必须使用新 ResourceVersion、新 Artifact ID，并显式 `replacesArtifactId` 指向当前 Run 的 failed Artifact。事务响应未知时只允许按原幂等键、摘要和执行授权 readback，不重新创建记录。
7. 用途区分 `deliverable | diagnostic | trace`。用户列表由 Repository 授权后，应用层仍只投影 `published deliverable`，作为纵深防御；界面不能从文件扩展名或路径猜用途。
8. 用户请求 scope 只承载上游认证结果。Repository 每次列表、下载都必须重新校验 active Membership 和所有权链，并对裸 ID 猜测统一返回不泄漏存在性的结果。
9. 下载请求公开输入只有 Artifact ID。Repository 原子解析已发布 Deliverable 的固定绑定并返回授权修订；应用层生成安全 attachment 文件名、使用存储媒体类型、固定 `artifact-download`，并把部署配置限制在 1 至 900 秒。Artifact 名称与下载文件名拒绝 Unicode `Cc/Cf`，包括双向覆盖/隔离和零宽格式字符；下载名额外防御 Windows 保留设备名。客户端不能传 objectKey、响应头、Content-Disposition、media type 或 TTL。
10. 预签名后必须用原授权修订和完整绑定再次确认；状态、版本、Membership 或 Blob 身份发生变化时丢弃 URL。默认只接受 HTTPS 签名 URL，本地开发必须显式允许 HTTP。
11. 所有未知依赖异常统一映射为不含 cause 的稳定错误。完成门额外统一为 `ARTIFACT_NOT_READY`，使 Worker 保持既有稳定错误语义；现有只读 `ArtifactPublicationPort` 保持兼容。

## 理由

显式声明和发布让“任务必须交什么”与“过程中产生了什么”分离；不可变绑定提供审计和可恢复性。授权前后两次确认不能撤销已经在对象存储侧生成的短期 URL，但能确保应用不会在已知授权漂移后把 URL 返回给调用者；短 TTL 进一步缩小极端并发窗口。把事务和授权强制放在 Repository 端口而不是相信 TypeScript 对象，避免把类型标注误当成安全边界。

## 影响

### 正面影响

- Run Worker 可以直接复用真实 `ArtifactPublicationPort` 完成门；
- 发布失败和响应丢失有确定、可审计且不覆盖历史的恢复路径；
- Diagnostic/Trace 即使被适配器误返回，也不会进入用户交付投影；
- 预签名参数完全由服务端固定，下载链接短时、私有且重新授权。

### 负面影响与成本

- PostgreSQL 后续需要声明、发布幂等、replacement、授权修订和固定 Blob 身份字段/约束；
- 每次下载需要授权解析、预签名和确认三段调用；
- 预签名成功但确认失败会产生一个未返回的短期 URL，应通过低 TTL 和指标观察，而不是尝试撤销 S3 签名。

### 安全、数据与运维影响

- Repository 是认证状态和所有权重检的安全边界，内存 Fake 不能被作为生产证明；
- `ArtifactExecutionAuthorization` 的进程内名义身份不能替代数据库重验；生产 Repository 缺失时写路径必须继续 fail-closed；
- 单调时钟来源必须与 permit 消费者一致；跨进程恢复不能沿用旧进程的 monotonic 数值，只能从数据库重新领取/消费许可；
- 日志不得记录预签名 URL、对象键、Provider/数据库私有消息；
- HTTP 下载仅供显式本地开发，生产装配必须保持默认 HTTPS；
- Blob 身份或授权修订异常应计入安全/一致性指标，但公开响应只使用稳定脱敏码。

## 验证

- 单元测试覆盖成功发布、幂等重放、摘要/绑定冲突、发布响应丢失 readback、Blob 缺失与依赖异常终结 failed；
- 单元测试覆盖新 ResourceVersion + 新 Artifact + replaces 修正链，以及原记录不能重试；
- 单元测试覆盖 required 三种阻断状态、optional 不参与完成阻断、声明响应丢失和重复声明键；
- 单元测试覆盖同形对象伪造、错误 effect/scope/双栅栏/Attempt/toolName/argsDigest，以及四个写阶段传递同一授权；
- 单元测试用可控单调时钟覆盖刚消费、窗口内、等于/超过上限、负 elapsed、创建后闲置，以及远端调用后过期阻止 finish/readback；
- 表驱动测试证明 declare/publish 的 kind、完整 scope、幂等键和每个规范化业务字段参与 canonical 摘要，而 permit ID/过期时间不参与；
- 单元测试覆盖跨 Tenant/用户错配/猜 ID、Diagnostic/Trace 过滤、下载授权变化和 ResourceVersion 漂移；
- 单元测试断言签名端口只收到服务端固定 Blob、media type、安全文件名、短 TTL 和 `artifact-download`；
- 单元测试覆盖畸形签名 URL、签名异常、TLS 默认策略和未知异常脱敏；
- 单元测试覆盖 U+202E、U+2066 至 U+2069、零宽格式字符、ASCII 控制字符和 Windows 保留设备名；
- 包级 typecheck/test/build、根 `check:clean-vendor` 与 `git diff --check` 通过。

## 可逆性与回退

本切片尚未写入生产 Schema，可以无数据迁移地替换端口或命名。PG migration 写入生产后，Artifact 不可变、replacement 链、幂等摘要和固定 Blob 身份不可原地回退；若新下载服务异常，可以停止签发链接但不能放宽授权或改发长期 URL。两次确认可在未来由等价的单事务签名代理替代，但必须保留每次下载重新授权和固定身份语义。

## 后续工作

- 新增 PostgreSQL migration 与 `ArtifactDeliveryRepositoryPort` 生产实现，使用 RLS、组合外键和事务约束；
- 把 `publish_artifact` 工具接入 Pi/tool-router，并让 Worker 生产装配使用本服务；
- 新增 HTTP 列表/下载端点和独立交付界面；
- 用真实 MinIO/S3 验证 Content-Disposition、媒体类型、短 TTL 和授权竞态；
- 增加发布失败、readback、未返回签名 URL 和完成门 blocker 指标。

## 实施记录

- 2026-07-26：实现无数据库迁移的应用核心、端口和故障/越权单元测试；不声称已有生产持久层、HTTP/UI 或真实对象存储闭环。
