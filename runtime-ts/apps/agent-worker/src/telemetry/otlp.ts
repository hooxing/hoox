import {
  type ISerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import type { TelemetryConfiguration } from "./configuration.js";

export const EXPORT_TIMEOUT_MS = 1000;
const MAX_ACK_BYTES = 16_384;

export interface TelemetryExporters {
  readonly traces: SpanExporter;
  readonly metrics: PushMetricExporter;
}

type RecordUnsent = (
  signal: "traces" | "metrics",
  reason: "export_failed" | "rejected",
  count: number,
) => void;

export function createOtlpExporters(
  configuration: TelemetryConfiguration,
  recordUnsent: RecordUnsent,
): TelemetryExporters {
  // SDK 负责队列和聚合；传输不读额外环境变量、不跟随重定向，也不透传响应或异常正文。
  const traces: SpanExporter = createExporter(
    configuration,
    "traces",
    ProtobufTraceSerializer,
    (response) => response.partialSuccess?.rejectedSpans,
    (spans) => spans.length,
    recordUnsent,
  );
  const metrics: PushMetricExporter = createExporter(
    configuration,
    "metrics",
    ProtobufMetricsSerializer,
    (response) => response.partialSuccess?.rejectedDataPoints,
    () => 1,
    recordUnsent,
  );
  return { traces, metrics };
}

function createExporter<Request, Response>(
  configuration: TelemetryConfiguration,
  signal: "traces" | "metrics",
  serializer: ISerializer<Request, Response>,
  rejectedCount: (response: Response) => number | undefined,
  failedCount: (request: Request) => number,
  recordUnsent: RecordUnsent,
) {
  const pending = new Set<Promise<void>>();
  const endpoint = `${configuration.endpoint}/v1/${signal}`;
  let stopped = false;
  return {
    export(request: Request, done: (result: { code: 0 | 1 }) => void) {
      if (stopped) return done({ code: 1 });
      const task = Promise.resolve()
        .then(() => send(request))
        .then(
          (rejected) => {
            if (rejected > 0) recordUnsent(signal, "rejected", rejected);
            done({ code: 0 });
          },
          () => {
            recordUnsent(signal, "export_failed", failedCount(request));
            done({ code: 1 });
          },
        );
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
    },
    async forceFlush() {
      await Promise.allSettled(pending);
    },
    async shutdown() {
      stopped = true;
      await Promise.allSettled(pending);
    },
  };

  async function send(request: Request): Promise<number> {
    const body = serializer.serializeRequest(request);
    if (body === undefined) throw new Error();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...configuration.headers, "content-type": "application/x-protobuf" },
      body: Buffer.from(body),
      redirect: "error",
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error();
    }
    if (!response.body) return 0;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_ACK_BYTES) throw new Error();
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (length === 0) return 0;
    const rejected =
      rejectedCount(serializer.deserializeResponse(Buffer.concat(chunks, length))) ?? 0;
    return Number.isSafeInteger(rejected) && rejected > 0 ? rejected : 0;
  }
}
