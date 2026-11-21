import { describe, expect, it, vi } from "vitest";
import { normalizeExternalToolSchema, type ExternalToolVersion } from "@hoox/domain";
import { ExternalToolTransportError } from "@hoox/run-contracts";
import { encodeControlledToolReceipt, parseControlledToolReceipt } from "@hoox/context-policy";
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
  httpMethod: "POST",
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

const consumePermit = async ({ toolVersionId }: { readonly toolVersionId: string }) => ({
  permit: { toolVersionId },
});

describe("外部工具运行骨架", () => {
  it("只有领取快照标记为 Playground 才短路外部请求并写入 Mock 回执", async () => {
    const invoke = vi.fn(async () => ({
      body: new TextEncoder().encode("real"),
      contentType: "text/plain",
    }));
    const authorizeAndConsume = vi.fn(consumePermit);
    const receipts: string[] = [];
    const persistStarted = vi.fn(async () => undefined);
    const tool = createExternalToolAgentTool(toolVersion, {
      runOrigin: "playground",
      playgroundMocks: { tv1: { answer: "simulated" } },
      getCallContext: () => ({ tenantId: "tenant", threadId: "thread", runId: "run" }),
      persistStarted,
      authorizeAndConsume,
      transport: { invoke },
      recordReceipt: async ({ receipt }) => {
        receipts.push(receipt);
      },
      requireRecovery: async () => undefined,
    });
    const result = await tool.execute("mock-call", { value: "q" });
    expect(result.details).toEqual({ executionMode: "mock", mockResult: { answer: "simulated" } });
    expect(result.content).toEqual([
      { type: "text", text: '[Playground Mock] {"answer":"simulated"}' },
    ]);
    expect(invoke).not.toHaveBeenCalled();
    expect(authorizeAndConsume).not.toHaveBeenCalled();
    expect(persistStarted).toHaveBeenCalledWith({ callId: "mock-call", toolName: "http__lookup" });
    expect(parseControlledToolReceipt(receipts[0] ?? "")).toMatchObject({
      outcome: "succeeded",
      executionMode: "playground_mock",
    });
  });

  it.each(["http", "mcp"] as const)(
    "Playground 的 %s 工具缺少 Mock 时失败关闭，不做 DNS、许可消费或 Transport",
    async (source) => {
      const invoke = vi.fn(async () => ({
        body: new TextEncoder().encode("real"),
        contentType: "text/plain",
      }));
      const resolveAddresses = vi.fn(async () => ["8.8.8.8"]);
      const authorizeAndConsume = vi.fn(consumePermit);
      const persistStarted = vi.fn(async () => undefined);
      const receipts: string[] = [];
      const selected: ExternalToolVersion =
        source === "http"
          ? toolVersion
          : {
              toolVersionId: "tv1",
              source: "mcp",
              endpoint: "https://8.8.8.8/mcp",
              modelToolName: "mcp__catalog__lookup",
              remoteToolName: "catalog.lookup",
              description: toolVersion.description,
              inputSchema: toolVersion.inputSchema,
              inputSchemaDigest: toolVersion.inputSchemaDigest,
              timeoutMs: toolVersion.timeoutMs,
              maxResponseBytes: toolVersion.maxResponseBytes,
              sideEffect: toolVersion.sideEffect,
              idempotent: toolVersion.idempotent,
              credentialRef: null,
            };
      const tool = createExternalToolAgentTool(selected, {
        runOrigin: "playground",
        playgroundMocks: {},
        resolveAddresses,
        getCallContext: () => ({ tenantId: "tenant", threadId: "thread", runId: "run" }),
        persistStarted,
        authorizeAndConsume,
        transport: { invoke },
        recordReceipt: async ({ receipt }) => {
          receipts.push(receipt);
        },
        requireRecovery: async () => undefined,
      });
      const result = await tool.execute("unmocked-call", { value: "q" });
      expect(result.details).toEqual({ error: "PLAYGROUND_MOCK_NOT_CONFIGURED" });
      expect(persistStarted).toHaveBeenCalledOnce();
      expect(resolveAddresses).not.toHaveBeenCalled();
      expect(authorizeAndConsume).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(parseControlledToolReceipt(receipts[0] ?? "")).toMatchObject({ outcome: "failed" });
    },
  );

  it.each(["normal", "evaluation", "api"] as const)(
    "%s Run 忽略同名持久 Mock 并走真实外部调用边界",
    async (runOrigin) => {
      const invoke = vi.fn(async () => ({
        body: new TextEncoder().encode("real"),
        contentType: "text/plain",
      }));
      const authorizeAndConsume = vi.fn(consumePermit);
      const tool = createExternalToolAgentTool(toolVersion, {
        runOrigin,
        playgroundMocks: { tv1: { answer: "must-not-appear" } },
        getCallContext: () => ({ tenantId: "tenant", threadId: "thread", runId: "run" }),
        persistStarted: async () => undefined,
        authorizeAndConsume,
        transport: { invoke },
        recordReceipt: async () => undefined,
        requireRecovery: async () => undefined,
      });
      await tool.execute(`real-${runOrigin}`, { value: "q" });
      expect(invoke).toHaveBeenCalledOnce();
      expect(authorizeAndConsume).toHaveBeenCalledOnce();
    },
  );

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
        getCallContext: () => ({
          tenantId: "tenant-fake",
          endUserId: "user-fake",
          threadId: "thread-fake",
          runId: "run-fake",
        }),
        persistStarted: async () => {},
        authorizeAndConsume: consumePermit,
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
    const authorizeAndConsume = vi.fn(consumePermit);
    const invoke = vi.fn(async () => {
      throw new Error("secret server text");
    });
    const requireRecovery = vi.fn(async () => undefined);
    const agentTool = createExternalToolAgentTool(toolVersion, {
      getCallContext: () => ({
        tenantId: "tenant-fake",
        threadId: "thread-fake",
        runId: "run-fake",
      }),
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
        toolVersionId: "tv1",
        argsDigest: expect.any(String),
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        callContext: { tenantId: "tenant-fake", threadId: "thread-fake", runId: "run-fake" },
      }),
    );
    await expect(agentTool.execute("call-1", { value: "x" })).rejects.toThrow(
      "EXTERNAL_TOOL_RECOVERY_REQUIRED",
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(authorizeAndConsume).toHaveBeenCalledOnce();
    expect(requireRecovery).toHaveBeenCalledWith({
      callId: "call-1",
      code: "EXTERNAL_TOOL_RESULT_UNKNOWN",
    });
  });
  it("DNS 校验通过后消费失败，先写固定失败回执再原样透传，不发包或转 UNKNOWN", async () => {
    const order: string[] = [];
    const denied = new Error("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    const invoke = vi.fn();
    const requireRecovery = vi.fn();
    const agentTool = createExternalToolAgentTool(
      { ...toolVersion, endpoint: "https://tools.example/api" },
      {
        persistStarted: async () => {
          order.push("started");
        },
        resolveAddresses: async () => {
          order.push("dns");
          return ["8.8.8.8"];
        },
        getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
        authorizeAndConsume: async () => {
          order.push("consume");
          throw denied;
        },
        transport: { invoke },
        recordReceipt: async ({ receipt }) => {
          order.push(receipt);
        },
        requireRecovery,
      },
    );
    await expect(agentTool.execute("denied", { value: "x" })).rejects.toBe(denied);
    expect(order).toEqual([
      "started",
      "dns",
      "consume",
      encodeControlledToolReceipt(toolVersion.modelToolName, "failed"),
    ]);
    expect(invoke).not.toHaveBeenCalled();
    expect(requireRecovery).not.toHaveBeenCalled();
  });
  it("DNS 预检完成后才消费精确版本许可，随后不再等待其他端口而单次发包", async () => {
    const order: string[] = [];
    const dnsStarted = Promise.withResolvers<void>();
    const dns = Promise.withResolvers<readonly string[]>();
    const authorizeAndConsume = vi.fn(async (input: { readonly toolVersionId: string }) => {
      order.push("consume");
      return consumePermit(input);
    });
    const invoke = vi.fn(async () => {
      order.push("invoke");
      return { body: new Uint8Array(), contentType: "" };
    });
    const agentTool = createExternalToolAgentTool(
      { ...toolVersion, endpoint: "https://tools.example/api" },
      {
        persistStarted: async () => {
          order.push("started");
        },
        resolveAddresses: async () => {
          order.push("dns:start");
          dnsStarted.resolve();
          const addresses = await dns.promise;
          order.push("dns:complete");
          return addresses;
        },
        getCallContext: () => {
          order.push("context");
          return { tenantId: "t", threadId: "th", runId: "r" };
        },
        authorizeAndConsume,
        transport: { invoke },
        recordReceipt: async () => {
          order.push("receipt");
        },
        requireRecovery: async () => {},
      },
    );
    const execution = agentTool.execute("ordered-call", { value: "x" });
    await dnsStarted.promise;
    expect(authorizeAndConsume).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    dns.resolve(["8.8.8.8"]);
    await execution;
    expect(order).toEqual([
      "started",
      "dns:start",
      "dns:complete",
      "context",
      "consume",
      "invoke",
      "receipt",
    ]);
    expect(authorizeAndConsume).toHaveBeenCalledOnce();
    expect(authorizeAndConsume).toHaveBeenCalledWith({
      callId: "ordered-call",
      toolName: toolVersion.modelToolName,
      toolVersionId: toolVersion.toolVersionId,
      argsDigest: expect.any(String),
    });
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("DNS 等待期间先完成撤销，最终消费拒绝后不发包或重放", async () => {
    const dnsStarted = Promise.withResolvers<void>();
    const dns = Promise.withResolvers<readonly string[]>();
    let revoked = false;
    const denied = new Error("EXTERNAL_TOOL_REVOKED");
    const authorizeAndConsume = vi.fn(async (input: { readonly toolVersionId: string }) => {
      if (revoked) throw denied;
      return consumePermit(input);
    });
    const invoke = vi.fn();
    const recordReceipt = vi.fn(async () => {});
    const requireRecovery = vi.fn();
    const agentTool = createExternalToolAgentTool(
      { ...toolVersion, endpoint: "https://tools.example/api", sideEffect: "write" },
      {
        persistStarted: async () => {},
        resolveAddresses: () => {
          dnsStarted.resolve();
          return dns.promise;
        },
        getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
        authorizeAndConsume,
        transport: { invoke },
        recordReceipt,
        requireRecovery,
      },
    );
    const execution = agentTool.execute("revoked-before-consume", { value: "x" });
    await dnsStarted.promise;
    expect(authorizeAndConsume).not.toHaveBeenCalled();
    revoked = true;
    dns.resolve(["8.8.8.8"]);
    await expect(execution).rejects.toBe(denied);
    expect(authorizeAndConsume).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(requireRecovery).not.toHaveBeenCalled();
    expect(recordReceipt).toHaveBeenCalledExactlyOnceWith({
      callId: "revoked-before-consume",
      receipt: encodeControlledToolReceipt(toolVersion.modelToolName, "failed"),
    });
  });
  it.each([
    ["缺少版本", {}, false],
    ["同名不同版本", { toolVersionId: "tv2" }, false],
    ["已显式对账但许可版本不符", { toolVersionId: "tv2" }, true],
  ] as const)("许可%s 时拒绝发包", async (_case, permit, retry) => {
    const invoke = vi.fn();
    const recordReceipt = vi.fn();
    const requireRecovery = vi.fn();
    const agentTool = createExternalToolAgentTool(toolVersion, {
      getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
      persistStarted: async () => {},
      authorizeAndConsume: async () => ({ permit }),
      transport: { invoke },
      recordReceipt,
      requireRecovery,
      reconciliation: { authorizeRetry: async () => "authorized" },
      isExplicitlyReconciledRetry: async () => retry,
    });
    await expect(agentTool.execute("wrong-version", { value: "x" })).rejects.toThrow(
      "EXTERNAL_EFFECT_NOT_AUTHORIZED",
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(requireRecovery).not.toHaveBeenCalled();
    expect(recordReceipt.mock.calls).toEqual([
      [
        {
          callId: "wrong-version",
          receipt: encodeControlledToolReceipt(toolVersion.modelToolName, "failed"),
        },
      ],
    ]);
  });
  it("Transport 已收到可归一化失败响应时写失败回执且不进入恢复", async () => {
    const requireRecovery = vi.fn(async () => undefined);
    const agentTool = createExternalToolAgentTool(toolVersion, {
      getCallContext: () => ({
        tenantId: "tenant-fake",
        threadId: "thread-fake",
        runId: "run-fake",
      }),
      persistStarted: async () => {},
      authorizeAndConsume: consumePermit,
      transport: {
        invoke: async () => {
          throw new ExternalToolTransportError("responded_failure", "EXTERNAL_TOOL_REJECTED");
        },
      },
      recordReceipt: async () => {},
      requireRecovery,
    });
    const result = await agentTool.execute("responded-call", { value: "x" });
    expect(result.details).toMatchObject({ error: "EXTERNAL_TOOL_REJECTED" });
    expect(requireRecovery).not.toHaveBeenCalled();
  });
  it("未分类的写出后异常继续进入 UNKNOWN 恢复", async () => {
    const requireRecovery = vi.fn(async () => undefined);
    const agentTool = createExternalToolAgentTool(toolVersion, {
      getCallContext: () => ({
        tenantId: "tenant-fake",
        threadId: "thread-fake",
        runId: "run-fake",
      }),
      persistStarted: async () => {},
      authorizeAndConsume: consumePermit,
      transport: {
        invoke: async () => {
          throw new Error("transport disconnected");
        },
      },
      recordReceipt: async () => {},
      requireRecovery,
    });
    await expect(agentTool.execute("unknown-call", { value: "x" })).rejects.toThrow(
      "EXTERNAL_TOOL_RESULT_UNKNOWN",
    );
    expect(requireRecovery).toHaveBeenCalledWith({
      callId: "unknown-call",
      code: "EXTERNAL_TOOL_RESULT_UNKNOWN",
    });
  });
  it("Transport 明确证明尚未写出时回可控失败而不进入恢复", async () => {
    const requireRecovery = vi.fn(async () => undefined);
    const agentTool = createExternalToolAgentTool(toolVersion, {
      getCallContext: () => ({
        tenantId: "tenant-fake",
        endUserId: "user-fake",
        threadId: "thread-fake",
        runId: "run-fake",
      }),
      persistStarted: async () => {},
      authorizeAndConsume: consumePermit,
      transport: {
        invoke: async () => {
          throw new ExternalToolTransportError("not_sent", "EXTERNAL_TOOL_REJECTED");
        },
      },
      recordReceipt: async () => {},
      requireRecovery,
    });
    const result = await agentTool.execute("preflight-call", { value: "x" });
    expect(result.details).toMatchObject({ error: "EXTERNAL_TOOL_REJECTED" });
    expect(requireRecovery).not.toHaveBeenCalled();
  });
  it("无凭据工具保留有界正文投影，UTF-8 截断不越过字节上限", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ value: "中".repeat(100) }));
    const transportInvoke = vi.fn(async (_input: { readonly credential?: string }) => ({
      body,
      contentType: "application/json",
    }));
    const receipt = vi.fn(
      async (_input: { readonly callId: string; readonly receipt: string }) => undefined,
    );
    const agentTool = createExternalToolAgentTool(toolVersion, {
      getCallContext: () => ({
        tenantId: "tenant-fake",
        endUserId: "user-fake",
        threadId: "thread-fake",
        runId: "run-fake",
      }),
      persistStarted: async () => {},
      authorizeAndConsume: consumePermit,
      transport: { invoke: transportInvoke },
      recordReceipt: receipt,
      requireRecovery: async () => {},
      maxModelVisibleBytes: 12,
    });
    const result = await agentTool.execute("bounded-call", { value: "ok" });
    const visible = JSON.stringify(result);
    expect(
      new TextEncoder().encode((result.content[0] as { text: string }).text).byteLength,
    ).toBeLessThanOrEqual(12);
    expect(result.details).toEqual({ truncated: true });
    expect((result.content[0] as { text: string }).text).toContain('{"value":"');
    expect(transportInvoke).toHaveBeenCalledOnce();
    expect(transportInvoke.mock.calls[0]?.[0]).not.toHaveProperty("credential");
    expect(visible).not.toContain("receipt");
    expect(receipt.mock.calls[0]?.[0]?.receipt).toContain("succeeded");
  });
  it("服务端回显凭据时以成功回执扣留正文", async () => {
    const secret = "credential-echo-secret";
    const invoke = vi.fn(async (input: { readonly credential?: string }) => ({
      body: new TextEncoder().encode(JSON.stringify({ echo: input.credential })),
      contentType: "application/json",
    }));
    const agentTool = createExternalToolAgentTool(
      toolVersion,
      {
        getCallContext: () => ({
          tenantId: "tenant-fake",
          endUserId: "user-fake",
          threadId: "thread-fake",
          runId: "run-fake",
        }),
        persistStarted: async () => {},
        authorizeAndConsume: consumePermit,
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
    expect(visible).toBe("外部工具调用已成功，但响应疑似包含凭据，正文已扣留，请勿重试。");
    expect(result.details).toEqual({ withheld: "EXTERNAL_TOOL_CREDENTIAL_ECHO" });
  });
  it.each(
    [
      ["base64", Buffer.from('placeholder-credential+/="\\\n\t').toString("base64")],
      ["hex", Buffer.from('placeholder-credential+/="\\\n\t').toString("hex")],
      ["URL", encodeURIComponent('placeholder-credential+/="\\\n\t')],
      ["反转", [...'placeholder-credential+/="\\\n\t'].reverse().join("")],
      ["JSON 转义", JSON.stringify('placeholder-credential+/="\\\n\t').slice(1, -1)],
    ].flatMap(([encoding, echo]) => [
      { encoding, contentType: "text/plain", body: `不可信业务正文：${echo}` },
      {
        encoding,
        contentType: "application/json",
        body: JSON.stringify({ value: "不可信业务正文", echo }),
      },
    ]),
  )("持凭据端点扣留 $contentType 中的 $encoding 回显", async ({ body, contentType }) => {
    const recordReceipt = vi.fn(async () => {});
    const requireRecovery = vi.fn();
    const agentTool = createExternalToolAgentTool(
      { ...toolVersion, credentialRef: "placeholder-credential-ref" },
      {
        getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
        persistStarted: async () => {},
        authorizeAndConsume: consumePermit,
        transport: {
          invoke: async () => ({ body: new TextEncoder().encode(body), contentType }),
        },
        recordReceipt,
        requireRecovery,
      },
      'placeholder-credential+/="\\\n\t',
    );
    const result = await agentTool.execute("encoded-echo", { value: "x" });
    expect(result).toEqual({
      content: [
        { type: "text", text: "外部工具调用已成功，但响应疑似包含凭据，正文已扣留，请勿重试。" },
      ],
      details: { withheld: "EXTERNAL_TOOL_CREDENTIAL_ECHO" },
    });
    expect(recordReceipt).toHaveBeenCalledExactlyOnceWith({
      callId: "encoded-echo",
      receipt: encodeControlledToolReceipt(toolVersion.modelToolName, "succeeded"),
    });
    expect(requireRecovery).not.toHaveBeenCalled();
  });
  it.each(["不可信业务正文", ""])(
    "只有凭据引用但没有可检测凭据时也不投影正文：%j",
    async (body) => {
      const agentTool = createExternalToolAgentTool(
        { ...toolVersion, credentialRef: "placeholder-credential-ref" },
        {
          getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
          persistStarted: async () => {},
          authorizeAndConsume: consumePermit,
          transport: {
            invoke: async () => ({
              body: new TextEncoder().encode(body),
              contentType: "text/plain",
            }),
          },
          recordReceipt: async () => {},
          requireRecovery: async () => {},
        },
      );
      expect((await agentTool.execute("credential-ref-only", { value: "x" })).content).toEqual([
        {
          type: "text",
          text:
            body.length === 0
              ? "外部工具调用已成功，未返回内容。"
              : "外部工具调用已成功，响应正文未向模型公开。",
        },
      ]);
    },
  );
  it.each([null, "placeholder-credential-ref"])(
    "传输携带凭据时未命中检测也不投影正文：%j",
    async (credentialRef) => {
      const agentTool = createExternalToolAgentTool(
        { ...toolVersion, credentialRef },
        {
          getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
          persistStarted: async () => {},
          authorizeAndConsume: consumePermit,
          transport: {
            invoke: async () => ({
              body: new TextEncoder().encode(JSON.stringify({ status: "ready", count: 3 })),
              contentType: "application/json",
            }),
          },
          recordReceipt: async () => {},
          requireRecovery: async () => {},
        },
        "known-secret-value",
      );
      expect((await agentTool.execute("normal-result", { value: "x" })).content).toEqual([
        { type: "text", text: "外部工具调用已成功，响应正文未向模型公开。" },
      ]);
    },
  );
  it("含引号、反斜线与控制字符的单次认证材料按解析后的 JSON 字面脱敏", async () => {
    const secret = 'quote" slash\\ control\n\t';
    const agentTool = createExternalToolAgentTool(toolVersion, {
      getCallContext: () => ({
        tenantId: "tenant-fake",
        endUserId: "user-fake",
        threadId: "thread-fake",
        runId: "run-fake",
      }),
      persistStarted: async () => {},
      authorizeAndConsume: consumePermit,
      transport: {
        invoke: async () => ({
          body: new TextEncoder().encode(JSON.stringify({ echo: secret, nested: [secret] })),
          contentType: "application/json",
          authMaterial: [secret],
        }),
      },
      recordReceipt: async () => {},
      requireRecovery: async () => {},
    });
    const result = await agentTool.execute("complex-secret", { value: "x" });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      echo: "[凭据已隐藏]",
      nested: ["[凭据已隐藏]"],
    });
    expect(result.details).toEqual({ truncated: false });
  });
  it("持凭据端点返回无法解释的 JSON 时不结算为成功，也不重放", async () => {
    const requireRecovery = vi.fn();
    const recordReceipt = vi.fn();
    const invoke = vi.fn(async () => ({
      body: new TextEncoder().encode('{"echo":"placeholder-secret"'),
      contentType: "application/json",
    }));
    const agentTool = createExternalToolAgentTool(
      toolVersion,
      {
        getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
        persistStarted: async () => {},
        authorizeAndConsume: consumePermit,
        transport: { invoke },
        recordReceipt,
        requireRecovery,
      },
      "placeholder-secret",
    );
    await expect(agentTool.execute("invalid-json", { value: "x" })).rejects.toThrow(
      "EXTERNAL_TOOL_RESULT_UNKNOWN",
    );
    await expect(agentTool.execute("another-call", { value: "x" })).rejects.toThrow(
      "EXTERNAL_TOOL_RECOVERY_REQUIRED",
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(recordReceipt).not.toHaveBeenCalled();
    expect(requireRecovery).toHaveBeenCalledExactlyOnceWith({
      callId: "invalid-json",
      code: "EXTERNAL_TOOL_RESULT_UNKNOWN",
    });
  });
  it("显式对账才允许幂等重试，原幂等键被复用", async () => {
    const invoke = vi.fn(async () => ({
      body: new TextEncoder().encode('{"ok":true}'),
      contentType: "application/json",
    }));
    const authorizeRetry = vi.fn(async () => "authorized" as const);
    const authorizeAndConsume = vi.fn(consumePermit);
    const agentTool = createExternalToolAgentTool(toolVersion, {
      getCallContext: () => ({
        tenantId: "tenant-fake",
        endUserId: "user-fake",
        threadId: "thread-fake",
        runId: "run-fake",
      }),
      persistStarted: vi.fn(),
      authorizeAndConsume,
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
    expect(authorizeAndConsume).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("HTTP 方法只来自版本绑定，缺失时不向 Transport 补默认方法", async () => {
    const invoke = vi.fn(async (_input: { readonly method?: string }) => ({
      body: new TextEncoder().encode("ok"),
      contentType: "text/plain",
    }));
    const ports = {
      getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
      persistStarted: async () => {},
      authorizeAndConsume: consumePermit,
      transport: { invoke },
      recordReceipt: async () => {},
      requireRecovery: async () => {},
    };
    const { httpMethod: _httpMethod, ...withoutMethod } = toolVersion;
    expect(() => createExternalToolAgentTool(withoutMethod, ports)).toThrow(
      "EXTERNAL_TOOL_HTTP_METHOD_INVALID",
    );
    await createExternalToolAgentTool({ ...toolVersion, httpMethod: "GET" }, ports).execute(
      "bound-method",
      { value: "x" },
    );
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ method: "GET" });
  });
  it("总超时从 DNS 预检开始，预检耗尽预算时以未写出失败结束", async () => {
    const invoke = vi.fn(async (_input: { readonly deadlineAt: number }) => ({
      body: new TextEncoder().encode("ok"),
      contentType: "text/plain",
    }));
    const requireRecovery = vi.fn(async () => undefined);
    const receipts: string[] = [];
    const authorizeAndConsume = vi.fn(consumePermit);
    const base = {
      getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
      persistStarted: async () => {},
      authorizeAndConsume,
      transport: { invoke },
      recordReceipt: async ({ receipt }: { readonly receipt: string }) => {
        receipts.push(receipt);
      },
      requireRecovery,
    };
    const slowTool = { ...toolVersion, endpoint: "https://slow.example/api", timeoutMs: 100 };
    const stalled = await createExternalToolAgentTool(slowTool, {
      ...base,
      resolveAddresses: () => new Promise<readonly string[]>(() => {}),
    }).execute("dns-timeout", { value: "x" });
    expect(stalled.details).toMatchObject({ error: "EXTERNAL_TOOL_UNAVAILABLE" });
    expect(receipts.at(-1)).toContain("failed");
    expect(authorizeAndConsume).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(requireRecovery).not.toHaveBeenCalled();
    const started = Date.now();
    await createExternalToolAgentTool(
      { ...slowTool, timeoutMs: 1000 },
      {
        ...base,
        resolveAddresses: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return ["8.8.8.8"];
        },
      },
    ).execute("dns-shared", { value: "x" });
    expect(authorizeAndConsume).toHaveBeenCalledOnce();
    const deadlineAt = invoke.mock.calls[0]?.[0].deadlineAt ?? Infinity;
    expect(deadlineAt).toBeLessThanOrEqual(started + 1000 + 5);
    expect(deadlineAt - Date.now()).toBeLessThan(1000 - 40);
  });
  it("合法空成功结果写成功回执，签名与时间戳等认证材料不进入模型可见结果", async () => {
    const receipts: string[] = [];
    const signature = "f".repeat(64);
    const timestamp = "1790000000000";
    let body = new Uint8Array();
    let contentType = "";
    const agentTool = createExternalToolAgentTool(toolVersion, {
      getCallContext: () => ({ tenantId: "t", threadId: "th", runId: "r" }),
      persistStarted: async () => {},
      authorizeAndConsume: consumePermit,
      transport: {
        invoke: async () => ({ body, contentType, authMaterial: [signature, timestamp] }),
      },
      recordReceipt: async ({ receipt }) => {
        receipts.push(receipt);
      },
      requireRecovery: async () => {},
    });
    const empty = await agentTool.execute("empty", { value: "x" });
    expect((empty.content[0] as { text: string }).text).toBe("外部工具调用已成功，未返回内容。");
    expect(receipts.at(-1)).toContain("succeeded");
    body = new TextEncoder().encode(
      JSON.stringify({
        headers: { "x-hoox-signature": `v1=${signature}`, [signature]: 1 },
        ts: Number(timestamp),
        tsText: timestamp,
      }),
    );
    contentType = "application/json";
    const echoed = (await agentTool.execute("echo-json", { value: "x" })).content[0] as {
      text: string;
    };
    expect(JSON.parse(echoed.text)).toEqual({
      headers: { "x-hoox-signature": "v1=[凭据已隐藏]", "[凭据已隐藏]": 1 },
      ts: "[凭据已隐藏]",
      tsText: "[凭据已隐藏]",
    });
    expect(receipts.at(-1)).toContain("succeeded");
    body = new TextEncoder().encode(`sig=${signature} ts=${timestamp}`);
    contentType = "text/plain";
    const text = (await agentTool.execute("echo-text", { value: "x" })).content[0] as {
      text: string;
    };
    expect(text.text).toBe("sig=[凭据已隐藏] ts=[凭据已隐藏]");
    body = new TextEncoder().encode(
      `sig=${signature} encoded=${Buffer.from(signature).toString("base64")}`,
    );
    expect(await agentTool.execute("encoded-signature", { value: "x" })).toEqual({
      content: [
        { type: "text", text: "外部工具调用已成功，但响应疑似包含凭据，正文已扣留，请勿重试。" },
      ],
      details: { withheld: "EXTERNAL_TOOL_CREDENTIAL_ECHO" },
    });
  });
});
