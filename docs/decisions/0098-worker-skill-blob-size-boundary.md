# ADR-0098：Worker Skill Blob 读取上限与预检一致性

- 状态：已接受
- 日期：2026-08-04
- 决策者：Runtime 维护者
- 关联任务/PR：安装 Skill 后 Run 持续排队故障修复
- 替代关系：细化 ADR-0095 的 Skill 文件读取边界

## 背景

Skill Runtime 允许单个包文件最大 32 MiB。Worker 装配因此把 S3 BlobStore 实例配置为 32 MiB，但底层通用适配器仍把构造参数硬限制在 16 MiB，导致 Worker 在启动阶段抛出 `INVALID_BLOB_ARGUMENT` 并退出。开发预检仍使用 16 MiB，因而出现“预检通过、真实进程启动失败”，队列中 Run 无消费者领取。

## 决策驱动因素

- Worker 必须能够读取已经通过 Skill Center 校验的 32 MiB 文件；
- API Resource 上传等写侧业务仍需保持自己的 16 MiB 或更小配额；
- 预检配置必须与真实 Worker 装配字节一致；
- 全量哈希校验前不得把未验证字节交给消费者。

## 备选方案

### 方案 A：通用适配器绝对上限提高到 32 MiB，实例继续自定更小上限

Worker 使用 32 MiB，API 等调用方仍显式使用 16 MiB。读取仍先完整缓冲并校验摘要。

### 方案 B：把 Skill 单文件上限降低到 16 MiB

不需要修改 BlobStore，但会让已接受的 32 MiB Skill 包协议与持久目录约束失配，并拒绝原本合法的目录版本。

### 方案 C：为 Skill 新建独立 S3 读取实现

可以隔离上限，但会复制稳定引用解析、流式读取和摘要校验逻辑，扩大安全审计面。

## 选择

采用方案 A：把 `S3BlobStore` 的绝对内存上限提高到 32 MiB；各实例的 `maxBlobSizeBytes` 仍决定实际能力。Worker 正式装配与 development preflight 共用一个 32 MiB 常量，API Resource 上传继续保持 16 MiB。

## 理由

该方案直接匹配 Skill 协议且不扩大其他服务实例的业务配额。方案 B 会制造协议不兼容；方案 C 会引入第二套内容完整性实现，风险和维护成本更高。

## 影响

### 正面影响

- Worker 可以正常启动并领取包含 Skill 快照的排队 Run；
- 预检能够发现与真实装配相同的 Blob 上限配置错误；
- Skill 文件继续复用既有稳定引用和完整摘要校验。

### 负面影响与成本

- 配置为 32 MiB 的 Worker 单次 Blob 读取最多缓冲 32 MiB，而此前通用硬上限为 16 MiB；
- 并发读取时需要相应评估 Worker 内存预算。

### 安全、数据与运维影响

- API 和其他显式配置 16 MiB 的实例不会自动获得更大的写入能力；
- 不修改数据库结构或已发布 Skill 数据；
- Worker 需要重新构建并重启，既有 queued Run 随后由正常轮询领取。

## 验证

- S3BlobStore 单元测试断言 32 MiB 配置可构造、32 MiB 加 1 字节仍被拒绝；
- Worker development preflight 与正式装配共用同一上限常量；
- 本地启动 Worker 后确认进程保持存活，并观察目标 Run 离开 `queued`。

## 可逆性与回退

代码可回退到 16 MiB，但必须同时把 Skill 单文件协议和目录数据限制降到 16 MiB，否则会重新导致装配或内容读取失败。该改动无数据迁移。

## 后续工作

- 为开发服务进程增加受控的稳定启动失败码投影，减少依赖直接装配诊断的需要。

## 实施记录

- 2026-08-04：统一 Worker 与预检上限，补充 S3BlobStore 构造边界回归测试。
