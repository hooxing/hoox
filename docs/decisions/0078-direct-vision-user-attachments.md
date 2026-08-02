# ADR-0078：视觉模型当前轮图片直传

- 状态：已接受
- 日期：2026-08-02
- 决策者：Runtime 团队
- 关联任务/PR：上传图片的模型能力路由
- 替代关系：实施 ADR-0077 的视觉模型路径

## 背景

上传附件已经形成不可变 ResourceVersion，并把稳定 `/resources/...` 路径追加到最新 user turn。
这个统一路径适合 shell、代码和历史资源按需读取，但支持视觉输入的模型不应先看到路径、再自行判断
是否需要调用文件工具；当前轮图片本身就是用户输入，应直接作为同一 user turn 的结构化图片内容提交。

模型能力不能从一次 Provider 请求失败中猜测。纯文本模型也不能收到不支持的图片 part，否则 Pi 只能
丢弃或替换输入，用户以为图片已被理解而实际没有。附件字节还不能进入 system prompt、调度表或长期
Thread 事实，否则既破坏上下文缓存，也扩大敏感内容持久化面。

## 决策

- 模型配置新增必填布尔值 `MODEL_SUPPORTS_IMAGES`，注册 Pi 模型时据此固定 `input` 为
  `['text', 'image']` 或 `['text']`；运行中不探测、不自动降级。
- 统一输入 receipt 持久化当前轮已授权的 `{resourceId, versionId}` 列表；最新 user 文本仍只追加
  JSON 转义的文件名和 `/resources/...` 路径，不修改 system、developer/harness prompt 或工具 schema。
- 视觉模型在首轮、排队 follow-up 和 durable steer 中都解析当前 user turn 的附件。PNG、JPEG、GIF、
  WebP 由 Worker 从稳定 Resource Blob 完整校验读取，编码为 Base64 `ImageContent`，与文本一起直接交给 Pi。
  非图片附件只保留路径，不生成模型图片 part。
- 纯文本模型不读取附件 Blob，也不向 Provider 提交图片；它继续接收相同路径事实，后续可在确有需要时
  通过受控 OCR/识图工具获得文本 observation。
- 图片准备发生在一次性 `model_start`/`model_continue` 许可签发之前，避免对象存储读取消耗短时许可；
  Base64 只存在于 Worker 内存和 Provider 请求，不写入 Run/Thread 数据库。
- 单个上传继续受 16 MiB API 边界约束；一次模型输入的图片总量上限为 32 MiB。超限、版本不可见、
  Blob 身份或完整性不匹配均在模型调用前失败关闭，不静默漏图。

## 理由

当前 user turn 的图片直接进入视觉模型，语义与主流多模态 API 一致，也省去一次由 Agent 决定是否读图的
工具回合。持久化资源引用而非 Base64，使排队 Run 和进程重启后仍可重建同一输入，同时保持数据库体积
和静态 prompt 稳定。纯文本模型不读取 Blob，避免为它无法消费的内容支付 MinIO、内存和编码成本。

使用显式能力配置虽然要求部署者准确填写，但比按模型名称维护易漂移的白名单或以失败重试探测更可靠。
Provider 若实际不支持图片，应修正配置并重新部署，而不是在同一 Run 中降级为可能误导用户的文本请求。

## 影响

- 视觉模型每个含图片的当前轮会增加一次 Resource 解析、对象读取和 Base64 请求体开销；图片总量门禁限制
  Worker 峰值内存，但后续仍可增加像素、帧数和压缩策略。
- 模型网络报文诊断开启时，请求正文可能包含 Base64 图片；它继续受既有显式开关、大小上限、保留期和
  租户隔离约束，运维侧必须把诊断存储按用户内容处理。
- 历史图片不会因路径存在而在每轮重复提交；只有当前 user turn 的附件列表会生成图片 part。
- OCR/识图 MCP 未在本次实现。纯文本模型只能按路径使用普通文件能力，不能声称已经理解图片像素。

## 验证

- Pi Session 测试验证视觉模型在 Provider 最终 user message 中收到文本和图片 part，并验证图片加载发生在
  模型许可之前；纯文本模型验证零 Blob 加载。
- 图片加载器测试验证只读取受支持图片、保留 MIME/Base64 字节，以及总量超限失败关闭。
- API、统一输入持久化和迁移测试验证附件引用经过授权后写入 receipt，可随排队 Run 与 steer 恢复。
- 配置契约和模型装配测试验证 `MODEL_SUPPORTS_IMAGES` 必填且准确投影到 Pi 模型输入能力。

## 可逆性与回退

关闭 `MODEL_SUPPORTS_IMAGES` 即可停止新请求的图片 Blob 读取和 Provider 图片输入；已上传 Resource 与
receipt 引用无需删除。数据库回退仅在确认没有旧版本 Worker 需要读取附件引用后执行迁移 down。未来接入
Provider 原生对象引用或媒体代理时，可替换 Worker 图片加载适配器，但不得改变 user turn、Resource 身份和
`/resources` 路径契约。
