import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  agentRevisionChangedSections,
  AgentRevisionContentSchema,
  AgentRevisionDtoSchema,
  CreateAgentDefinitionRequestSchema,
} from "./agent-definition.js";

const content = {
  displayName: "助手",
  description: "测试助手",
  suggestedQuestions: [],
  operatorInstructions: "使用中文回答",
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

describe("AgentDefinition 协议 Schema", () => {
  it("版本差异按配置分区归类且键顺序不影响结果", () => {
    const earlier = { ...content, model: { mode: "platform_default" as const } };
    const current = {
      ...content,
      model: { modelId: "m", mode: "pinned" as const, providerKey: "p", providerRevision: 1 },
      skillVersions: [{ skillId: "skill_one", version: "1.0.0" }],
    };
    expect(agentRevisionChangedSections(current, earlier)).toEqual(["model", "skills"]);
    const reorderedTools = {
      toolCallingMode: "native" as const,
      clientTools: [],
      externalTools: [],
      builtinTools: ["read"],
      mode: "configured" as const,
    };
    expect(agentRevisionChangedSections({ ...earlier, tools: reorderedTools }, earlier)).toEqual(
      [],
    );
  });
  it("校验 Revision 全量内容和创建请求", () => {
    expect(Value.Check(AgentRevisionContentSchema, content)).toBe(true);
    expect(
      Value.Check(CreateAgentDefinitionRequestSchema, {
        id: "agent_valid",
        availability: { mode: "all_tenants" },
        content,
        idempotencyKey: "agent-create-1",
        expectedGeneration: 0,
      }),
    ).toBe(true);
  });
  it("接受跟随平台工具设置及显式工具配置", () => {
    expect(
      Value.Check(AgentRevisionContentSchema, {
        ...content,
        tools: { mode: "platform_default" },
      }),
    ).toBe(true);
    expect(Value.Check(AgentRevisionContentSchema, content)).toBe(true);
    expect(
      Value.Check(AgentRevisionContentSchema, {
        ...content,
        model: {
          mode: "pinned",
          providerKey: "provider_saved",
          providerRevision: 2,
          modelId: "model_saved",
        },
        memory: { mode: "platform_default" },
      }),
    ).toBe(true);
  });
  it("拒绝未声明的 Revision 和请求字段", () => {
    expect(Value.Check(AgentRevisionContentSchema, { ...content, credential: "secret" })).toBe(
      false,
    );
    expect(
      Value.Check(CreateAgentDefinitionRequestSchema, {
        id: "agent_valid",
        availability: { mode: "all_tenants" },
        content,
        idempotencyKey: "agent-create-1",
        expectedGeneration: 0,
        tenantId: "request-scoped-data-must-not-enter-agent-config",
      }),
    ).toBe(false);
  });
  it("版本说明为可选后台元数据并限制 2000 字符", () => {
    expect(Value.Check(AgentRevisionContentSchema, content)).toBe(true);
    expect(
      Value.Check(AgentRevisionDtoSchema, {
        id: "revision_notes",
        definitionId: "agent_valid",
        revision: 1,
        status: "draft",
        content,
        versionNotes: "版本说明",
        digest: "a".repeat(64),
        createdAt: "2026-11-20T00:00:00.000Z",
        createdBy: "user_valid",
      }),
    ).toBe(true);
    expect(
      Value.Check(AgentRevisionDtoSchema, {
        id: "revision_notes",
        definitionId: "agent_valid",
        revision: 1,
        status: "draft",
        content,
        versionNotes: "说".repeat(2001),
        digest: "a".repeat(64),
        createdAt: "2026-11-20T00:00:00.000Z",
        createdBy: "user_valid",
      }),
    ).toBe(false);
  });
});
