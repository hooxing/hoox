# ADR-0048：Workspace Revision 到 Artifact 的原子发布闭环

- 状态：已接受
- 日期：2026-07-29
- 关联：ADR-0021、ADR-0024、ADR-0027、ADR-0046、ADR-0047

## 背景

既有 `publish_artifact` 会在模型工具调用期间先准备 ResourceVersion，再把 Artifact 标为 published。
Workspace 的最终内容事实却只在模型结束、Sandbox snapshot 校验和 RuntimeMutation 提交后形成。两条时间线
会让工具在最终 Revision 尚不存在时谎报已发布，也无法证明下载字节来自本轮 Revision 的指定路径。生产装配
同时仍未注入 Artifact Router、动态授权 issuer、PG Repository 与真实完成门。

本切片必须保留 ADR-0047 的 candidate 原子交接，并把发布意图、最终 source identity、ResourceVersion、
Artifact settlement 和下载读侧连接为一条失败关闭事实链。

## 备选

1. 工具调用时读取可变 Sandbox 并立即发布。响应快，但发布内容可能与最终 Revision 不同。
2. Revision 提交后由异步消费者结算 Artifact。能解耦事务，但需要新 outbox、恢复消费者和 pending 状态；在闭环
   完成前 completion gate 不能安全放行。
3. 工具阶段只追加 durable intent；完成门验证本轮 prepared candidate 的 path，最终 RuntimeMutation 在提交
   Revision 的同一事务内建立 ResourceVersion、Artifact 与 published settlement。

## 决策

采用方案 3。

- `0016_workspace_artifact_intents` 新增只追加 intent 表。身份绑定 Tenant、Thread、Run、Attempt、Workspace、
  RootRun、已消费 permit/call、幂等键、原始工具摘要、命令摘要、模型请求别名、replacement/deliverable、来源路径
  与 Resource 名称。Artifact、Resource、ResourceVersion、Blob reference/operation ID 均由服务端按
  `tenant + attempt + idempotency key` 确定性派生。
- Workspace 来源的 `publish_artifact` 返回 `ARTIFACT_ACCEPTED`，不再调用 Resource preparation 或
  `finishPublication`，也不返回 published 快照。同键同完整 identity 可读回；摘要或别名冲突永久拒绝；COMMIT
  响应未知只按原授权和幂等键读回，不创建第二份意图。
- 完成门要求传入本轮 `workspaceRevisionId`。Repository 重新验证 Run/Workspace/Attempt scope，并只把与该
  prepared candidate 同 Attempt、同 Revision、同 source path 且确实存在 candidate file 的 required intent
  视为可结算；历史 Revision 的 published Artifact、其他 candidate 或裸路径均不能放行。
- RuntimeMutation 已锁定双栅栏和 candidate 后，先写 Revision manifest/files，再从刚写入的精确
  `path + sha256 + size + lifecycle/incarnation/physical key` 创建独立 resource Blob 引用、不可变 ResourceVersion
  和 Artifact，最后追加 published settlement。Artifact 通过组合外键反向绑定同一 Revision file。所有写入与
  Workspace head CAS、Run success、mutation receipt 共用 SERIALIZABLE 事务；提交前列表和下载查询均不可见。
- 新表启用并强制 RLS，Runtime 仅有 SELECT/INSERT；Artifact source 组合 FK 与既有 Tenant RLS 共同拒绝跨租户、
  跨 Workspace、跨 Revision 和 incarnation 漂移。读侧继续使用既有 Membership 原子授权、预签名前后双重确认，
  不新增 UI 或绕过 API 的下载路径。
- development process-entry 创建单一 Artifact authorization authority，把 issuer 仅交给 Worker session，把
  verifier 交给 Router、Service 和 PG Repository；同时注入 PG Resource bridge 与真实 completion gate。任一
  依赖缺失时构造失败，不使用 `NoDeclaredArtifactCompletionGate`。

## 失败与恢复语义

- 取消、lease loss、Attempt 版本漂移会在 intent accept 的 PG 执行边界和最终 RuntimeMutation 双重拒绝；只留下
  不可下载 intent，不会留下可见 Artifact。
- candidate correction 可创建新 intent。只有最终 candidate 中存在的 source path 会结算；未匹配的旧 intent
  保留审计事实但永不进入 Artifact 读投影。
- RuntimeMutation COMMIT 结果未知继续以 mutation receipt 对账；Resource/Artifact 与 receipt 在同一事务，不能
  出现“Revision 已提交但 Artifact 未结算”的中间状态。
- 当前切片不从文件扩展名猜测媒体类型，Workspace 结算统一使用 `application/octet-stream`。无法证明 path 的
  intent、缺失 required source、无 prepared candidate、旧 Revision 或依赖异常均保持 `ARTIFACT_NOT_READY`。

## 验证

- Tool Router 测试证明 Workspace 来源只调用 intent 端口并返回 accepted，不触碰 Resource preparation 和即时
  publication。
- migration 契约测试覆盖 source 组合键/FK、tool digest、RLS/FORCE、PUBLIC 回收和无 UPDATE ACL。
- Artifact、Tool Router、Pi Session 与 process-entry focused 测试继续覆盖授权伪造、幂等冲突、完成门和真实装配。
- PostgreSQL 集成环境可进一步验证列表、预览和下载 bytes/hash 与 Revision file 相同；环境不可用时不得用内存
  结果替代真实 PG 结论。

## 可逆性

停止新 Worker 后可回退代码，使 intent 不再创建。down 只允许 development/test：删除 intent 与新增 source FK；
已经发布的 ResourceVersion 和 Artifact 是不可变交付事实，不应在生产回退中删除或改写。若发布链异常，可停止
Artifact 工具和下载签发，但不能放宽完成门或把 pending intent 投影为已发布。
