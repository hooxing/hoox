# ADR-0172：E2B ResourceFS 受控快照物化

- 状态：已接受
- 日期：2026-08-14

## 背景

E2B Provider 的生命周期、命令、文件和 pause/connect 已经接入，但 Agent Worker 在首次 Sandbox 工具调用时固定要求 `/resources`。CubeSandbox 通过宿主机 Volume 插件把只读 WebDAV ResourceFS 挂载到 microVM；E2B registry 没有对应能力时会在远端 create 前失败关闭，导致完整 Agent Run 只能得到 `SANDBOX_FAILED`。

E2B JavaScript SDK 已暴露 Volume API 和 `volumeMounts`，但 Volume 是账户级可选能力，真实开发账户可能返回 403，不能作为 E2B Provider 的最低可用前提。CubeSandbox 文档中的 `/volumes` 和 `read_only` 属于 CubeAPI 提供的 E2B 协议兼容扩展，调用目标仍是 CubeAPI，不等同于官方 E2B Cloud 的 Volume 能力；因此 Cube Provider 继续使用 Cube SDK/REST，E2B Provider 继续使用官方 E2B SDK，不能混用后端。

直接把 PostgreSQL、S3 或 ResourceFS 签名密钥注入 Sandbox 会扩大凭据边界，也不允许。把全部 Provider 在失败时回退到 Cube 会破坏已经持久化的 `providerKey` 和清理路由语义。

## 备选

1. 保持 E2B ResourceFS fail-closed。安全，但所有需要 Sandbox 工具的正常 Run 都不可用，E2B 只剩独立 SDK 冒烟价值。
2. 强制启用 E2B Volume 并把 Tenant 长期卷挂到 `/resources`。接入直接，但账户能力不是普遍可用；共享可写卷还会让一个 Sandbox 修改其他 Session 的资源视图。
3. 在 E2B 内安装 rclone/FUSE，通过公网 ResourceFS WebDAV 动态只读挂载。读取延迟和容量最好，但要求专用模板、外部可达的 HTTPS 数据面和短期 capability 续期，不能解决当前 loopback 开发环境。
4. Worker 在 Tenant RLS 内读取 Resource/History/Skill 目录和不可变 Blob，把受控快照写入每个 E2B Sandbox。Sandbox 不持有数据库、对象存储或签名凭据；远端副本的修改不会回写持久来源。

## 选择

采用方案 4 作为 E2B 的最低完整运行能力，并保留方案 3 作为后续大规模数据面的优化方向：

1. `ProviderSandboxSessionRegistry` 同时支持宿主 Volume 和受控物化器。`requiresResourceFilesystem=true` 时两者都缺失仍在 create 前失败关闭。
2. E2B registry 在新建 Sandbox 后、返回 Session 前物化 `/resources`；Thread Sandbox pause/connect 恢复时重新物化，避免长期 Session 使用旧快照。
3. 快照来源只允许当前 `ExecutionScope.tenantId` 下经 PostgreSQL RLS 授权的 searchable Resource、History 稳定入口和公开 Skill 文件。Blob 读取继续校验 stable incarnation、大小和 SHA-256。
4. Worker 通过 E2B 文件 API上传业务字节，不向 Sandbox 传入 PostgreSQL URL、S3 凭据、物理对象键、Volume token 或 ResourceFS 签名密钥。
5. 文件先写入随机 staging 根，逐文件在远端验证 SHA-256，再以目录替换发布为 `/resources`。目录和文件分别收紧为 `0555`、`0444`；这用于阻止普通用户的意外写入，真正的持久只读不变量来自每个 Sandbox 独立副本且没有回写通道。
6. 首版明确限制为最多 512 个文件、总计 128 MiB、单文件 32 MiB。超过边界必须失败关闭，不允许静默缺文件。
7. 新建后的物化失败必须销毁 Sandbox；清理结果未知时升级为 `UNKNOWN`，进入既有对账与清理事实链。
8. E2B 使用独立的 `E2B_SESSION_TTL_SECONDS`，默认 3600 秒，不再复用 Cube 为 12 小时 Run 设计的 `CUBESANDBOX_SESSION_TTL_SECONDS=43800`。真实账户明确拒绝超过 1 小时的 timeout；E2B SDK 把该 HTTP 400 包装成普通 `SandboxError` 时，Gateway 必须归类为 `INVALID_ARGUMENT`，不得误报为创建结果未知。
9. E2B 基础模板不保证存在 `/workspace`。E2B registry 在 create/connect 后幂等建立当前普通用户拥有、权限为 `0700` 且非符号链接的 `/workspace`，再开放 Workspace adapter。
10. E2B SDK 对非零命令退出抛出 `CommandExitError`，而 Runtime 的 `SandboxHandle` 契约要求返回 `{stdout, stderr, exitCode}`。Gateway 必须只归一化这一明确错误类型，使 Workspace 安全脚本和用户命令可以按退出码处理；其他 SDK 异常继续走基础设施错误映射。
11. E2B 普通用户不能直接在根目录创建 `/history` 与 `/thread-files`。受控物化器在发布 `/resources` 后用 sudo 建立固定符号链接，并拒绝覆盖非空目录、普通文件或指向错误目标的既有链接。

## 影响

- E2B 可以执行完整 Agent Sandbox 工具链，不再因为缺少 Cube Volume、`/workspace` 或根目录固定入口而失败，也不会因误用 Cube 的 43,800 秒 TTL 被 E2B 账户上限拒绝。
- Resource、历史文件和 Skill 在同一个 E2B Session 内可通过既有路径读取；pause/connect 后会刷新。
- 首次创建和恢复会产生目录枚举、对象读取和 E2B 上传开销；大型 Tenant 超过快照上限时仍会失败关闭。
- E2B 基础模板默认用户可能拥有 sudo，因此不能声称 Sandbox 内核层面不可修改本地副本；但修改只影响当前 Sandbox 副本，不能污染 PostgreSQL/MinIO 来源或其他 Tenant/Session。
- 后续可在不改变 `SandboxResourceFilesystemMaterializerPort` 和 `providerKey` 路由的前提下，替换为专用模板内的短期 capability WebDAV 只读挂载。

## 验证

- 单元测试覆盖 Resource、History、Thread 稳定入口和公开 Skill 的路径物化、摘要验证、凭据不泄漏及容量失败关闭。
- Provider registry 测试覆盖缺少物化器时 create 前失败、E2B `/workspace` 初始化、配置物化器后 create → initialize → materialize → ready 的顺序，以及初始化失败且清理未知时保留 `providerSandboxId`。
- 真实 E2B Gate 覆盖创建、`/workspace` 初始化、快照上传、`/resources` 数据面探针、非零退出归一化、命令执行、pause/connect 后重新物化及清理。
- 完整开发链路使用 `SANDBOX_DEFAULT_PROVIDER=e2b`、`E2B_SESSION_TTL_SECONDS=3600` 提交实际 Run，确认终端工具成功并持久化 `providerKey=e2b`。

## 可逆性

移除 E2B 物化器装配即可恢复 fail-closed 行为，不涉及数据库迁移。未来切换 WebDAV/FUSE 或 E2B Volume 时保留相同 Provider registry 能力接口和持久化身份，不需要重写已有 Sandbox 清理路由。
