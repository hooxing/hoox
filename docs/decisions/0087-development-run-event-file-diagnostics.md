# ADR-0087：开发环境 Run 事件文件诊断

## 状态

已接受，2026-08-02。

## 背景

模型原始请求和 SSE 已能在显式开启 `MODEL_WIRE_TRACE_ENABLED` 时镜像到项目目录，但思考增量、工具生命周期、
稳定错误类别和 Attempt 状态仍主要通过 PostgreSQL `run_events` 排查。开发者在页面只显示汇总状态或 Run 未能
收敛时，需要连接数据库并重组事件，定位成本较高。

Run 事件可能包含用户和模型正文，工具原始异常、stdout、stderr、对象键和凭据又受既有安全决策禁止进入普通日志。
诊断写入还不能成为 durable mutation 的前置条件，不能因磁盘只读、空间不足或本地链接攻击改变 Run 结果。

## 备选方案

### 方案 A：只依赖 PostgreSQL/API

不增加本地文件面，安全边界最简单，但离线排障和一次性开发复现仍需要数据库查询与事件重组，不能解决当前诉求。

### 方案 B：把 Worker stdout/stderr 全量重定向为一个日志文件

接入成本低，但并发 Run 难以分组，崩溃时可能留下半行；更重要的是，任意异常对象和控制台调用容易把连接串、
原始工具输出或用户内容扩大到未受控日志面。

### 方案 C：在现有显式敏感诊断开关下镜像 durable Run 事件

每个 Run/Attempt/sequence 使用一个不可变规范 JSON 文件，与模型 wire trace 共用固定目录、安全路径校验和人工删除
流程。只镜像公开 `RuntimeEventV1`，不新增原始异常或工具输出采集。

## 决策

选择方案 C。

- 仅在 development 且 `MODEL_WIRE_TRACE_ENABLED=true` 时创建 Run 事件镜像；production 永不创建宿主机文件。
- 只在对应 Runtime mutation 已应用或幂等读回后写入，未提交事件不得伪装成 durable 事实。
- 文件位于 `model-wire-traces/<runId>/<attemptId>/runtime-event-<sequence>-<kind>.json`；正文使用键排序的规范 JSON。
- 每个 sequence 独立以临时文件、同步和不覆盖 hard link 发布；同字节重放成功，异字节拒绝覆盖。
- 文件写入是 best-effort，任何失败都被隔离，不能改变 Run、数据库或模型调用结果。
- 不采集原始工具异常、stdout、stderr、请求头、凭据、连接配置、对象键或驱动错误；既有稳定事件里已经存在的
  思考/消息正文按敏感诊断数据处理。
- 本地文件不是权威事实源，不提供 ACL、自动 retention、备份或生产读取能力；PG/MinIO 和既有授权 API 保持权威。

## 影响

### 正面

- 单个目录即可按顺序对照模型 request/SSE 与 Runtime 思考、工具、错误和 Attempt 状态。
- 逐事件不可变文件避免 JSONL append 的半行、并发交错和重放重复问题。
- 复用已有显式敏感诊断开关，不扩大默认采集面，也不增加生产文件写入。

### 负面与运维成本

- 开启诊断时小文件数量随事件数量增长，本地镜像仍需由开发者在 Worker 停止后人工清理。
- 文件没有数据库生成的 `occurred_at`；sequence 是唯一权威顺序，文件时间只可作为近似排障信息。
- 为遵守安全边界，工具失败仍只有稳定类别，不能从该文件取得原始 SDK 异常或未受控输出。

### 安全

模型正文和思考可能包含敏感内容，因此目录权限、共享、备份和删除必须与原始 wire trace 使用同一标准。固定根、
逐级 realpath/reparse 校验和不覆盖发布继续拒绝目录逃逸；镜像端口不接受配置、请求头或异常对象。

## 验证

- 组件测试验证规范文件名和 JSON、同字节重放、异字节冲突以及 development/production 开关。
- Run Worker 测试验证仅在 durable mutation 成功后调用镜像，并注入磁盘失败证明 Run 结果不受影响。
- `pnpm check` 验证格式、类型、单测、构建和配置契约。
- 人工开发验证可开启现有开关，运行含 thinking 与工具调用的任务，按 sequence 对照 wire trace 与事件文件。

## 可逆性

移除 Run 事件镜像装配和 Worker 可选端口即可回退，不涉及数据库迁移或公开 API。关闭现有诊断开关会立即停止新增
文件；历史文件在 Worker 停止后可人工删除，不影响 PG/MinIO 权威事实。
