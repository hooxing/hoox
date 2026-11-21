import { describe, expect, it, vi } from "vitest";
import { normalizeExternalToolSchema, type ExternalToolVersion } from "@hoox/domain";
import type { ExternalToolTransport } from "@hoox/run-contracts";
import { McpExternalToolTransport, type McpExchange } from "@hoox/tool-router";
import { createExternalToolFactory } from "./external-tool-factory.js";
const s = normalizeExternalToolSchema({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});
const make = (name: string): ExternalToolVersion => ({
  toolVersionId: name,
  source: "http",
  httpMethod: "POST",
  endpoint: "https://8.8.8.8/api",
  modelToolName: name,
  description: "tool",
  inputSchema: s.schema,
  inputSchemaDigest: s.digest,
  timeoutMs: 1000,
  maxResponseBytes: 32,
  sideEffect: "read_only",
  idempotent: false,
  credentialRef: null,
});
describe("外部工具 Pi 工厂", () => {
  it("按快照名称排序，不接入 Session", () => {
    const create = createExternalToolFactory({
      getCallContext: () => ({
        tenantId: "tenant-fake",
        threadId: "thread-fake",
        runId: "run-fake",
      }),
      persistStarted: async () => {},
      authorizeAndConsume: async ({ toolVersionId }) => ({ permit: { toolVersionId } }),
      transport: { invoke: async () => ({ body: new Uint8Array(), contentType: "text/plain" }) },
      recordReceipt: async () => {},
      requireRecovery: async () => {},
    });
    const first = create([{ tool: make("http__z") }, { tool: make("http__a") }]);
    const reversed = create([{ tool: make("http__a") }, { tool: make("http__z") }]);
    expect(first.map((tool) => tool.name)).toEqual(["http__a", "http__z"]);
    expect(
      first.map((tool) =>
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
      ),
    ).toEqual(
      reversed.map((tool) =>
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
      ),
    );
  });
  describe.each(["base64", "hex", "URL"] as const)("MCP %s 凭据回显", (encoding) => {
    it.each(["content", "structuredContent"] as const)("%s 只返回固定回执", async (resultKind) => {
      const credential = 'placeholder-credential+/="\\\n\t';
      const echo = {
        base64: Buffer.from(credential).toString("base64"),
        hex: Buffer.from(credential).toString("hex"),
        URL: encodeURIComponent(credential),
      }[encoding];
      const exchange = vi.fn<McpExchange>(async () => ({
        status: 200,
        contentType: "application/json",
        body: new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result:
              resultKind === "content"
                ? { content: [{ type: "text", text: `不可信业务正文：${echo}` }] }
                : { structuredContent: { value: "不可信业务正文", echo } },
          }),
        ),
      }));
      const authorizeAndConsume = vi.fn(
        async ({ toolVersionId }: { readonly toolVersionId: string }) => ({
          permit: { toolVersionId },
        }),
      );
      const recordReceipt = vi.fn(async () => {});
      const requireRecovery = vi.fn();
      const create = createExternalToolFactory({
        getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
        persistStarted: async () => {},
        authorizeAndConsume,
        transport: new McpExternalToolTransport(exchange),
        recordReceipt,
        requireRecovery,
      });
      const { httpMethod: _httpMethod, ...tool } = make("mcp__server__lookup");
      const [agentTool] = create([
        {
          tool: {
            ...tool,
            source: "mcp",
            remoteToolName: "_lookup",
            credentialRef: "placeholder-credential-ref",
            maxResponseBytes: 2048,
          },
          credential,
        },
      ]);
      if (!agentTool) throw new Error("测试工具未生成");
      const result = await agentTool.execute("encoded-mcp", {});
      expect(result).toEqual({
        content: [{ type: "text", text: "外部工具调用已成功，响应正文未向模型公开。" }],
        details: { truncated: false },
      });
      expect(exchange).toHaveBeenCalledOnce();
      expect(exchange.mock.calls[0]?.[0]).toMatchObject({
        credential,
        idempotencyKey: "encoded-mcp",
      });
      expect(authorizeAndConsume).toHaveBeenCalledExactlyOnceWith({
        callId: "encoded-mcp",
        toolName: tool.modelToolName,
        toolVersionId: tool.toolVersionId,
        argsDigest: expect.any(String),
      });
      expect(recordReceipt).toHaveBeenCalledOnce();
      expect(requireRecovery).not.toHaveBeenCalled();
      expect(JSON.stringify(agentTool.parameters)).not.toContain(credential);
    });
  });
  it.each(["GET", "POST"] as const)(
    "HTTP %s 方法和凭据只取固定快照，不投影服务端正文",
    async (method) => {
      const credential = "placeholder-http-credential";
      const tool = {
        ...make("http__lookup"),
        httpMethod: method,
        credentialRef: "placeholder-credential-ref",
        maxResponseBytes: 1024,
      };
      const invoke = vi.fn<ExternalToolTransport["invoke"]>(async () => ({
        body: new TextEncoder().encode(
          JSON.stringify({ echo: Buffer.from(credential).toString("hex") }),
        ),
        contentType: "application/json",
      }));
      const create = createExternalToolFactory({
        getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
        persistStarted: async () => {},
        authorizeAndConsume: async ({ toolVersionId }) => ({ permit: { toolVersionId } }),
        transport: { invoke },
        recordReceipt: async () => {},
        requireRecovery: async () => {},
      });
      const [agentTool] = create([{ tool, credential }]);
      if (!agentTool) throw new Error("测试工具未生成");
      expect((await agentTool.execute("http-bound-method", {})).content).toEqual([
        { type: "text", text: "外部工具调用已成功，响应正文未向模型公开。" },
      ]);
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke.mock.calls[0]?.[0]).toMatchObject({ tool, credential, method });
    },
  );
  it("无凭据快照继续投影有界正文，并隐藏本次认证材料", async () => {
    const signature = "f".repeat(64);
    const timestamp = "1790000000000";
    const create = createExternalToolFactory({
      getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
      persistStarted: async () => {},
      authorizeAndConsume: async ({ toolVersionId }) => ({ permit: { toolVersionId } }),
      transport: {
        invoke: async () => ({
          body: new TextEncoder().encode(
            `sig=${signature} ts=${timestamp} value=${"中".repeat(100)}`,
          ),
          contentType: "text/plain",
          authMaterial: [signature, timestamp],
        }),
      },
      recordReceipt: async () => {},
      requireRecovery: async () => {},
      maxModelVisibleBytes: 96,
    });
    const [agentTool] = create([{ tool: { ...make("http__lookup"), maxResponseBytes: 1024 } }]);
    if (!agentTool) throw new Error("测试工具未生成");
    const result = await agentTool.execute("no-credential", {});
    const visible = (result.content[0] as { readonly text: string }).text;
    expect(visible).toContain("sig=[凭据已隐藏] ts=[凭据已隐藏] value=");
    expect(visible).not.toContain(signature);
    expect(visible).not.toContain(timestamp);
    expect(new TextEncoder().encode(visible).byteLength).toBeLessThanOrEqual(96);
    expect(result.details).toEqual({ truncated: true });
  });
  it("DNS 等待期间撤销先完成，最终消费失败原样透传且不调用 Transport", async () => {
    const dnsStarted = Promise.withResolvers<void>();
    const dns = Promise.withResolvers<readonly string[]>();
    let revoked = false;
    const denied = new Error("EXTERNAL_TOOL_REVOKED");
    const invoke = vi.fn();
    const requireRecovery = vi.fn();
    const authorizeAndConsume = vi.fn(
      async ({ toolVersionId }: { readonly toolVersionId: string }) => {
        if (revoked) throw denied;
        return { permit: { toolVersionId } };
      },
    );
    const create = createExternalToolFactory({
      getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
      persistStarted: async () => {},
      resolveAddresses: () => {
        dnsStarted.resolve();
        return dns.promise;
      },
      authorizeAndConsume,
      transport: { invoke },
      recordReceipt: async () => {},
      requireRecovery,
    });
    const tool = {
      ...make("http__lookup"),
      endpoint: "https://tools.example/api",
      sideEffect: "write" as const,
    };
    const [agentTool] = create([{ tool }]);
    if (!agentTool) throw new Error("测试工具未生成");
    const execution = agentTool.execute("revoked-before-consume", {});
    await dnsStarted.promise;
    expect(authorizeAndConsume).not.toHaveBeenCalled();
    revoked = true;
    dns.resolve(["8.8.8.8"]);
    await expect(execution).rejects.toBe(denied);
    expect(authorizeAndConsume).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(requireRecovery).not.toHaveBeenCalled();
  });
  it.each([undefined, "other-version"])(
    "拒绝许可中缺失或不匹配的版本：%s",
    async (toolVersionId) => {
      const invoke = vi.fn();
      const requireRecovery = vi.fn();
      const create = createExternalToolFactory({
        getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
        persistStarted: async () => {},
        authorizeAndConsume: async () => ({
          permit: toolVersionId === undefined ? {} : { toolVersionId },
        }),
        transport: { invoke },
        recordReceipt: async () => {},
        requireRecovery,
      });
      const [agentTool] = create([{ tool: make("http__lookup") }]);
      if (!agentTool) throw new Error("测试工具未生成");
      await expect(agentTool.execute("wrong-version", {})).rejects.toThrow(
        "EXTERNAL_EFFECT_NOT_AUTHORIZED",
      );
      expect(invoke).not.toHaveBeenCalled();
      expect(requireRecovery).not.toHaveBeenCalled();
    },
  );
  it("同一调用的一次性许可已经消费时，显式重复执行也不重放请求", async () => {
    let consumed = false;
    const invoke = vi.fn(async () => ({ body: new Uint8Array(), contentType: "" }));
    const requireRecovery = vi.fn();
    const authorizeAndConsume = vi.fn(
      async ({ toolVersionId }: { readonly toolVersionId: string }) => {
        if (consumed) throw new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
        consumed = true;
        return { permit: { toolVersionId } };
      },
    );
    const create = createExternalToolFactory({
      getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
      persistStarted: async () => {},
      authorizeAndConsume,
      transport: { invoke },
      recordReceipt: async () => {},
      requireRecovery,
    });
    const [agentTool] = create([{ tool: make("http__lookup") }]);
    if (!agentTool) throw new Error("测试工具未生成");
    await agentTool.execute("single-use", {});
    await expect(agentTool.execute("single-use", {})).rejects.toThrow(
      "EXTERNAL_EFFECT_NOT_AUTHORIZED",
    );
    expect(authorizeAndConsume).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledOnce();
    expect(requireRecovery).not.toHaveBeenCalled();
  });
  it("写出后结果未知阻止后续调用，不重新消费许可或自动重放", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("placeholder-transport-disconnected");
    });
    const requireRecovery = vi.fn(async () => {});
    const authorizeAndConsume = vi.fn(
      async ({ toolVersionId }: { readonly toolVersionId: string }) => ({
        permit: { toolVersionId },
      }),
    );
    const create = createExternalToolFactory({
      getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
      persistStarted: async () => {},
      authorizeAndConsume,
      transport: { invoke },
      recordReceipt: async () => {},
      requireRecovery,
    });
    const [agentTool] = create([{ tool: make("http__lookup") }]);
    if (!agentTool) throw new Error("测试工具未生成");
    await expect(agentTool.execute("unknown", {})).rejects.toThrow("EXTERNAL_TOOL_RESULT_UNKNOWN");
    await expect(agentTool.execute("unknown", {})).rejects.toThrow(
      "EXTERNAL_TOOL_RECOVERY_REQUIRED",
    );
    await expect(agentTool.execute("another-call", {})).rejects.toThrow(
      "EXTERNAL_TOOL_RECOVERY_REQUIRED",
    );
    expect(authorizeAndConsume).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    expect(requireRecovery).toHaveBeenCalledExactlyOnceWith({
      callId: "unknown",
      code: "EXTERNAL_TOOL_RESULT_UNKNOWN",
    });
  });
});
