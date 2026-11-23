# 运行事件与对话展示

本文面向修改 Worker 事件、API 事件读取、Web 对话渲染或诊断入口的开发者，说明运行事件从持久化到界面展示的当前契约。读取接口见[开发 API 契约](../reference/development-api.md)，诊断数据的开启与查看见[诊断指南](../maintainers/diagnostics.md)，工具展示字段见[工具调用模式](tool-calling-modes.md#用户可见工具信息与错误处理)。

## 持久事件是唯一事实源

- Worker 把模型流、工具生命周期、Todo、运行提示和终态写入 PostgreSQL `run_events`，按 `(attempt_id, sequence)` 排序；事件写入经过与其他执行副作用相同的持久化通道和双栅栏。
- 读取只返回当前 Run 最新 Attempt 的事件，sequence 游标不能跨 Attempt。Run 不存在、Thread 不匹配、跨 Tenant 或成员关系失效一律返回 404，数据库异常返回 503，不泄漏内部错误。
- 浏览器内的未发布文字、动画和计时状态只是展示缓冲；停止、切换任务或刷新时丢弃，不影响服务端事实。

## Webhook Outbox

Run 进入普通 `waiting` 或终态，以及 Artifact 发布时必须在提交该业务事实的同一事务写入 Tenant Webhook Outbox；所有提交 Run 状态转换的路径（Worker 收尾、API 取消、过期 Attempt 安全失败、团队解散批量取消）都经同一入队入口，事件 ID 由 Tenant、Run、转换后版本与状态（或 Artifact ID）确定性派生，重放不重复入队。Outbox 只保存白名单内的业务字段（客户端工具事件包含参数，其他状态事件不附带正文），不保存目的地址或签名密钥；投递端无需读取业务表。新增 Run 状态写入路径时必须同事务调用该入口。`run.requires_action` 只代表持久化的客户端工具请求，与请求在同一事务产生，不能从普通 `waiting` 推断。SSE 在 `run-events` 批次将该项投影为 `requires_action`。Scheduler 使用独立数据库角色领取并结算 Outbox，按至少一次语义发送，接收端以事件 ID 去重。完整载荷、签名与重试语义见 [Webhook 参考](../reference/webhooks.md)。

## 推送与续读

- API 通过 SSE 推送持久事件页。浏览器用 fetch 读取 SSE，继续携带 Authorization 与 Tenant Header，不把令牌放入 URL。每次补读重新认证并确认 Run 归属，流按有限页读取并服从背压，连接定期结束后按已接收游标续连。
- Worker 在事件写入事务中调用 `pg_notify`，通知只包含 Tenant/Run 的散列路由键，随事务提交才可见。API 每进程使用一条专用 LISTEN 连接；订阅先于初次补读，断线重建和定时补读覆盖通知丢失。通知不是授权或持久事实。
- 分页读取接口保留用于历史、补读和旧服务兼容。代理必须允许流式转发。
- Worker 对连续文本增量做合并后再持久化，以减少事件数量；合并不改变文本内容与顺序。

## 对话投影

- 正文消费与 Artifact、Thread 上下文刷新相互独立；首批文字和控制事件立即发布，连续文字按帧合并，事件投影只折叠追加部分。
- 一个 Agent 回合按有序块展示：思考、工具调用、正文和最终回复保持组件身份，滚动只在用户跟随底部且高度改变时更新。
- 已完成的终端用户可对正式回答点赞或点踩并附加不超过 2000 字符的附言；反馈按 Run 和 Revision 保存，并允许本人修改或撤销。工作台回显本人状态；Playground 与评测 Run 不提供反馈入口。后台附言遵循 Run 正文权限与访问审计。
- 思考内容实时展示并在完成后折叠；模型可通过受控标记把长过程折叠，只突出最终答复。工具调用只显示受控摘要（操作、相对路径、用途、技能名），不显示完整参数、源码、命令或业务输出。
- Markdown 使用固定版本的增量解析器（`runtime-ts/vendor/deepseek-markdown`），Hoox 保留 GFM、链接净化、禁用原始 HTML 和阻止第三方图片请求等安全策略。
- `executionStatus=recovery_required` 的 Run 显示“执行已中断”，停止计时、动画和短轮询，见 [Run 执行与恢复](run-execution-and-recovery.md#状态分层)。
- 失败时页面优先展示同一 Agent 根据持久工具失败事实给出的解释；Runtime 兜底提示不包含原始异常与私有诊断。旧数据或事件缺口由页面提供最后一层通用展示。

## 诊断数据

- 模型网络请求诊断默认关闭，只有显式开启后才拦截与配置 Provider 匹配的 `chat/completions` 请求，保存最终请求正文；不保存 HTTP header、原始响应正文或 Sandbox/S3 等其他请求。诊断正文进入 trace Blob 生命周期，受保留期与 GC 约束。
- Worker 将每个 Attempt 的逻辑轨迹事件（模型调用、上下文、助手思考/回复、工具参数/结果、子调用与阶段时序）写入现有 trace Blob 对象存储；PostgreSQL 只保存分页索引、内容摘要、Blob 引用和到期时间。子 Agent 事件以 `(agentThreadId, agentTurnId)` 标识独立 Session，索引主键、Blob 幂等键和分页游标都包含这两个字段；sequence 只在 Session 内递增，不能跨 Session 去重。保留原始模型 request body 的既有可选诊断，不采集原始 HTTP response/SSE；轨迹记录在持久化前剥离 header 对象及凭据字段，并对字符串中的认证头、Cookie、命令行和 URL 凭据脱敏。轨迹诊断写入失败只产生不含正文的观测日志，不改变 Run 结果。
- 后台“运行记录”提供按 Run/Attempt 的完整逻辑轨迹，前端按 `(agentThreadId, agentTurnId)` 独立投影，再按事件 UTC 时间合并时间轴；账本标注主 Agent 或子 Agent Session，选择与展开状态使用 Session 命名空间记录 ID。服务端按稳定游标分页返回原始事件；每页读取前在同一数据库事务写入内容访问审计，且只向有效平台管理员授权。前端自动读取 Attempt 的全部分页后统一投影和计算汇总，最多读取 50,000 条事件或 20 MiB；触及上限时展示已加载部分并明确标注汇总范围。审计、索引或对象读取失败时不返回轨迹正文。列表筛选通过 POST 请求体传递，避免关键词进入 URL 访问日志；旧 Run 没有轨迹时展示持久事件时间线并说明其早于完整轨迹记录。旧 `/trajectory/` 部署入口重定向到 `/admin/runs`。development 的 `@hoox/trajectory-web` 仍可读取本地 Worker 诊断镜像，不能部署为生产服务或作为 Run 事实来源。
- 逻辑轨迹对象默认保留 30 天，由 `RUN_TRAJECTORY_RETENTION_DAYS` 配置；Scheduler 以独立只读角色从受限目录枚举租户，并以 Runtime Tenant RLS 逐租户清理到期索引。写入超时不代表提交终结。清理器先从 pending 索引恢复 Blob 提交，绑定稳定引用后才释放引用；只有 staging 已放弃并清理、稳定对象已回收或确认仍有其他引用时才移除索引；对象删除失败保留索引供下次周期重试。过期轨迹立即从读取视图隐藏。Scheduler、Worker 和后台 API 必须使用同一对象存储 bucket 与兼容凭据。
- 模型用量（未缓存输入、输出、缓存读取 Token 与生成时长）原子写入租户隔离的低基数指标账本，后台只读取跨 Tenant 聚合视图，不保存 Provider 身份或模型正文。
- Worker 的 [OpenTelemetry 导出](../maintainers/diagnostics.md#导出到-opentelemetry)只旁听 Provider 流与通过持久化验证的 Run/工具事件。同一 Tool Call 的重复读回不生成新 Span；没有已确认的结束事实不猜测结果。导出默认不含正文，不复制持久账本，也不作为界面投影、恢复或计费依据。
- 开发模式的本地 Run 事件镜像对 `run_waiting` 只保留客户端调用元数据，剥离参数与结果；这与 OTel 正文、原始模型报文和内部轨迹的 Thread 敏感历史保护相互独立。诊断数据可能包含用户内容，必须按敏感数据处理；配置错误、日志和测试失败不得输出秘密值。

## 修改检查清单

1. 新事件类型同时定义持久 payload、协议白名单、Web 投影和旧事件缺字段的兼容展示。
2. 不在事件中写入完整工具参数、签名 URL、对象键或凭据。
3. 新的推送或缓存机制不得替代持久事实，断线和通知丢失必须由补读覆盖。
