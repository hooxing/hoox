import { describe, expect, it } from "vitest";
import {
  AGENT_CONFIGURATION_MAX_BYTES,
  AgentConfigurationError,
  parseAgentConfiguration,
  serializeAgentConfiguration,
} from "./agent-configuration.js";

const configuration = {
  schemaVersion: 1 as const,
  definition: { id: "agent_example", availability: { mode: "all_tenants" as const } },
  revision: {
    content: {
      displayName: "示例 Agent",
      description: "配置示例",
      suggestedQuestions: ["如何开始？"],
      operatorInstructions: "使用中文回答。",
      replyLanguage: "zh-CN",
      model: { mode: "platform_default" as const },
      tools: { mode: "platform_default" as const },
      skillVersions: [],
      includeTenantSkills: false,
      sandboxIdleAction: "pause" as const,
      memory: { mode: "platform_default" as const },
    },
    versionNotes: "初始导入",
  },
};

function errors(source: string) {
  try {
    parseAgentConfiguration(source);
  } catch (error) {
    if (error instanceof AgentConfigurationError) return error.errors;
    throw error;
  }
  throw new Error("配置应当无效");
}

describe("Agent YAML 配置文件", () => {
  it("规范化序列化并往返保持字节稳定", () => {
    const yaml = serializeAgentConfiguration(configuration);
    expect(serializeAgentConfiguration(parseAgentConfiguration(yaml))).toBe(yaml);
    expect(yaml.startsWith("schemaVersion: 1\n")).toBe(true);
  });

  it("只导出引用和配置，不会夹带秘密字段或值", () => {
    const yaml = serializeAgentConfiguration(configuration);
    expect(yaml).not.toContain("apiKey");
    expect(yaml).not.toContain("secret");
    expect(yaml).not.toContain("credentialValue");
  });

  it("为未知版本、字段和超长配置返回路径化错误", () => {
    expect(errors("schemaVersion: 2\ndefinition: {}\nrevision: {}\n")[0]).toMatchObject({
      path: "/schemaVersion",
      code: "UNKNOWN_SCHEMA_VERSION",
    });
    const unknown = errors(`${serializeAgentConfiguration(configuration)}unknown: true\n`);
    expect(unknown).toContainEqual(expect.objectContaining({ code: "UNKNOWN_FIELD" }));
    expect(errors("x".repeat(AGENT_CONFIGURATION_MAX_BYTES + 1))[0]).toMatchObject({
      code: "DOCUMENT_TOO_LARGE",
    });
  });

  it("拒绝别名、自定义标签和多个 YAML 文档", () => {
    expect(errors("a: &a [x]\nb: *a\n")[0]?.code).toBe("YAML_ALIAS_NOT_ALLOWED");
    expect(errors("x: !custom secret\n")[0]?.code).toBe("YAML_TAG_NOT_ALLOWED");
    expect(errors("a: 1\n---\nb: 2\n")[0]?.code).toBe("INVALID_YAML");
  });
});
