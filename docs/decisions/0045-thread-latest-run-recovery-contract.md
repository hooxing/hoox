# ADR-0045：Thread 最新 Run 恢复读取契约

- 状态：已接受
- 日期：2026-07-28
- 决策者：Runtime 团队
- 关联任务/PR：Thread 历史恢复读取纵向契约
- 替代关系：补充 ADR-0042

## 背景

浏览器刷新或切回一个 Thread 时，内存中的当前 Run、事件和 Artifact 投影会消失。虽然 ADR-0042 已定义了单个 Run 的增量读取，但客户端没有一个安全、明确的入口来找到应恢复的 Run，因而容易显示空白或依赖不可靠的本地缓存。

## 决策驱动因素

- 恢复查询必须沿用 TenantScope、成员关系和 Thread 归属校验；
- 最新 Run 的选择必须可测试且排序稳定；
- 事件 sequence 游标绝不能跨最新 Attempt；
- UI 切换 Thread 或切走再切回时，旧网络响应不能覆盖新状态；
- 公开面应最小，不新增跨 Thread、跨租户或按 Attempt 的浏览器查询。

## 备选方案

### 方案 A：Thread 嵌套最新 Run 快照窗口

增加 `GET /v1/threads/:threadId/runs?limit=N`。它返回请求快照内按 `updatedAt DESC, createdAt DESC, id DESC` 排序的最近 N 条 Run；不声明跨并发写入可续接的分页语义。客户端恢复用 `limit=1`，然后继续使用既有嵌套路由读取该 Run 的事件和 Artifact。

### 方案 B：只增加 `GET .../runs/latest`

端点更短，但未来需要有限历史窗口时会再增加一个相近的端点；也不能让调用方显式控制恢复前展示多少条最近 Run。

### 方案 C：浏览器保存最后 Run ID

缓存可以失效、被篡改且不能解决多设备或历史 Thread；服务端仍须验证归属，不能作为恢复事实来源。

## 选择

采用方案 A。API 先通过受成员关系约束的 Thread 读取确认父级，再通过同一 TenantScope 的 Run 查询获取快照窗口。Thread 不存在、跨租户、成员撤销和 Run 归属不匹配均按 404 失败关闭；查询不接受裸 tenant、attempt 或用户 ID。

窗口查询固定排序但没有游标，故只表示“该次读取时最近的 N 条”，不承诺请求间无重复或无遗漏。这样避免把会被并发更新打破的伪游标公开为历史同步契约。需要完整历史时应另行设计带签名游标的端点。

Run 事件读取使用只读 `REPEATABLE READ` 事务，在同一个 MVCC 快照中完成 Run 授权、最新 Attempt 选择和事件读取，并以 `limit + 1` 计算 `hasMore`。仅标记只读而保留 PostgreSQL 默认 `READ COMMITTED` 不足以满足该承诺，因为并发 Attempt 切换或旧 Attempt 追加可能被后续语句的新快照观察到。响应中的 `attemptId` 是该 cursor 的边界：客户端遇到变更必须从 `-1` 重新读取，不能把旧 Attempt 的 cursor 带入新 Attempt。

Web client 提供 `listLatestRuns`，状态机的 `recoverLatestRun` 动作携带 Thread 与 `selectionGeneration`。Reducer 对 Thread 或代次不匹配的迟到响应保持原状态；导航辅助函数也在响应前复验导航代次。这些是供主界面接入的恢复基础，当前 `main.tsx` 尚未调用它们，因此本 ADR 此阶段不宣称刷新或切回 Thread 已在实际页面中恢复内容。

## 当前实施范围

- 已实现并验证 API、PostgreSQL 查询、Web client、Reducer 与导航代次闩锁；
- 已保持现有主界面代码不变，避免与并行 UI 重构产生冲突；
- 实际页面的加载态、恢复调用、Run 轮询激活以及事件和 Artifact 回填仍待 UI 分支合并后接入。

## 影响

### 正面影响

- API 与 Web 状态层已具备从持久化事实恢复最新 Run 的受权基础；
- 未授权读取不会暴露 Thread 是否含有 Run；
- Attempt 边界和浏览器导航边界都成为可测试的不变量。

### 负面影响与成本

- 该端点不是完整历史 API；
- 当前主界面尚未接入恢复动作，刷新或切回 Thread 仍可能显示空白；
- 完成 UI 接入后的恢复过程至少需要 Run、事件和 Artifact 三次读取，页面应显示加载态而非把空快照当终态。

## 验证

- API 契约测试覆盖稳定最新窗口与跨租户 404；
- Web API、Reducer 与导航测试覆盖可供 UI 接入的恢复基础和迟到响应丢弃，但不作为主界面已接入的证明；
- 持久层在同一受 RLS 约束的事务中查询 Run，并以 `limit + 1` 验证最新 Attempt 的 `hasMore` 边界；
- 运行定向测试、类型检查、Biome 与 `git diff --check`。

## 可逆性与回退

端点和恢复动作不改变数据库 schema。若需回退可停止 Web 调用并移除路由；单 Run 的既有读取语义不受影响。

## 后续工作

- UI 分支合并后，在 `main.tsx` 的初次加载与 Thread 选择路径调用 `listLatestRuns(limit=1)`；
- 仅在导航代次仍匹配时分发 `recoverLatestRun`，随后激活该 Run 的事件和 Artifact 轮询；
- 补主界面级测试，覆盖刷新、切回、空 Thread、切走再切回及迟到恢复响应。

## 实施记录

- 2026-07-28：完成最新 Run API、PG 查询以及 Web client/reducer/navigation 基础。
- 2026-07-29：独立审查确认主界面尚未接入，收窄本 ADR 的完成声明；事件读取明确升级为只读 `REPEATABLE READ`，并补并发 Attempt 切换、`limit` 与 `hasMore` 集成覆盖。
