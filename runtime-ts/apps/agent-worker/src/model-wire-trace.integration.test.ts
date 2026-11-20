import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  installModelWireFetchInstrumentation,
  type ModelWireTracePort,
  type ModelWireTraceRecord,
  ModelWireTraceSession,
} from "./model-wire-trace.js";
import { PiWorkerSessionFactory } from "./pi-session-factory.js";
import { createDevelopmentOpenAiCompatibleModel } from "./process-entry.js";
import { RunWorker } from "./run-worker.js";
import {
  FakeCancellationPort,
  FakeClock,
  FakeExecutionPersistence,
  FakeRecoveryMetrics,
  FakeRevisionVerifier,
  FakeSandboxRegistry,
  fakeSeed,
} from "./testing/fakes.js";

class MemoryWirePort implements ModelWireTracePort {
  readonly records: ModelWireTraceRecord[] = [];
  readonly failures: Parameters<ModelWireTracePort["captureFailed"]>[0][] = [];

  async persist(record: ModelWireTraceRecord): Promise<void> {
    this.records.push(record);
  }

  async captureFailed(input: Parameters<ModelWireTracePort["captureFailed"]>[0]): Promise<void> {
    this.failures.push(input);
  }
}

interface ProviderRequest {
  readonly bodyBytes: Buffer;
  readonly body: Record<string, unknown>;
  readonly authorization: string | undefined;
  readonly cookie: string | undefined;
}

const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all([...servers].map(closeServer));
  servers.clear();
});

describe("模型网络报文真实 Pi transport", () => {
  it("真实 Pi 工具循环仅保存精确请求，回复与模型可见命令结果不依赖原始 SSE 存储", async () => {
    const requests: ProviderRequest[] = [];
    const server = createServer((request, response) => {
      void handleRequest(request, response, async (providerRequest) => {
        requests.push(providerRequest);
        const messages = providerRequest.body.messages as Array<Record<string, unknown>>;
        const hasToolResult = messages.some((message) => message.role === "tool");
        const bytes = hasToolResult
          ? finalTextSse("工具结果已核验")
          : toolCallSse("call-wire-write", "exec_command", {
              cmd: "printf wire-tool-effect > /tmp/wire-trace.txt",
            });
        sendSse(response, bytes);
      });
    });
    const port = await listen(server);
    const traces = new MemoryWirePort();
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed({ ...fakeSeed("wire-loop"), input: "执行网络报文工具循环" });
    const sandboxes = new FakeSandboxRegistry();
    sandboxes.handle.command = async () => {
      sandboxes.handle.files.set("/tmp/wire-trace.txt", "wire-tool-effect");
      return { stdout: "wire-tool-effect\n", stderr: "", exitCode: 0 };
    };
    const worker = await createWorker(port, traces, persistence, sandboxes);

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.authorization === "Bearer test-wire-secret")).toBe(
      true,
    );
    const secondMessages = requests[1]?.body.messages as Array<Record<string, unknown>>;
    const toolResult = secondMessages.find((message) => message.role === "tool");
    expect(toolResult).toMatchObject({ tool_call_id: "call-wire-write" });
    expect(String(toolResult?.content)).toContain('"exit_code":0');
    expect(String(toolResult?.content)).toContain('"stdout":"wire-tool-effect\\n"');
    expect(sandboxes.handle.files.get("/tmp/wire-trace.txt")).toBe("wire-tool-effect");
    expect(JSON.stringify(persistence.record(scope).events)).toContain("工具结果已核验");

    const requestRecords = recordsFor(traces, "request");
    const responseRecords = recordsFor(traces, "response");
    expect(
      requestRecords.map(({ modelTurn, transportAttempt }) => [modelTurn, transportAttempt]),
    ).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(responseRecords).toEqual([]);
    expect(requestRecords.map((record) => Buffer.from(record.body))).toEqual(
      requests.map((request) => request.bodyBytes),
    );
    expect(traces.failures).toEqual([]);
    expect(JSON.stringify({ records: traces.records, failures: traces.failures })).not.toContain(
      "test-wire-secret",
    );
  });

  it("同一 Provider invocation 自动重试时保持 modelTurn，只递增 transportAttempt", async () => {
    let calls = 0;
    const server = createServer((request, response) => {
      void handleRequest(request, response, async () => {
        calls += 1;
        if (calls === 1) {
          response.writeHead(429, {
            "content-type": "application/json",
            "retry-after-ms": "1",
          });
          response.end('{"error":{"message":"retry-once"}}');
          return;
        }
        sendSse(response, finalTextSse("重试成功"));
      });
    });
    const port = await listen(server);
    const traces = new MemoryWirePort();
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed({ ...fakeSeed("wire-retry"), input: "验证自动重试" });
    const worker = await createWorker(port, traces, persistence, new FakeSandboxRegistry(), 1);

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(calls).toBe(2);
    expect(
      recordsFor(traces, "request").map(({ modelTurn, transportAttempt }) => [
        modelTurn,
        transportAttempt,
      ]),
    ).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(recordsFor(traces, "response")).toEqual([]);
  });

  it("两个 Worker Attempt 并发时上下文、modelTurn 与 transportAttempt 完全隔离", async () => {
    const server = createServer((request, response) => {
      void handleRequest(request, response, async (providerRequest) => {
        const serialized = providerRequest.bodyBytes.toString("utf8");
        const marker = serialized.includes("并发任务甲") ? "甲" : "乙";
        await new Promise((resolve) => setTimeout(resolve, marker === "甲" ? 15 : 1));
        sendSse(response, finalTextSse(`并发${marker}完成`));
      });
    });
    const port = await listen(server);
    const traces = new MemoryWirePort();
    installModelWireFetchInstrumentation();
    const { modelRuntime, model } = await createDevelopmentOpenAiCompatibleModel({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-wire-secret",
      modelId: "wire-test-model",
      supportsImages: false,
      contextWindow: 32_768,
      maxOutputTokens: 1_024,
    });
    const sessions = new PiWorkerSessionFactory(
      model,
      modelRuntime,
      observationRecorder,
      undefined,
      undefined,
      new ModelWireTraceSession(traces, 1024 * 1024, `http://127.0.0.1:${port}/v1`),
    );
    const persistence = new FakeExecutionPersistence();
    const scopeA = persistence.addSeed({ ...fakeSeed("wire-concurrent-a"), input: "并发任务甲" });
    const scopeB = persistence.addSeed({ ...fakeSeed("wire-concurrent-b"), input: "并发任务乙" });
    const worker = createRunWorker(persistence, sessions, new FakeSandboxRegistry());

    await expect(Promise.all([worker.execute(scopeA), worker.execute(scopeB)])).resolves.toEqual([
      { outcome: "succeeded" },
      { outcome: "succeeded" },
    ]);

    const requestRecords = recordsFor(traces, "request");
    expect(requestRecords).toHaveLength(2);
    expect(recordsFor(traces, "response")).toEqual([]);
    expect(new Set(requestRecords.map((record) => record.context.runId))).toEqual(
      new Set([scopeA.runId, scopeB.runId]),
    );
    for (const record of requestRecords) {
      const isA = record.context.runId.includes("concurrent-a");
      expect(record.context).toMatchObject({
        tenantId: isA ? scopeA.tenantId : scopeB.tenantId,
        threadId: isA ? scopeA.threadId : scopeB.threadId,
        runId: record.context.runId,
        attemptId: isA ? "attempt-1" : "attempt-2",
      });
      const body = Buffer.from(record.body).toString("utf8");
      expect(body).toContain(isA ? "并发任务甲" : "并发任务乙");
      expect(body).not.toContain(isA ? "并发任务乙" : "并发任务甲");
      expect(record.modelTurn).toBe(0);
      expect(record.transportAttempt).toBe(0);
    }
  });
});

async function createWorker(
  port: number,
  traces: MemoryWirePort,
  persistence: FakeExecutionPersistence,
  sandboxes: FakeSandboxRegistry,
  providerMaxRetries?: number,
): Promise<RunWorker> {
  // OpenAI SDK 在 client 构造时捕获 default fetch，必须先安装诊断包装器。
  installModelWireFetchInstrumentation();
  const { modelRuntime, model } = await createDevelopmentOpenAiCompatibleModel({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-wire-secret",
    modelId: "wire-test-model",
    supportsImages: false,
    contextWindow: 32_768,
    maxOutputTokens: 1_024,
  });
  if (providerMaxRetries !== undefined) {
    const provider = modelRuntime.getProvider(model.provider);
    if (provider === undefined) throw new Error("测试 Provider 未注册");
    const streamSimple = provider.streamSimple;
    // 在同一真实 OpenAI transport invocation 上开启一次 Provider 重试，证明内部重试不会被记成新轮次。
    provider.streamSimple = function retryingStream(currentModel, context, options) {
      return streamSimple.call(this, currentModel, context, {
        ...options,
        maxRetries: providerMaxRetries,
        maxRetryDelayMs: 10,
      });
    };
  }
  const sessions = new PiWorkerSessionFactory(
    model,
    modelRuntime,
    observationRecorder,
    undefined,
    undefined,
    new ModelWireTraceSession(traces, 1024 * 1024, `http://127.0.0.1:${port}/v1`),
  );
  return createRunWorker(persistence, sessions, sandboxes);
}

function createRunWorker(
  persistence: FakeExecutionPersistence,
  sessions: PiWorkerSessionFactory,
  sandboxes: FakeSandboxRegistry,
): RunWorker {
  return new RunWorker(
    {
      persistence,
      revisions: new FakeRevisionVerifier(),
      sandboxes,
      orphanSandboxes: sandboxes,
      sessions,
      cancellation: new FakeCancellationPort(),
      clock: new FakeClock(),
      metrics: new FakeRecoveryMetrics(),
    },
    { workerId: "wire-trace-worker", runTimeoutMs: 30_000 },
  );
}

function observationRecorder(
  _input: Parameters<ConstructorParameters<typeof PiWorkerSessionFactory>[2]>[0],
  outputs: Parameters<ConstructorParameters<typeof PiWorkerSessionFactory>[2]>[1],
) {
  return {
    recordStarted: async () => "recorded" as const,
    record: async (call: { readonly toolCallId: string; readonly toolName: string }) => {
      const observation = await outputs.readControlledReceipt(call);
      return observation === undefined
        ? { outcome: "conflict" as const }
        : { outcome: "recorded" as const, observation, isTruncated: false };
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: ProviderRequest) => Promise<void>,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyBytes = Buffer.concat(chunks);
    await handler({
      bodyBytes,
      body: JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown>,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
  } catch {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
}

function toolCallSse(callId: string, name: string, args: Record<string, unknown>): Buffer {
  return sse([
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: callId,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ]);
}

function finalTextSse(text: string): Buffer {
  return sse([chunk({ role: "assistant", content: text }), chunk({}, "stop")]);
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-wire-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "wire-test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sse(events: readonly Record<string, unknown>[]): Buffer {
  return Buffer.from(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    "utf8",
  );
}

function sendSse(response: ServerResponse, bytes: Buffer): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.end(bytes);
}

function recordsFor(traces: MemoryWirePort, part: "request" | "response"): ModelWireTraceRecord[] {
  return traces.records
    .filter((record) => record.part === part)
    .sort(
      (left, right) =>
        left.modelTurn - right.modelTurn || left.transportAttempt - right.transportAttempt,
    );
}

async function listen(server: Server): Promise<number> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试 Provider 未监听 TCP");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
