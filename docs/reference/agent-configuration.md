# Agent 配置文件

本文面向通过管理页面或后台接口迁移 Agent 的平台管理员和自动化客户端，定义当前 YAML 文件字段、引用边界和导入导出行为。当前 Revision 字段以共享协议 `AgentRevisionContentSchema` 为准。

## 文件格式

文件使用 UTF-8 YAML 1.2，恰好包含一个文档，最大 1 MiB。自定义 Tag、别名、重复键和超过 64 层或 100,000 个节点的结构会被拒绝。未知字段、字段值越界、非法引用和未知 `schemaVersion` 均返回带 JSON Pointer 风格路径的校验错误。

| 路径 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 整数，固定为 `1` | 配置文件格式版本，与 Agent Revision 版本无关。 |
| `definition.id` | Agent ID | 新建 Definition 时的 ID；导入新 Definition 时不能与现有 ID 冲突。 |
| `definition.availability` | `all_tenants` 或 `selected_tenants` | Definition 可用范围；Tenant ID 必须已存在。 |
| `revision.content.displayName` | 字符串，1–200 字符 | Agent 展示名称。 |
| `revision.content.description` | 字符串，最多 2048 字符 | Agent 简介。 |
| `revision.content.avatarRef` | 可选字符串，最多 512 字符 | 展示头像引用。 |
| `revision.content.welcomeMessage` | 可选字符串，最多 2048 字符 | Thread 欢迎语。 |
| `revision.content.suggestedQuestions` | 字符串数组，最多 12 项；每项 1–500 字符 | 展示给终端用户的问题建议。 |
| `revision.content.operatorInstructions` | 字符串，1–32768 UTF-8 字节 | 平台管理员提供的 Agent 指令。 |
| `revision.content.replyLanguage` | 字符串，1–100 字符 | 回复语言要求。 |
| `revision.content.model` | `platform_default` 或 `pinned` | 固定模型时使用已保存模型版本引用，不能内嵌凭据。 |
| `revision.content.tools` | `platform_default` 或 `configured` | 内置工具、已发布 MCP/HTTP 工具版本、客户端工具声明和调用模式。 |
| `revision.content.skillVersions` | 最多 64 个版本引用 | Agent 自带 Skill 的精确 `skillId` 与版本。 |
| `revision.content.includeTenantSkills` | 布尔值 | 是否叠加 Tenant 已安装 Skill。 |
| `revision.content.sandboxTemplateId` | 可选 ID | Sandbox 模板引用。 |
| `revision.content.sandboxIdleAction` | `pause` 或 `kill` | Sandbox 空闲策略。 |
| `revision.content.memory` | `platform_default` 或 `configured` | 平台默认长期记忆策略或显式开关。 |
| `revision.versionNotes` | 可选字符串，最多 2000 字符 | 后台版本说明，不会进入模型上下文。 |

固定模型的 `pinned` 字段为 `providerKey`、正整数 `providerRevision` 和 `modelId`。`configured` 工具配置字段为 `builtinTools`（最多 64 个唯一名称）、`externalTools`（最多 64 个 `{kind, versionId}` 引用）、`clientTools`（最多 64 个名称、描述、JSON Schema 和可选等待时限）以及 `toolCallingMode`（`native` 或 `ptc`）。等待时限为 1000–86400000 毫秒。当前 AgentRevision Schema 尚未定义评测发布门槛字段；若评测模块将门槛持久化到 Revision，配置格式和往返测试需与该契约同步。

示例只使用公开引用和占位信息，不包含任何秘密：

```yaml
schemaVersion: 1
definition:
  id: agent_example
  availability:
    mode: all_tenants
revision:
  content:
    displayName: 示例助手
    description: 面向示例业务的助手
    suggestedQuestions:
      - 如何开始？
    operatorInstructions: 使用中文回答，并在不确定时说明限制。
    replyLanguage: zh-CN
    model:
      mode: pinned
      providerKey: provider_example
      providerRevision: 1
      modelId: example-model
    tools:
      mode: configured
      builtinTools:
        - read
      externalTools:
        - kind: http
          versionId: tool_version_example
      clientTools: []
      toolCallingMode: native
    skillVersions:
      - skillId: skill_example
        version: 1.0.0
    includeTenantSkills: false
    sandboxIdleAction: pause
    memory:
      mode: platform_default
  versionNotes: 初始配置
```

`model` 只包含平台已保存的 `providerKey + providerRevision + modelId` 引用；`externalTools` 只包含类型和已发布 `versionId`；Skill 使用 `skillId + version`。API Key、MCP/HTTP Header、凭据密文及其明文均不属于文件 Schema。导出不会读取或回显这些秘密。导入时模型、外部工具和 Tenant 引用必须仍然有效；不匹配或已撤销的引用会被拒绝。导出使用稳定字段序和格式，同一配置再次序列化得到字节相同的 YAML。

## 管理接口

所有接口沿用 AgentDefinition 管理权限。请求需要管理会话或后台服务凭据、JSON 内容类型；写入接口需要 `Idempotency-Key`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /v1/admin/control/agent-definitions/{definitionId}/revisions/{revisionId}/export` | 导出该 Revision 为 `application/yaml` 附件；写入导出审计。 |
| `POST /v1/admin/control/agent-definitions/import` | 校验或新建 Definition 草稿及其首个 Revision。 |
| `POST /v1/admin/control/agent-definitions/{definitionId}/import` | 校验或向现有 Definition 追加草稿 Revision。 |

导入请求 JSON：

```json
{
  "yaml": "schemaVersion: 1\n...",
  "dryRun": true,
  "expectedGeneration": 3
}
```

`expectedGeneration` 对新 Definition 可省略或为 `0`；向已有 Definition 追加时必填。文件中的 Definition ID 与可用范围必须和目标一致。`dryRun: true` 校验格式、管理权限、Agent ID/目标状态、模型凭据引用和外部工具版本，不创建草稿、不写导入审计。`selected_tenants` 中 Tenant ID 是否仍存在由数据库外键在实际导入事务中确认；为避免越过 Tenant RLS，dry-run 不直接探测 Tenant 表。校验成功返回 `data.valid: true`；失败返回 `data.valid: false` 和带 `path`、`code`、`message` 的 `errors`。实际导入将 `dryRun` 设为 `false`，成功响应包含新草稿；已发布 Revision 不变，导入不会自动发布。实际失败以 `400` 和 `validationErrors` 返回结构化字段错误。
