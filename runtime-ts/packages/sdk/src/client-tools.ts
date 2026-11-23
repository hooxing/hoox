import type { HooxClient } from "./client.js";
import { HooxError } from "./errors.js";
import { aborted, pause, retryDelay, retryPolicy } from "./retry.js";
import type {
  ClientToolAction,
  ClientToolHandler,
  RequestOptions,
  RunStreamEvent,
  StreamOptions,
  SubmitToolResult,
} from "./types.js";

function actionOf(value: Record<string, unknown>): ClientToolAction {
  if (
    !["threadId", "runId", "callId", "toolName", "deadline"].every(
      (key) => typeof value[key] === "string" && value[key] !== "",
    ) ||
    typeof value.arguments !== "object" ||
    value.arguments === null ||
    Array.isArray(value.arguments) ||
    !Number.isFinite(Date.parse(String(value.deadline)))
  ) {
    throw new HooxError("客户端工具调用格式无效", "INVALID_STREAM");
  }
  return value as ClientToolAction;
}

type Entry = { result: Promise<SubmitToolResult | undefined>; submission?: Promise<void> };

export class ClientTools {
  readonly #handlers = new Map<string, ClientToolHandler>();
  readonly #calls = new WeakMap<HooxClient, Map<string, Entry>>();

  register(name: string, handler: ClientToolHandler): this {
    if (this.#handlers.has(name)) throw new HooxError("客户端工具重复注册", "INVALID_CONFIG");
    this.#handlers.set(name, handler);
    return this;
  }

  async handle(
    client: HooxClient,
    action: ClientToolAction,
    options: StreamOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) throw aborted();
    action = actionOf(action);
    let calls = this.#calls.get(client);
    if (!calls) {
      calls = new Map();
      this.#calls.set(client, calls);
    }
    const key = JSON.stringify([action.threadId, action.runId, action.callId]);
    let entry = calls.get(key);
    if (!entry) {
      entry = { result: this.execute(action, options) };
      calls.set(key, entry);
    }
    const result = await entry.result;
    if (!result) return;
    if (!entry.submission) {
      const policy = retryPolicy(options.retry);
      const submit = async () => {
        for (let attempt = 0; ; attempt += 1) {
          if (options.signal?.aborted) throw aborted();
          if (Date.now() >= Date.parse(action.deadline)) return;
          try {
            await client.submitToolResult(action.threadId, action.runId, result, options);
            return;
          } catch (error) {
            if (!(error instanceof HooxError) || !error.retryable || attempt >= policy.maxRetries) {
              throw error;
            }
            await pause(retryDelay(attempt, policy), options.signal);
          }
        }
      };
      entry.submission = submit().catch((error: unknown) => {
        delete entry.submission;
        throw error;
      });
    }
    await entry.submission;
  }

  async *stream(
    client: HooxClient,
    threadId: string,
    runId: string,
    options: StreamOptions = {},
  ): AsyncGenerator<RunStreamEvent> {
    let cursor = options.lastEventId;
    const policy = retryPolicy(options.retry);
    let idle = 0;
    while (true) {
      let waiting = false;
      let progress = false;
      for await (const event of client.streamRunEvents(threadId, runId, {
        ...options,
        ...(cursor === undefined ? {} : { lastEventId: cursor }),
      })) {
        if (event.event === "run-events") {
          cursor = event.id ?? cursor;
          const active =
            !["succeeded", "failed", "cancelled"].includes(event.data.run.status) &&
            event.data.run.executionStatus !== "recovery_required";
          waiting = active && event.data.run.status === "waiting";
          progress ||= event.data.page.items.length > 0;
          const actions = event.data.page.items
            .filter((item) => active && item.type === "requires_action")
            .map((item) => actionOf(item.payload));
          if (actions.some((action) => action.threadId !== threadId || action.runId !== runId)) {
            throw new HooxError("客户端工具调用不属于当前 Run", "INVALID_STREAM");
          }
          await Promise.all(actions.map((action) => this.handle(client, action, options)));
        }
        if (event.event !== "end" || !waiting) yield event;
      }
      if (!waiting) return;
      idle = progress ? 0 : idle + 1;
      if (idle > policy.maxRetries) {
        throw new HooxError("客户端工具回传后 Run 未恢复", "RECONNECT_LIMIT");
      }
      await pause(retryDelay(idle, policy), options.signal);
    }
  }

  private async execute(
    action: ClientToolAction,
    options: RequestOptions,
  ): Promise<SubmitToolResult | undefined> {
    const remaining = Date.parse(action.deadline) - Date.now();
    if (remaining <= 0) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const stopped = new Promise<undefined>((resolve, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          resolve(undefined);
        },
        Math.min(remaining, 2_147_483_647),
      );
      abort = () => {
        controller.abort();
        reject(aborted());
      };
      options.signal?.addEventListener("abort", abort, { once: true });
    });
    const work = async (): Promise<SubmitToolResult> => {
      const handler = this.#handlers.get(action.toolName);
      try {
        if (!handler) throw new Error("未注册客户端工具");
        const result = await handler(action.arguments, {
          threadId: action.threadId,
          runId: action.runId,
          callId: action.callId,
          deadline: action.deadline,
          signal: controller.signal,
        });
        if (
          typeof result !== "string" ||
          result.includes("\0") ||
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            new TextEncoder().encode(result),
          ) !== result ||
          new TextEncoder().encode(result).byteLength > 1_048_576
        ) {
          throw new Error("客户端工具结果无效");
        }
        return { callId: action.callId, outcome: "succeeded", result };
      } catch {
        return {
          callId: action.callId,
          outcome: "failed",
          result: handler ? "客户端工具执行失败" : "未注册客户端工具",
        };
      }
    };
    try {
      return await Promise.race([stopped, work()]);
    } finally {
      clearTimeout(timer);
      if (abort) options.signal?.removeEventListener("abort", abort);
    }
  }
}
