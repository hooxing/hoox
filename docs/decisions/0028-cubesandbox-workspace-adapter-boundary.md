# ADR-0028：CubeSandbox Workspace 可信适配边界

- 状态：已接受
- 日期：2026-07-28
- 决策者：M2 CubeSandbox Workspace 适配器实现
- 关联任务/PR：M2 Workspace Cube adapter
- 替代关系：细化 ADR-0004、ADR-0019、ADR-0022，不替代既有决策

## 背景

Workspace 应用核心已经用窄端口约束物化与发布，但尚无 CubeSandbox v0.6 生产实现。厂商 SDK 接受任意 Sandbox ID 和绝对路径；如果把这些参数继续暴露给业务层，调用方可以绕过 Thread Session 代际、固定根目录和 UNKNOWN 恢复语义。SDK 文件读取接口也无法同时证明普通文件类型、读取期间稳定性和配额。

## 决策驱动因素

- Workspace 只能绑定可信 Session registry 提供的 `tenantId + threadId + workspaceId + sessionId + generation`；
- 根目录固定为 Sandbox 内 `/workspace`，不能接收宿主路径或调用方根目录；
- symlink、特殊文件、路径逃逸、代际漂移和协议异常必须失败关闭；
- 外部变更超时或确认帧异常时，不能猜测远端副作用是否发生；
- 首版以正确性和明确配额为先，后续再优化大文件与增量快照。

## 备选方案

### 方案 A：业务层直接使用 CubeSandbox SDK

实现较短，但 Sandbox ID、路径、厂商异常和变更确认会扩散到 Workspace 核心，无法在一个边界统一审计代际与 UNKNOWN 语义。

### 方案 B：以可信 Session capability 装配固定根窄适配器

Gateway 只接受可重验且支持 Abort 的 capability；适配器绑定首次完整 scope 与身份，在每次调用、延迟流真正消费前后及副作用后重验。所有 Workspace 路径操作交给固定的 Linux Python 3 dirfd helper：从 `/workspace` 开始逐级 `O_NOFOLLOW` 打开目录，并只用相对 dirfd 的 stat/read/mkdir/unlink/rename；Base64 环境变量只承载数据，不参与 shell 拼接。

### 方案 C：先把 `/workspace` 打包下载到宿主机

易于生成快照，但重新引入宿主临时目录、归档解包、symlink 和整包配额风险，违反“不把 Workspace 复制成宿主共享目录”的边界。

## 选择

采用方案 B，并固定以下约束：

- 生产入口只允许 Linux Worker，且 Sandbox 模板必须提供 Python 3 与所需 POSIX dirfd API；缺失时启动失败关闭；
- 启动 probe 必须实际执行 `openat2`，不能只检查内核版本、Python 常量或脚本文本；`ENOSYS/EINVAL/EPERM` 等任一失败均禁止创建适配器；
- 不提供 package testing 子路径或生产构建可导入的平台旁路；测试仅临时替换 Node 的只读平台描述符后调用同一生产入口，公开类构造器保持私有；
- `/workspace` 根和规范相对路径由适配器内部解析，命令参数只通过 Base64 环境变量传递，不拼接用户路径；
- capability 每次读取都有硬超时与 AbortSignal；即使实现错误地忽略 Abort，适配器也不会无限等待；
- 快照在开始 I/O 前按 operation key 原子绑定可信 scope 与共享 in-flight Promise，并保存排序条目、内容 SHA-256 和读取指纹；并发同 key 只扫描一次，不同 scope 失败；
- `SandboxWorkspacePort` 把 operation 快照释放列为正式生命周期方法；Publisher 与 Materializer 对成功、known/unknown 失败、journal completed 和异常均在 `finally` 调用。release 与同 key capture 原子互斥；释放后内容缓存失效，再次扫描只有相同内容才能得到相同的确定性 token，从而保持 journal 重入身份；
- 文件数、单文件、总字节、路径 UTF-8、命令输出、chunk、快照数量和操作超时均要求显式正整数上限；
- 所有调用方相对路径在任何 SDK/命令调用前执行 UTF-8 字节上限；helper 自身也限制扫描路径和输出；
- SDK 只把随机临时正文写到 `/tmp`；helper 以 `O_NOFOLLOW` 重验普通文件、大小与 SHA-256，再在目标父 dirfd 内创建临时文件、fsync 并相对 rename。已知拒绝会清理 `/tmp` 文件；
- 扫描、读取、建目录、删除和递归删除全部使用逐级 dirfd，不使用 SDK 的绝对路径 `list/stat/remove/rename/makeDir`，因此祖先目录的 symlink/TOCTOU 不能逃逸根目录；
- `openat2` 固定启用 `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`；递归删除的每一级子目录也必须经同一 openat2 包装，禁止退回普通 `os.open`；
- 变更脚本只有完整 `OK` 确认才视为成功。明确发生在副作用前的退出码归为 known；可能部分执行、超时或确认异常归为 unknown。

## 理由

该方案让 Session 所有权、固定根目录和外部副作用分类集中在一个可测试边界，同时不让 Workspace 核心依赖厂商 SDK。它保留真实 Cube 纵向验证路径，也避免为了快照将过程文件复制到宿主机。

## 影响

### 正面影响

- 调用方不能注入 Sandbox URL、裸 session ID、根目录或宿主路径；
- generation 漂移和不安全文件类型统一失败关闭；
- 应用核心可以直接复用现有 Materializer/Publisher，不感知 Cube 协议。

### 负面影响与成本

- 首版读取会把受限单文件收集到内存并以 Base64 经过命令输出，性能不适合超大文件；
- 快照缓存在 Worker 进程内，由 Workspace 应用核心在 operation 终态显式 release；Worker 重启后以 operation key、可信 scope 和内容确定性 token 重新建立 journal 身份；
- 文件系统 helper 依赖 Linux Python 3 的 `dir_fd`、`O_NOFOLLOW`、`fsync` 与相对 `os.replace`，模板升级时必须重新跑真实 Cube 冒烟；
- `/tmp` SDK 写入仍可能被同 Sandbox 内恶意进程制造拒绝服务，但随机名、helper 的 `O_NOFOLLOW` 和 SHA-256 复验阻止其把内容或路径引向 Workspace 外；最终目标操作仍只使用可信父 dirfd。

### 安全、数据与运维影响

- capability 必须来自可信 Session registry，完整 scope 不得由 HTTP 请求体或模型工具参数构造；registry 必须在 generation 或 scope 变化时立即让旧 capability 失效；
- 配额应与 Workspace execution policy 对齐，生产配置不得使用无限值；
- UNKNOWN 必须进入既有 operation journal/recovery，不能自动当作 known failure 重试；
- 日志不得记录文件正文、Base64、绝对路径、Provider 凭据或原始异常详情。

## 验证

- package typecheck、build 和 Workspace 适配器契约测试通过；
- 契约覆盖固定根扫描、并发快照 in-flight 共享、跨 scope、祖先 symlink、延迟读取换代、快照释放、路径配额、capability 硬超时、tmp 清理和变更确认异常；
- Session/Snapshot 返回对象执行 exact-key 与 JSON journal 往返测试，禁止 capability 的 scope 混入端口身份；
- Linux 集成测试必须真正执行 helper，在真实临时目录创建普通文件和祖先 symlink；环境允许 bind mount 时还要证明 `NO_XDEV` 拒绝挂载点，不能用 Faux 或字符串包含断言代替；
- 合并前运行全工作区 `check:clean-workspace`；
- 在 Linux Worker 对 CubeSandbox v0.6 执行真实 materialize/publish 冒烟，覆盖普通文件、目录、symlink、原子覆盖与清理；若环境不可用，不得用 Faux 结果宣称真实冒烟通过。

## 可逆性与回退

生产装配前可删除适配器和 sandbox→workspace package 依赖。进入生产后，回退不能把已记录的 UNKNOWN 强行解释为未执行；必须先停止新 Workspace 操作、释放/对账快照和临时文件，再回退 Worker。快照 token 仍是进程内实现细节，未来持久化时需新增版本而非重解释旧 token。

## 后续工作

- 增加 Linux 真实 Cube v0.6 适配器冒烟和故障注入；
- 将可信 Session capability 接入 warm manager/registry 的生产装配；
- 评估 SDK 流式文件接口或受限分块协议，降低 Base64 与单文件内存开销；
- 增加指标：代际漂移、UNKNOWN 变更、配额拒绝、快照漂移和操作延迟。

## 实施记录

- `@cube-runtime/sandbox` 已实现固定 `/workspace` 的 CubeSandbox v0.6 窄适配器、完整 scope capability、dirfd helper、显式快照释放和聚焦契约测试；没有生产可导入的测试构造入口。真实 Cube 冒烟仍是合并前 Linux 环境 Gate，未通过时不得宣称该模板可投入生产。
