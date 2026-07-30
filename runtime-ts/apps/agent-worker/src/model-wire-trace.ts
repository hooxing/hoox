import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type ModelWirePart = "request" | "response";
export type ModelWireCaptureStatus = "complete" | "truncated" | "aborted" | "failed";

export interface ModelWireTraceContext {
  readonly tenantId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly attemptId: string;
}

export interface ModelWireTraceRecord {
  readonly context: ModelWireTraceContext;
  readonly modelTurn: number;
  readonly transportAttempt: number;
  readonly part: ModelWirePart;
  readonly body: Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly status: ModelWireCaptureStatus;
  readonly httpStatus?: number;
}

/**
 * 这个端口故意不接受请求头。模型密钥只允许停留在 HTTP transport，不能通过诊断面、普通日志
 * 或 Blob 索引流转。实现失败仅记录为诊断状态，绝不能影响模型调用结果。
 */
export interface ModelWireTracePort {
  persist(record: ModelWireTraceRecord): Promise<void>;
  captureFailed(input: {
    readonly context: ModelWireTraceContext;
    readonly modelTurn: number;
    readonly transportAttempt: number;
    readonly part: ModelWirePart;
    readonly code: "CAPTURE_UNAVAILABLE" | "BODY_UNREADABLE";
    readonly httpStatus?: number;
  }): Promise<void>;
}

interface ActiveTrace {
  readonly context: ModelWireTraceContext;
  readonly port: ModelWireTracePort;
  readonly state: TraceState;
  readonly provider: ProviderBoundary;
  readonly maxBytes: number;
  readonly modelTurn: number;
  nextTransportAttempt: number;
}

interface TraceState {
  nextTurn: number;
  readonly tasks: Set<Promise<void>>;
}

interface ProviderBoundary {
  readonly origin: string;
  readonly completionsPath: string;
}

const activeTrace = new AsyncLocalStorage<ActiveTrace>();
let installed = false;
type FetchInput = string | URL | Request;

/**
 * 安装一次受 AsyncLocalStorage 约束的 fetch 包装器。没有 run() 作用域、URL 不属于已验证的
 * Provider Chat Completions 时完全透传，因此 S3、CubeSandbox、就绪探针等请求不会被捕获。
 */
export function installModelWireFetchInstrumentation(): void {
  if (installed) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const current = activeTrace.getStore();
    if (current === undefined || !isChatCompletions(input, init, current.provider))
      return originalFetch(input, init);
    // 只构造这一份 outbound Request：capture 读取 clone，原对象随后交给真实 fetch，二者字节一致。
    const outbound = new Request(input, init);
    const transportAttempt = current.nextTransportAttempt++;
    track(current, captureRequest(current, transportAttempt, outbound));
    let response: Response;
    try {
      response = await originalFetch(outbound);
    } catch (error) {
      // 自定义 AbortSignal reason 不一定是 DOMException；以实际 outbound signal 为最终分类事实。
      track(
        current,
        safeFailure(
          current,
          transportAttempt,
          "response",
          outbound.signal.aborted || isAbort(error) ? "BODY_UNREADABLE" : "CAPTURE_UNAVAILABLE",
        ),
      );
      // 捕获面只旁路记录失败事实，调用方仍收到 Provider transport 的原始 rejection reason。
      throw error;
    }
    // clone() 建立独立消费者；读取从不等待或替换 Provider 实际消费的 Response body。
    track(current, captureResponse(current, transportAttempt, response));
    return response;
  };
  installed = true;
}

export class ModelWireTraceSession {
  private readonly state: TraceState = { nextTurn: 0, tasks: new Set() };
  private readonly provider: ProviderBoundary;

  constructor(
    private readonly port: ModelWireTracePort,
    private readonly maxBytes: number,
    providerBaseUrl: string,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new TypeError("模型网络报文上限无效");
    this.provider = providerBoundary(providerBaseUrl);
  }

  createAttempt(): ModelWireTraceSession {
    return new ModelWireTraceSession(
      this.port,
      this.maxBytes,
      `${this.provider.origin}${this.provider.completionsPath.replace(/\/chat\/completions$/u, "")}`,
    );
  }

  run<T>(context: ModelWireTraceContext, operation: () => T): T {
    assertContext(context);
    return activeTrace.run(
      {
        context: Object.freeze({ ...context }),
        port: this.port,
        state: this.state,
        provider: this.provider,
        maxBytes: this.maxBytes,
        modelTurn: this.state.nextTurn++,
        nextTransportAttempt: 0,
      },
      operation,
    );
  }

  /** Worker 在释放 Session 前调用；只等待既有诊断任务，任何失败都已在包装器中吞没。 */
  async drain(maxWaitMilliseconds = 2_000): Promise<void> {
    if (!Number.isSafeInteger(maxWaitMilliseconds) || maxWaitMilliseconds < 0)
      throw new TypeError("模型网络诊断等待上限无效");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMilliseconds);
      timer.unref?.();
    });
    await Promise.race([
      (async () => {
        while (this.state.tasks.size > 0) await Promise.allSettled([...this.state.tasks]);
      })(),
      deadline,
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function captureRequest(
  trace: ActiveTrace,
  transportAttempt: number,
  outbound: Request,
): Promise<void> {
  try {
    // Request.clone 读取的是 Fetch 即将发送的 application body bytes，不是 onPayload 的对象重建。
    const captured = await readBounded(outbound.clone().body, trace.maxBytes);
    await safePersist(trace, transportAttempt, "request", captured);
  } catch {
    await safeFailure(trace, transportAttempt, "request", "BODY_UNREADABLE");
  }
}

async function captureResponse(
  trace: ActiveTrace,
  transportAttempt: number,
  response: Response,
): Promise<void> {
  try {
    const captured = await readBounded(response.clone().body, trace.maxBytes);
    await safePersist(trace, transportAttempt, "response", captured, response.status);
  } catch (error) {
    await safeFailure(
      trace,
      transportAttempt,
      "response",
      isAbort(error) ? "BODY_UNREADABLE" : "CAPTURE_UNAVAILABLE",
      response.status,
    );
  }
}

async function safePersist(
  trace: ActiveTrace,
  transportAttempt: number,
  part: ModelWirePart,
  captured: { readonly body: Uint8Array; readonly status: ModelWireCaptureStatus },
  httpStatus?: number,
): Promise<void> {
  try {
    await trace.port.persist({
      context: trace.context,
      modelTurn: trace.modelTurn,
      transportAttempt,
      part,
      body: captured.body,
      sha256: createHash("sha256").update(captured.body).digest("hex"),
      size: captured.body.byteLength,
      status: captured.status,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    });
  } catch {
    await safeFailure(trace, transportAttempt, part, "CAPTURE_UNAVAILABLE", httpStatus);
  }
}

async function safeFailure(
  trace: ActiveTrace,
  transportAttempt: number,
  part: ModelWirePart,
  code: "CAPTURE_UNAVAILABLE" | "BODY_UNREADABLE",
  httpStatus?: number,
): Promise<void> {
  try {
    await trace.port.captureFailed({
      context: trace.context,
      modelTurn: trace.modelTurn,
      transportAttempt,
      part,
      code,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    });
  } catch {
    // 诊断面不可用不能篡改模型调用的成功/失败语义。
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ readonly body: Uint8Array; readonly status: ModelWireCaptureStatus }> {
  if (stream === null) return { body: new Uint8Array(), status: "complete" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return { body: concat(chunks, size), status: "complete" };
      const remaining = maxBytes - size;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(next.value.slice(0, remaining));
        size += Math.max(remaining, 0);
        await reader.cancel("模型网络诊断上限");
        return { body: concat(chunks, size), status: "truncated" };
      }
      chunks.push(next.value);
      size += next.value.byteLength;
      if (size === maxBytes) {
        const probe = await reader.read();
        if (probe.done) return { body: concat(chunks, size), status: "complete" };
        await reader.cancel("模型网络诊断上限");
        return { body: concat(chunks, size), status: "truncated" };
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (isAbort(error)) return { body: concat(chunks, size), status: "aborted" };
    throw error;
  }
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isChatCompletions(
  input: FetchInput,
  init: RequestInit | undefined,
  provider: ProviderBoundary,
): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST") return false;
  const value =
    input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
  try {
    const url = new URL(value);
    return (
      url.origin === provider.origin &&
      url.pathname.replace(/\/+$/u, "") === provider.completionsPath
    );
  } catch {
    return false;
  }
}

function providerBoundary(baseUrl: string): ProviderBoundary {
  const url = new URL(baseUrl);
  if (url.username || url.password) throw new TypeError("模型 Provider URL 不得包含凭据");
  return Object.freeze({
    origin: url.origin,
    completionsPath: `${url.pathname.replace(/\/+$/u, "")}/chat/completions`.replace(
      /^$/u,
      "/chat/completions",
    ),
  });
}

function track(trace: ActiveTrace, task: Promise<void>): void {
  trace.state.tasks.add(task);
  void task.finally(() => trace.state.tasks.delete(task));
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : false;
}

function assertContext(context: ModelWireTraceContext): void {
  for (const value of Object.values(context)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value))
      throw new TypeError("模型网络诊断作用域无效");
  }
}
