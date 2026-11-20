import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  AgentRevisionContentSchema,
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
  longTermMemoryEnabled: false,
};

describe("AgentDefinition 协议 Schema", () => {
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
});
