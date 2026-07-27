# ADR-0027：CubeSandbox Workspace 可信适配边界

- 状态：已接受
- 日期：2026-07-28
- 决策者：M2 CubeSandbox Workspace 适配器实现
- 关联任务/PR：M2 Workspace Cube adapter
- 替代关系：细化 ADR-0004、ADR-0019、ADR-0022，不替代既有决策

## 背景

Workspace 应用核心已经用窄端口约束物化与发布，但尚无 CubeSandbox v0.6 生产实现。厂商 SDK 接受任意 Sandbox ID 和绝对路径；如果把这些参数继续暴露给业务层，调用方可以绕过 Thread Session 代际、固定根目录和 UNKNOWN 恢复语义。SDK 文件读取接口也无法同时证明普通文件类型、读取期间稳定性和配额。

## 决策驱动因素

- Workspace 只能绑定可信 Session registry 提供的 `sessionId + generation`；
- 根目录固定为 Sandbox 内 `/workspace`，不能接收宿主路径或调用方根目录；
- symlink、特殊文件、路径逃逸、代际漂移和协议异常必须失败关闭；
- 外部变更超时或确认帧异常时，不能猜测远端副作用是否发生；
- 首版以正确性和明确配额为先，后续再优化大文件与增量快照。

## 备选方案

### 方案 A：业务层直接使用 CubeSandbox SDK

实现较短，但 Sandbox ID、路径、厂商异常和变更确认会扩散到 Workspace 核心，无法在一个边界统一审计代际与 UNKNOWN 语义。

### 方案 B：以可信 Session capability 装配固定根窄适配器

Gateway 只接受可重验的 capability；适配器绑定首次身份，在每次调用及副作用后重验 generation。列举使用 SDK 元数据接口，普通文件读取和原子变更使用固定脚本与 Base64 环境变量传参，并对白名单退出码分类。

### 方案 C：先把 `/workspace` 打包下载到宿主机

易于生成快照，但重新引入宿主临时目录、归档解包、symlink 和整包配额风险，违反“不把 Workspace 复制成宿主共享目录”的边界。

## 选择

采用方案 B，并固定以下约束：

- 生产入口只允许 Linux Worker；测试子路径只绕过平台判断，不绕过 identity、路径、配额或协议校验；
- 主 package 入口不导出测试构造函数，公开类构造器保持私有；
- `/workspace` 根和规范相对路径由适配器内部解析，命令参数只通过 Base64 环境变量传递，不拼接用户路径；
- 快照按 operation key 幂等绑定 scope 与 Session generation，保存排序条目、内容 SHA-256 和读取指纹；后续读取发现变化即拒绝；
- 文件数、单文件、总字节、路径 UTF-8、命令输出、chunk、快照数量和操作超时均要求显式正整数上限；
- 原子写采用同目录临时文件、大小复验、`mv -T` 和目录同步；递归删除不跟随 symlink；
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
- 快照缓存在 Worker 进程内，Worker 重启后需重新建立 operation 恢复流程；
- 文件系统脚本依赖 Linux coreutils，模板升级时必须重新跑真实 Cube 冒烟。

### 安全、数据与运维影响

- capability 必须来自可信 Session registry，禁止由 HTTP 请求体或模型工具参数构造；
- 配额应与 Workspace execution policy 对齐，生产配置不得使用无限值；
- UNKNOWN 必须进入既有 operation journal/recovery，不能自动当作 known failure 重试；
- 日志不得记录文件正文、Base64、绝对路径、Provider 凭据或原始异常详情。

## 验证

- package typecheck、build 和 Workspace 适配器契约测试通过；
- 契约覆盖固定根扫描、快照幂等、路径逃逸、内容漂移、generation 漂移和变更确认异常；
- 合并前运行全工作区 `check:clean-workspace`；
- 在 Linux Worker 对 CubeSandbox v0.6 执行真实 materialize/publish 冒烟，覆盖普通文件、目录、symlink、原子覆盖与清理；若环境不可用，不得用 Faux 结果宣称真实冒烟通过。

## 可逆性与回退

生产装配前可删除适配器、测试子路径和 sandbox→workspace package 依赖。进入生产后，回退不能把已记录的 UNKNOWN 强行解释为未执行；必须先停止新 Workspace 操作、完成对账，再回退 Worker。快照 token 仍是进程内实现细节，未来持久化时需新增版本而非重解释旧 token。

## 后续工作

- 增加 Linux 真实 Cube v0.6 适配器冒烟和故障注入；
- 将可信 Session capability 接入 warm manager/registry 的生产装配；
- 评估 SDK 流式文件接口或受限分块协议，降低 Base64 与单文件内存开销；
- 增加指标：代际漂移、UNKNOWN 变更、配额拒绝、快照漂移和操作延迟。

## 实施记录

- `@cube-runtime/sandbox` 已实现固定 `/workspace` 的 CubeSandbox v0.6 窄适配器、测试专用构造入口和聚焦契约测试；真实 Cube 冒烟仍为合并后的环境 Gate。
