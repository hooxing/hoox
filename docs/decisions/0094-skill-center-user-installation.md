# ADR-0094：Skill Center 全局用户安装与受管目录边界

- 状态：已接受
- 日期：2026-08-03
- 决策者：Runtime 维护者
- 关联任务/PR：Skill Center 阶段 A 的用户安装闭环
- 替代关系：补充 ADR-0003、ADR-0013 与 ADR-0092；不实施或替代 ADR-0029 的 Prompt 结论

## 背景

Skill 需要从本地文件发现迁移到受管 Skill Center。第一步要让用户浏览中心目录、安装固定版本、停用、启用和
卸载，并保证安装关系跨 Tenant 属于同一个人。完整 `SKILL.md` 加载、Run 快照、System Prompt 目录和 `skill`
工具尚未进入本切片。

目录版本由受信发布流程提供，正文以后存放在私有 Blob/S3；API Runtime 不能获得发布权限。用户安装会被多个
Tenant 下的 Run 消费，因此不能把它错误建模成 Tenant 业务数据，但每次公开请求仍必须先完成既有身份认证和
Membership 重验。

模型可见 `AVAILABLE_SKILLS` 如果包含内部 SHA-256，会让仅内部摘要变化破坏 Provider 上下文缓存。本阶段不改
Prompt，并把后续目录格式明确为不展示摘要；数据库内部的幂等摘要和内容完整性摘要不受此限制。

## 决策驱动因素

- 用户 A 的安装、命令回放和审计不能被用户 B 读取或修改；
- 安装、配置和卸载必须支持重试，并防止并发请求覆盖版本或抢占调用名称；
- Runtime 只能消费已发布目录，不能通过公开 API 发布或改写 Skill 内容；
- 安装中心的普通数据库 I/O 不应创建 Sandbox；
- 阶段 A 不能提前耦合 Run Prompt、Pi Session 或 Skill 包物化协议。

## 备选方案

### 方案 A：按 Tenant 安装

复用现有 Tenant RLS 最直接，但同一用户切换个人或团队 Tenant 时会得到不同安装集合，也违背已经确认的个人
全局安装语义。

### 方案 B：全局用户安装，使用用户 RLS、幂等命令和 CAS

目录表全局只读，安装、命令和审计表以可信 `app.user_id` 隔离。Runtime 以幂等命令快照回放成功结果，用户级
事务锁串行化安装配额与调用名称检查，`version_token` 保护配置和卸载。

### 方案 C：继续使用本地 Skill 目录

实现成本低，但需要文件系统或 Sandbox 才能发现内容，难以与用户安装关系、版本撤销和多实例恢复保持一致。

## 选择

采用方案 B，并限定本次交付边界：

1. PostgreSQL 新增受管 `skills`、不可变 `skill_versions`、文件清单和用户安装、命令、审计表；Skill 内容引用
   只由 Migrator/受信发布流程写入，Runtime 对三个目录表只有 `SELECT`。
2. 安装关系以 `(user_id, skill_id)` 为唯一事实，状态为 `enabled`、`disabled` 或 `uninstalled`；卸载只改变
   状态，不物理删除历史。
3. 调用名称在同一用户的有效安装中唯一，并拒绝平台保留命令；单用户最多保留 64 个有效安装。
4. `PUT`、`PATCH`、`DELETE` 都要求幂等键。成功命令保存脱敏结果快照；同键同请求稳定回放，同键异请求返回
   冲突。配置与卸载要求调用方提交 `expectedVersionToken`。
5. 公开 API 使用现有 AuthContext 的 `userId`，不接收 `user_id`；PostgreSQL 再以 `app.user_id` RLS 失败关闭。
6. Web 工作台提供技能中心入口、搜索、安装、启停和卸载。
7. 本切片不提供管理员发布 HTTP API、不读取 Skill Blob、不创建 Run Skill 快照、不修改 System Prompt、不注册
   `skill` 工具，也不启动 Sandbox。

## 理由

用户级 RLS 让全局个人安装语义与既有 Tenant 请求认证可以同时成立。命令快照解决 COMMIT 结果未知后的安全
重试，用户级 advisory lock 同时覆盖“行尚不存在”时的安装配额和调用名称竞争，CAS 则避免用户基于旧界面
覆盖较新的配置。

把发布写权限留给 Migrator/受信流程，使首个用户安装切片不会意外形成无审核的第三方发布入口。目录、安装与
界面先形成独立闭环，后续 Run 快照和 Prompt 变更可以单独评审缓存、恢复与兼容边界。

## 影响

### 正面影响

- 用户安装跨 Tenant 稳定复用，且不会泄漏给其他用户；
- 安装重试、并发名称冲突、安装上限和旧版本配置都有确定结果；
- Runtime 无权发布 Skill 版本，目录供应链边界清晰；
- 技能中心全程只访问 API/PostgreSQL，不消耗 Sandbox。

### 负面影响与成本

- 生产目录在受信导入流程落地前可能为空，本切片不提供普通用户发布入口；
- 每个写命令增加命令快照和审计行，并在单用户范围串行化；
- Skill 包引用先作为受管不透明引用保存，实际 Blob 生命周期与预览留给后续切片闭环。

### 安全、数据与运维影响

- Runtime 角色对目录表只有读权限，对用户表只具备最小 `SELECT/INSERT` 和列级 `UPDATE`；
- 所有用户表启用并强制 RLS，策略只接受事务级可信 `app.user_id`；
- 迁移包含不可变版本摘要与内容引用，但公开 DTO 不返回 Blob 引用、包摘要或内部 Skill ID；
- 安装或审计事实存在时，down migration 拒绝破坏性回滚。

## 验证

- Skill 领域测试覆盖查询规范化、保留命令、幂等摘要、冲突和 CAS 参数；
- API 契约测试覆盖目录读取、同键回放以及用户 A/B 安装隔离；
- Web API 与组件测试覆盖写请求幂等键、版本令牌和安装交互；
- 迁移契约与真实 PostgreSQL 集成测试覆盖发布者导入、用户 RLS、有效安装唯一索引、幂等回放、CAS、审计事实和
  Runtime 最小权限；
- 执行受影响包 typecheck、格式、lint 与直接测试。

## 可逆性与回退

在没有安装、命令或审计事实时，可以执行 0029 down 并移除 API/UI。产生事实后不得自动回滚表结构；应先停止
写入、导出审计并制定显式数据迁移。API 路由可以先从装配中关闭，数据库表保持只读，不影响既有 Thread、Run
或 Sandbox。

## 后续工作

- 实现受信管理员导入、私有 Blob 提交和 Skill 详情预览；
- 创建 Run Skill 快照，并评审不含摘要的 `AVAILABLE_SKILLS` Prompt 目录；
- 实现显式 Skill 调用、固定 `skill` 工具和零 Sandbox 指令加载；
- 为硬撤销、历史 Run 引用与包 Blob 保留建立生命周期协议。

## 实施记录

- 2026-08-03：完成 PostgreSQL、领域服务、公开 API 与 Web 技能中心安装闭环。
