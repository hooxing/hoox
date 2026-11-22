import { createServer, type RequestListener } from "node:http";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { transitionRun } from "@hoox/domain";
import { bindTrustedPiModelContextCapability } from "@hoox/pi-adapter";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace";
import { describe, expect, it, vi } from "vitest";
import { PiWorkerSessionFactory } from "../pi-session-factory.js";
import { RunWorker } from "../run-worker.js";
import { fakeAgentSnapshot } from "../testing/agent-snapshot.js";
import {
  FakeCancellationPort,
  FakeClock,
  FakeExecutionPersistence,
  FakeRecoveryMetrics,
  FakeRevisionVerifier,
  FakeSandboxRegistry,
  type FakeSeed,
  fakeSeed,
} from "../testing/fakes.js";
import { assembleWorkerTelemetry, type TelemetryConfiguration } from "./configuration.js";
import { createWorkerTelemetry, type WorkerTelemetry } from "./runtime.js";

const defaultConfiguration: TelemetryConfiguration = {
  endpoint: "https://otel.example.invalid",
  headers: {},
  sampleRate: 1,
  contentEnabled: false,
};

function memoryTelemetry(overrides: Partial<TelemetryConfiguration> = {}) {
  const traces = new InMemorySpanExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = createWorkerTelemetry(
    { ...defaultConfiguration, ...overrides },
    { traces, metrics },
  );
  const metricData = () =>
    metrics
      .getMetrics()
      .at(-1)
      ?.scopeMetrics.flatMap((item) => item.metrics) ?? [];
  return { traces, telemetry, metricData };
}

async function workerRun(
  telemetry: WorkerTelemetry,
  options: {
    key?: string;
    observationUnknown?: boolean;
    providerFails?: boolean;
    seed?: Partial<FakeSeed>;
    rebindModel?: boolean;
  } = {},
) {
  const credentials = new InMemoryCredentialStore();
  const faux = fauxProvider({ provider: "faux-otel-provider", tokensPerSecond: 100_000 });
  faux.setResponses(
    options.providerFails
      ? [
          fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "opaque-provider-error-placeholder",
          }),
        ]
      : [
          fauxAssistantMessage(
            fauxToolCall("exec_command", { cmd: "echo tool-args-canary" }, { id: "call-ok" }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage(fauxToolCall("exec_command", {}, { id: "call-fails-validation" }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("model-output-canary"),
        ],
  );
  await credentials.modify(faux.provider.id, async () => ({
    type: "api_key",
    key: "model-key-placeholder",
  }));
  const modelRuntime = createModels({ credentials });
  modelRuntime.setProvider(faux.provider);
  const model = faux.getModel();
  telemetry.instrumentModelRuntime(modelRuntime, model);
  const persistence = new FakeExecutionPersistence();
  const scope = persistence.addSeed({
    ...fakeSeed(options.key ?? "otel"),
    input: "prompt-canary",
    ...options.seed,
  });
  const sandboxes = new FakeSandboxRegistry();
  const baseSessions = new PiWorkerSessionFactory(
    model,
    modelRuntime,
    () => ({
      recordStarted: async () => "recorded" as const,
      record: async () =>
        options.observationUnknown
          ? { outcome: "unknown" as const }
          : { outcome: "recorded" as const, observation: "", isTruncated: false },
    }),
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
    undefined,
    undefined,
    undefined,
    undefined,
    telemetry,
  );
  const worker = new RunWorker(
    {
      persistence,
      revisions: new FakeRevisionVerifier(),
      sandboxes,
      orphanSandboxes: sandboxes,
      sessions: options.rebindModel
        ? baseSessions.withModel({
            model,
            modelRuntime,
            modelContext: bindTrustedPiModelContextCapability(modelRuntime, model),
            modelWireTraces: undefined,
            prepareRuntimeCompaction: undefined,
          })
        : baseSessions,
      cancellation: new FakeCancellationPort(),
      clock: new FakeClock(),
      metrics: new FakeRecoveryMetrics(),
      telemetry,
    },
    { workerId: "otel-test" },
  );
  return { worker, scope, persistence, model };
}

async function listener(run: RequestListener) {
  const server = createServer(run);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试端口未建立");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

describe("Worker OpenTelemetry", () => {
  it("未启用时不加载 SDK 或构造导出器", async () => {
    const load = vi.fn(async () => {
      throw new Error("未启用时不能加载导出模块");
    });
    await expect(assembleWorkerTelemetry(undefined, load)).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "从真实 Pi 会话和持久事件建立 Attempt Span 树（正文=%s）",
    async (contentEnabled) => {
      const { telemetry, traces, metricData } = memoryTelemetry({ contentEnabled });
      try {
        const { worker, scope, persistence, model } = await workerRun(telemetry);
        await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
        await expect(worker.execute(scope)).resolves.toEqual({
          outcome: "ignored",
          reason: "terminal",
        });
        await telemetry.flush();
        const spans = traces.getFinishedSpans();
        const root = spans.find((span) => span.parentSpanContext === undefined);
        if (!root) throw new Error("缺少 Attempt 根 Span");
        const runIdentifiers = {
          "hoox.tenant.id": scope.tenantId,
          "hoox.thread.id": scope.threadId,
          "hoox.run.id": scope.runId,
          "hoox.attempt.id": persistence.record(scope).attempt?.attemptId,
        };
        expect(root).toMatchObject({
          name: "invoke_agent",
          kind: SpanKind.INTERNAL,
          attributes: {
            ...runIdentifiers,
            "gen_ai.operation.name": "invoke_agent",
            "hoox.outcome": "success",
          },
        });
        const children = spans.filter(
          (span) => span.parentSpanContext?.spanId === root.spanContext().spanId,
        );
        expect(spans).toHaveLength(6);
        expect(children).toHaveLength(5);
        for (const span of children) {
          expect(span.spanContext().traceId).toBe(root.spanContext().traceId);
          expect(span.attributes).toMatchObject(runIdentifiers);
          expect(span.duration[0] * 1e9 + span.duration[1]).toBeGreaterThan(0);
        }
        const calls = children.filter((span) => span.kind === SpanKind.CLIENT);
        expect(calls).toHaveLength(3);
        expect(calls[2]).toMatchObject({
          name: `chat ${model.id}`,
          attributes: {
            "gen_ai.request.model": model.id,
            "gen_ai.provider.name": model.provider,
            "gen_ai.usage.input_tokens": expect.any(Number),
            "gen_ai.usage.output_tokens": expect.any(Number),
            "gen_ai.response.finish_reasons": ["stop"],
            "hoox.outcome": "success",
          },
        });
        const tools = children.filter((span) => span.name === "execute_tool exec_command");
        const success = tools.find((span) => span.attributes["gen_ai.tool.call.id"] === "call-ok");
        expect(success?.attributes).toMatchObject({
          "gen_ai.tool.name": "exec_command",
          "hoox.outcome": "success",
        });
        expect(
          tools.find((span) => span.attributes["gen_ai.tool.call.id"] === "call-fails-validation"),
        ).toMatchObject({
          status: { code: SpanStatusCode.ERROR },
          attributes: { "hoox.outcome": "failure" },
        });
        if (contentEnabled) {
          expect(calls[0]?.attributes["gen_ai.system_instructions"]).toEqual(expect.any(String));
          expect(calls[0]?.attributes["gen_ai.input.messages"]).toContain("prompt-canary");
          expect(calls[2]?.attributes["gen_ai.output.messages"]).toContain("model-output-canary");
          expect(success?.attributes["gen_ai.tool.call.arguments"]).toContain("tool-args-canary");
          expect(success?.attributes["gen_ai.tool.call.result"]).toEqual(expect.any(String));
        } else {
          for (const span of spans) {
            expect(Object.keys(span.attributes)).not.toEqual(
              expect.arrayContaining(["gen_ai.input.messages"]),
            );
            for (const key of [
              "gen_ai.system_instructions",
              "gen_ai.output.messages",
              "gen_ai.tool.call.arguments",
              "gen_ai.tool.call.result",
            ]) {
              expect(span.attributes[key]).toBeUndefined();
            }
          }
        }
        expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(
          "model-key-placeholder",
        );
        expect(metricData().map((metric) => metric.descriptor.name)).toEqual(
          expect.arrayContaining([
            "hoox.run.completed",
            "hoox.run.attempt.completed",
            "gen_ai.invoke_agent.duration",
            "gen_ai.client.inference.usage.input_tokens",
            "gen_ai.client.inference.usage.output_tokens",
            "gen_ai.client.inference.duration",
          ]),
        );
        const counts = metricData().find(
          (metric) => metric.descriptor.name === "hoox.run.completed",
        );
        expect(counts?.dataPoints).toMatchObject([{ value: 1 }]);
        expect(JSON.stringify(metricData())).not.toContain(scope.runId);
      } finally {
        await telemetry.close();
      }
    },
  );

  it("等待中的 Run 按 Agent 快照与 checkpoint 恢复，重建 Session 后保留模型与工具子 Span", async () => {
    const { telemetry, traces } = memoryTelemetry({ contentEnabled: true });
    try {
      const seed = fakeSeed("otel-resumed");
      const running = transitionRun(seed.run, "running", seed.run.updatedAt);
      const { worker, scope, persistence, model } = await workerRun(telemetry, {
        rebindModel: true,
        seed: {
          ...seed,
          run: transitionRun(running, "waiting", running.updatedAt),
          answer: "范围仅限测试",
          agent: fakeAgentSnapshot({ operatorInstructions: "快照指令：只处理测试资料。" }),
          rolloutProjection: {
            ...seed.rolloutProjection,
            items: [
              { kind: "turn", role: "user", text: "生成报告" },
              { kind: "turn", role: "assistant", text: "请确认报告范围" },
            ],
          },
        },
      });

      await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
      await telemetry.flush();
      const spans = traces.getFinishedSpans();
      const roots = spans.filter((span) => span.parentSpanContext === undefined);
      expect(roots).toHaveLength(1);
      const [root] = roots;
      if (!root) throw new Error("缺少恢复 Attempt 根 Span");
      expect(root).toMatchObject({
        name: "invoke_agent",
        attributes: {
          "hoox.attempt.id": persistence.record(scope).attempt?.attemptId,
          "hoox.outcome": "success",
        },
      });
      const children = spans.filter((span) => span !== root);
      expect(children).toHaveLength(5);
      for (const span of children) {
        expect(span.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
        expect(span.spanContext().traceId).toBe(root.spanContext().traceId);
      }
      const firstModelCall = children.find((span) => span.name === `chat ${model.id}`);
      expect(firstModelCall?.attributes["gen_ai.system_instructions"]).toContain(
        "快照指令：只处理测试资料。",
      );
      expect(firstModelCall?.attributes["gen_ai.input.messages"]).toContain("请确认报告范围");
      expect(firstModelCall?.attributes["gen_ai.input.messages"]).toContain("范围仅限测试");
      const tool = children.find((span) => span.attributes["gen_ai.tool.call.id"] === "call-ok");
      expect(tool).toMatchObject({
        name: "execute_tool exec_command",
        attributes: {
          "hoox.outcome": "success",
          "gen_ai.tool.call.arguments": expect.stringContaining("tool-args-canary"),
        },
      });
    } finally {
      await telemetry.close();
    }
  });

  it("配置客户端工具时即便打开正文遥测也只导出元数据", async () => {
    const { telemetry, traces } = memoryTelemetry({ contentEnabled: true });
    try {
      const { worker, scope } = await workerRun(telemetry, {
        seed: {
          agent: fakeAgentSnapshot({
            tools: {
              mode: "configured",
              toolCallingMode: "native",
              builtinTools: ["exec_command"],
              externalTools: [],
              clientTools: [
                {
                  name: "lookup",
                  description: "客户端查询",
                  inputSchema: { type: "object", additionalProperties: false, properties: {} },
                },
              ],
            },
          }),
        },
      });
      expect(await worker.execute(scope)).toEqual({ outcome: "succeeded" });
      await telemetry.flush();
      const spans = traces.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(1);
      for (const { attributes } of spans)
        for (const key of [
          "gen_ai.input.messages",
          "gen_ai.output.messages",
          "gen_ai.tool.call.arguments",
          "gen_ai.tool.call.result",
        ])
          expect(attributes[key]).toBeUndefined();
    } finally {
      await telemetry.close();
    }
  });
  it("Agent 快照无效时只记录失败的 Attempt 根 Span，不执行模型或工具", async () => {
    const { telemetry, traces } = memoryTelemetry();
    try {
      const { worker, scope, persistence } = await workerRun(telemetry, {
        seed: { agent: "AGENT_SNAPSHOT_INVALID" },
      });
      await expect(worker.execute(scope)).resolves.toEqual({ outcome: "failed" });
      await telemetry.flush();
      expect(traces.getFinishedSpans()).toMatchObject([
        {
          name: "invoke_agent",
          parentSpanContext: undefined,
          status: { code: SpanStatusCode.ERROR },
          attributes: {
            "hoox.attempt.id": persistence.record(scope).attempt?.attemptId,
            "hoox.outcome": "failure",
          },
        },
      ]);
    } finally {
      await telemetry.close();
    }
  });

  it("工具回执未知时不把错误回执伪装成确定失败", async () => {
    const { telemetry, traces, metricData } = memoryTelemetry();
    try {
      const { worker, scope } = await workerRun(telemetry, { observationUnknown: true });
      await expect(worker.execute(scope)).resolves.toEqual({
        outcome: "recovery_required",
        code: "PERSISTENCE_UNAVAILABLE",
      });
      await telemetry.flush();
      const spans = traces.getFinishedSpans();
      expect(
        spans.find((span) => span.name === "execute_tool exec_command")?.attributes["hoox.outcome"],
      ).toBe("unknown");
      expect(
        spans.find((span) => span.name === "invoke_agent")?.attributes["hoox.attempt.outcome"],
      ).toBe("recovery_required");
      expect(metricData().map((metric) => metric.descriptor.name)).not.toContain(
        "hoox.run.completed",
      );
    } finally {
      await telemetry.close();
    }
  });

  it("采样率为零时不导出 Span，失败和延迟指标仍记录", async () => {
    const { telemetry, traces, metricData } = memoryTelemetry({ sampleRate: 0 });
    try {
      const { worker, scope } = await workerRun(telemetry, { providerFails: true });
      await expect(worker.execute(scope)).resolves.toEqual({ outcome: "failed" });
      await telemetry.flush();
      expect(traces.getFinishedSpans()).toEqual([]);
      expect(
        metricData().find((metric) => metric.descriptor.name === "hoox.run.failed")?.dataPoints,
      ).toMatchObject([{ value: 1 }]);
      expect(metricData().map((metric) => metric.descriptor.name)).toContain(
        "gen_ai.client.inference.duration",
      );
    } finally {
      await telemetry.close();
    }
  });

  it("并发 Attempt 的 Provider 与工具 Span 各自归属正确的根", async () => {
    const { telemetry, traces } = memoryTelemetry({ contentEnabled: true });
    try {
      const first = await workerRun(telemetry, { key: "otel-concurrent-a" });
      const second = await workerRun(telemetry, { key: "otel-concurrent-b" });
      await expect(
        Promise.all([first.worker.execute(first.scope), second.worker.execute(second.scope)]),
      ).resolves.toEqual([{ outcome: "succeeded" }, { outcome: "succeeded" }]);
      await telemetry.flush();
      const spans = traces.getFinishedSpans();
      expect(spans).toHaveLength(12);
      for (const { scope } of [first, second]) {
        const sameRun = spans.filter((span) => span.attributes["hoox.run.id"] === scope.runId);
        const root = sameRun.find((span) => span.parentSpanContext === undefined);
        expect(sameRun).toHaveLength(6);
        expect(root).toBeDefined();
        for (const child of sameRun.filter((span) => span !== root)) {
          expect(child.parentSpanContext).toEqual(root?.spanContext());
        }
      }
    } finally {
      await telemetry.close();
    }
  });

  it("发送积压时队列有界，溢出的 Span 计数而不阻塞 Attempt", async () => {
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let exported = 0;
    const traces: SpanExporter = {
      export(spans, done) {
        exported += spans.length;
        ready.resolve();
        void release.promise.then(() => done({ code: 0 }));
      },
      shutdown: async () => undefined,
    };
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = createWorkerTelemetry(defaultConfiguration, { traces, metrics });
    const scope = new FakeExecutionPersistence().addSeed(fakeSeed("otel-overflow"));
    try {
      for (let index = 0; index < 64; index++) {
        await telemetry.runAttempt(scope, `initial-${index}`, async () => ({
          outcome: "succeeded",
        }));
      }
      await ready.promise;
      for (let index = 0; index < 1034; index++) {
        await telemetry.runAttempt(scope, `queued-${index}`, async () => ({
          outcome: "succeeded",
        }));
      }
      expect(exported).toBe(64);
      release.resolve();
      await telemetry.flush();
      expect(exported).toBe(1088);
      const processed = metrics
        .getMetrics()
        .at(-1)
        ?.scopeMetrics.flatMap((item) => item.metrics)
        .find((metric) => metric.descriptor.name === "otel.sdk.processor.span.processed");
      expect(processed?.dataPoints).toContainEqual(
        expect.objectContaining({
          value: 10,
          attributes: expect.objectContaining({ "error.type": "queue_full" }),
        }),
      );
    } finally {
      release.resolve();
      await telemetry.close();
    }
  });

  it("导出器关闭挂起时仍在 3 秒预算内返回", async () => {
    const shutdown = vi.fn(() => new Promise<void>(() => undefined));
    vi.useFakeTimers();
    try {
      const telemetry = createWorkerTelemetry(defaultConfiguration, {
        traces: { export: (_spans, done) => done({ code: 0 }), shutdown },
        metrics: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      });
      const closed = vi.fn();
      const pending = telemetry.close().then(closed);
      await vi.advanceTimersByTimeAsync(2999);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(closed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Collector 不可达时 Run 仍提交成功，关闭不传播传输异常", async () => {
    const server = await listener((_request, response) => {
      response.writeHead(200).end();
    });
    await server.close();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const telemetry = createWorkerTelemetry({ ...defaultConfiguration, endpoint: server.endpoint });
    try {
      const { worker, scope, persistence } = await workerRun(telemetry);
      await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
      expect(persistence.record(scope).run.status).toBe("succeeded");
      await expect(telemetry.close()).resolves.toBeUndefined();
      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
        `${server.endpoint}/v1/traces`,
        `${server.endpoint}/v1/metrics`,
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("向 OTLP 路径发送 protobuf，追踪发送失败时指标统计丢弃的 Span", async () => {
    const messages: {
      path: string | undefined;
      type: string | undefined;
      headerMatches: boolean;
      body: Buffer;
    }[] = [];
    const server = await listener((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        messages.push({
          path: request.url,
          type: request.headers["content-type"],
          headerMatches: request.headers.authorization === "Bearer placeholder",
          body: Buffer.concat(chunks),
        });
        response.writeHead(request.url === "/collector/v1/traces" ? 503 : 200).end();
      });
    });
    const telemetry = createWorkerTelemetry({
      ...defaultConfiguration,
      endpoint: `${server.endpoint}/collector`,
      headers: { authorization: "Bearer placeholder" },
    });
    try {
      const { worker, scope } = await workerRun(telemetry);
      await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
      await telemetry.close();
      expect(messages.map(({ path, type, headerMatches }) => [path, type, headerMatches])).toEqual([
        ["/collector/v1/traces", "application/x-protobuf", true],
        ["/collector/v1/metrics", "application/x-protobuf", true],
      ]);
      expect(messages[0]?.body.includes("invoke_agent")).toBe(true);
      expect(messages[1]?.body.includes("hoox.otel.export.unsent")).toBe(true);
      expect(messages[1]?.body.includes("export_failed")).toBe(true);
      expect(messages.some(({ body }) => body.includes("Bearer placeholder"))).toBe(false);
    } finally {
      await server.close();
    }
  });
});
