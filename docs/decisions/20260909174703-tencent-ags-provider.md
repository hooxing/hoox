# ADR-20260909174703：腾讯云 AGS 独立 Provider 与受限生命周期

- 状态：部分已替代
- 配置来源由 [后端管理 Sandbox 配置](20260910005916-managed-sandbox-routing.md) 部分替代；独立身份与 AGS 受限生命周期结论继续有效。
- 日期：2026-09-09
- 部分替代：[ADR-0177](0177-sandbox-provider-persistence-and-routing.md) 中 Provider key 仅有 cube/e2b 的限制；其身份、路由和失败关闭约束继续有效。
- 关联：[ADR-0176](0176-e2b-provider-first-sdk-adapter.md)、[ADR-0178](0178-e2b-resourcefs-controlled-snapshot.md)。

## 背景与约束

腾讯云 AGS 提供 E2B 兼容接口，但独立账号、地域、实例身份和生命周期扩展不能等同于 E2B 官方服务。复用同一个 e2b key 并切换域名，会把存量 Session 和清理请求发送给错误服务。

腾讯云[暂停恢复说明](https://cloud.tencent.com/document/product/1814/132323)明确使用 `metadata["x-ags-sandbox-state"]` 表达兼容 state 无法区分的过渡态与失败态。[实例生命周期](https://cloud.tencent.com/document/product/1814/132337)描述 TTL 到期停止；当前没有足够证据承诺 E2B `lifecycle.onTimeout=pause` 与 `autoResume` 扩展生效。

## 备选方案

1. 仅更换 E2B 域名：改动少，但无法同时路由两个服务，也无法隔离厂商语义。
2. 完整重写腾讯云 API 适配：可覆盖原生控制面，但增加签名、SDK 和数据面组合的维护成本。
3. 独立 AGS Provider，复用 E2B 协议实现并显式限制扩展：保留身份隔离，集中处理差异。

## 决策与理由

采用方案 3。`tencent-ags` 使用独立凭据、域名和模板配置。创建、命令、文件、Workspace 与创建失败对账复用现有 E2B 适配；未知创建事件必须保留 AGS 身份，不自动切换 Provider。

AGS Thread 创建采用到期销毁策略，不向云端发送未确认的 lifecycle、keepMemory 或 Cube Volume 扩展。主动暂停仍由 Scheduler 驱动，连接已暂停实例使用标准 E2B connect；连接前拒绝过渡态，连接后确认 running。未知状态保留身份等待对账，不把兼容 running/paused 当作细粒度状态的事实源。

ResourceFS 复用受控快照与 Workspace 初始化；不引入 CFS 挂载、不向沙箱传递 PG/S3 凭据。Cube/E2B 的现有策略保持有效。

## 影响

迁移 0063 扩展六个持久化边界的 Provider CHECK，保留唯一性、外键和已有身份。Worker 与 Scheduler 必须同时配置 AGS；切换默认 Provider 只影响新创建。

0063 已在 Windows 以 CRLF 原始字节执行；迁移校验绑定完整 SQL 字节。为遵守已执行迁移不可修改的约束，Git 属性对这对文件关闭文本换行转换，确保 Linux checkout 与已执行版本的 checksum 相同。此例外仅限 0063，后续新迁移仍应在首次执行前采用 LF。

AGS TTL 到期可能丢失未持久化进程和文件，不能提供到期自动暂停保证。运行中连接续期、暂停后的进程保留、模板权限、配额及完整附件/交付链路必须在目标地域验收；代码测试不构成云服务 readiness。

## 验证

自动化覆盖独立配置与路由、创建扩展拒绝、细粒度状态优先、恢复后状态校验、未知创建身份、Thread 生命周期选择、数据库约束及无数据回退。真实冒烟入口为 `pnpm test:tencent-ags:real`，覆盖基本命令、文件、暂停恢复与清理；生产准入还需完成当前说明中的完整验收。

## 可逆性

尚未产生 AGS 事实时可以回退迁移。任一持久表已有 AGS 身份时，down 明确拒绝；停止新建后仍须保留 Provider 配置，以处理存量会话及 cleanup，不得将其改记为 e2b 或 cube。

## 当前说明

使用和限制以[Sandbox Provider](../architecture/sandbox-providers.md)为准，配置入口见[配置参考](../reference/configuration.md)。
