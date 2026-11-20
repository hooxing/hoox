import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  Provider,
} from "@earendil-works/pi-ai";
import {
  type Attributes,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { ExecutionScope, RuntimeEventV1, RuntimeMutation } from "../ports.js";
import type { RunWorkerResult } from "../run-worker.js";
import type { TelemetryConfiguration } from "./configuration.js";
import {
  captureModelInput,
  captureModelOutput,
  CONTENT_MAX_BYTES,
  encodeContent,
  encodeToolResult,
} from "./content.js";
import { createOtlpExporters, EXPORT_TIMEOUT_MS, type TelemetryExporters } from "./otlp.js";

const SERVICE = "hoox-agent-worker";
const MAX_ACTIVE_TOOLS = 128;
const SHUTDOWN_TIMEOUT_MS = 3000;

type Result = "success" | "failure" | "unknown";
type TerminalRun = "succeeded" | "failed" | "cancelled";
type Tool = { span?: Span; args?: string; result?: string; unknown?: true };

interface Attempt {
  readonly id: string;
  readonly span: Span;
  readonly startedAt: number;
  readonly attributes: Attributes;
  readonly tools?: Map<string, Tool>;
  readonly closeModelSpans?: Set<Span>;
  terminal?: TerminalRun;
  lastToolSequence: number;
  closed: boolean;
}

export function createWorkerTelemetry(
  configuration: TelemetryConfiguration,
  exporters?: TelemetryExporters,
): WorkerTelemetry {
  return new WorkerTelemetry(configuration, exporters);
}

export class WorkerTelemetry {
  readonly #attempts = new AsyncLocalStorage<Attempt>();
  readonly #instrumented = new WeakSet<Models>();
  readonly #tracerProvider: TracerProvider;
  readonly #meterProvider: MeterProvider;
  readonly #tracer: Tracer;
  readonly #runCount;
  readonly #runFailures;
  readonly #attemptCount;
  readonly #attemptDuration;
  readonly #modelDuration;
  readonly #inputTokens;
  readonly #outputTokens;
  readonly #unsent;
  readonly contentEnabled: boolean;

  constructor(configuration: TelemetryConfiguration, exporters?: TelemetryExporters) {
    const resource = resourceFromAttributes({ "service.name": SERVICE });
    const { traces, metrics } =
      exporters ??
      createOtlpExporters(configuration, (signal, reason, count) => {
        this.#unsent.add(count, {
          signal,
          reason,
          unit: signal === "traces" ? "span" : reason === "rejected" ? "data_point" : "batch",
        });
      });
    this.#meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metrics,
          exportIntervalMillis: 15_000,
          exportTimeoutMillis: EXPORT_TIMEOUT_MS + 200,
        }),
      ],
    });
    this.#tracerProvider = new TracerProvider({
      resource,
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(configuration.sampleRate),
      }),
      spanLimits: { attributeValueLengthLimit: CONTENT_MAX_BYTES },
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: traces,
          maxQueueSize: 1024,
          maxExportBatchSize: 64,
          scheduledDelayMillis: 1000,
          exportTimeoutMillis: EXPORT_TIMEOUT_MS + 200,
          selfObsMeterProvider: this.#meterProvider,
        }),
      ],
    });
    this.#tracer = this.#tracerProvider.getTracer(SERVICE);
    const meter = this.#meterProvider.getMeter(SERVICE);
    this.#runCount = meter.createCounter("hoox.run.completed", { unit: "{run}" });
    this.#runFailures = meter.createCounter("hoox.run.failed", { unit: "{run}" });
    this.#attemptCount = meter.createCounter("hoox.run.attempt.completed", { unit: "{attempt}" });
    this.#attemptDuration = meter.createHistogram("gen_ai.invoke_agent.duration", {
      unit: "s",
      advice: { explicitBucketBoundaries: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300] },
    });
    this.#modelDuration = meter.createHistogram("gen_ai.client.inference.duration", {
      unit: "s",
      advice: {
        explicitBucketBoundaries: [
          0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
        ],
      },
    });
    this.#inputTokens = meter.createCounter("gen_ai.client.inference.usage.input_tokens", {
      unit: "{token}",
    });
    this.#outputTokens = meter.createCounter("gen_ai.client.inference.usage.output_tokens", {
      unit: "{token}",
    });
    this.#unsent = meter.createCounter("hoox.otel.export.unsent");
    this.contentEnabled = configuration.contentEnabled;
  }

  async runAttempt(
    scope: ExecutionScope,
    id: string,
    execute: () => Promise<RunWorkerResult>,
  ): Promise<RunWorkerResult> {
    const attributes = {
      "hoox.run.id": scope.runId,
      "hoox.attempt.id": id,
      "hoox.thread.id": scope.threadId,
      "hoox.tenant.id": scope.tenantId,
      "gen_ai.conversation.id": scope.threadId,
    };
    const attempt = safely((): Attempt => {
      const span = this.#tracer.startSpan(
        "invoke_agent",
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            ...attributes,
            "gen_ai.operation.name": "invoke_agent",
          },
        },
        ROOT_CONTEXT,
      );
      return {
        id,
        span,
        startedAt: performance.now(),
        attributes,
        ...(span.isRecording() ? { tools: new Map(), closeModelSpans: new Set() } : {}),
        closed: false,
        lastToolSequence: -1,
      };
    });
    if (attempt === undefined) return await execute();
    let result: RunWorkerResult | undefined;
    try {
      result = await this.#attempts.run(attempt, execute);
      return result;
    } finally {
      attempt.closed = true;
      const outcome = attempt.terminal ?? result?.outcome ?? "unknown";
      const category =
        outcome === "succeeded" || outcome === "waiting"
          ? "success"
          : outcome === "failed" || outcome === "cancelled"
            ? "failure"
            : "unknown";
      safely(() => {
        for (const { span } of attempt.tools?.values() ?? []) if (span) finish(span, "unknown");
        attempt.tools?.clear();
        for (const span of attempt.closeModelSpans ?? []) finish(span, "unknown");
        attempt.closeModelSpans?.clear();
        const labels = { "hoox.attempt.outcome": outcome, "hoox.outcome": category };
        attempt.span.setAttributes(labels);
        finish(attempt.span, category);
        this.#attemptCount.add(1, labels);
        this.#attemptDuration.record((performance.now() - attempt.startedAt) / 1000, {
          ...labels,
          "gen_ai.operation.name": "invoke_agent",
          ...(category === "success" ? {} : { "error.type": category }),
        });
        if (attempt.terminal !== undefined) {
          this.#runCount.add(1, { "hoox.run.status": attempt.terminal });
          if (attempt.terminal === "failed") this.#runFailures.add(1);
        }
      });
    }
  }

  recordMutation(
    attemptId: string,
    events: readonly RuntimeEventV1[],
    runStatus: RuntimeMutation["nextRunStatus"],
  ): void {
    const attempt = this.#current(attemptId);
    if (!attempt) return;
    if (runStatus === "succeeded" || runStatus === "failed" || runStatus === "cancelled")
      attempt.terminal = runStatus;
    if (!attempt.tools) return;
    safely(() => {
      for (const event of events) {
        if (event.kind !== "agent_event") continue;
        const tool = event.payload;
        if (tool.type !== "tool.started" && tool.type !== "tool.completed") continue;
        // 幂等读回仍可确认首次提交；已经观察过的序号不可再次生成 Span。
        if (event.sequence <= attempt.lastToolSequence) continue;
        attempt.lastToolSequence = event.sequence;
        if (tool.type === "tool.started") {
          const state = this.#tool(attempt, tool.callId);
          if (!state) {
            this.#unsent.add(1, { signal: "traces", reason: "active_tools_full", unit: "span" });
            continue;
          }
          if (state.span) continue;
          state.span = this.#tracer.startSpan(
            `execute_tool ${tool.name}`,
            {
              kind: SpanKind.INTERNAL,
              attributes: {
                ...attempt.attributes,
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": tool.name,
                "gen_ai.tool.type": "function",
                "gen_ai.tool.call.id": tool.callId,
              },
            },
            trace.setSpan(ROOT_CONTEXT, attempt.span),
          );
        } else {
          const state = attempt.tools?.get(tool.callId);
          attempt.tools?.delete(tool.callId);
          if (!state?.span) continue;
          if (state.args !== undefined)
            state.span.setAttribute("gen_ai.tool.call.arguments", state.args);
          const outcome = state.unknown === true ? "unknown" : tool.isError ? "failure" : "success";
          if (outcome === "success" && state.result !== undefined)
            state.span.setAttribute("gen_ai.tool.call.result", state.result);
          finish(state.span, outcome);
        }
      }
    });
  }

  markToolUnknown(attemptId: string, callId: string): void {
    const attempt = this.#current(attemptId);
    if (!attempt?.tools) return;
    safely(() => {
      const tool = this.#tool(attempt, callId);
      if (tool !== undefined) tool.unknown = true;
    });
  }

  captureToolBody(attemptId: string, callId: string, kind: "args" | "result", body: unknown): void {
    if (!this.contentEnabled) return;
    const attempt = this.#current(attemptId);
    if (!attempt?.tools) return;
    safely(() => {
      const tool = this.#tool(attempt, callId);
      if (tool === undefined) return;
      const content = kind === "args" ? encodeContent(body) : encodeToolResult(body);
      if (content !== undefined) tool[kind] = content;
    });
  }

  instrumentModelRuntime(runtime: Models, model: Model<Api>): void {
    if (
      this.#instrumented.has(runtime) ||
      !("setProvider" in runtime) ||
      typeof runtime.setProvider !== "function"
    )
      return;
    const provider = runtime.getProvider(model.provider);
    if (provider === undefined) return;
    // 在绑定可信模型快照之前装饰同一 Provider；认证、路由、参数和返回的流对象保持不变。
    const instrumented: Provider = {
      ...provider,
      stream: (selected, context, options) =>
        this.#observeModel(selected, context, () => provider.stream(selected, context, options)),
      streamSimple: (selected, context, options) =>
        this.#observeModel(selected, context, () =>
          provider.streamSimple(selected, context, options),
        ),
    };
    runtime.setProvider(instrumented);
    this.#instrumented.add(runtime);
  }

  #observeModel<T extends { result(): Promise<AssistantMessage> }>(
    model: Model<Api>,
    context: Context,
    invoke: () => T,
  ): T {
    const attempt = this.#current();
    if (!attempt) return invoke();
    const startedAt = performance.now();
    const attributes = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": model.provider,
      "gen_ai.request.model": model.id,
    };
    const span = safely(() => {
      const child = attempt.span.isRecording()
        ? this.#tracer.startSpan(
            `chat ${model.id}`,
            {
              kind: SpanKind.CLIENT,
              attributes: { ...attempt.attributes, ...attributes },
            },
            trace.setSpan(ROOT_CONTEXT, attempt.span),
          )
        : undefined;
      if (child !== undefined) {
        attempt.closeModelSpans?.add(child);
        if (this.contentEnabled) safely(() => captureModelInput(child, context));
      }
      return child;
    });
    const settle = (message?: AssistantMessage) => {
      if (attempt.closed) return;
      const outcome: Result =
        message === undefined || message.stopReason === "aborted"
          ? "unknown"
          : message.stopReason === "error" || message.errorMessage
            ? "failure"
            : "success";
      const responseModel = message?.responseModel;
      const labels = {
        ...attributes,
        ...(responseModel === undefined ? {} : { "gen_ai.response.model": responseModel }),
        ...(outcome === "success" ? {} : { "error.type": outcome }),
      };
      this.#modelDuration.record((performance.now() - startedAt) / 1000, labels);
      if (message !== undefined) {
        const { usage } = message;
        // Pi 的 input 不含缓存命中与写入，GenAI input_tokens 包含所有输入 Token。
        const input = usage.input + usage.cacheRead + usage.cacheWrite;
        if (input + usage.output > 0) {
          for (const [type, count] of [
            ["input", input],
            ["output", usage.output],
          ] as const) {
            if (!Number.isSafeInteger(count) || count < 0) continue;
            (type === "input" ? this.#inputTokens : this.#outputTokens).add(count, labels);
            span?.setAttribute(`gen_ai.usage.${type}_tokens`, count);
          }
        }
        const finishReason = message.stopReason === "toolUse" ? "tool_calls" : message.stopReason;
        if (span !== undefined) {
          span.setAttributes({ ...labels, "gen_ai.response.finish_reasons": [finishReason] });
          if (usage.cacheRead > 0)
            span.setAttribute("gen_ai.usage.cache_read.input_tokens", usage.cacheRead);
          if (usage.cacheWrite > 0)
            span.setAttribute("gen_ai.usage.cache_write.input_tokens", usage.cacheWrite);
          if (this.contentEnabled) safely(() => captureModelOutput(span, message, finishReason));
        }
      }
      if (span !== undefined) {
        attempt.closeModelSpans?.delete(span);
        finish(span, outcome);
      }
    };
    let stream: T;
    try {
      stream = invoke();
    } catch (error) {
      safely(() => settle());
      throw error;
    }
    // 只旁听最终结果，不消费事件流或改变 Provider 异常传播。
    safely(
      () =>
        void stream.result().then(
          (message) => safely(() => settle(message)),
          () => safely(() => settle()),
        ),
    );
    return stream;
  }

  #current(attemptId?: string): Attempt | undefined {
    const attempt = this.#attempts.getStore();
    return attempt?.closed === false && (attemptId === undefined || attempt.id === attemptId)
      ? attempt
      : undefined;
  }

  #tool(attempt: Attempt, id: string): Tool | undefined {
    const tools = attempt.tools;
    if (!tools) return undefined;
    const existing = tools.get(id);
    if (existing !== undefined) return existing;
    if (tools.size >= MAX_ACTIVE_TOOLS) return undefined;
    const tool = {};
    tools.set(id, tool);
    return tool;
  }

  async flush(): Promise<void> {
    await this.#tracerProvider.forceFlush({ timeoutMillis: SHUTDOWN_TIMEOUT_MS });
    await this.#meterProvider.forceFlush();
  }

  async close(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const shutdown = async () => {
        await this.#tracerProvider.shutdown().catch(() => undefined);
        await this.#meterProvider.shutdown().catch(() => undefined);
      };
      await Promise.race([
        shutdown(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function finish(span: Span, result: Result): void {
  span.setAttribute("hoox.outcome", result);
  if (result !== "success") {
    span.setAttribute("error.type", result);
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

function safely<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    return undefined;
  }
}
