import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalToolTransportError, type ValidatedExternalTarget } from "@hoox/run-contracts";
import {
  McpExternalToolTransport,
  McpStreamableHttpClient,
  probeMcpServer,
  probeMcpEndpoint,
  probeMcpServerReport,
  type McpExchange,
} from "./mcp-client.js";

const servers: Server[] = [];
async function fakeMcp(
  handler: (
    request: Record<string, unknown>,
    authorization: string | undefined,
  ) => {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    raw?: string;
    delayMs?: number;
  },
) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const result = handler(rpc, request.headers.authorization);
    if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    response.writeHead(result.status ?? 200, {
      "content-type": "application/json",
      ...result.headers,
    });
    response.end(
      result.raw ??
        JSON.stringify(
          result.body ?? {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { content: [{ type: "text", text: "ok" }] },
          },
        ),
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server failed");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const target = {
    url,
    hostname: url.hostname,
    servername: url.hostname,
    hostHeader: url.host,
    address: "127.0.0.1",
    addresses: ["127.0.0.1"],
  } as ValidatedExternalTarget;
  const exchange: McpExchange = async (input) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        input.target.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(input.credential ? { authorization: `Bearer ${input.credential}` } : {}),
          },
        },
        (response) => {
          const data: Buffer[] = [];
          response.on("data", (chunk: Buffer) => data.push(chunk));
          response.on("end", () => {
            clearTimeout(timer);
            resolve({
              status: response.statusCode ?? 0,
              contentType: String(response.headers["content-type"]),
              body: Buffer.concat(data),
            });
          });
        },
      );
      const timer = setTimeout(() => request.destroy(new Error("timeout")), input.timeoutMs);
      request.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      request.end(Buffer.from(input.body));
    });
  return { target, exchange };
}
import { request as httpRequest } from "node:http";

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close").catch(() => undefined);
    }),
  );
});

describe("MCP Streamable HTTP transport", () => {
  it("按不可变原始名称调用并只通过 Authorization 头发送凭据", async () => {
    const seen: { name?: unknown; authorization?: string | undefined } = {};
    const { target, exchange } = await fakeMcp((rpc, authorization) => {
      seen.authorization = authorization;
      seen.name = (rpc.params as Record<string, unknown>).name;
      return {
        body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "done" }] } },
      };
    });
    const transport = new McpExternalToolTransport(exchange);
    const result = await transport.invoke({
      tool: {
        source: "mcp",
        remoteToolName: "_lookup",
        toolVersionId: "v1",
        endpoint: target.url.href,
        modelToolName: "mcp__srv__lookup",
        description: "",
        inputSchema: {},
        inputSchemaDigest: "",
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        sideEffect: "read_only",
        idempotent: false,
        credentialRef: "cred",
      },
      target,
      arguments: {},
      credential: "secret-token",
      idempotencyKey: "call-1",
      callContext: { tenantId: "tenant-test", threadId: "thread-test", runId: "run-test" },
      deadlineAt: Date.now() + 1000,
      timeoutMs: 1000,
      maxResponseBytes: 1024,
      redirect: "error",
    });
    expect(seen.name).toBe("_lookup");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(new TextDecoder().decode(result.body)).toBe("done");
    const toolFailure = new McpExternalToolTransport(async () => ({
      status: 200,
      contentType: "application/json",
      body: new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "secret-token" }] },
        }),
      ),
    }));
    const error = await toolFailure
      .invoke({
        tool: {
          source: "mcp",
          remoteToolName: "_lookup",
          toolVersionId: "v1",
          endpoint: target.url.href,
          modelToolName: "mcp__srv__lookup",
          description: "",
          inputSchema: {},
          inputSchemaDigest: "",
          timeoutMs: 1000,
          maxResponseBytes: 1024,
          sideEffect: "read_only",
          idempotent: false,
          credentialRef: "cred",
        },
        target,
        arguments: {},
        credential: "secret-token",
        idempotencyKey: "call-1",
        callContext: { tenantId: "tenant-test", threadId: "thread-test", runId: "run-test" },
        deadlineAt: Date.now() + 1000,
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirect: "error",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExternalToolTransportError);
    expect((error as ExternalToolTransportError).disposition).toBe("responded_failure");
    expect((error as ExternalToolTransportError).safeCode).toBe("EXTERNAL_TOOL_REJECTED");
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("探测执行 initialize 与 tools/list，并拒绝不支持的 Schema", async () => {
    const methods: unknown[] = [];
    const { target, exchange } = await fakeMcp((rpc) => {
      methods.push(rpc.method);
      if (rpc.method === "initialize")
        return {
          body: {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          },
        };
      if (rpc.method === "notifications/initialized") return { body: {} };
      return {
        body: {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            tools: [
              {
                name: "lookup",
                description: "lookup",
                inputSchema: {
                  type: "object",
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            ],
          },
        },
      };
    });
    const tools = await probeMcpServer({
      client: new McpStreamableHttpClient(exchange),
      target,
      serverName: "srv",
      timeoutMs: 1000,
      maxResponseBytes: 1024,
    });
    expect(tools[0]?.remoteToolName).toBe("lookup");
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    const rejected = await fakeMcp((rpc) =>
      rpc.method === "initialize"
        ? {
            body: {
              jsonrpc: "2.0",
              id: rpc.id,
              result: { protocolVersion: "2025-06-18", capabilities: {} },
            },
          }
        : rpc.method === "notifications/initialized"
          ? { body: {} }
          : {
              body: {
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  tools: [
                    {
                      name: "bad",
                      description: "",
                      inputSchema: {
                        type: "object",
                        properties: {},
                        required: [],
                        additionalProperties: false,
                        $ref: "x",
                      },
                    },
                  ],
                },
              },
            },
    );
    await expect(
      probeMcpServer({
        client: new McpStreamableHttpClient(rejected.exchange),
        target: rejected.target,
        serverName: "srv",
        timeoutMs: 1000,
        maxResponseBytes: 1024,
      }),
    ).rejects.toThrow("MCP_SCHEMA_REJECTED");
  });

  it("逐工具报告合规结果与受控 Schema 拒绝原因", async () => {
    const { target, exchange } = await fakeMcp((rpc) =>
      rpc.method === "initialize"
        ? {
            body: {
              jsonrpc: "2.0",
              id: rpc.id,
              result: { protocolVersion: "2025-06-18", capabilities: {} },
            },
          }
        : rpc.method === "notifications/initialized"
          ? { body: {} }
          : {
              body: {
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  tools: [
                    {
                      name: "ok",
                      description: "可用",
                      inputSchema: {
                        type: "object",
                        properties: {},
                        required: [],
                        additionalProperties: false,
                      },
                    },
                    {
                      name: "bad",
                      description: "不合规",
                      inputSchema: {
                        type: "object",
                        properties: {},
                        required: [],
                        additionalProperties: false,
                        $ref: "secret-schema",
                      },
                    },
                  ],
                },
              },
            },
    );
    const report = await probeMcpServerReport({
      client: new McpStreamableHttpClient(exchange),
      target,
      serverName: "srv",
      timeoutMs: 1000,
      maxResponseBytes: 1024,
    });
    expect(report.map(({ accepted }) => accepted)).toEqual([true, false]);
    const rejected = report[1];
    if (!rejected || rejected.accepted) throw new Error("预期第二个工具被拒绝");
    expect(rejected.reasonMessage).toContain("Schema");
    expect(rejected.remoteToolName).toBe("bad");
    expect(JSON.stringify(report)).not.toContain("secret-schema");
  });

  it("以受控错误拒绝协议错误、重定向和响应超限", async () => {
    const { target, exchange } = await fakeMcp(() => ({
      body: { jsonrpc: "2.0", id: 1, error: { code: -1, message: "secret-token" } },
    }));
    const transport = new McpExternalToolTransport(exchange);
    const tool = {
      source: "mcp" as const,
      remoteToolName: "remote",
      toolVersionId: "v1",
      endpoint: target.url.href,
      modelToolName: "mcp__srv__remote",
      description: "",
      inputSchema: {},
      inputSchemaDigest: "",
      timeoutMs: 1000,
      maxResponseBytes: 1024,
      sideEffect: "read_only" as const,
      idempotent: false,
      credentialRef: null,
    };
    const call = (t = target, maxResponseBytes = 1024) =>
      transport.invoke({
        tool,
        target: t,
        arguments: {},
        idempotencyKey: "call",
        callContext: { tenantId: "tenant-test", threadId: "thread-test", runId: "run-test" },
        deadlineAt: Date.now() + 1000,
        timeoutMs: 1000,
        maxResponseBytes,
        redirect: "error",
        credential: "secret-token",
      });
    await expect(call()).rejects.toMatchObject({
      disposition: "responded_failure",
      safeCode: "EXTERNAL_TOOL_REJECTED",
    });
    const redirectServer = await fakeMcp(() => ({
      status: 302,
      headers: { location: "http://example.invalid" },
      raw: "",
    }));
    await expect(
      new McpExternalToolTransport(redirectServer.exchange).invoke({
        tool,
        target: redirectServer.target,
        arguments: {},
        idempotencyKey: "call",
        callContext: { tenantId: "tenant-test", threadId: "thread-test", runId: "run-test" },
        deadlineAt: Date.now() + 1000,
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirect: "error",
      }),
    ).rejects.toMatchObject({
      disposition: "responded_failure",
      safeCode: "EXTERNAL_TOOL_REJECTED",
    });
    const oversized = await fakeMcp(() => ({ raw: "x".repeat(200) }));
    await expect(
      new McpExternalToolTransport(oversized.exchange).invoke({
        tool,
        target: oversized.target,
        arguments: {},
        idempotencyKey: "call",
        callContext: { tenantId: "tenant-test", threadId: "thread-test", runId: "run-test" },
        deadlineAt: Date.now() + 1000,
        timeoutMs: 1000,
        maxResponseBytes: 10,
        redirect: "error",
      }),
    ).rejects.toThrow("EXTERNAL_TOOL_RESULT_UNKNOWN");
  });

  it("向 Transport 传递可信上下文但不序列化，并按响应可知性分类", async () => {
    const target = {
      url: new URL("https://example.invalid/mcp"),
      hostname: "example.invalid",
      servername: "example.invalid",
      hostHeader: "example.invalid",
      address: "8.8.8.8",
      addresses: ["8.8.8.8"],
    } as ValidatedExternalTarget;
    const context = { tenantId: "tenant-secret", threadId: "thread-secret", runId: "run-secret" };
    const deadlineAt = Date.now() + 10_000;
    let observed: { deadlineAt?: number; callContext?: unknown; body?: string } = {};
    const transport = new McpExternalToolTransport(async (input) => {
      observed = {
        deadlineAt: input.deadlineAt,
        callContext: input.callContext,
        body: new TextDecoder().decode(input.body),
      };
      return {
        status: 200,
        contentType: "application/json",
        body: new TextEncoder().encode("not-json"),
      };
    });
    const tool = {
      source: "mcp" as const,
      remoteToolName: "remote",
      toolVersionId: "v1",
      endpoint: target.url.href,
      modelToolName: "mcp__srv__model-name",
      description: "",
      inputSchema: {},
      inputSchemaDigest: "",
      timeoutMs: 1000,
      maxResponseBytes: 1024,
      sideEffect: "read_only" as const,
      idempotent: false,
      credentialRef: null,
    };
    const failure = await transport
      .invoke({
        tool,
        target,
        arguments: {},
        idempotencyKey: "call",
        callContext: context,
        deadlineAt,
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirect: "error",
      })
      .catch((error: unknown) => error);
    expect(observed.deadlineAt).toBe(deadlineAt);
    expect(observed.callContext).toBe(context);
    expect(observed.body).not.toContain("tenant-secret");
    expect(observed.body).not.toContain("thread-secret");
    expect(observed.body).not.toContain("run-secret");
    expect(observed.body).toContain('"name":"remote"');
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("EXTERNAL_TOOL_RESULT_UNKNOWN");

    const serverFailure = new McpExternalToolTransport(async () => ({
      status: 503,
      contentType: "application/json",
      body: new Uint8Array(),
    }));
    await expect(
      serverFailure.invoke({
        tool,
        target,
        arguments: {},
        idempotencyKey: "call",
        callContext: context,
        deadlineAt,
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirect: "error",
      }),
    ).rejects.toThrow("EXTERNAL_TOOL_RESULT_UNKNOWN");
  });

  it("区分写出前超时与写出后超时，错误不包含凭据", async () => {
    const target = {
      url: new URL("https://example.invalid/mcp"),
      hostname: "example.invalid",
      servername: "example.invalid",
      hostHeader: "example.invalid",
      address: "8.8.8.8",
      addresses: ["8.8.8.8"],
    } as ValidatedExternalTarget;
    const tool = {
      source: "mcp" as const,
      remoteToolName: "remote",
      toolVersionId: "v1",
      endpoint: target.url.href,
      modelToolName: "mcp__srv__remote",
      description: "",
      inputSchema: {},
      inputSchemaDigest: "",
      timeoutMs: 10,
      maxResponseBytes: 10,
      sideEffect: "read_only" as const,
      idempotent: false,
      credentialRef: null,
    };
    const before = new McpExternalToolTransport(async () => {
      throw new ExternalToolTransportError("not_sent", "EXTERNAL_TOOL_UNAVAILABLE");
    });
    await expect(
      before.invoke({
        tool,
        target,
        arguments: {},
        idempotencyKey: "1",
        callContext: { tenantId: "tenant-test", threadId: "thread-test", runId: "run-test" },
        deadlineAt: Date.now() + 1000,
        timeoutMs: 10,
        maxResponseBytes: 10,
        redirect: "error",
        credential: "never-log",
      }),
    ).rejects.toBeInstanceOf(ExternalToolTransportError);
    const delayed = await fakeMcp(() => ({ delayMs: 50 }));
    const after = new McpExternalToolTransport(delayed.exchange);
    const failure = await after
      .invoke({
        tool,
        target: delayed.target,
        arguments: {},
        idempotencyKey: "1",
        callContext: { tenantId: "tenant-test", threadId: "thread-test", runId: "run-test" },
        deadlineAt: Date.now() + 1000,
        timeoutMs: 5,
        maxResponseBytes: 1024,
        redirect: "error",
        credential: "never-log",
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("EXTERNAL_TOOL_RESULT_UNKNOWN");
    expect((failure as Error).message).not.toContain("never-log");
  });
});

it("发现重复游标立即停止，不允许空页无限探测", async () => {
  const target = {
    url: new URL("https://example.invalid/"),
    hostname: "example.invalid",
    servername: "example.invalid",
    hostHeader: "example.invalid",
    address: "8.8.8.8",
    addresses: ["8.8.8.8"],
  };
  let calls = 0;
  const client = new McpStreamableHttpClient(async ({ body }) => {
    calls++;
    if (calls > 2) throw new Error("意外的额外请求");
    const { id } = JSON.parse(new TextDecoder().decode(body));
    return {
      status: 200,
      contentType: "application/json",
      body: new TextEncoder().encode(
        JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [], nextCursor: "same" } }),
      ),
    };
  });
  await expect(
    client.listTools(target, { timeoutMs: 1000, maxResponseBytes: 4096 }),
  ).rejects.toBeInstanceOf(ExternalToolTransportError);
  expect(calls).toBe(2);
});

it("默认策略在管理探测建连前拒绝私网及回环目标", async () => {
  for (const endpoint of ["https://127.0.0.1/", "https://[::1]/", "https://10.0.0.4/"]) {
    await expect(
      probeMcpEndpoint({
        endpoint,
        serverName: "srv",
        timeoutMs: 100,
        maxResponseBytes: 1024,
      }),
    ).rejects.toThrow("EXTERNAL_TARGET_REJECTED");
  }
});

it("逐工具检查原始声明：被丢弃的字段也不能反射凭据，拒绝过长或含控制字符的原名", async () => {
  const credential = 'test-only-"marker';
  const target = {
    url: new URL("https://example.invalid/"),
    hostname: "example.invalid",
    servername: "example.invalid",
    hostHeader: "example.invalid",
    address: "8.8.8.8",
    addresses: ["8.8.8.8"],
  };
  const deadlines = new Set<number>();
  const client = new McpStreamableHttpClient(async ({ body, deadlineAt }) => {
    deadlines.add(deadlineAt);
    const { id, method } = JSON.parse(new TextDecoder().decode(body));
    const result =
      method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {} }
        : {
            tools: [
              { name: "lookup", inputSchema: { $ref: credential } },
              { name: "x".repeat(513) },
              { name: "line\nfeed" },
            ],
          };
    return {
      status: 200,
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, result })),
    };
  });
  const report = await probeMcpServerReport({
    client,
    target,
    credential,
    serverName: "srv",
    timeoutMs: 1000,
    maxResponseBytes: 4096,
  });
  expect(report.map((tool) => (tool.accepted ? null : tool.reason))).toEqual([
    "MCP_UNSAFE_METADATA",
    "MCP_TOOL_INVALID",
    "MCP_TOOL_INVALID",
  ]);
  for (const tool of report) expect(tool).not.toHaveProperty("remoteToolName");
  expect(deadlines.size).toBe(1);
});
