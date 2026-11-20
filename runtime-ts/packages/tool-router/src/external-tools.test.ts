import { describe, expect, it, vi } from "vitest";
import { normalizeExternalToolSchema, type ExternalToolVersion } from "@hoox/domain";
import { ExternalToolTransportError } from "@hoox/run-contracts";
import {
  createExternalToolAgentTool,
  externalTargetConnection,
  validateExternalHttpsTarget,
  validateExternalToolArguments,
} from "./external-tools.js";

const normalized = normalizeExternalToolSchema({
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
});
const toolVersion: ExternalToolVersion = {
  toolVersionId: "tv1",
  source: "http",
  endpoint: "https://8.8.8.8/api",
  modelToolName: "http__lookup",
  description: "查找记录",
  inputSchema: normalized.schema,
  inputSchemaDigest: normalized.digest,
  timeoutMs: 1000,
  maxResponseBytes: 1024,
  sideEffect: "read_only",
  idempotent: true,
  credentialRef: null,
};

describe("外部工具运行骨架", () => {
  it("拒绝私网 IP 和 DNS 解析到私网的目标，并允许部署开关", async () => {
    await expect(validateExternalHttpsTarget("https://127.0.0.1/a")).rejects.toThrow(
      "EXTERNAL_TARGET_REJECTED",
    );
    await expect(
      validateExternalHttpsTarget("https://public.example", {
        resolve: async () => ["8.8.8.8", "10.0.0.4"],
      }),
    ).rejects.toThrow("EXTERNAL_TARGET_REJECTED");
    await expect(validateExternalHttpsTarget("https://[fd00::1]")).rejects.toThrow(
      "EXTERNAL_TARGET_REJECTED",
    );
    await expect(validateExternalHttpsTarget("https://[fe80::1]")).rejects.toThrow(
      "EXTERNAL_TARGET_REJECTED",
    );
    await expect(
      validateExternalHttpsTarget("https://[fd00::1]", { allowPrivate: true }),
    ).resolves.toHaveProperty("addresses", ["fd00::1"]);
    await expect(validateExternalHttpsTarget("http://public.example")).rejects.toThrow(
      "EXTERNAL_TARGET_REJECTED",
    );
  });
  it("逐次解析后校验 DNS，检测从公网变为回环地址的重绑定", async () => {
    const answers = [["8.8.8.8"], ["::1"]];
    const resolve = async () => answers.shift() ?? [];
    await expect(
      validateExternalHttpsTarget("https://rebind.example", { resolve }),
    ).resolves.toHaveProperty("addresses", ["8.8.8.8"]);
    await expect(
      validateExternalHttpsTarget("https://rebind.example", { resolve }),
    ).rejects.toThrow("EXTERNAL_TARGET_REJECTED");
    await expect(validateExternalHttpsTarget("https://[::ffff:127.0.0.1]")).rejects.toThrow(
      "EXTERNAL_TARGET_REJECTED",
    );
  });
  it("拒绝 NAT64 私网映射、NAT64 本地用途、Teredo 与 site-local 地址", async () => {
    for (const address of ["64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1"]) {
      await expect(validateExternalHttpsTarget(`https://[${address}]`)).rejects.toThrow(
        "EXTERNAL_TARGET_REJECTED",
      );
    }
    await expect(validateExternalHttpsTarget("https://[64:ff9b::a00:1]")).rejects.toThrow(
      "EXTERNAL_TARGET_REJECTED",
    );
    for (const address of ["64:ff9b:1::1", "2001::1", "fec0::1"]) {
      await expect(
        validateExternalHttpsTarget(`https://[${address}]`, { allowPrivate: true }),
      ).rejects.toThrow("EXTERNAL_TARGET_REJECTED");
    }
  });
  it("私网开关仍拒绝链路本地和已知云元数据地址", async () => {
    for (const address of ["169.254.1.2", "169.254.169.254", "100.100.100.200"]) {
      await expect(
        validateExternalHttpsTarget(`https://${address}`, { allowPrivate: true }),
      ).rejects.toThrow("EXTERNAL_TARGET_REJECTED");
    }
    for (const address of ["fe80::1", "fd00:ec2::254"]) {
      await expect(
        validateExternalHttpsTarget(`https://[${address}]`, { allowPrivate: true }),
      ).rejects.toThrow("EXTERNAL_TARGET_REJECTED");
    }
    await expect(
      validateExternalHttpsTarget("https://100.100.100.200", { allowPrivate: true }),
    ).rejects.toThrow("EXTERNAL_TARGET_REJECTED");
    await expect(
      validateExternalHttpsTarget("https://metadata.example", {
        allowPrivate: true,
        resolve: async () => ["169.254.169.254"],
      }),
    ).rejects.toThrow("EXTERNAL_TARGET_REJECTED");
  });
  it("传输固定使用校验时的 DNS 地址而不重新解析", async () => {
    const answers = ["8.8.8.8", "127.0.0.1"];
    const resolveAddresses = vi.fn(async () => [answers.shift() ?? "8.8.8.8"]);
    let connection: ReturnType<typeof externalTargetConnection> | undefined;
    const agentTool = createExternalToolAgentTool(
      { ...toolVersion, endpoint: "https://rebind.example/api" },
      {
        persistStarted: async () => {},
        authorizeAndConsume: async () => {},
        resolveAddresses,
        transport: {
          invoke: async ({ target }) => {
            connection = externalTargetConnection(target);
            return { body: new TextEncoder().encode("ok"), contentType: "text/plain" };
          },
        },
        recordReceipt: async () => {},
        requireRecovery: async () => {},
      },
    );
    await agentTool.execute("pinned-call", { value: "x" });
    expect(resolveAddresses).toHaveBeenCalledOnce();
    expect(connection).toMatchObject({
      address: "8.8.8.8",
      servername: "rebind.example",
      hostHeader: "rebind.example",
    });
  });
  it("校验参数并将 Transport 异常归为结果未知、不自动重放", async () => {
    expect(validateExternalToolArguments(toolVersion, { value: "ok" })).toBe(true);
    expect(validateExternalToolArguments(toolVersion, { value: 3 })).toBe(false);
    const persistStarted = vi.fn(async () => undefined);
    const authorizeAndConsume = vi.fn(async () => undefined);
    const invoke = vi.fn(async () => {
      throw new Error("secret server text");
    });
    const requireRecovery = vi.fn(async () => undefined);
    const agentTool = createExternalToolAgentTool(toolVersion, {
      persistStarted,
      authorizeAndConsume,
      transport: { invoke },
      recordReceipt: vi.fn(async () => undefined),
      requireRecovery,
    });
    await expect(agentTool.execute("call-1", { value: "x" })).rejects.toThrow(
      "EXTERNAL_TOOL_RESULT_UNKNOWN",
    );
    expect(persistStarted).toHaveBeenCalledOnce();
    expect(persistStarted.mock.invocationCallOrder[0]).toBeLessThan(
      authorizeAndConsume.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(authorizeAndConsume.mock.invocationCallOrder[0]).toBeLessThan(
      invoke.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(authorizeAndConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call-1",
        toolName: "http__lookup",
        argsDigest: expect.any(String),
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    await expect(agentTool.execute("call-1", { value: "x" })).rejects.toThrow(
      "EXTERNAL_TOOL_RECOVERY_REQUIRED",
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(requireRecovery).toHaveBeenCalledWith({
      callId: "call-1",
      code: "EXTERNAL_TOOL_RESULT_UNKNOWN",
    });
  });
  it("Transport 明确证明尚未写出时回可控失败而不进入恢复", async () => {
    const requireRecovery = vi.fn(async () => undefined);
    const agentTool = createExternalToolAgentTool(toolVersion, {
      persistStarted: async () => {},
      authorizeAndConsume: async () => {},
      transport: {
        invoke: async () => {
          throw new ExternalToolTransportError("preflight", "EXTERNAL_TOOL_REJECTED");
        },
      },
      recordReceipt: async () => {},
      requireRecovery,
    });
    const result = await agentTool.execute("preflight-call", { value: "x" });
    expect(result.details).toMatchObject({ error: "EXTERNAL_TOOL_FAILED" });
    expect(requireRecovery).not.toHaveBeenCalled();
  });
  it("截断模型可见结果并且不回显传输凭据", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ value: "中".repeat(100) }));
    const transportInvoke = vi.fn(async () => ({ body, contentType: "application/json" }));
    const receipt = vi.fn(
      async (_input: { readonly callId: string; readonly receipt: string }) => undefined,
    );
    const agentTool = createExternalToolAgentTool(
      toolVersion,
      {
        persistStarted: async () => {},
        authorizeAndConsume: async () => {},
        transport: { invoke: transportInvoke },
        recordReceipt: receipt,
        requireRecovery: async () => {},
        maxModelVisibleBytes: 12,
      },
      "very-secret",
    );
    const result = await agentTool.execute("bounded-call", { value: "ok" });
    const visible = JSON.stringify(result);
    expect(
      new TextEncoder().encode((result.content[0] as { text: string }).text).byteLength,
    ).toBeLessThanOrEqual(12);
    expect(visible).not.toContain("very-secret");
    expect(visible).not.toContain("receipt");
    expect(receipt.mock.calls[0]?.[0]?.receipt).toContain("succeeded");
  });
  it("服务端回显凭据时仍从模型可见结果删除", async () => {
    const secret = "credential-echo-secret";
    const invoke = vi.fn(async (input: { readonly credential?: string }) => ({
      body: new TextEncoder().encode(JSON.stringify({ echo: input.credential })),
      contentType: "application/json",
    }));
    const agentTool = createExternalToolAgentTool(
      toolVersion,
      {
        persistStarted: async () => {},
        authorizeAndConsume: async () => {},
        transport: { invoke },
        recordReceipt: async () => {},
        requireRecovery: async () => {},
      },
      secret,
    );
    const result = await agentTool.execute("echo-call", { value: "x" });
    const visible = (result.content[0] as { text: string }).text;
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ credential: secret }));
    expect(visible).not.toContain(secret);
    expect(visible).toContain("[凭据已隐藏]");
  });
  it("解析 JSON 后脱敏含引号、反斜线与控制字符的凭据", async () => {
    const secret = 'quote" slash\\ control\n\t';
    const agentTool = createExternalToolAgentTool(
      toolVersion,
      {
        persistStarted: async () => {},
        authorizeAndConsume: async () => {},
        transport: {
          invoke: async () => ({
            body: new TextEncoder().encode(JSON.stringify({ echo: secret, nested: [secret] })),
            contentType: "application/json",
          }),
        },
        recordReceipt: async () => {},
        requireRecovery: async () => {},
      },
      secret,
    );
    const result = await agentTool.execute("complex-secret", { value: "x" });
    const visible = (result.content[0] as { text: string }).text;
    expect(visible).not.toContain(secret);
    expect(visible).toContain('["[凭据已隐藏]"]');
  });
  it("显式对账才允许幂等重试，原幂等键被复用", async () => {
    const invoke = vi.fn(async () => ({
      body: new TextEncoder().encode('{"ok":true}'),
      contentType: "application/json",
    }));
    const authorizeRetry = vi.fn(async () => "authorized" as const);
    const agentTool = createExternalToolAgentTool(toolVersion, {
      persistStarted: vi.fn(),
      authorizeAndConsume: vi.fn(),
      transport: { invoke },
      reconciliation: { authorizeRetry },
      isExplicitlyReconciledRetry: async () => true,
      recordReceipt: vi.fn(async () => undefined),
      requireRecovery: vi.fn(async () => undefined),
    });
    await agentTool.execute("same-key", { value: "x" });
    expect(authorizeRetry).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "same-key", idempotent: true }),
    );
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "same-key" }));
  });
});
