import { describe, expect, it } from "vitest";
import {
  createAgentDefinition,
  createAgentRevision,
  deactivateAgentDefinition,
  publishAgentRevision,
  revokeAgentRevision,
  validateAgentRevisionContent,
  validateAgentVersionNotes,
  type AgentRevisionContent,
} from "./agent-definition.js";
import { tenantId } from "./ids.js";
const content: AgentRevisionContent = {
  displayName: "助手",
  description: "默认",
  suggestedQuestions: [],
  operatorInstructions: "用中文回答",
  replyLanguage: "zh-CN",
  model: { mode: "platform_default" },
  tools: {
    mode: "configured",
    builtinTools: ["read"],
    externalTools: [],
    clientTools: [],
    toolCallingMode: "native",
  },
  skillVersions: [],
  includeTenantSkills: true,
  sandboxIdleAction: "pause",
  memory: { mode: "configured", longTermEnabled: false },
};
const configuredTools = content.tools as Extract<
  AgentRevisionContent["tools"],
  { mode: "configured" }
>;
describe("AgentDefinition 领域约束", () => {
  it("版本说明可省略且最多 2000 字符", () => {
    expect(() => validateAgentVersionNotes(undefined)).not.toThrow();
    expect(() => validateAgentVersionNotes("说".repeat(2000))).not.toThrow();
    expect(() => validateAgentVersionNotes("说".repeat(2001))).toThrow("2000 字符");
  });
  it("允许默认 Agent 跟随平台工具设置，也保留显式工具配置", () => {
    expect(
      validateAgentRevisionContent({ ...content, tools: { mode: "platform_default" } }).tools,
    ).toEqual({ mode: "platform_default" });
    expect(validateAgentRevisionContent(content).tools).toMatchObject({
      mode: "configured",
      builtinTools: ["read"],
      toolCallingMode: "native",
    });
  });
  it("校验精确模型 Revision 引用与平台记忆模式", () => {
    expect(
      validateAgentRevisionContent({
        ...content,
        model: {
          mode: "pinned",
          providerKey: "provider_saved",
          providerRevision: 4,
          modelId: "model_saved",
        },
        memory: { mode: "platform_default" },
      }),
    ).toMatchObject({
      model: { providerKey: "provider_saved", providerRevision: 4, modelId: "model_saved" },
      memory: { mode: "platform_default" },
    });
    expect(() =>
      validateAgentRevisionContent({
        ...content,
        model: {
          mode: "pinned",
          providerKey: "provider_saved",
          providerRevision: 0,
          modelId: "model_saved",
        },
      }),
    ).toThrow("模型引用无效");
  });
  it("拒绝 PTC 客户端工具组合并校验客户端等待时限", () => {
    const clientTool = {
      name: "send_order",
      description: "创建订单",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      waitTimeoutMs: 30_000,
    };
    expect(
      validateAgentRevisionContent({
        ...content,
        tools: { ...configuredTools, clientTools: [clientTool] },
      }).tools,
    ).toMatchObject({
      clientTools: [{ ...clientTool, inputSchema: { ...clientTool.inputSchema, required: [] } }],
    });
    expect(() =>
      validateAgentRevisionContent({
        ...content,
        tools: {
          ...configuredTools,
          clientTools: [
            {
              ...clientTool,
              inputSchema: { type: "object", properties: {}, additionalProperties: true },
            },
          ],
        },
      }),
    ).toThrow("封闭对象");
    expect(() =>
      validateAgentRevisionContent({
        ...content,
        tools: { ...configuredTools, clientTools: [clientTool], toolCallingMode: "ptc" },
      }),
    ).toThrow("不支持 PTC 模式与客户端工具同时启用");
    expect(() =>
      validateAgentRevisionContent({
        ...content,
        tools: {
          ...configuredTools,
          clientTools: [{ ...clientTool, waitTimeoutMs: 999 }],
        },
      }),
    ).toThrow("等待时限");
  });
  it("拒绝请求级模板值并验证指令 UTF-8 字节上限", () => {
    expect(() =>
      validateAgentRevisionContent({ ...content, operatorInstructions: "你好 {{user.name}}" }),
    ).toThrow("不得包含模板变量");
    expect(() =>
      validateAgentRevisionContent({ ...content, credential: "secret" } as AgentRevisionContent),
    ).toThrow("未声明字段");
    expect(() =>
      validateAgentRevisionContent({ ...content, operatorInstructions: "é".repeat(16385) }),
    ).toThrow("长度无效");
  });
  it("创建时冻结指定 Tenant 可用范围", () => {
    const ids = [tenantId("tenant_alpha")];
    const definition = createAgentDefinition({
      id: "agent_example",
      status: "draft",
      generation: 0,
      availability: { mode: "selected_tenants", tenantIds: ids },
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
    });
    ids.push(tenantId("tenant_beta"));
    expect(definition.availability).toEqual({
      mode: "selected_tenants",
      tenantIds: [tenantId("tenant_alpha")],
    });
    expect(Object.isFrozen(definition.availability)).toBe(true);
  });
  it("执行发布、停用和撤销的 generation 与当前 Revision 转换", () => {
    const now = "2026-11-19T00:00:00.000Z";
    const definition = createAgentDefinition({
      id: "agent_lifecycle",
      status: "draft",
      generation: 0,
      availability: { mode: "all_tenants" },
      createdAt: now,
      updatedAt: now,
    });
    const revision = createAgentRevision({
      id: "agent_revision_lifecycle",
      definitionId: definition.id,
      revision: 1,
      status: "draft",
      content,
      digest: "a".repeat(64),
      createdAt: now,
      createdBy: "user_manager",
    });
    const published = publishAgentRevision({ definition, revision, expectedGeneration: 0, now });
    expect(published.definition).toMatchObject({
      status: "published",
      generation: 1,
      currentRevisionId: revision.id,
    });
    expect(published.revision.status).toBe("published");
    const disabled = deactivateAgentDefinition({
      definition: published.definition,
      expectedGeneration: 1,
      now,
    });
    expect(disabled).toMatchObject({ status: "disabled", generation: 2 });
    const revoked = revokeAgentRevision({
      definition: published.definition,
      revision: published.revision,
      expectedGeneration: 1,
      now,
    });
    expect(revoked.definition).toMatchObject({ status: "revoked", generation: 2 });
    expect(revoked.revision.status).toBe("revoked");
    expect(() =>
      deactivateAgentDefinition({ definition: published.definition, expectedGeneration: 0, now }),
    ).toThrow("generation 已变化");
  });
});
