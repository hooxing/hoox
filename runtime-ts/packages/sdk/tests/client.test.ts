import { afterEach, describe, expect, it, vi } from "vitest";
import { HooxClient, HooxError } from "../src/index.js";
import { retryDelay, retryPolicy } from "../src/retry.js";
import { events, ok, retry, run, sseResponse } from "./fixtures.js";

afterEach(() => vi.useRealTimers());

describe("SDK HTTP", () => {
  it("拒绝不安全地址和无效超时；成功响应格式错误不伪装成网络故障", async () => {
    for (const baseUrl of [
      "not-a-url",
      "file:///tmp",
      "https://key@example.invalid",
      "https://example.invalid/?key=secret",
    ]) {
      expect(() => new HooxClient({ baseUrl })).toThrow(HooxError);
    }
    const client = new HooxClient({
      baseUrl: "https://api.example.invalid",
      fetch: async () => new Response("not json"),
    });
    await expect(client.getThread("thread_sdk")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
    await expect(client.getThread("thread_sdk", { timeoutMs: 0 })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });
  it("传递 Key、终端用户、幂等键并使用公开路由与响应 data", async () => {
    const fetcher = vi.fn(async () => ok(run()));
    const client = new HooxClient({
      baseUrl: "https://api.example.invalid/proxy/",
      apiKey: "placeholder-api-key",
      endUser: "Customer:42",
      fetch: fetcher,
    });
    await client.createRun("thread_sdk", { input: "你好" }, { idempotencyKey: "create-run-0001" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(url.pathname).toBe("/proxy/v1/threads/thread_sdk/runs");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(headers.get("Authorization")).toBe("Bearer placeholder-api-key");
    expect(headers.get("Hoox-End-User")).toBe("Customer:42");
    expect(headers.get("Idempotency-Key")).toBe("create-run-0001");
    expect(JSON.parse(String(init.body))).toEqual({ input: "你好" });
    await client.listThreads({ cursor: "cursor:/+=", limit: 2 });
    await client.getThread("thread_sdk");
    await client.listThreadRuns("thread_sdk", { limit: 3 });
    await client.getRun("thread_sdk", "run_sdk");
    await client.cancelRun("thread_sdk", "run_sdk");
    await client.listRunEvents("thread_sdk", "run_sdk", { after: 1 });
    await client.listAgents();
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(client)).not.toContain("placeholder-api-key");
  });

  it("无 Key 的浏览器代理模式不注入 Authorization；不自动重试创建请求", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network detail");
    });
    const client = new HooxClient({ baseUrl: "https://app.example.invalid/hoox", fetch: fetcher });
    await expect(
      client.createThread({ title: "测试" }, { idempotencyKey: "" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      client.createThread({ title: "测试" }, { idempotencyKey: "thread-key-0001" }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("统一映射错误状态、错误码、请求 ID，屏蔽 Key 和底层异常", async () => {
    const secret = "placeholder-api-key";
    const client = new HooxClient({
      baseUrl: "https://api.example.invalid",
      apiKey: secret,
      fetch: async () =>
        Response.json(
          {
            requestId: "req_example",
            error: { code: "CONFLICT", message: `不能包含 ${secret}`, retryable: false },
          },
          { status: 409 },
        ),
    });
    try {
      await client.getThread("thread_sdk");
      expect.fail("应返回错误");
    } catch (error) {
      expect(error).toBeInstanceOf(HooxError);
      expect(error).toMatchObject({
        status: 409,
        code: "CONFLICT",
        requestId: "req_example",
        retryable: false,
      });
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    const broken = new HooxClient({
      baseUrl: "https://api.example.invalid",
      fetch: async () =>
        new Response("private server body", {
          status: 502,
          headers: { "x-request-id": "req_gateway" },
        }),
    });
    await expect(broken.getThread("thread_sdk")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 502,
      requestId: "req_gateway",
      retryable: true,
    });
  });

  it("超时和 AbortSignal 会中止请求且不泄露 abort reason", async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("private detail")), {
          once: true,
        });
      });
    const client = new HooxClient({
      baseUrl: "https://api.example.invalid",
      fetch: fetcher,
      timeoutMs: 10,
    });
    const timeout = expect(client.getThread("thread_sdk")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(10);
    await timeout;
    const controller = new AbortController();
    const aborted = expect(
      client.getThread("thread_sdk", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED", message: "操作已取消" });
    controller.abort("private reason");
    await aborted;
    await expect(
      client.getThread("thread_sdk", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("SDK SSE 续连", () => {
  it.each(["succeeded", "failed", "cancelled"] as const)(
    "终态 %s 补读完所有页后停止",
    async (status) => {
      const first = JSON.parse(events([0], status).split("data: ")[1] ?? "{}");
      first.page.hasMore = true;
      const fetcher = vi.fn(async () =>
        sseResponse(`event: run-events\ndata: ${JSON.stringify(first)}\n\n${events([1], status)}`),
      );
      const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
      const sequences = [];
      for await (const event of client.streamRunEvents("thread_sdk", "run_sdk", { retry })) {
        if (event.event === "run-events")
          sequences.push(...event.data.page.items.map((item) => item.sequence));
      }
      expect(sequences).toEqual([0, 1]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("EOF 后用 Last-Event-ID 续连，按 Attempt 去重，终态停止", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(events([0, 1])))
      .mockResolvedValueOnce(sseResponse(events([1, 2])))
      .mockResolvedValueOnce(sseResponse(events([0], "succeeded", "attempt_new")));
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    const ids = [];
    for await (const event of client.streamRunEvents("thread_sdk", "run_sdk", { retry })) {
      if (event.event === "run-events")
        ids.push(...event.data.page.items.map((item) => item.eventId));
    }
    expect(ids).toEqual(["attempt_sdk-0", "attempt_sdk-1", "attempt_sdk-2", "attempt_new-0"]);
    expect(new Headers(fetcher.mock.calls[1]?.[1].headers).get("Last-Event-ID")).toBe(
      "attempt_sdk-1",
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("初始游标去重；renew 续连，waiting settled 停止", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse(`${events([1, 2])}event: end\ndata: {"reason":"renew"}\n\n`),
      )
      .mockResolvedValueOnce(
        sseResponse(`${events([2, 3], "waiting")}event: end\ndata: {"reason":"settled"}\n\n`),
      );
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    const sequences = [];
    for await (const event of client.streamRunEvents("thread_sdk", "run_sdk", {
      retry,
      lastEventId: "attempt_sdk-1",
    })) {
      if (event.event === "run-events")
        sequences.push(...event.data.page.items.map((item) => item.sequence));
    }
    expect(sequences).toEqual([2, 3]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("指数退避有延时和次数上限，认证错误不续连", async () => {
    vi.useFakeTimers();
    const policy = retryPolicy({ initialDelayMs: 10, maxDelayMs: 25, maxRetries: 4 });
    expect([0, 1, 2, 3, 100].map((attempt) => retryDelay(attempt, policy))).toEqual([
      10, 20, 25, 25, 25,
    ]);
    const fetcher = vi.fn(async () => {
      throw new Error("断线");
    });
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    const promise = expect(
      client.streamRunEvents("thread_sdk", "run_sdk", { retry: policy }).next(),
    ).rejects.toMatchObject({ code: "RECONNECT_LIMIT" });
    await vi.advanceTimersByTimeAsync(9);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(71);
    await promise;
    expect(fetcher).toHaveBeenCalledTimes(5);
    const auth = vi.fn(async () => new Response("", { status: 401 }));
    const denied = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: auth });
    await expect(denied.streamRunEvents("thread_sdk", "run_sdk").next()).rejects.toMatchObject({
      status: 401,
    });
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it("非法 SSE 不重试；取消退避和提前退出均释放连接", async () => {
    const invalid = new HooxClient({
      baseUrl: "https://api.example.invalid",
      fetch: async () => sseResponse("event: run-events\ndata: {bad}\n\n"),
    });
    await expect(invalid.streamRunEvents("thread_sdk", "run_sdk").next()).rejects.toMatchObject({
      code: "INVALID_STREAM",
    });
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      throw new Error("断线");
    });
    const client = new HooxClient({ baseUrl: "https://api.example.invalid", fetch: fetcher });
    const waiting = expect(
      client.streamRunEvents("thread_sdk", "run_sdk", { signal: controller.signal }).next(),
    ).rejects.toMatchObject({ code: "ABORTED" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    await waiting;
  });
});
