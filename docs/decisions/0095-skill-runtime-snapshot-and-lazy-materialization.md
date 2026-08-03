# ADR-0095：Skill Runtime 快照、后端注入与延迟物化

- 状态：已接受
- 日期：2026-08-03

## 背景

ADR-0094 只交付了 Skill Center 与用户安装关系。完整运行时还必须解决四个边界：安装集合在 Run 执行期间不能漂移；模型应先看到受控目录而不是完整第三方正文；加载 `SKILL.md` 不应领取 Sandbox；包内资源和脚本又必须在真正使用时具有固定、只读路径。

ADR-0029 原先禁止 Skill 元数据进入 system role，以保护提示词缓存和信任边界。该结论适用于任意 Skill 正文和请求级内容，但不能提供类似 Claude Code 的“目录发现后按需加载”体验。本决策对它作最小范围替代。

## 备选方案

1. 沿用 Pi 的本地 Skill 发现。实现最少，但必须给 Worker 或 Sandbox 准备本地目录，无法以数据库安装关系作为唯一事实源，也会重新打开宿主目录发现边界，因此不采用。
2. 在每次请求前把所有已安装 Skill 的完整正文注入 System Prompt。无需工具循环，但会显著放大上下文、使正文变化持续破坏缓存，并在 Skill 未使用时也读取全部内容，因此不采用。
3. 只把受管目录注入 System Prompt，显式调用由后端预注入，自然语言触发通过固定 `skill` 工具加载；资源仅在后续 Sandbox 工具出现时物化。该方案增加快照和恢复状态，但同时满足安装固定、按需上下文与零 Sandbox 指令读取，因此采用。

Sandbox 包可进一步选择预先挂载、首次 Skill 调用即启动，或随首个 Sandbox 工具延迟物化。前两者都会让纯问答或信息不足时的澄清请求无谓启动 Sandbox，因此选择延迟物化。Cube 当前没有原生只读挂载端口，首版以权限封存实现，保留替换端口。

## 决策

1. API 创建或预留 Run 身份时，在同一个 PostgreSQL 事务中读取当前用户已启用的精确安装版本，写入不可变 `RunSkillSnapshot`。Worker 只读取快照，不反查用户当前安装。
2. System Prompt 升级为 `runtime-system-prompt.v4`。在 capability manifest 之后加入固定 `<AVAILABLE_SKILLS schema=1>` 分区，只包含快照中的 `invocationName` 与一句描述。数据库内部快照摘要用于 Worker 完整性校验和恢复兼容身份，但不进入任何模型可见内容，避免内部摘要变化破坏模型上下文缓存。
3. 显式 Slash 与结构化 `skillInvocation` 都由 API 解析并在快照中固定。Worker 在第一次模型调用前从私有 BlobStore 读取、校验完整 `SKILL.md`，以独立 `runtime.skill_instruction.v1` custom entry 注入。
4. Pi 始终注册固定 schema 的 `skill` 只读工具，包括零安装场景。工具必须先形成 durable `tool_call`，再通过双栅栏绑定的 Skill Runtime 端口读取同一 Run 快照和 Blob，最后形成 durable tool result。它不申请外部副作用许可，也不调用 Sandbox 准备能力。
5. Skill 元数据仍在 PostgreSQL，文件正文仍在私有 Blob/S3。`blob_ref` 是后端不透明引用；模型只看到资源的路径、媒体类型、大小和摘要，不看到对象键或签名 URL。
6. 只有显式或工具调用成功的 Skill 才进入待物化集合。第一次 `read`、`exec_command`、`edit`、`write` 或交付工具触发既有按需 Sandbox 后，在副作用许可签发前把这些固定版本物化到 `/skills/<invocationName>/`，随后递归移除写权限。同一 Session 已物化根目录不重复写入；跨 Run 复用 Thread Sandbox 时，先完整校验新包，再清理同名旧目录后写入，不能混留旧版本文件。
7. Skill 指令、参数与包不能扩大 Platform Harness、Tool Router、Tenant、双栅栏或副作用许可。硬撤销、Blob 缺失或摘要不匹配均失败关闭，不静默选择新版本。

## 取舍

- `AVAILABLE_SKILLS` 会随用户安装集合改变 System Prompt 字节，这是目录发现能力的必要成本；相同目录仍保持完全相同的字节和工具 schema。
- 迁移前已经存在且没有发起用户快照的 legacy Run 使用固定空目录，绝不反查当前安装集合。
- 为覆盖“先 steer、终态时才转 follow-up”的既有队列语义，可在用户提交时为尚未插入 `runs` 的 fallback Run 身份预写快照；未被消费的候选快照作为不可变审计事实保留。
- 首版包只读通过 Sandbox 内固定命令设置 Unix 权限；它不是宿主机写入，也不绕过模型工具路由。后续若 Cube 提供原生只读挂载，应以相同端口替换实现。

## 影响与验证

- 新增 Run Skill 快照、调用事实、RLS 与最小 Runtime ACL。
- Prompt golden、目录转义/排序、结构化与 Slash 歧义、Blob 完整性、零 Sandbox 指令加载、延迟物化、固定工具 schema和 PostgreSQL 集成需要自动化测试。
- 回滚在存在 Run 快照或调用事实时拒绝，避免删除恢复所需版本身份。
- 已以 Prompt golden、Pi/Faux 工具循环、RunWorker 延迟 Sandbox、Skill 包路径与摘要校验、API 契约、迁移契约和 PostgreSQL 用户隔离集成测试验证；生产发布继续观察 Skill 加载失败分类、上下文字节数和首次 Skill 物化触发的 Sandbox 指标。

## 可逆性

在没有任何 Run Skill 快照或调用事实时可以回退迁移和 Prompt 版本；一旦产生事实，只能先完成显式的数据迁移与保留方案，不能直接破坏性回滚。
