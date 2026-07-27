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

### 方案 B：Prompt Builder 固定 Harness，低信任内容使用受控 custom/user 消息

平台规范集中且可版本化，低信任内容不占用 system role；能力清单可从真实注册数组派生。代价是新增能力或来源类型必须显式升级 Builder 契约和 Session 投影。

### 方案 C：完全依赖 Provider 的 system/user 消息角色

消息角色有帮助，但若没有来源元数据、严格解码和能力核对，仍不能防止内部 ID 泄漏、结构欺骗和工具文案漂移。

## 选择

采用方案 B：

1. `prompt-builder` 固定版本化 `PLATFORM_HARNESS`，调用方不能提交或覆盖 Harness 文本。
2. system role 只包含固定 Harness 与本 Session 实际 capability manifest。Tenant、Skill、User 每项分别写为 `runtime.untrusted_context.v1` CustomMessage；Pi 将其转换成 Provider 的 user 消息。Session Entry 的受控 `details` 只保存来源类型、公开 alias、局部序号和内容摘要；模型可见 content 同样只出现公开 alias/局部序号和 JSON 字符串。内部 ID 只用于排序和完整投影摘要，不进入 system、custom content 或来源元数据。`<`、`>`、`&` 额外转义，数据不能产生第二个结构分区。
3. Harness 准确区分两类效果：`sandbox_*` 只操作隔离 CubeSandbox，文件协议继续接受 Sandbox 内绝对路径；Artifact 工具若实际注册，则经 Tool Router、执行许可和业务校验固定 ResourceVersion、发布不可变交付物。不得笼统声称所有工具只作用于 `/workspace`。
4. `createSafePiSession` 先从将要传给 Pi 的 `customTools` 的 `name + description + 参数 Schema 规范摘要` 生成 capability manifest。无 Artifact Router 时不出现 Artifact 能力；不存在的 `request_user_input` 等能力不得硬编码。Session 创建后必须重新读取 `session.agent.state.tools`，对三项完整重算并逐项比较；任何差异都先释放 Session 再失败关闭。
5. Prompt 输入只接受普通对象、普通稠密数组、精确字段和固定 `schemaVersion=1`；通过 `node:util.types.isProxy` 在读取原型或描述符前拒绝根与任意嵌套 Proxy，并拒绝访问器、Symbol、非枚举字段、未知字段、附加数组属性、稀疏数组、重复或空 ID。
6. Tool 参数 Schema 使用独立、基于 property descriptor 的规范化器，递归拒绝 Proxy、getter/accessor、非普通对象、稀疏/附加字段数组、循环、非有限数值和未知 Symbol/非枚举字段。只白名单兼容 TypeBox 历史协议的 `Symbol.for("TypeBox.Kind")`、`Symbol.for("TypeBox.Transform")`，以及当前固定版本使用的非枚举 `~kind`、`~optional`、`~readonly`；这些标记必须具有约定的字符串/布尔值，且不进入 Provider JSON 和 Schema 摘要。
7. ID 使用有限 ASCII 协议；文本必须非空且为 NFC。除换行外拒绝 Unicode `Cc/Cf/Cs`，并额外拒绝 U+034F、Hangul/中日韩不可见填充、FE00–FE0D 和补充 Variation Selectors 等审计欺骗字符。FE0E/FE0F 明确保留，避免破坏常用 emoji 的文本/彩色呈现。
8. 所有长度限制以 UTF-8 字节计数，遍历使用 Unicode code point，不做 UTF-16 截断。每项和三层总量分别有固定上限；上限不是可由低信任输入提交的数值。
9. 能力和每层内容按内部 ID 排序并拒绝重复；内部 ID 只参与排序、受控元数据和完整投影摘要。manifest 与“systemPrompt + custom context entries”分别计算 SHA-256。输出携带 prompt schema/version、manifest version/digest 和 prompt digest，且深度冻结；相同输入在不同进程中应字节一致。
10. Pi 设置仍固定 `compaction.enabled=false`；Controller 只暴露窄接口，不增加 `compact`，诊断同时公开 Prompt 版本和摘要用于测试与审计。

## 影响

### 正面影响

- 低信任内容不进入 system role，无法通过 Builder 获得平台 Harness 的结构位置；
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

- Golden Prompt 固定仅含 Harness 与 manifest 的 system，并固定三类低信任 custom/user context；攻击文本与内部来源 ID 不出现在 system 和模型可见元数据中；
- 注入分隔符、系统消息伪装、控制/Bidi/U+034F/受限 Variation Selector/零宽/孤立代理项、非 NFC、超 UTF-8 上限和结构欺骗均失败关闭，常用 FE0F emoji 正常保留；
- Prompt 根/嵌套 Proxy 和工具 Schema 根/嵌套 Proxy、访问器、稀疏数组、未知 Symbol/非枚举元数据均在读取内容前失败关闭；TypeBox 明确白名单的 Symbol 与非枚举标记不改变 Provider JSON 摘要；
- 输入重排和进程式重建得到相同摘要，能力增删或同名工具参数 Schema 改变都会改变 manifest 与 Prompt 摘要；
- Linux Pi/Faux 上下文证明低信任内容位于 user 消息而非 system；能力只出现实际 Sandbox 工具，无 `request_user_input`，Artifact Router 存在时才出现 Artifact 工具；
- 独立 Node 24 Linux 容器在无网络运行阶段执行 Prompt Builder、Pi Session、Artifact Faux 与 Worker PiFactory 测试，并验证镜像测试进程不是 root；
- Pi 诊断继续断言 Compaction disabled、无 compaction entry、Controller 无 `compact`。

## 可逆性与回退

本切片不改变持久 Schema。合并后可回退 Builder 与 Pi 接入代码，但这会重新开放提示/能力漂移风险，应阻断发布而非静默降级。未来 Prompt 结构不兼容时新增 `runtime-system-prompt.v2`；已记录的 v1 摘要继续按 v1 Builder 重建，不原地改变其语义。
