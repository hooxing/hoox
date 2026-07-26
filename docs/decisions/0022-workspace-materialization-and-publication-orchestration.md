# ADR-0022：Workspace 安全物化与可验证发布编排

- 状态：已接受
- 日期：2026-07-26
- 决策者：M2 Workspace 应用核心实现
- 关联任务/PR：M2 Workspace materializer/publisher
- 替代关系：细化 ADR-0003、ADR-0005、ADR-0010、ADR-0011、ADR-0019，不替代既有决策

## 背景

ADR-0019 已经固定逐文件 WorkspaceManifest 和确定性物化计划，但没有执行任何外部 I/O。下一步需要把 stable Blob 安全写入 Sandbox，并从 Sandbox 普通文件生成下一 Revision 候选。如果应用核心直接依赖 CubeSandbox SDK、S3 SDK 或宿主文件系统，就会把路径、授权和外部副作用恢复语义散落到 Provider 细节；如果上传成功就直接推进 Workspace head，又会越过 PostgreSQL Lease/CAS 事实源。

本切片只建立可复用 TypeScript 应用核心与窄端口，不新增数据库迁移、HTTP、UI 或生产装配。

## 决策驱动因素

- stable 对象键中的 Tenant 只是身份字段，不能代替当前授权事实；
- Sandbox 可能被工具写入 symlink、特殊文件、截断文件或超配额内容；
- Blob、Sandbox 和数据库之间不存在分布式事务，超时后不能用普通重试猜测远端是否执行；
- 物化必须严格保持 `verify → remove → ensure → write` 依赖顺序；
- 应用核心不能获得宿主工作目录读写能力，也不能把未提交候选包装成 Revision；
- 大文件处理必须有单次内存和总量上限。

## 备选方案

### 方案 A：应用核心直接调用 S3、CubeSandbox 和 PostgreSQL

可以较快形成纵向链路，但核心会同时承担 SDK 协议、授权、事务和路径安全；Faux 很难证明与生产装配遵循同一副作用边界，外部响应未知也容易被普通重试掩盖。

### 方案 B：应用核心依赖可信窄端口，发布只返回可验证候选

物化器消费确定性 plan；授权、Blob 读取、Sandbox 相对路径操作、候选上传和 operation journal 分别由窄端口提供。所有对象验证通过后发布器只返回 `ValidatedWorkspaceChange`，未来由独立 PG 引用事务重新验证 Lease、对象生命周期和 base revision 后提交。

### 方案 C：先把 Workspace 整体打包上传，恢复时解包

调用次数少，但重新引入 tar/zip 解包路径、symlink 和整包内存/临时磁盘风险，也失去每个 stable incarnation 的逐文件证明，违反 ADR-0019。

## 选择

采用方案 B，并固定以下边界：

- 应用核心位于 `@cube-runtime/workspace`，只定义端口，不反向依赖 `persistence`、`sandbox` 或任一 Provider SDK。测试 Fake 只存在于测试文件，不从生产入口导出；
- 物化根固定为 Sandbox 内 `/workspace`。高层调用者只能提供已验证 Manifest，不能传根目录或宿主路径；Sandbox 端口只接收规范相对路径。端口实现不得使用宿主 `fs` 或拼接 shell，原子写协议必须使用同目录临时普通文件和 rename，无法保证时失败关闭；
- 执行任何删除前，目标 Manifest 的每个 stable Blob 都必须通过可信授权端口，并逐字段重验 `tenantId + purpose + incarnationId + physicalObjectKey + sha256 + size` 以及 HEAD。相同路径的现有 Sandbox 文件仍只是候选，必须流式重算摘要；损坏、缺失、目录、symlink 或特殊文件候选不被沿用，安全回退到已授权 stable Blob；
- 严格按 ADR-0019 的五个 phase 执行，目录与文件操作保持 plan 内顺序。每个外部副作用前及 phase 边界设置 abort 安全点；已经取得确定结果的副作用不会因迟到 abort 被伪装为未发生；
- operation identity 显式固定 `workspace-operation-v2` 摘要算法，并把可信 `tenantId + threadId + workspaceId`、Sandbox `sessionId + generation`、Manifest digest 纳入摘要；发布还必须先取得与 operationKey 幂等绑定的不可变 `snapshotToken`，再 begin journal，后续 list/read 全部携带同一 snapshot 身份。不同 Sandbox、generation、snapshot、base 或目标 Manifest 产生不同 digest，已发生副作用后不得把相同 operationKey 重新绑定；
- Sandbox 原子写和 Blob 上传都绑定稳定的子 operation key。物化子 key 覆盖父 digest、路径、内容身份和完整 stable object 身份；发布先对不可变快照做第一遍流式摘要，再以父 digest、snapshot、路径和内容身份生成上传子 key，第二遍流式上传并重验。Blob 返回的 incarnation/物理键随后由 Manifest schema 与 HEAD 证明，不能在分配前伪造进上传 key；
- journal 对同一 operationKey 永久保存首次 identity。known failure 不删除 identity，而分为允许同 digest 恢复的 `retryable` 与禁止恢复的 `terminal`；任何不同 digest 永久 conflict。UNKNOWN、completed、terminal 都不能降级，completed 响应作为 unknown 输入完整拒绝 Proxy、getter、额外字段，并重验 result kind、operationKey、scope、Sandbox/snapshot、base、candidate Manifest schema/digest/stable identity、时间和当前配额；
- 发布端口只列举 `/workspace` 下受限条目并按相对路径读取普通文件。symlink 与特殊文件使整次候选失败；目录不进入 schemaVersion 1。`maxEntries` 限制所有扫描条目，`maxFiles` 只限制普通文件；流在消费时另行强制 chunk、单文件、路径与总字节配额，短读、长读和上传返回身份不一致均失败；
- 候选 Blob 必须先通过 Manifest schema 的 tenant/purpose/incarnation/物理键绑定校验，再通过 HEAD 精确验证。只有所有文件验证完成才构建 `ValidatedWorkspaceChange`；该对象只是 PG 提交的输入证据，不是已提交 Revision，也不携带推进 Workspace head 的端口或权限；
- 依赖异常只对外暴露稳定应用错误码。Provider 消息、对象键、Sandbox 路径、凭据和 cause 不进入恢复事实或调用方错误。

## 理由

窄端口让路径和副作用不变量能在没有真实基础设施时被契约测试，同时保留后续 S3/Cube 适配空间。授权与 HEAD 前置可以在破坏工作副本前发现不可读 Revision；候选发布与 PG 引用事务分离，则把跨存储失败收敛为可清理的无引用对象，而不会产生数据库可见记录指向未验证内容。固定根目录和相对路径端口从能力层面阻止调用者把宿主路径带入 Workspace 核心。

## 影响

### 正面影响

- 候选损坏不会污染目标工作副本，跨 Tenant 对象在删除前失败；
- 完成和 UNKNOWN 均有 operation 事实，重放不会造成无控制的双写；
- 文件内容只以受限 chunk 经过内存，不创建宿主临时目录；
- 发布结果无法由本切片直接推进 Revision 或 Workspace head。

### 负面影响与成本

- 生产还需要实现 journal、可信授权、S3 stable 读取、候选 Blob 生命周期和 Cube 文件系统窄端口；
- 全量发布会读取并 HEAD 每个文件，大 Workspace 未来需要并发窗口、增量快照和背压调优；
- abort 发生在已确定副作用之后可能留下无引用候选或部分工作副本，必须依靠相同 operation key、Revision 重新物化或 GC 收敛，而不是承诺回滚远端世界。

### 安全、数据与运维影响

- 生产授权端口必须读取 PG 当前引用/生命周期事实并使用可信 Tenant Context，不能只检查对象键前缀；
- Sandbox 适配器必须以不跟随 symlink 的原语实现 list/read/write/remove，并验证 rename 目标仍位于固定根；
- 同路径保留候选若实际漂移成目录，执行器必须在 `remove_files` 删除阶段调用专用的不跟随 symlink 的递归目录删除端口，然后才从 stable Blob 写同目录临时普通文件并以 POSIX rename 替换；文件、symlink 和特殊文件漂移用 unlink 语义删除，不能把 rename-over-directory 当成原子替换；
- UNKNOWN journal 是生产恢复所需事实，不能替换为进程内 Map；依赖分类必须是白名单代码；
- `begin/recordUnknown/failKnown/complete` 的异常统一映射为脱敏稳定错误；单次业务失败最多发出一次状态 CAS，recordUnknown 自身失败不能再降级为 known failure CAS；
- 候选对象在 PG 引用失败后属于无引用 Blob，沿用 ADR-0003/0010/0012 的宽限期清理规则。

## 验证

- Faux 测试断言 stable 授权和 HEAD 发生在删除前，候选完整时不下载，损坏或 symlink 候选回退 stable；
- 阶段事件证明 `verify_existing → remove_files → remove_directories → ensure_directories → materialize_files`，并逐阶段注入 abort；
- 路径逃逸、错误 Tenant/回执、损坏 HEAD、短读、长读、超大 chunk、文件数和总量失败关闭；
- 写后未知与上传后未知均生成脱敏恢复事实，相同 operation key 重放不再次发出副作用；known failure、abort 和部分上传以同 digest/snapshot/子 key 恢复且不双写，不同 Sandbox 代际永久冲突；
- journal completed 的 Proxy、getter、额外字段、scope/snapshot/base/Manifest/时间漂移全部失败关闭；journal 自身失败不泄漏消息且不触发第二次 CAS；
- previous/base 使用显式、非默认的有界历史 Manifest 策略解析；当前 target/candidate 重新按当前执行配额解析；`maxEntries` 与 `maxFiles` 分别测试；
- 发布侧拒绝 symlink、特殊文件和重复路径，所有 HEAD 通过后才返回候选，结果中不存在 Revision 提交字段；
- 包级 test/typecheck/build、根 `check:clean-vendor` 与 `git diff --check` 通过。

## 可逆性与回退

在生产适配器和 PG 引用事务接入前，可以删除这些应用类或调整窄端口。operation journal 一旦持久化后，operation key、输入摘要和 UNKNOWN 状态不能原地重解释；需要新增 schema/version 并保留旧恢复器。Manifest schemaVersion 1 与 stable incarnation 语义继续受 ADR-0019 约束。

## 后续工作

- 实现 PG Workspace 引用事务：重验 Writer Lease、base revision、stable 生命周期后原子插入 Revision 并推进 head；
- 实现真实 S3/MinIO 授权读取与候选写入适配器，并接入生命周期/孤儿 GC；
- 基于 CubeSandbox v0.6 文件 API 实现不跟随 symlink、分块读取和原子 rename 的 `/workspace` 端口；
- 设计 warm Session 对账、增量发布、生产装配、指标和故障演练；
- HTTP、预览、下载和 UI 仍由 Resource/Artifact 后续切片完成。

## 实施记录

- `@cube-runtime/workspace` 已提供 materializer、publisher、窄端口、稳定错误分类与 Faux 契约测试；尚无 PG 引用事务、真实 S3/Cube、warm session 或生产装配。
