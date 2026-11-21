import { describe, expect, it } from "vitest";
import {
  EXTERNAL_TOOL_LIMITS,
  normalizeExternalToolName,
  normalizeExternalToolSchema,
  validateExternalToolVersion,
} from "./external-tool.js";

describe("外部工具领域契约", () => {
  it("MCP 原始工具名必填，HTTP 版本不得绑定远程 MCP 名称", () => {
    const schema = normalizeExternalToolSchema({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    const base = {
      toolVersionId: "version-1",
      endpoint: "https://tools.example/mcp",
      modelToolName: "mcp__server__lookup",
      description: "lookup",
      inputSchema: schema.schema,
      inputSchemaDigest: schema.digest,
      timeoutMs: 5000,
      maxResponseBytes: 4096,
      sideEffect: "read_only" as const,
      idempotent: false,
      credentialRef: null,
    };
    expect(() => validateExternalToolVersion({ ...base, source: "mcp" })).toThrow(
      "EXTERNAL_TOOL_REMOTE_NAME_REQUIRED",
    );
    expect(() =>
      validateExternalToolVersion({
        ...base,
        source: "http",
        httpMethod: "POST",
        modelToolName: "http__lookup",
        remoteToolName: "lookup",
      }),
    ).toThrow("EXTERNAL_TOOL_REMOTE_NAME_SOURCE_MISMATCH");
    expect(
      validateExternalToolVersion({ ...base, source: "mcp", remoteToolName: "_lookup" })
        .remoteToolName,
    ).toBe("_lookup");
  });
  it("规范化稳定排序属性和枚举并摘要", () => {
    const a = normalizeExternalToolSchema({
      type: "object",
      additionalProperties: false,
      properties: { z: { type: "string" }, a: { type: "integer", enum: [2, 1] } },
      required: ["z"],
    });
    const b = normalizeExternalToolSchema({
      type: "object",
      required: ["z"],
      properties: { a: { enum: [1, 2], type: "integer" }, z: { type: "string" } },
      additionalProperties: false,
    });
    expect(a.digest).toBe(b.digest);
    expect(Object.isFrozen(a.schema)).toBe(true);
    expect(Object.isFrozen((a.schema.properties as Record<string, unknown>).a)).toBe(true);
  });
  it.each(["$ref", "oneOf", "anyOf", "not", "mystery"])("拒绝关键字 %s", (key) => {
    expect(() =>
      normalizeExternalToolSchema({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
        [key]: {},
      }),
    ).toThrow();
  });
  it("拒绝与声明类型冲突的 enum", () => {
    expect(() =>
      normalizeExternalToolSchema({
        type: "object",
        properties: { x: { type: "string", enum: [1] } },
        required: [],
        additionalProperties: false,
      }),
    ).toThrow("EXTERNAL_TOOL_SCHEMA_ENUM_TYPE_MISMATCH");
  });
  it("接受受控的基础类型、数组、嵌套对象与 enum", () => {
    const normalized = normalizeExternalToolSchema({
      type: "object",
      properties: {
        text: { type: "string", enum: ["a", "b"] },
        number: { type: "number" },
        integer: { type: "integer" },
        flag: { type: "boolean" },
        list: { type: "array", items: { type: "string" } },
        nested: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
      required: ["text"],
      additionalProperties: false,
    });
    expect(Object.keys(normalized.schema.properties as object)).toHaveLength(6);
  });
  it("拒绝递归 Schema", () => {
    const recursive: Record<string, unknown> = {
      type: "object",
      required: [],
      additionalProperties: false,
    };
    recursive.properties = { child: recursive };
    expect(() => normalizeExternalToolSchema(recursive)).toThrow("EXTERNAL_TOOL_SCHEMA_INVALID");
  });
  it("拒绝超过规范化 Schema 字节上限的定义", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `field_${index}`,
        { type: "string", description: "x".repeat(2000) },
      ]),
    );
    expect(() =>
      normalizeExternalToolSchema({
        type: "object",
        properties,
        required: [],
        additionalProperties: false,
      }),
    ).toThrow("EXTERNAL_TOOL_SCHEMA_INVALID");
  });
  it("拒绝开放对象与超过结构容量的定义", () => {
    expect(() => normalizeExternalToolSchema({ type: "object", properties: {} })).toThrow();
    expect(EXTERNAL_TOOL_LIMITS.maxTools).toBe(64);
  });
  it("组合名称符合两个消费者且超长输入被安全收敛", () => {
    expect(normalizeExternalToolName("mcp", "my server", "a tool")).toBe("mcp__my_server__a_tool");
    expect(normalizeExternalToolName("http", "unused", "hello")).toBe("http__hello");
    expect(normalizeExternalToolName("mcp", "s", "x".repeat(300)).length).toBeLessThanOrEqual(128);
  });
});
