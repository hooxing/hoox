# ADR-0027：Artifact PostgreSQL 不可变发布与下载双重授权

- 状态：已接受
- 日期：2026-07-28
- 决策者：M4 Artifact PostgreSQL 持久化实施
- 关联任务：Artifact 生产 Repository 最小闭环
- 替代关系：落实 ADR-0021、ADR-0024，不改变其工具与完成门语义

## 背景

Artifact 应用核心已有声明、发布、修正链、完成门和下载授权端口，但缺少生产事实表。
同时 `artifact` 已依赖 `persistence` 的 Blob 契约，若将 Repository 实现放入 persistence，
会形成反向包依赖。

## 选择

1. 新增 0010 migration，分别保存交付声明命令、声明、不可变发布事实和发布命令。
2. Artifact 固定 ResourceVersion 及 stable Blob 的 incarnation、物理键、摘要、大小和媒体类型；
   只有状态可从 `publishing` 单向进入 `published/failed`。
3. 同一 Run 只接受一份声明集合；同一 Attempt 的幂等键绑定命令摘要和 Artifact，精确重放，
   摘要或 Artifact 不同均冲突。
4. 修正必须创建新 Artifact，并只允许替换同 Run、同用途、同声明键的 failed Artifact。
5. 写事务逐字段重验已消费 permit、Attempt version、Run claim、Workspace fence/lease、scope、
   tool/call/digest 和数据库时钟有效期；TypeScript 能力验证器不能替代这些事实。
6. 用户列表与下载每次重验 active Membership。下载授权修订绑定 Membership lock marker 和
   Artifact 更新时间，预签名前后再次核对完整 Blob 身份。
7. `PgArtifactDeliveryRepository` 位于 artifact 包并直接使用窄 PG 事务辅助器，避免包依赖环；
   migration 和 Runtime 最小权限仍由 persistence 管理。
8. 四张表全部 ENABLE/FORCE RLS。Runtime 只拥有 SELECT/INSERT，且仅可更新 Artifact 的
   `status/updated_at`，无 DELETE、TRUNCATE、REFERENCES 或 TRIGGER 权限。

## 影响与边界

正面影响是发布、完成门和授权下载拥有同一 PostgreSQL 事实源，跨租户裸 ID 查询在 RLS 和
Membership 两层均失败。成本是 Artifact 包新增 `pg` 运行依赖，且 Schema 保存了冗余 Blob
身份以换取可审计的不漂移绑定。

本切片不实现 HTTP/UI、真实 Workspace 路径提升或对象存储预览；它只接受已经存在且仍绑定
active stable Blob 的 searchable ResourceVersion。`workspaceRevisionId` 当前只参与调用边界，
待 Workspace 逐文件事实落库后再新增前向迁移绑定完成门修订。

## 验证与可逆性

真实 PostgreSQL 集成测试覆盖声明、缺失 blocker、发布、幂等重放、完成门、下载二次确认和
跨租户拒绝；迁移器覆盖 0010 up/down 与 Runtime ACL 白名单。生产产生 Artifact 后不得执行
0010 down；停用功能可以撤下装配，数据修正必须使用新的前向迁移。
