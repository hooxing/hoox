# ADR-20260815182655：使用本地不可变诊断镜像提供内部轨迹查看器

## 状态

已被 ADR-20260815193622 部分替代，2026-08-15。回环监听、development-only 和本地敏感诊断边界继续有效；公开 Runtime Event 近似轨迹的数据方案不再使用。

## 背景

DeepSeek Harness 的 Trajectory 直接投影完整 Session Event log；`codex-trajectory` 则把 Codex JSONL
转换成独立事件账本。当前 Runtime 已经持久化严格递增的 Run Event，并在 development 且
`MODEL_WIRE_TRACE_ENABLED=true` 时，把已提交事件和模型 request/response 正文写入
`model-wire-traces/<runId>/<attemptId>/` 的不可变文件。用户 Web 只投影有限的公开动作，无法集中检查模型步骤、
思考、工具耗时、稳定错误类别、Attempt 状态和原始模型报文。

维护者需要类似 Trajectory 的排障界面，但该能力可能展示 Prompt、思考正文、工具参数和模型可见回执，不能成为
普通租户成员可访问的产品功能，也不应为了首版诊断新增生产凭据、跨租户查询或公开 HTTP 协议。

## 备选

1. 把完整轨迹页加入用户 Web，并复用现有 Run Event API。实现简单，但会扩大敏感信息披露面，且公开事件缺少原始
   request/response，不能满足根因定位。
2. 新增生产 Operator API 和管理后台，从 PostgreSQL/对象存储读取权威诊断。可以远程排障，但需要独立 Operator
   身份、审计、授权、保留和部署边界，首版安全成本过高。
3. 仅在 development 提供回环地址本地查看器，读取已有不可变镜像，不新增公开 API 或生产装配。选择此方案。

## 决策

- 新增 `@cube-runtime/trajectory`，把带观察时间的 `RuntimeEventV1` 投影为维护者记录：Attempt 状态、近似模型步骤、
  推理、助手回复、工具生命周期、等待、恢复与稳定错误；未知或不完整生命周期保持可检查，不伪造成功。
- 新增 `@cube-runtime/trajectory-web`，只允许绑定 `127.0.0.1` 或 `::1`，默认读取仓库根目录
  `model-wire-traces`。它提供 Run/Attempt 列表、轨迹概览、记录检查器和模型 request/response 原文查看。
- 查看器不接入用户 Web、公开 API、production 进程、数据库或对象存储；关闭现有采集开关后不会产生新数据。
- 事件镜像没有 PostgreSQL `occurred_at`。首版只使用不可变文件 mtime 作为“诊断观察时刻”计算近似耗时，并在界面
  明确标记，禁止把它解释为权威业务时间。
- 文件访问只接受固定格式的 Run、Attempt 和 trace 文件名；逐级拒绝符号链接、junction、路径逃逸、非普通文件及
  超过 4 MiB 的单文件。HTTP 响应禁用缓存并设置 CSP、`nosniff` 和 `no-referrer`。
- 本实现独立编写，不复制 DeepSeek Harness 或 `codex-trajectory` 的源码、样式或运行时依赖。

## 影响

- 正面：维护者可在一个本地页面关联 Runtime 事件与模型网络报文，快速区分 Provider 输出、工具执行和 durable
  状态收敛问题；不会增加用户可见面或生产服务攻击面。
- 负面：只有显式开启诊断后的 development Run 可用；mtime 是近似时间；当前公开 Run Event 不包含完整工具
  stdout/stderr，仍需结合模型报文和既有日志排障。
- 安全：页面会展示敏感正文，只能在受控开发机使用；不得反向代理、端口转发或把 `model-wire-traces` 提交到 Git。

## 验证

- 投影单元测试覆盖思考、回复、工具、步骤近似和稳定错误。
- 文件系统测试覆盖普通目录发现、symlink/junction 排除、路径逃逸和文件白名单。
- 对仓库现有真实 `model-wire-traces` 启动查看器，验证 Run 列表、Attempt 切换、记录选择和模型报文读取。
- 执行受影响包的 format、lint、typecheck、build 和测试。

## 可逆性

删除两个内部 workspace 包、根脚本和文档即可回退；没有数据库迁移、公开协议或生产数据格式变化。已经存在的
诊断镜像仍按原有 ADR-0055 保留与删除，不依赖本查看器。
