import { HooxError } from "./errors.js";
import { routes, type Operations } from "./openapi.generated.js";
import { aborted, pause, retryDelay, retryPolicy } from "./retry.js";
import { parseSse } from "./sse.js";
import type {
  CreateRunRequest,
  CreateThreadRequest,
  IdempotentRequestOptions,
  RequestOptions,
  RunStreamEvent,
  StreamOptions,
  SubmitToolResult,
} from "./types.js";

const MAX_ARTIFACT_CONTENT_BYTES = 24 * 1024 * 1024;

export type HooxClientOptions = {
  baseUrl: string;
  apiKey?: string;
  endUser?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

type Operation = keyof Operations;
type Data<Key extends Operation> = Operations[Key]["response"] extends { data: infer Value }
  ? Value
  : never;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function batch(value: unknown): value is Extract<RunStreamEvent, { event: "run-events" }>["data"] {
  if (!record(value) || !record(value.run) || !record(value.page)) return false;
  const { run, page } = value;
  return (
    typeof run.id === "string" &&
    typeof run.threadId === "string" &&
    ["queued", "running", "waiting", "succeeded", "failed", "cancelled"].includes(
      String(run.status),
    ) &&
    (page.attemptId === undefined || typeof page.attemptId === "string") &&
    Array.isArray(page.items) &&
    page.items.every(
      (item) =>
        record(item) &&
        typeof item.eventId === "string" &&
        Number.isSafeInteger(item.sequence) &&
        typeof item.type === "string" &&
        record(item.payload),
    )
  );
}

export class HooxClient {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #endUser: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HooxClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new HooxError("baseUrl 必须是 HTTP(S) 绝对地址", "INVALID_CONFIG");
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new HooxError("baseUrl 不允许凭据、查询参数或片段", "INVALID_CONFIG");
    }
    this.#baseUrl = url.href.replace(/\/$/u, "");
    this.#apiKey = options.apiKey;
    this.#endUser = options.endUser;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  listAgents(options?: RequestOptions): Promise<Data<"listAgents">> {
    return this.request("listAgents", {}, undefined, undefined, options);
  }

  createThread(
    body: CreateThreadRequest,
    options: IdempotentRequestOptions,
  ): Promise<Data<"createThread">> {
    return this.request("createThread", {}, body, undefined, options);
  }

  listThreads(
    query: Operations["listThreads"]["query"] = {},
    options?: RequestOptions,
  ): Promise<Data<"listThreads">> {
    return this.request("listThreads", {}, undefined, query, options);
  }

  getThread(threadId: string, options?: RequestOptions): Promise<Data<"getThread">> {
    return this.request("getThread", { threadId }, undefined, undefined, options);
  }

  createRun(
    threadId: string,
    body: CreateRunRequest,
    options: IdempotentRequestOptions,
  ): Promise<Data<"createRun">> {
    return this.request("createRun", { threadId }, body, undefined, options);
  }

  listThreadRuns(
    threadId: string,
    query: Operations["listThreadRuns"]["query"] = {},
    options?: RequestOptions,
  ): Promise<Data<"listThreadRuns">> {
    return this.request("listThreadRuns", { threadId }, undefined, query, options);
  }

  getRun(threadId: string, runId: string, options?: RequestOptions): Promise<Data<"getRun">> {
    return this.request("getRun", { threadId, runId }, undefined, undefined, options);
  }

  cancelRun(threadId: string, runId: string, options?: RequestOptions): Promise<Data<"cancelRun">> {
    return this.request("cancelRun", { threadId, runId }, undefined, undefined, options);
  }

  listRunEvents(
    threadId: string,
    runId: string,
    query: Operations["listRunEvents"]["query"] = {},
    options?: RequestOptions,
  ): Promise<Data<"listRunEvents">> {
    return this.request("listRunEvents", { threadId, runId }, undefined, query, options);
  }

  submitToolResult(
    threadId: string,
    runId: string,
    body: SubmitToolResult,
    options?: RequestOptions,
  ): Promise<Data<"submitToolResult">> {
    return this.request("submitToolResult", { threadId, runId }, body, undefined, options);
  }

  listArtifacts(
    threadId: string,
    runId: string,
    options?: RequestOptions,
  ): Promise<Data<"listArtifacts">> {
    return this.request("listArtifacts", { threadId, runId }, undefined, undefined, options);
  }

  previewArtifact(
    threadId: string,
    runId: string,
    artifactId: string,
    options?: RequestOptions,
  ): Promise<Data<"previewArtifact">> {
    return this.request(
      "previewArtifact",
      { threadId, runId, artifactId },
      undefined,
      undefined,
      options,
    );
  }

  downloadArtifact(
    threadId: string,
    runId: string,
    artifactId: string,
    options?: RequestOptions,
  ): Promise<Data<"downloadArtifact">> {
    return this.request(
      "downloadArtifact",
      { threadId, runId, artifactId },
      undefined,
      undefined,
      options,
    );
  }

  async readArtifactContent(
    threadId: string,
    runId: string,
    artifactId: string,
    options: RequestOptions = {},
  ): Promise<Uint8Array> {
    const connection = this.connection(options);
    try {
      const response = await this.send(
        "readArtifactContent",
        { threadId, runId, artifactId },
        undefined,
        undefined,
        options,
        connection.signal,
      );
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_CONTENT_BYTES) {
        await response.body?.cancel();
        throw new HooxError("Artifact 内容超过读取上限", "RESPONSE_TOO_LARGE", response.status);
      }
      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_ARTIFACT_CONTENT_BYTES) {
            await reader.cancel();
            throw new HooxError("Artifact 内容超过读取上限", "RESPONSE_TOO_LARGE", response.status);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const content = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return content;
    } catch (error) {
      throw connection.error(error);
    } finally {
      connection.close();
    }
  }

  async *streamRunEvents(
    threadId: string,
    runId: string,
    options: StreamOptions = {},
  ): AsyncGenerator<RunStreamEvent> {
    const policy = retryPolicy(options.retry);
    let cursor = options.lastEventId;
    let failures = 0;
    const seen = new Map<string, number>();
    if (cursor) {
      const separator = cursor.lastIndexOf("-");
      const sequence = Number(cursor.slice(separator + 1));
      if (separator > 0 && Number.isSafeInteger(sequence)) {
        seen.set(cursor.slice(0, separator), sequence);
      }
    }
    while (true) {
      let renew = false;
      const connection = this.connection(options);
      try {
        const response = await this.send(
          "streamRunEvents",
          { threadId, runId },
          undefined,
          undefined,
          options,
          connection.signal,
          cursor,
        );
        if (
          !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
          !response.body
        ) {
          await response.body?.cancel();
          throw new HooxError("响应不是 SSE 事件流", "INVALID_STREAM", response.status);
        }
        for await (const frame of parseSse(response.body)) {
          let data: unknown;
          if (!["run-events", "end"].includes(frame.event)) continue;
          try {
            data = JSON.parse(frame.data);
          } catch {
            throw new HooxError("SSE 事件不是有效 JSON", "INVALID_STREAM");
          }
          if (frame.event === "end") {
            if (!record(data) || !["settled", "renew"].includes(String(data.reason))) {
              throw new HooxError("SSE 结束事件无效", "INVALID_STREAM");
            }
            if (data.reason === "settled") {
              yield { event: "end", data: { reason: "settled" } };
              return;
            }
            renew = true;
            break;
          }
          if (!batch(data) || data.run.id !== runId || data.run.threadId !== threadId) {
            throw new HooxError("SSE Run 事件无效", "INVALID_STREAM");
          }
          const attempt = data.page.attemptId ?? "pending";
          const items = data.page.items.filter((item) => {
            if (item.sequence <= (seen.get(attempt) ?? -1)) return false;
            seen.set(attempt, item.sequence);
            return true;
          });
          if (items.length > 0) {
            cursor = items.at(-1)?.eventId;
            failures = 0;
          }
          yield {
            event: "run-events",
            ...(cursor === undefined ? {} : { id: cursor }),
            data: { run: data.run, page: { ...data.page, items } },
          };
          if (
            !data.page.hasMore &&
            (["succeeded", "failed", "cancelled"].includes(data.run.status) ||
              data.run.executionStatus === "recovery_required")
          ) {
            yield { event: "end", data: { reason: "settled" } };
            return;
          }
        }
      } catch (error) {
        const mapped = connection.error(error);
        if (!mapped.retryable) throw mapped;
      } finally {
        connection.close();
      }
      if (!renew && failures >= policy.maxRetries) {
        throw new HooxError("SSE 重连次数超过上限", "RECONNECT_LIMIT");
      }
      await pause(retryDelay(failures, policy), options.signal);
      if (!renew) failures += 1;
    }
  }

  private connection(options: RequestOptions) {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new HooxError("timeoutMs 必须是有效的正数毫秒值", "INVALID_CONFIG");
    }
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    return {
      signal: controller.signal,
      close: () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        controller.abort();
      },
      error: (error: unknown): HooxError => {
        if (options.signal?.aborted) return aborted();
        if (timedOut) return new HooxError("请求超时", "TIMEOUT", undefined, undefined, true);
        if (error instanceof HooxError) return error;
        return new HooxError("网络请求失败", "NETWORK_ERROR", undefined, undefined, true);
      },
    };
  }

  private async request<Key extends Operation>(
    operation: Key,
    params: Record<string, string>,
    body: unknown,
    query: object | undefined,
    options: RequestOptions = {},
  ): Promise<Data<Key>> {
    const connection = this.connection(options);
    try {
      const response = await this.send(operation, params, body, query, options, connection.signal);
      let envelope: unknown;
      try {
        envelope = await response.json();
      } catch {
        if (connection.signal.aborted) throw aborted();
        throw new HooxError("API 成功响应不是有效 JSON", "INVALID_RESPONSE", response.status);
      }
      if (!record(envelope) || envelope.version !== "v1" || !("data" in envelope)) {
        throw new HooxError("API 成功响应格式无效", "INVALID_RESPONSE", response.status);
      }
      return envelope.data as Data<Key>;
    } catch (error) {
      throw connection.error(error);
    } finally {
      connection.close();
    }
  }

  private async send(
    operation: Operation,
    params: Record<string, string>,
    body: unknown,
    query: object | undefined,
    options: RequestOptions,
    signal: AbortSignal,
    cursor?: string,
  ): Promise<Response> {
    if (signal.aborted) throw aborted();
    if (["createThread", "createRun"].includes(operation) && !options.idempotencyKey) {
      throw new HooxError("创建请求必须提供 idempotencyKey", "INVALID_REQUEST");
    }
    const route = routes[operation];
    const path = route.path.replace(/\{(\w+)\}/gu, (_, key: string) =>
      encodeURIComponent(params[key] ?? ""),
    );
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers({
      accept:
        operation === "streamRunEvents"
          ? "text/event-stream"
          : operation === "readArtifactContent"
            ? "application/octet-stream"
            : "application/json",
    });
    if (this.#apiKey) headers.set("Authorization", `Bearer ${this.#apiKey}`);
    if (this.#endUser !== undefined) headers.set("Hoox-End-User", this.#endUser);
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
    if (cursor !== undefined) headers.set("Last-Event-ID", cursor);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.#fetch(url, {
      method: route.method,
      headers,
      signal,
      redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.ok) return response;
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      envelope = undefined;
    }
    const detail = record(envelope) && record(envelope.error) ? envelope.error : undefined;
    const redact = (value: string) =>
      [this.#apiKey, this.#endUser]
        .filter((secret): secret is string => Boolean(secret))
        .sort((left, right) => right.length - left.length)
        .reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
    throw new HooxError(
      redact(typeof detail?.message === "string" ? detail.message : "API 请求失败"),
      redact(typeof detail?.code === "string" ? detail.code : "HTTP_ERROR"),
      response.status,
      redact(
        record(envelope) && typeof envelope.requestId === "string"
          ? envelope.requestId
          : (response.headers.get("x-request-id") ?? ""),
      ) || undefined,
      detail?.retryable === true || [408, 429, 500, 502, 503, 504].includes(response.status),
    );
  }
}
