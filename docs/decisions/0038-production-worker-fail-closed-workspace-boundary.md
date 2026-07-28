# ADR-0038：生产 Worker 的 Workspace 失败关闭边界

- 状态：已接受
- 日期：2026-07-28

## 背景

生产 Agent Worker 已能执行模型与 Sandbox，但 WorkspacePublisher、稳定 Blob 清单、
WorkspaceRevision 提交和下一 Run 物化尚未接入同一个生产装配入口。若验证器无条件返回
“没有变更”，Sandbox 关闭后文件会永久丢失，同时 Run 仍被错误标记为成功。

Artifact Router 也尚未在该入口启用；当前 Session 能力清单不注册 Artifact 工具，完成门只表示
“不存在已声明的 required Artifact”，不表示 Artifact 发布能力可用。

## 备选

1. 在本切片内接通完整发布和恢复链路。正确，但需要同时引入 journal、候选 Blob 提升、manifest
   引用授权、revision 原子提交和 materializer，范围超过当前可安全验证的切片。
2. 继续把 Sandbox 当临时执行区。实现简单，但会成功丢失用户成果，不可接受。
3. 对非空 `/workspace` 失败关闭；空 Workspace 维持现状，完整链路另行接入。

## 决策

采用方案 3。生产验证器通过 Sandbox 命令检查 `/workspace`。目录不存在或包含任何条目时，验证
失败，RunWorker 进入 `recovery_required` 并执行既有 cleanup saga；只有空 Workspace 才允许完成。
该检查是安全下限，不是 Workspace revision 功能完成的声明。

同时，恢复清理指标写入租户隔离的 PostgreSQL 表；模型 context window 和最大输出 token 必须由
严格环境配置提供，并与 provider `/models` 元数据一致，否则 readiness 失败关闭。

## 影响

- 生产默认不再出现“成功但文件消失”。
- 会写文件的 Run 在完整发布链路上线前进入恢复态，属于显式能力缺口。
- Artifact 能力仍禁用，不能通过完成门推断其已启用。
- 下一安全切片必须从 `startWorkerProcess` 接入 WorkspacePublisher、稳定 manifest Blob、
  WorkspaceRevision 原子提交及下一 Run 的 WorkspaceMaterializer。

## 验证

- polling loop 测试覆盖 claim 阻塞期间关闭，关闭后返回的 claim 只 defer、不执行。
- 进程配置测试覆盖模型预算必填。
- 生产集成 Gate 必须增加写文件导致 `recovery_required`；完整发布上线时再替换为跨 Run 恢复 E2E。

## 可逆性

完整发布链路验证通过后可用真实 revision verifier 替换失败关闭实现。禁止回退为无条件成功的
临时验证器。
