import { execFileSync } from "node:child_process";
import { createHmac, hkdfSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type Context,
} from "@earendil-works/pi-ai";
import { encodeControlledToolReceipt } from "@hoox/context-policy";
import { normalizeExternalToolSchema, runId } from "@hoox/domain";
import { ExternalToolSnapshotError } from "@hoox/run-contracts";
import { deriveHttpToolSigningKey, verifyHttpToolSignature } from "@hoox/tool-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PiWorkerSessionFactory } from "./pi-session-factory.js";
import type {
  AgentControlPersistencePort,
  AgentSessionFactoryPort,
  ExternalToolRuntimeSnapshot,
  ExternalToolSnapshotReader,
  SubAgentConversationSnapshot,
} from "./ports.js";
import { RunWorker } from "./run-worker.js";
import { fakeAgentSnapshot } from "./testing/agent-snapshot.js";
import {
  FakeCancellationPort,
  FakeClock,
  FakeExecutionPersistence,
  FakeRecoveryMetrics,
  FakeRevisionVerifier,
  FakeSandboxRegistry,
  fakeSeed,
} from "./testing/fakes.js";

const credential = "placeholder-external-credential";
const rootKey = Buffer.alloc(32, 7);
const schema = normalizeExternalToolSchema({
  type: "object",
  properties: { runId: { type: "string" } },
  required: ["runId"],
  additionalProperties: false,
});
function version(
  source: "mcp" | "http",
  origin = "https://tools.invalid",
  id = `${source}-v1`,
): ExternalToolRuntimeSnapshot {
  return {
    credential,
    tool: {
      source,
      toolVersionId: id,
      endpoint: `${origin}/${source}`,
      modelToolName: source === "mcp" ? "mcp__catalog__lookup" : "http__lookup",
      ...(source === "mcp" ? { remoteToolName: "catalog.lookup" } : { httpMethod: "POST" }),
      description: "查询条目",
      inputSchema: schema.schema,
      inputSchemaDigest: schema.digest,
      timeoutMs: 3000,
      maxResponseBytes: 4096,
      sideEffect: "read_only",
      idempotent: true,
      credentialRef: "placeholder-ref",
    },
  };
}
function seed(
  name: string,
  versions: readonly ExternalToolRuntimeSnapshot[],
  builtinTools: string[] = [],
  id = runId(`run-${name}`),
  toolCallingMode: "native" | "ptc" = "native",
) {
  return {
    ...fakeSeed(name, id),
    agent: fakeAgentSnapshot({
      tools: {
        mode: "configured",
        builtinTools,
        externalTools: versions.map(({ tool }) => ({
          kind: tool.source,
          versionId: tool.toolVersionId,
        })),
        clientTools: [],
        toolCallingMode,
      },
    }),
  };
}
function reader(versions: readonly ExternalToolRuntimeSnapshot[]): ExternalToolSnapshotReader {
  return {
    read: async ({ toolVersionIds }) =>
      versions.filter(({ tool }) => toolVersionIds.includes(tool.toolVersionId)),
  };
}
async function pi(
  snapshots: ExternalToolSnapshotReader,
  toolCallingMode: "native" | "ptc" = "native",
) {
  const faux = fauxProvider({ api: "faux-b5", provider: "faux-b5", tokensPerSecond: 100_000 });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.provider.id, async () => ({
    type: "api_key",
    key: "placeholder-model-key",
  }));
  const runtime = createModels({ credentials });
  runtime.setProvider(faux.provider);
  const receipts: { callId: string; receipt: string }[] = [];
  const starts: { toolCallId: string; toolName: string }[] = [];
  const manifestHashes = new Map<string, string>();
  const sessions = new PiWorkerSessionFactory(
    faux.getModel(),
    runtime,
    (_input, outputs) => ({
      recordStarted: async (call) => {
        starts.push(call);
        return "recorded";
      },
      record: async (call) => {
        const receipt = await outputs.readControlledReceipt(call);
        if (receipt === undefined) return { outcome: "conflict" };
        receipts.push({ callId: call.toolCallId, receipt });
        return { outcome: "recorded", observation: receipt, isTruncated: false };
      },
    }),
    undefined,
    async (input, compatibility) => {
      manifestHashes.set(input.attemptId, compatibility.toolSchemaHash);
      return input.rolloutProjection;
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    toolCallingMode,
    undefined,
    undefined,
    { snapshots, allowPrivateAddresses: true, httpIdentityRootKey: rootKey },
  );
  return { faux, sessions, receipts, starts, manifestHashes };
}
function worker(
  persistence: FakeExecutionPersistence,
  sessions: AgentSessionFactoryPort,
  agentControl?: AgentControlPersistencePort,
) {
  const sandboxes = new FakeSandboxRegistry();
  return new RunWorker(
    {
      persistence,
      sessions,
      revisions: new FakeRevisionVerifier(),
      sandboxes,
      orphanSandboxes: sandboxes,
      cancellation: new FakeCancellationPort(),
      clock: new FakeClock(),
      metrics: new FakeRecoveryMetrics(),
      ...(agentControl && { agentControl }),
    },
    { workerId: "external-session-worker", runTimeoutMs: 60_000, subagentsEnabled: !!agentControl },
  );
}
const toolCall = (name: string, args: Record<string, unknown>, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
const externalNames = (ctx: Context) =>
  (ctx.tools ?? []).map((t) => t.name).filter((n) => /^(http|mcp)__/.test(n));

describe("外部工具经 Worker Session 调用本地 TLS 服务", () => {
  let origin: string;
  const requests: { method: string; path: string; body: Buffer; headers: IncomingHttpHeaders }[] =
    [];
  let onRequest: () => void;
  let disconnect = false;
  const server = createServer();
  const previousCAs = getCACertificates("default");
  beforeAll(async () => {
    // Router 即使放行私网也禁止回环；只监听本机的私网接口，不放宽生产出站或 TLS 策略。
    const address = Object.values(networkInterfaces())
      .flat()
      .find(
        (a) =>
          a?.family === "IPv4" &&
          !a.internal &&
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address),
      )?.address;
    if (!address) throw new Error("TLS 夹具需要本机私网 IPv4 接口");
    const dir = mkdtempSync(join(tmpdir(), "hoox-session-tls-"));
    try {
      const key = join(dir, "key.pem");
      const cert = join(dir, "cert.pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          `subjectAltName=IP:${address}`,
        ],
        { stdio: "ignore" },
      );
      const pem = readFileSync(cert, "utf8");
      server.setSecureContext({ key: readFileSync(key), cert: pem });
      setDefaultCACertificates([...previousCAs, pem]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    server.on("request", async (req, res) => {
      if (req.socket.remoteAddress !== address) {
        res.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? "", path: req.url ?? "", body, headers: req.headers });
      onRequest();
      if (disconnect) {
        res.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/mcp"
            ? {
                jsonrpc: "2.0",
                id: JSON.parse(body.toString()).id,
                result: { content: [{ type: "text", text: `MCP 找到 ${credential}` }] },
              }
            : { answer: "HTTP 找到", echo: credential },
        ),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, address, resolve);
    });
    origin = `https://${address}:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    setDefaultCACertificates(previousCAs);
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  beforeEach(() => {
    requests.length = 0;
    onRequest = () => {};
    disconnect = false;
  });
  it("MCP 与 HTTP 凭据回显均被扣留，签名身份来自 ExecutionScope", async () => {
    requests.length = 0;
    onRequest = () => {};
    const versions = [version("mcp", origin), version("http", origin)];
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(seed("external-services", versions));
    const { faux, sessions, receipts } = await pi(reader(versions));
    const args = { runId: "模型提供的非可信 Run" };
    let results: unknown[] = [];
    faux.setResponses([
      toolCall("mcp__catalog__lookup", args, "call-mcp"),
      toolCall("http__lookup", args, "call-http"),
      (ctx) => {
        results = ctx.messages.filter((m) => m.role === "toolResult");
        return fauxAssistantMessage("完成");
      },
    ]);
    expect(await worker(persistence, sessions).execute(scope)).toEqual({ outcome: "succeeded" });
    expect(requests.map((r) => r.path)).toEqual(["/mcp", "/http"]);
    const [mcp, http] = requests;
    if (!mcp || !http) throw new Error("缺少外部请求");
    expect(JSON.parse(mcp.body.toString())).toMatchObject({
      method: "tools/call",
      params: { name: "catalog.lookup", arguments: args },
    });
    expect(mcp.headers.authorization === `Bearer ${credential}`).toBe(true);
    expect(http.method).toBe("POST");
    expect(JSON.parse(http.body.toString())).toEqual(args);
    expect(
      verifyHttpToolSignature({ ...http, key: deriveHttpToolSigningKey(credential, "http-v1") }),
    ).toBe(true);
    const key = hkdfSync("sha256", rootKey, "hoox-http-identity-v1", "tool-version:http-v1", 32);
    for (const [field, value] of Object.entries({
      tenant: scope.tenantId,
      thread: scope.threadId,
      run: scope.runId,
      "end-user": "",
    })) {
      expect(
        http.headers[`x-hoox-${field}`] ===
          createHmac("sha256", Buffer.from(key))
            .update(`hoox-context-v1\n${field}\n${value}`)
            .digest("hex"),
      ).toBe(true);
    }
    expect(results).toMatchObject([
      {
        toolCallId: "call-mcp",
        isError: false,
        content: [
          { type: "text", text: "外部工具调用已成功，但响应疑似包含凭据，正文已扣留，请勿重试。" },
        ],
      },
      {
        toolCallId: "call-http",
        isError: false,
        content: [
          { type: "text", text: "外部工具调用已成功，但响应疑似包含凭据，正文已扣留，请勿重试。" },
        ],
      },
    ]);
    expect(JSON.stringify(results)).not.toContain(credential);
    expect(receipts).toEqual([
      {
        callId: "call-mcp",
        receipt: encodeControlledToolReceipt("mcp__catalog__lookup", "succeeded"),
      },
      { callId: "call-http", receipt: encodeControlledToolReceipt("http__lookup", "succeeded") },
    ]);
  });
  it("首个调用执行期间撤销版本，在 turn 安全点终止而不再调用外部服务", async () => {
    requests.length = 0;
    const available = [version("mcp", origin)];
    let revoked = false;
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(seed("external-revoked", available));
    onRequest = () => {
      revoked = true;
    };
    const { faux, sessions, receipts } = await pi({
      read: async (input) => {
        if (revoked) throw new ExternalToolSnapshotError("EXTERNAL_TOOL_REVOKED");
        return reader(available).read(input);
      },
    });
    faux.setResponses([
      toolCall("mcp__catalog__lookup", { runId: "first" }, "call-first"),
      toolCall("mcp__catalog__lookup", { runId: "second" }, "call-second"),
    ]);
    expect(await worker(persistence, sessions).execute(scope)).toEqual({ outcome: "failed" });
    expect(persistence.record(scope).events).toContainEqual(
      expect.objectContaining({
        kind: "attempt_state_changed",
        payload: expect.objectContaining({ code: "EXTERNAL_TOOL_REVOKED" }),
      }),
    );
    expect(requests).toHaveLength(1);
    expect(receipts).toEqual([
      {
        callId: "call-first",
        receipt: encodeControlledToolReceipt("mcp__catalog__lookup", "succeeded"),
      },
    ]);
    expect(faux.state.callCount).toBe(1);
  });
  it.each(["mcp", "http"] as const)(
    "PTC 的 %s 子调用复用同名 durable 前驱且仅消费一次许可",
    async (source) => {
      const snapshot = version(source, origin);
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(seed("external-ptc", [snapshot], [], undefined, "ptc"));
      const { faux, sessions, starts, receipts } = await pi(reader([snapshot]), "ptc");
      faux.setResponses([
        toolCall(
          "run_code",
          { code: `return await tools.${snapshot.tool.modelToolName}({runId: "ptc"});` },
          "program",
        ),
        fauxAssistantMessage("完成"),
      ]);
      expect(await worker(persistence, sessions).execute(scope)).toEqual({ outcome: "succeeded" });
      expect(requests).toHaveLength(1);
      const predecessors = starts.filter((call) => call.toolName === snapshot.tool.modelToolName);
      expect(predecessors).toHaveLength(1);
      const [predecessor] = predecessors;
      const permits = persistence.permits.filter(
        ({ permit }) => permit.toolVersionId === snapshot.tool.toolVersionId,
      );
      expect(permits).toHaveLength(1);
      expect(permits[0]).toMatchObject({
        consumed: true,
        permit: { callId: predecessor?.toolCallId },
      });
      expect(receipts.filter((call) => call.callId === predecessor?.toolCallId)).toHaveLength(1);
    },
  );
  it("根 Agent 断连后立即撤销仍持久保留 UNKNOWN，且不再发起副作用", async () => {
    disconnect = true;
    let revoked = false;
    const published = version("http", origin);
    const snapshot = {
      ...published,
      tool: { ...published.tool, sideEffect: "write" as const, idempotent: false },
    };
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(seed("external-unknown-revoked", [snapshot]));
    const { faux, sessions, receipts } = await pi({
      read: async () => {
        if (revoked) throw new ExternalToolSnapshotError("EXTERNAL_TOOL_REVOKED");
        return [snapshot];
      },
    });
    onRequest = () => {
      revoked = true;
    };
    faux.setResponses([
      toolCall("http__lookup", { runId: "first" }, "unknown-call"),
      toolCall("http__lookup", { runId: "forbidden" }, "forbidden-call"),
    ]);
    expect(await worker(persistence, sessions).execute(scope)).toEqual({
      outcome: "recovery_required",
      code: "EXTERNAL_TOOL_RESULT_UNKNOWN",
    });
    expect(persistence.record(scope).attempt?.status).toBe("recovery_required");
    expect(
      persistence
        .record(scope)
        .events.filter((event) => event.kind === "attempt_state_changed")
        .at(-1),
    ).toMatchObject({
      payload: { status: "recovery_required", code: "EXTERNAL_TOOL_RESULT_UNKNOWN" },
    });
    expect(requests).toHaveLength(1);
    expect(receipts).toEqual([]);
    expect(faux.state.callCount).toBe(1);
  });
  it("子 Agent 断连使根 Attempt 待对账，不发布普通子任务失败或继续父 Agent 副作用", async () => {
    disconnect = true;
    const published = version("http", origin);
    const snapshot = {
      ...published,
      tool: { ...published.tool, sideEffect: "write" as const, idempotent: false },
    };
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(
      seed("external-child-unknown", [snapshot], ["spawn_agent", "wait_agent"]),
    );
    const control = childConversations();
    const settle = vi.spyOn(control.port, "settleTurn");
    const mailbox = vi.spyOn(control.port, "appendMailbox");
    const { faux, sessions } = await pi(reader([snapshot]));
    const next = (ctx: Context) =>
      ctx.tools?.some((tool) => tool.name === "spawn_agent")
        ? toolCall("wait_agent", { after_sequence: 0, timeout_ms: 1000 }, "wait-child")
        : toolCall("http__lookup", { runId: "child" }, "child-unknown");
    faux.setResponses([
      toolCall(
        "spawn_agent",
        {
          task: "执行写入",
          tools: [],
          fork_turns: "none",
          external_tool_version_ids: [snapshot.tool.toolVersionId],
        },
        "spawn-child",
      ),
      next,
      next,
      toolCall("http__lookup", { runId: "forbidden" }, "forbidden-root-call"),
    ]);
    expect(await worker(persistence, sessions, control.port).execute(scope)).toEqual({
      outcome: "recovery_required",
      code: "EXTERNAL_TOOL_RESULT_UNKNOWN",
    });
    expect(persistence.record(scope).attempt?.status).toBe("recovery_required");
    expect(requests).toHaveLength(1);
    expect(settle).not.toHaveBeenCalled();
    expect(mailbox.mock.calls.some(([call]) => call.kind === "error")).toBe(false);
    expect(persistence.permits.some(({ permit }) => permit.callId === "forbidden-root-call")).toBe(
      false,
    );
  });
  it.each(["initial", "turn"] as const)(
    "%s 快照读取不可用进入持久恢复而不标记撤销",
    async (point) => {
      const snapshot = version("mcp", origin);
      let reads = 0;
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(seed("external-unavailable", [snapshot]));
      const { faux, sessions } = await pi({
        read: async () => {
          reads += 1;
          if (point === "initial" || reads > 1) throw new Error("临时连接失败");
          return [snapshot];
        },
      });
      faux.setResponses([
        toolCall("mcp__catalog__lookup", { runId: "first" }, "first"),
        fauxAssistantMessage("不能继续"),
      ]);
      expect(await worker(persistence, sessions).execute(scope)).toEqual({
        outcome: "recovery_required",
        code: "PERSISTENCE_UNAVAILABLE",
      });
      expect(persistence.record(scope).attempt?.status).toBe("recovery_required");
      expect(
        persistence
          .record(scope)
          .events.filter((event) => event.kind === "attempt_state_changed")
          .at(-1),
      ).toMatchObject({ payload: { code: "PERSISTENCE_UNAVAILABLE" } });
      expect(requests).toHaveLength(point === "initial" ? 0 : 1);
    },
  );
  it("快照缺失不是撤销证据，以无效快照终止且不发包", async () => {
    const snapshot = version("mcp", origin);
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(seed("external-missing", [snapshot]));
    const { sessions } = await pi(reader([]));
    expect(await worker(persistence, sessions).execute(scope)).toEqual({ outcome: "failed" });
    expect(
      persistence
        .record(scope)
        .events.filter((event) => event.kind === "attempt_state_changed")
        .at(-1),
    ).toMatchObject({ payload: { status: "failed", code: "EXTERNAL_TOOL_SNAPSHOT_INVALID" } });
    expect(requests).toHaveLength(0);
  });
  it("发包前最终消费确认已撤销时，只保留失败回执且不发包", async () => {
    const snapshot = version("http", origin);
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(seed("external-revoke-before-consume", [snapshot]));
    const consume = persistence.consumeExternalEffectPermit.bind(persistence);
    vi.spyOn(persistence, "consumeExternalEffectPermit").mockImplementation(async (input) =>
      input.permit.toolVersionId === snapshot.tool.toolVersionId
        ? { outcome: "external_tool_revoked" }
        : consume(input),
    );
    const { faux, sessions, receipts } = await pi(reader([snapshot]));
    faux.setResponses([
      toolCall("http__lookup", { runId: "not-sent" }, "revoked-call"),
      fauxAssistantMessage("不应采样"),
    ]);
    expect(await worker(persistence, sessions).execute(scope)).toEqual({ outcome: "failed" });
    expect(
      persistence
        .record(scope)
        .events.filter((event) => event.kind === "attempt_state_changed")
        .at(-1),
    ).toMatchObject({ payload: { code: "EXTERNAL_TOOL_REVOKED" } });
    expect(requests).toHaveLength(0);
    expect(receipts).toEqual([
      { callId: "revoked-call", receipt: encodeControlledToolReceipt("http__lookup", "failed") },
    ]);
    expect(faux.state.callCount).toBe(1);
  });
});

describe("按 Run 快照重建 Pi Session", () => {
  it.each([false, true])(
    "恢复 Attempt 的工具与能力清单保持字节一致（重启 Worker：%s）",
    async (restart) => {
      const catalog = [version("mcp"), version("http")];
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(seed("external-resume", catalog));
      const initial = await pi(reader(catalog));
      const samples: { names: string[]; schemaBytes: string; manifest?: string }[] = [];
      function observe(ctx: Context) {
        const manifest = ctx.systemPrompt?.match(
          /<CAPABILITY_MANIFEST [^>]*>[\s\S]*?<\/CAPABILITY_MANIFEST>/u,
        )?.[0];
        samples.push({
          names: externalNames(ctx),
          schemaBytes: JSON.stringify(ctx.tools),
          ...(manifest && { manifest }),
        });
        return fauxAssistantMessage("请确认范围");
      }
      initial.faux.setResponses([observe]);
      // Pi 尚无等待输入的工具；只替换首轮的退出原因，让 Worker 自己持久化检查点并领取后续 Attempt。
      let first = true;
      const firstWorker = worker(persistence, {
        create: async (input) => {
          const session = await initial.sessions.create(input);
          if (!first) return session;
          first = false;
          return {
            ...session,
            runPrompt: async (...args) => {
              const result = await session.runPrompt(...args);
              if (result.kind !== "completed") return result;
              return {
                kind: "waiting",
                question: "请确认范围",
                rolloutProjection: {
                  schemaVersion: 2,
                  checkpointId: "external-wait",
                  items: [{ kind: "turn", role: "assistant", text: "请确认范围" }],
                },
              };
            },
          };
        },
      });
      expect(await firstWorker.execute(scope)).toEqual({ outcome: "waiting" });
      const before = persistence.record(scope).attempt?.attemptId;
      catalog.reverse();
      const published = version("http", undefined, "http-v2");
      catalog.push({ ...published, tool: { ...published.tool, description: "同名工具的新版本" } });
      const resumed = restart ? await pi(reader(catalog)) : initial;
      resumed.faux.setResponses([observe]);
      persistence.setAnswer(scope, "已确认");
      expect(
        await (restart ? worker(persistence, resumed.sessions) : firstWorker).execute(scope),
      ).toEqual({ outcome: "succeeded" });
      const after = persistence.record(scope).attempt?.attemptId;
      if (!before || !after) throw new Error("缺少 Attempt");
      expect(after).not.toBe(before);
      expect(samples).toHaveLength(2);
      expect(samples[0]?.names).toEqual(["http__lookup", "mcp__catalog__lookup"]);
      for (const name of samples[0]?.names ?? [])
        expect(samples[0]?.manifest).toContain(`- id="${name}"`);
      expect(samples[1]).toEqual(samples[0]);
      expect(initial.manifestHashes.get(before)).toBeTruthy();
      expect(resumed.manifestHashes.get(after)).toBe(initial.manifestHashes.get(before));
    },
  );
});

function childConversations() {
  const conversations: SubAgentConversationSnapshot[] = [];
  let sequence = 0;
  const port: AgentControlPersistencePort = {
    initializeRoot: async () => ({ outcome: "ready", conversations }),
    spawn: async ({ snapshot }) => {
      conversations.push({ ...snapshot, currentTask: snapshot.task });
      return { outcome: "created", snapshot };
    },
    startTurn: async () => "started",
    settleTurn: async () => "settled",
    queueFollowUp: async () => "created",
    appendMailbox: async () => ({ outcome: "created", sequence: ++sequence }),
    recordCommand: async () => "recorded",
  };
  return { port, conversations };
}

describe("父子 Pi Session 的版本授权", () => {
  const versions = [version("mcp"), version("http")];
  function harness() {
    const persistence = new FakeExecutionPersistence();
    const { port, conversations } = childConversations();
    const builtins = ["spawn_agent", "followup_task"];
    const controlErrors: string[] = [];
    const runChild = async (
      id: string,
      catalog: ExternalToolRuntimeSnapshot[],
      command: ReturnType<typeof toolCall>,
    ) => {
      const scope = persistence.addSeed(seed("external-child", catalog, builtins, runId(id)));
      const { sessions, faux } = await pi(reader(catalog));
      const childNames: string[][] = [];
      const rootNames: string[][] = [];
      // 父工具返回与子模型首轮可并发；由真实 Session 的协作工具区分调用方，而不是假定调度顺序。
      function finish(ctx: Context) {
        if (ctx.tools?.some((t) => t.name === "spawn_agent")) {
          rootNames.push(externalNames(ctx));
          for (const message of ctx.messages) {
            if (message.role === "toolResult" && message.isError) {
              for (const block of message.content)
                if (block.type === "text") controlErrors.push(block.text);
            }
          }
        } else {
          childNames.push(externalNames(ctx));
        }
        return fauxAssistantMessage("完成");
      }
      faux.setResponses([command, finish, finish]);
      expect(await worker(persistence, sessions, port).execute(scope)).toEqual({
        outcome: "succeeded",
      });
      expect(rootNames).toEqual([["http__lookup", "mcp__catalog__lookup"]]);
      return childNames;
    };
    return { runChild, conversations, controlErrors };
  }
  function spawn(toolVersionIds?: string[]) {
    return toolCall(
      "spawn_agent",
      {
        task: "检查授权",
        tools: [],
        fork_turns: "none",
        ...(toolVersionIds === undefined ? {} : { external_tool_version_ids: toolVersionIds }),
      },
      "call-spawn",
    );
  }
  it("未授权的子 Agent 看不到父 Session 的外部工具", async () => {
    const { runChild, conversations } = harness();
    expect(await runChild("run-spawn", versions, spawn())).toEqual([[]]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.externalToolVersionIds ?? []).toEqual([]);
  });
  it("快照外的版本不能被显式下放", async () => {
    const { runChild, conversations, controlErrors } = harness();
    expect(await runChild("run-denied", versions, spawn(["http-v2"]))).toEqual([]);
    expect(conversations).toHaveLength(0);
    expect(controlErrors).toEqual([expect.stringContaining("AGENT_TOOLS_INVALID")]);
  });
  it("跨 Run 复用只保留相同 toolVersionId，不按同名新版本换绑", async () => {
    const { runChild, conversations } = harness();
    expect(await runChild("run-spawn", versions, spawn(["http-v1"]))).toEqual([["http__lookup"]]);
    const [child] = conversations;
    if (!child) throw new Error("缺少子 Agent 快照");
    expect(child.externalToolVersionIds).toEqual(["http-v1"]);
    const followUp = toolCall(
      "followup_task",
      { target: child.agentThreadId, task: "复查授权" },
      "call-followup",
    );
    expect(await runChild("run-same-version", versions, followUp)).toEqual([["http__lookup"]]);
    expect(
      await runChild(
        "run-new-version",
        [version("mcp"), version("http", undefined, "http-v2")],
        followUp,
      ),
    ).toEqual([[]]);
  });
});
