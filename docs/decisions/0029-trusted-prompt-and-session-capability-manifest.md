# ADR-0029：可信 Prompt 分层与 Session 能力清单

- 状态：已接受
- 日期：2026-07-28
- 决策者：M5 Prompt 第一切片实现审阅
- 关联任务：M5-04 可信 Prompt 分层与实际 Tool capability manifest
- 替代关系：细化 ADR-0004、ADR-0006，不替代其结论

## 背景

Pi Session 已关闭扩展、Skill、AGENTS 和宿主目录自动发现，也只注册受控 Sandbox 与可选 Artifact 工具；但系统提示仍是一段通用常量，不能证明它描述的能力与本次 Session 实际注册工具一致。后续 Tenant 规范、Skill 资料和用户上下文还会进入模型上下文。若这些低信任内容可以直接拼入平台 Harness，租户数据就可能伪装成系统规范；若能力说明维护第二份硬编码清单，则可出现提示声称存在 `request_user_input`、实际 Session 却未注册该工具的漂移。

本切片只建立 Prompt 与能力清单的安全、确定性边界，不实现 Token 预算、工具结果 Blob 截断或 Runtime 自有压缩。

## 决策驱动因素

- 平台 Harness 必须与 Tenant、Skill、User 数据存在机器可测试的显式信任边界；
- 能力说明必须由传给 Pi 的同一组真实工具派生，缺失能力不能出现在系统提示中；
- Worker 重启后用同样输入必须重建字节一致的 Prompt，并能核对版本和摘要；
- Prompt 输入是运行时边界，TypeScript 类型不能替代严格解码和 Unicode 审计；
- Pi 默认 Compaction 必须继续关闭，适配层仍不能暴露 `session.compact()`。

## 备选方案

### 方案 A：应用层传入完整 systemPrompt

最灵活，但任何装配都能替换平台 Harness，低信任内容和能力说明也没有统一校验，无法证明信任层级。

### 方案 B：Prompt Builder 固定 Harness，装配只注入结构化低信任层和真实工具描述

平台规范集中且可版本化；能力清单可从真实注册数组派生；代价是新增能力或信任层必须显式升级 Builder 契约。

### 方案 C：完全依赖 Provider 的 system/user 消息角色

消息角色有帮助，但无法解决租户规范和 Skill 数据在同一 systemPrompt 内的边界，也不能防止能力文案与实际工具漂移。

## 选择

采用方案 B：

1. `prompt-builder` 固定版本化 `PLATFORM_HARNESS`，调用方不能提交或覆盖 Harness 文本。
2. Tenant、Skill、User 内容分别进入 `UNTRUSTED_LAYER`。每项以 JSON 字符串表示，并额外转义 `<`、`>`、`&`，使数据中的分隔符不能产生第二个结构分区。Harness 明确声明这些内容不能新增工具、授权、Tenant 身份或平台规范。
3. `createSafePiSession` 先构造将要传给 Pi 的 `customTools`，再从同一数组的 `name + description + 参数 Schema 规范摘要` 生成 capability manifest 和系统提示。无 Artifact Router 时不出现 Artifact 能力；不存在的 `request_user_input` 等能力不得硬编码。Session 创建后还要逐项核对 Pi 实际活动工具与 manifest，不一致即释放 Session 并失败关闭。
4. 输入只接受普通对象、普通稠密数组、精确字段和固定 `schemaVersion=1`；拒绝访问器、Symbol、非枚举字段、未知字段、附加数组属性、稀疏数组、重复或空 ID。
5. ID 使用有限 ASCII 协议；文本必须非空且为 NFC。除换行外拒绝 Unicode `Cc/Cf/Cs`，覆盖控制字符、Bidi 控制、零宽格式字符和孤立代理项。
6. 所有长度限制以 UTF-8 字节计数，遍历使用 Unicode code point，不做 UTF-16 截断。每项和三层总量分别有固定上限；上限不是可由低信任输入提交的数值。
7. 能力和每层内容按 ID 排序并拒绝重复，manifest 和完整 Prompt 分别计算 SHA-256。输出携带 prompt schema/version、manifest version/digest 和 prompt digest，且深度冻结；相同输入在不同进程中应字节一致。
8. Pi 设置仍固定 `compaction.enabled=false`；Controller 只暴露窄接口，不增加 `compact`，诊断同时公开 Prompt 版本和摘要用于测试与审计。

## 影响

### 正面影响

- 低信任内容无法通过 Builder 获得平台 Harness 的结构位置；
- 模型看到的能力与本次 Session 实际注册工具共享单一来源；
- Prompt 可做 Golden 回归，能力变化和重启重建可通过摘要解释；
- Unicode 审计欺骗和对象结构技巧在进入 Prompt 前失败关闭。

### 负面影响与成本

- 当前平台 Harness 的升级需要版本化代码变更，不能由租户临时覆盖；
- JSON 字符串转义降低少量可读性，但保留完整内容且换取稳定边界；
- 本切片不解决模型对低信任文本的所有语义服从问题，仍需后续 Context Policy、行为测试和最小工具权限共同约束。

### 安全与运维影响

Prompt 摘要可记录用于重建核对，但不得记录完整低信任内容。摘要不是授权凭据，也不能代替 Tool Router 的每次数据库许可。未来增加工具时，必须从实际注册数组进入 manifest，不能只改提示文案。

## 验证

- Golden Prompt 固定 Harness、manifest 和三类低信任分区；
- 注入分隔符、系统消息伪装、控制/Bidi/零宽/孤立代理项、非 NFC、超 UTF-8 上限和结构欺骗均失败关闭；
- 输入重排和进程式重建得到相同摘要，能力增删或同名工具参数 Schema 改变都会改变 manifest 与 Prompt 摘要；
- Pi/Faux 上下文只出现实际 Sandbox 工具，无 `request_user_input`；Artifact Router 存在时才出现 Artifact 工具；
- Pi 诊断继续断言 Compaction disabled、无 compaction entry、Controller 无 `compact`。

## 可逆性与回退

本切片不改变持久 Schema。合并后可回退 Builder 与 Pi 接入代码，但这会重新开放提示/能力漂移风险，应阻断发布而非静默降级。未来 Prompt 结构不兼容时新增 `runtime-system-prompt.v2`；已记录的 v1 摘要继续按 v1 Builder 重建，不原地改变其语义。
