# 模型 Provider 凭据按 Revision 加密托管

- 状态：已接受（模型探测后发布门禁与“保存—探测—启用”界面流程已被 ADR-20260825180549 部分替代，凭据加密和 Run 快照语义继续有效）
- 日期：2026-08-25
- 决策者：Runtime 维护者
- 关联任务/PR：让后台模型配置真正切换 Provider 地址、模型与调用密钥
- 替代关系：替代 ADR-20260825164722 第 4、7 条以及 ADR-20260819165254 中“Provider secretRef 只能引用部署秘密”的首版限制；模型保存即启用流程见 ADR-20260825180549，凭据加密、Provider 标识防误填和 Run 快照语义继续有效

## 背景

原实现只版本化 Provider 地址和模型目录，所有模型探测与 Worker 调用仍使用部署级 `MODEL_API_KEY`。因此后台看似可以配置和切换 Provider，实际切到需要另一把密钥的 Provider 时不会生效；让管理员再改部署环境也违背了控制台用于日常配置的目标。

同时，密钥不能成为普通配置字段：任何列表、详情、审计、幂等响应或错误都不得回显它，数据库泄露也不应直接暴露明文。

## 决策

1. 模型草稿提供写入型 `apiKey`。首次创建必须输入；编辑已有托管 Revision 时可留空并明确复用同一 Provider 的既有密文，也可输入新值覆盖。
2. Admin API 使用 `MODEL_CREDENTIAL_ENCRYPTION_KEY` 经 HKDF 派生 AES-256-GCM 密钥，在持久化前加密。AAD 绑定 `providerKey`，密文可以在同一 Provider 的后续 Revision 复用，不能跨 Provider 搬用。
3. 加密包与非秘密模型配置保存在同一个不可变 Revision JSON 中。读取投影先剥离加密包，只返回 `credentialConfigured`；协议 DTO 不定义密文、nonce、tag 或明文密钥。
4. 探测先按准确 Revision 解密密钥，再请求 Provider。发布仍要求该 Revision 探测健康。
5. Worker 按 `run_runtime_config_snapshots` 固定的模型 Revision 读取并解密密钥；动态 Provider 使用该密钥，不再无条件使用进程级 `MODEL_API_KEY`。因此新 Run 随 active Revision 切换，已有 Run 重试保持原 Revision 和原密钥。
6. `MODEL_CREDENTIAL_ENCRYPTION_KEY` 是平台级加密主密钥，只授予 Admin API 与 Worker，不能调用任何模型 Provider，也不得进入后台、Git 或日志。production 必须独立配置且至少 32 字节。
7. 为兼容已经启用的旧 `deployment:model` Revision，Admin API 与 Worker 暂时允许使用 `MODEL_API_KEY` 回退；所有新 Revision 都写入托管密钥。development/test 未提供独立主密钥时可临时以旧模型密钥作为迁移兼容根，production 不允许该回退。

## 理由与影响

该方案让“保存—探测—启用”真正覆盖模型调用所需的完整配置，同时把秘密暴露面限制在一次写请求、可信进程内存和数据库密文。密钥更新会形成新 Revision，不原地覆盖历史事实；切换 active 不会改变已存在 Run 的可重放性。

代价是 Admin API 与 Worker 必须共享稳定的加密主密钥。主密钥丢失会使托管凭据无法解密，轮换需要另行实现重加密流程，不能直接替换环境值。

## 验证

- 密码学单元测试验证明文不进入密文对象、随机 nonce 和跨 Provider AAD 隔离；
- Admin API 与 Web 测试验证密钥只进入写请求且不进入响应；
- Worker 测试验证运行时工厂使用快照中的 Revision 密钥；
- 新迁移同时接受旧部署引用与新加密包，并继续禁止模型配置 JSON 出现明文 `apiKey`；
- 受影响包执行格式、lint、typecheck 和定向测试，并在本地迁移后人工验证模型页面。

## 可逆性

只要数据库中不存在托管密钥 Revision，可以回退迁移和代码。存在托管 Revision 后，向下迁移必须失败关闭，防止丢失密文；恢复旧版本前应先创建受审计的数据导出或迁移方案。旧部署回退路径保留一个过渡周期，移除前需要确认所有 active 与 Run 固定 Revision 已完成托管凭据迁移。
