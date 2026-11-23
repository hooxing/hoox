import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientTools, HooxClient, type ClientToolAction } from "../src/index.js";
import { events, ok, retry, sseResponse } from "./fixtures.js";

afterEach(() => vi.useRealTimers());

function action(): ClientToolAction {
  return {
    threadId: "thread_sdk",
    runId: "run_sdk",
    callId: "call_sdk",
    toolName: "lookup",
    arguments: { city: "上海" },
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("SDK 客户端工具", () => {
  it.each(["succeeded", "failed", "cancelled", "recovery_required"] as const)(
    "%s 快照不执行历史客户端工具，也不续连",
    async (status) => {
      const data = JSON.parse(
        events(
          [0],
          status === "recovery_required" ? "waiting" : status,
          "attempt_sdk",
          action(),
          "requires_action",
        ).split("data: ")[1] ?? "{}",
      );
      if (status === "recovery_required") data.run.executionStatus = status;
      const fetcher = vi.fn(async () =>
        sseResponse(`event: run-events\ndata: ${JSON.stringify(data)}\n\n`),
      );
      const handler = vi.fn(() => "不可执行");
      const tools = new ClientTools().register("lookup", handler);
      const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
      const output = [];
      for await (const event of tools.stream(client, "thread_sdk", "run_sdk", { retry }))
        output.push(event.event);
      expect(output).toEqual(["run-events", "end"]);
      expect(handler).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("保留合法结果的 BOM 与多字节正文，拒绝 NUL 与超出 UTF-8 字节上限的文本", async () => {
    const fetcher = vi.fn(async () => ok({ accepted: true }));
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    const text = "\uFEFF上海🙂";
    await new ClientTools().register("lookup", () => text).handle(client, action());
    const [, success] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(success.body))).toMatchObject({ outcome: "succeeded", result: text });
    for (const result of ["\0", "🙂".repeat(262_145)]) {
      await new ClientTools().register("lookup", () => result).handle(client, action());
      const [, failure] = fetcher.mock.calls.at(-1) as unknown as [URL, RequestInit];
      expect(JSON.parse(String(failure.body)).outcome).toBe("failed");
    }
  });
  it("同批多条调用并发执行；忽略普通 waiting 并拒绝跨 Run 的执行指令", async () => {
    const first = action();
    const second = { ...first, callId: "call_second" };
    const data = JSON.parse(
      events([0], "waiting", "attempt_sdk", first, "requires_action").split("data: ")[1] ?? "{}",
    );
    data.page.items.push({
      ...data.page.items[0],
      eventId: "attempt_sdk-1",
      sequence: 1,
      payload: second,
    });
    let entered = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tools = new ClientTools().register("lookup", async () => {
      entered += 1;
      if (entered === 2) release?.();
      await barrier;
      return "ok";
    });
    const fetcher: typeof fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith("tool-results")) return ok({ accepted: true });
      return new Headers(init?.headers).has("Last-Event-ID")
        ? sseResponse(events([2], "succeeded"))
        : sseResponse(
            `event: run-events\ndata: ${JSON.stringify(data)}\n\nevent: end\ndata: {"reason":"settled"}\n\n`,
          );
    });
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    for await (const _event of tools.stream(client, "thread_sdk", "run_sdk", { retry })) {
    }
    expect(entered).toBe(2);
    const foreign = new HooxClient({
      baseUrl: "https://api.example.invalid",
      fetch: async () =>
        sseResponse(
          events(
            [0],
            "waiting",
            "attempt_sdk",
            { ...first, runId: "another_run" },
            "requires_action",
          ),
        ),
    });
    await expect(tools.stream(foreign, "thread_sdk", "run_sdk").next()).rejects.toMatchObject({
      code: "INVALID_STREAM",
    });
    const handler = vi.fn(() => "ok");
    const normal = new ClientTools().register("lookup", handler);
    const notice = new HooxClient({
      baseUrl: "https://api.example.invalid",
      fetch: async () => sseResponse(events([0], "succeeded", "attempt_sdk", first, "run_waiting")),
    });
    for await (const _event of normal.stream(notice, "thread_sdk", "run_sdk")) {
    }
    expect(handler).not.toHaveBeenCalled();
  });
  it("成功与抛错均按协议回传，错误正文不泄露异常", async () => {
    const fetcher = vi.fn(async () => ok({ callId: "call_sdk", accepted: true }));
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    const tools = new ClientTools().register("lookup", (args) => JSON.stringify(args));
    await tools.handle(client, action());
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      callId: "call_sdk",
      outcome: "succeeded",
      result: '{"city":"上海"}',
    });
    const failed = new ClientTools().register("lookup", () => {
      throw new Error("private secret");
    });
    await failed.handle(client, action());
    const [, failure] = fetcher.mock.calls[1] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(failure.body))).toEqual({
      callId: "call_sdk",
      outcome: "failed",
      result: "客户端工具执行失败",
    });
  });

  it("并发重复只执行一次，丢失回执重试复用完整结果和 outcome", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("回执丢失"))
      .mockResolvedValue(ok({ callId: "call_sdk", accepted: true }));
    const handler = vi.fn(() => "result");
    const tools = new ClientTools().register("lookup", handler);
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    const call = action();
    await Promise.all([
      tools.handle(client, call, { retry }),
      tools.handle(client, call, { retry }),
    ]);
    await tools.handle(client, call);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1].body).toEqual(fetcher.mock.calls[1]?.[1].body);
  });

  it("提交失败后再次处理不重新执行；不同客户端不共享幂等身份", async () => {
    const handler = vi.fn(() => "result");
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("断线"))
      .mockImplementation(async () => ok({ accepted: true }));
    const tools = new ClientTools().register("lookup", handler);
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    const call = action();
    await expect(
      tools.handle(client, call, { retry: { ...retry, maxRetries: 0 } }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await tools.handle(client, call);
    expect(handler).toHaveBeenCalledTimes(1);
    await tools.handle(
      new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher }),
      call,
    );
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("以服务端 deadline 中止处理函数，不回传迟到结果；外部取消不回传失败", async () => {
    vi.useFakeTimers();
    let toolSignal: AbortSignal | undefined;
    const tools = new ClientTools().register("lookup", (_args, context) => {
      toolSignal = context.signal;
      return new Promise(() => {});
    });
    const fetcher = vi.fn(async () => ok({ accepted: true }));
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    const call = { ...action(), deadline: new Date(Date.now() + 10).toISOString() };
    const pending = tools.handle(client, call);
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(toolSignal?.aborted).toBe(true);
    await tools.handle(client, call);
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const aborted = expect(
      tools.handle(client, { ...action(), callId: "cancelled" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort();
    await aborted;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("未知工具和无效 UTF-8 文本转为失败回执", async () => {
    const fetcher = vi.fn(async () => ok({ accepted: true }));
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    await new ClientTools().handle(client, action());
    await new ClientTools().register("lookup", () => "\uD800").handle(client, action());
    for (const call of fetcher.mock.calls) {
      const [, init] = call as unknown as [URL, RequestInit];
      expect(JSON.parse(String(init.body)).outcome).toBe("failed");
    }
  });

  it("waiting 回传后续连同一 Run", async () => {
    const call = action();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse(
          events([0], "waiting", "attempt_sdk", call, "requires_action") +
            'event: end\ndata: {"reason":"settled"}\n\n',
        ),
      )
      .mockResolvedValueOnce(ok({ callId: call.callId, accepted: true }))
      .mockResolvedValueOnce(sseResponse(events([1], "succeeded")));
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    const handler = vi.fn(() => "上海");
    const tools = new ClientTools().register("lookup", handler);
    const output = [];
    for await (const event of tools.stream(client, "thread_sdk", "run_sdk", { retry }))
      output.push(event.event);
    expect(output).toEqual(["run-events", "run-events", "end"]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[2]?.[1].headers).get("Last-Event-ID")).toBe(
      "attempt_sdk-0",
    );
    expect(fetcher.mock.calls.every(([url]) => String(url).includes("/runs/run_sdk/"))).toBe(true);
  });
});
