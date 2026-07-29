# ADR-0047：Workspace candidate 原子交接与开发 Worker 启用

- 状态：已接受
- 日期：2026-07-29
- 关联：ADR-0012、ADR-0014、ADR-0022、ADR-0038、ADR-0046

## 背景

ADR-0046 已完成逐文件 Workspace manifest、物化和 RuntimeMutation 的数据边界，但因新文件的 stable Blob
引用会早于 Workspace head CAS 创建，development Worker 仍失败关闭所有非空 Workspace。若发布在取消、
租约冲突、修正轮次或 COMMIT 响应未知时中断，单独的 stable 引用既不能被当作已提交 revision，也不能被
GC 回收。

本切片需要把 Sandbox 快照产生的候选引用持久绑定到同一 Tenant、Workspace、Attempt、Run、Thread、
RootRun、parent revision、目标 revision 与 operation digest，并在最终 RuntimeMutation 中完成可证明的所有权
交接。协议还必须允许 unchanged 文件零上传复用、拒绝跨路径或跨 revision 授权，并在明确失败和恢复路径上
释放候选，而不能把 PostgreSQL COMMIT 响应丢失猜成失败。

## 备选

1. 继续使用 ADR-0038 的空目录 verifier。边界安全，但 development Worker 无法跨 Run 保存 Workspace。
2. 新 stable 引用不入 candidate 表，依靠按时间扫描无主 Blob。实现较少，但无法区分仍在提交中的引用与
   真正孤儿，也不能证明 GC 与最终 CAS 不并发。
3. 建立持久化 candidate 状态机，把新引用先绑定到 Attempt candidate，最终在同一 SERIALIZABLE
   RuntimeMutation 内写 revision、推进 head 并把引用退出 stable 可达集合；明确失败和过期恢复也在事务内释放。

## 决策

采用方案 3。迁移 `0015_workspace_candidate_handoff` 增加
`workspace_revision_candidates` 与 `workspace_revision_candidate_files`，两表启用并强制 RLS。candidate
身份完整绑定执行 scope、parent/target revision、operation key 与 operation digest，状态只能按以下路径推进：

```text
building -> prepared -> committed
    |           |
    +-----------+-> released
```

- `begin` 必须在 SERIALIZABLE 事务内锁定仍有效的 ExecutionAttempt、Run claim 与 Workspace lease，并核对
  parent head。修正轮次创建新 candidate 时，同 Attempt 的旧 building/prepared candidate 及其 uploaded 引用
  在同一事务标记 released。
- 新文件先经 Blob commit 协议取得精确 active incarnation。把 `blob_references` 从 staged 标成 stable 与写入
  uploaded candidate file 必须使用同一个 PostgreSQL 事务，不能留下“已 stable、未归属 candidate”的崩溃窗口。
- `prepare` 要求 manifest 每个文件恰好来自该 candidate 的 uploaded 引用，或来自 parent revision 同路径且
  `sha256 + size + incarnation + physical key` 完全一致的 base 文件。unchanged 文件直接复用 base 行，不创建
  新 Blob 或引用；跨路径复用不成立。
- 最终 RuntimeMutation 锁定精确 prepared candidate，重验 manifest digest、逐文件 active incarnation 与
  uploaded stable 引用；随后在同一 SERIALIZABLE 事务写 revision/manifest/files、推进 Workspace head、把
  uploaded 引用标记 released，并把 candidate 标记 committed。revision files 从此成为 Blob 可达事实，
  released 引用只保留交接审计身份，不参与 GC 可达性。
- 发布明确失败、终态释放栅栏、Attempt 租约过期恢复和人工恢复分别使用持久化 release reason 收敛仍处于
  building/prepared 的 candidate 与 uploaded 引用。对象存储副作用未知时保留状态，交给原 operation 或
  过期恢复处理。
- RuntimeMutation 的 COMMIT 响应未知继续遵守 ADR-0014：调用方只能用原 scope、幂等键和 command digest
  调用 `readMutation`。不得重发发布、释放 candidate 或猜测 head 是否推进。
- Workspace stable 读取授权与回执必须逐字段绑定 Tenant、Thread、Workspace、revision、relative path、
  内容身份和物理 incarnation；续期也必须重验同一文件事实。

development Worker 装配因此改为真实 `ManifestWorkspaceRuntime`、候选 Blob writer、candidate handoff、
Workspace manifest repository 和 CubeSandbox 冻结 Workspace capability。该接线只改变 development Worker；
固定开发身份仍不是生产认证，仓库也不新增生产 Worker 入口。Artifact 发布继续是独立闭环，Workspace 文件
不会自动成为 deliverable Artifact。

## 安全与运维影响

- candidate 表、外键、唯一索引、RLS 和最小 Runtime 角色 ACL 共同阻止跨 Tenant、跨 Attempt 或重复引用交接。
- GC 只把 `blob_references.state='stable'` 和已提交 revision files 计为可达；released 不延长对象生命周期。
- candidate 生命周期受现有 Attempt claim/Workspace lease 限制。恢复协调器释放过期 Attempt 时同时释放候选，
  不需要无范围地扫描或取得跨租户权限。
- `released` 是不可逆的安全事实。`0015` down 删除 candidate 表，但故意保留 blob reference 的 released 状态
  与约束；FORCE RLS 下迁移不能越权逐租户把 released 改回 stable，改回也会错误阻止 GC。因此 down 不是字节级
  恢复旧 schema，生产回退应先停止新 Worker，再保留已写入的 revision 和生命周期事实。

## 验证

- Workspace 单元测试覆盖 unchanged 零上传复用、candidate identity/digest、发布/物化精确授权及回执绑定。
- 迁移和 Role bootstrap 测试覆盖状态约束、复合外键、RLS、恢复索引与最小表/列 ACL。
- 真实 PostgreSQL 集成测试覆盖 uploaded 引用的原子最终交接、COMMIT 响应丢失后的 `readMutation`、终态与
  过期恢复释放，以及 `0015` down/re-up。
- 合并前执行 `pnpm check`；真实 PostgreSQL Gate 通过后 development Worker 才能替换失败关闭 verifier。

## 可逆性

代码可回退为 ADR-0038 的失败关闭装配，不再创建 candidate。尚未 committed 的 candidate 由终态或过期恢复
标记 released；已 committed revision 不回滚、不删除。迁移 down 只移除 candidate 协调表并保留 released
生命周期语义，避免已交接/释放的引用重新变成可达引用。
