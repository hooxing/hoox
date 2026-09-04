import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type ModelWirePart = "request" | "response";
export type ModelWireCaptureStatus = "complete" | "truncated" | "aborted" | "failed";

export interface ModelWireTraceContext {
  readonly tenantId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly agentThreadId?: string;
  readonly agentTurnId?: string;
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
  readonly tasks: Set<Promise<void>>;
}

interface TraceTurnAllocator {
  nextTurn: number;
}

interface TraceAttemptAllocator extends TraceTurnAllocator {
  activeSessions: number;
}

interface TraceAttemptAllocators {
  readonly byAttempt: Map<string, TraceAttemptAllocator>;
}

interface TraceAttemptAllocation {
  readonly attemptId: string;
  readonly allocator: TraceAttemptAllocator;
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
    // 回复与工具调用由轨迹事件保留；原始响应不再 clone、旁路消费或持久化。
    return response;
  };
  installed = true;
}

export class ModelWireTraceSession {
  private readonly state: TraceState = { tasks: new Set() };
  private readonly provider: ProviderBoundary;
  private released = false;

  constructor(
    private readonly port: ModelWireTracePort,
    private readonly maxBytes: number,
    providerBaseUrl: string,
    private readonly allocator: TraceTurnAllocator = { nextTurn: 0 },
    private readonly attemptAllocators: TraceAttemptAllocators = { byAttempt: new Map() },
    private readonly attemptAllocation?: TraceAttemptAllocation,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new TypeError("模型网络报文上限无效");
    this.provider = providerBoundary(providerBaseUrl);
  }

  createAttempt(attemptId = "default"): ModelWireTraceSession {
    let allocator = this.attemptAllocators.byAttempt.get(attemptId);
    if (allocator === undefined) {
      allocator = { nextTurn: 0, activeSessions: 0 };
      this.attemptAllocators.byAttempt.set(attemptId, allocator);
    }
    allocator.activeSessions += 1;
    return new ModelWireTraceSession(
      this.port,
      this.maxBytes,
      `${this.provider.origin}${this.provider.completionsPath.replace(/\/chat\/completions$/u, "")}`,
      allocator,
      this.attemptAllocators,
      { attemptId, allocator },
    );
  }

  run<T>(context: ModelWireTraceContext, operation: () => T): T {
    assertModelWireTraceContext(context);
    return activeTrace.run(
      {
        context: Object.freeze({ ...context }),
        port: this.port,
        state: this.state,
        provider: this.provider,
        maxBytes: this.maxBytes,
        modelTurn: this.allocator.nextTurn++,
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

  /** Pi Session dispose 时释放 Attempt allocator；Root 与 Child 都释放后才允许回收。 */
  release(): void {
    if (this.released || this.attemptAllocation === undefined) return;
    this.released = true;
    this.attemptAllocation.allocator.activeSessions -= 1;
    if (
      this.attemptAllocation.allocator.activeSessions === 0 &&
      this.attemptAllocators.byAttempt.get(this.attemptAllocation.attemptId) ===
        this.attemptAllocation.allocator
    ) {
      this.attemptAllocators.byAttempt.delete(this.attemptAllocation.attemptId);
    }
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
    await safePersistRequest(trace, transportAttempt, captured);
  } catch {
    await safeFailure(trace, transportAttempt, "request", "BODY_UNREADABLE");
  }
}

async function safePersistRequest(
  trace: ActiveTrace,
  transportAttempt: number,
  captured: { readonly body: Uint8Array; readonly status: ModelWireCaptureStatus },
): Promise<void> {
  try {
    await trace.port.persist({
      context: trace.context,
      modelTurn: trace.modelTurn,
      transportAttempt,
      part: "request",
      body: captured.body,
      sha256: createHash("sha256").update(captured.body).digest("hex"),
      size: captured.body.byteLength,
      status: captured.status,
    });
  } catch {
    await safeFailure(trace, transportAttempt, "request", "CAPTURE_UNAVAILABLE");
  }
}

async function safeFailure(
  trace: ActiveTrace,
  transportAttempt: number,
  part: ModelWirePart,
  code: "CAPTURE_UNAVAILABLE" | "BODY_UNREADABLE",
): Promise<void> {
  try {
    await trace.port.captureFailed({
      context: trace.context,
      modelTurn: trace.modelTurn,
      transportAttempt,
      part,
      code,
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

export function assertModelWireTraceContext(context: ModelWireTraceContext): void {
  const agentIdentity = [context.agentThreadId, context.agentTurnId];
  if (agentIdentity.filter((value) => value !== undefined).length === 1) {
    throw new TypeError("模型网络诊断子 Agent 身份不完整");
  }
  for (const value of [
    context.tenantId,
    context.threadId,
    context.runId,
    context.attemptId,
    ...agentIdentity.filter((item): item is string => item !== undefined),
  ]) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value))
      throw new TypeError("模型网络诊断作用域无效");
  }
}
