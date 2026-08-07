import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installModelWireFetchInstrumentation,
  type ModelWireTracePort,
  type ModelWireTraceRecord,
  ModelWireTraceSession,
} from "./model-wire-trace.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("监听失败");
  return address.port;
}

class TracePort implements ModelWireTracePort {
  readonly records: ModelWireTraceRecord[] = [];
  readonly failures: Parameters<ModelWireTracePort["captureFailed"]>[0][] = [];
  async persist(record: ModelWireTraceRecord): Promise<void> {
    this.records.push(record);
  }
  async captureFailed(input: Parameters<ModelWireTracePort["captureFailed"]>[0]): Promise<void> {
    this.failures.push(input);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("诊断记录未完成");
}

describe("模型网络原始报文诊断", () => {
  it("保存最终发送的 application request body 和 content-decoded SSE 字节，且不保存 Authorization", async () => {
    installModelWireFetchInstrumentation();
    const server = createServer((request, response) => {
      void (async () => {
        const body: Buffer[] = [];
        for await (const chunk of request)
          body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        expect(request.headers.authorization).toBe("Bearer test-secret");
        expect(request.headers.cookie).toBe("session=test-cookie-secret");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"delta":"甲"}\n\n');
        response.end("data: [DONE]\n\n");
      })();
    });
    const port = await listen(server);
    const traces = new TracePort();
    const session = new ModelWireTraceSession(traces, 1024, `http://127.0.0.1:${port}/v1`);
    try {
      const response = await session.run(
        { tenantId: "tenant_a", threadId: "thread_a", runId: "run_a", attemptId: "attempt_a" },
        () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: {
              authorization: "Bearer test-secret",
              cookie: "session=test-cookie-secret",
              "content-type": "application/json",
            },
            // 空格和 Unicode 用于证明保存的是 Fetch 实际编码后的字节，而非对象重建。
            body: '{ "message": "甲" }',
          }),
      );
      expect(await response.text()).toBe('data: {"delta":"甲"}\n\ndata: [DONE]\n\n');
      await session.drain();
      await eventually(() => traces.records.length === 2);
      expect(traces.failures).toEqual([]);
      const request = traces.records.find((entry) => entry.part === "request");
      const sse = traces.records.find((entry) => entry.part === "response");
      expect(Buffer.from(request?.body ?? []).toString("utf8")).toBe('{ "message": "甲" }');
      expect(Buffer.from(sse?.body ?? []).toString("utf8")).toBe(
        'data: {"delta":"甲"}\n\ndata: [DONE]\n\n',
      );
      expect(JSON.stringify(traces.records)).not.toContain("test-secret");
      expect(JSON.stringify(traces.records)).not.toContain("test-cookie-secret");
      expect(sse).toMatchObject({
        status: "complete",
        httpStatus: 200,
        modelTurn: 0,
        transportAttempt: 0,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("同一 Attempt 的 root 与子 Agent Session 共享模型轮次分配器且保留独立身份", async () => {
    installModelWireFetchInstrumentation();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: [DONE]\n\n");
    });
    const port = await listen(server);
    const traces = new TracePort();
    const root = new ModelWireTraceSession(traces, 1024, `http://127.0.0.1:${port}/v1`);
    const rootAttempt = root.createAttempt();
    const childAttempt = root.createAttempt();
    try {
      const rootResponse = await rootAttempt.run(
        {
          tenantId: "tenant_shared",
          threadId: "thread_shared",
          runId: "run_shared",
          attemptId: "attempt_shared",
        },
        () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            body: "root-request",
          }),
      );
      const childResponse = await childAttempt.run(
        {
          tenantId: "tenant_shared",
          threadId: "thread_shared",
          runId: "run_shared",
          attemptId: "attempt_shared",
          agentThreadId: "agent_shared",
          agentTurnId: "turn_shared",
        },
        () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            body: "child-request",
          }),
      );
      await rootResponse.text();
      await childResponse.text();
      await Promise.all([rootAttempt.drain(), childAttempt.drain()]);

      const requests = traces.records
        .filter((entry) => entry.part === "request")
        .sort((left, right) => left.modelTurn - right.modelTurn);
      expect(requests.map((entry) => entry.modelTurn)).toEqual([0, 1]);
      expect(requests[0]?.context.agentThreadId).toBeUndefined();
      expect(requests[1]?.context).toMatchObject({
        agentThreadId: "agent_shared",
        agentTurnId: "turn_shared",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("达到上限、非 2xx 与中断时只影响诊断状态，不替换实际 Response 语义", async () => {
    installModelWireFetchInstrumentation();
    const server = createServer((_request, response) => {
      response.writeHead(429, { "content-type": "text/event-stream" });
      response.end("data: 0123456789\n\n");
    });
    const port = await listen(server);
    const traces = new TracePort();
    const session = new ModelWireTraceSession(traces, 8, `http://127.0.0.1:${port}/v1`);
    try {
      const response = await session.run(
        { tenantId: "tenant_b", threadId: "thread_b", runId: "run_b", attemptId: "attempt_b" },
        () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            body: "0123456789",
          }),
      );
      expect(response.status).toBe(429);
      expect(await response.text()).toBe("data: 0123456789\n\n");
      await session.drain();
      await eventually(() => traces.records.length === 2);
      expect(traces.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ part: "request", status: "truncated", size: 8 }),
          expect.objectContaining({
            part: "response",
            status: "truncated",
            size: 8,
            httpStatus: 429,
          }),
        ]),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("连续 prompt 使用单调 modelTurn，Request 输入与无作用域请求不会串入", async () => {
    installModelWireFetchInstrumentation();
    const server = createServer((_request, response) => response.end("ok"));
    const port = await listen(server);
    const traces = new TracePort();
    const session = new ModelWireTraceSession(traces, 1024, `http://127.0.0.1:${port}/v1`);
    const context = {
      tenantId: "tenant_c",
      threadId: "thread_c",
      runId: "run_c",
      attemptId: "attempt_c",
    };
    try {
      const request = new Request(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        body: "one",
      });
      await session.run(context, () => fetch(request));
      await session.run(context, () =>
        fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: "two" }),
      );
      await fetch(`http://127.0.0.1:${port}/v1/other`, { method: "POST", body: "outside" });
      await session.drain();
      expect(
        traces.records.filter((entry) => entry.part === "request").map((entry) => entry.modelTurn),
      ).toEqual([0, 1]);
      expect(traces.records.every((entry) => entry.transportAttempt === 0)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("persist 与 captureFailed 同时失败也不改变 Provider Response", async () => {
    installModelWireFetchInstrumentation();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: diagnostic-port-down\n\n");
    });
    const port = await listen(server);
    let persistCalls = 0;
    let failureCalls = 0;
    const session = new ModelWireTraceSession(
      {
        persist: async () => {
          persistCalls += 1;
          throw new Error("diagnostic persistence unavailable");
        },
        captureFailed: async () => {
          failureCalls += 1;
          throw new Error("diagnostic failure recorder unavailable");
        },
      },
      1024,
      `http://127.0.0.1:${port}/v1`,
    );
    try {
      const response = await session.run(
        { tenantId: "tenant_d", threadId: "thread_d", runId: "run_d", attemptId: "attempt_d" },
        () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            body: "diagnostic failures are isolated",
          }),
      );
      expect(await response.text()).toBe("data: diagnostic-port-down\n\n");
      await session.drain();
      expect(persistCalls).toBe(2);
      expect(failureCalls).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("慢 capture 的 drain 成功路径清理 deadline，超时路径也不阻塞业务", async () => {
    installModelWireFetchInstrumentation();
    const server = createServer((_request, response) => response.end("provider-ok"));
    const port = await listen(server);
    const releases: Array<() => void> = [];
    let persistStarted = 0;
    const session = new ModelWireTraceSession(
      {
        persist: async () => {
          persistStarted += 1;
          await new Promise<void>((resolve) => releases.push(resolve));
        },
        captureFailed: async () => undefined,
      },
      1024,
      `http://127.0.0.1:${port}/v1`,
    );
    try {
      const response = await session.run(
        { tenantId: "tenant_e", threadId: "thread_e", runId: "run_e", attemptId: "attempt_e" },
        () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            body: "slow-capture",
          }),
      );
      expect(await response.text()).toBe("provider-ok");
      await eventually(() => persistStarted === 2);

      vi.useFakeTimers();
      const completedBeforeDeadline = session.drain(5_000);
      expect(vi.getTimerCount()).toBe(1);
      for (const release of releases) release();
      await completedBeforeDeadline;
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();

      let neverResolve: (() => void) | undefined;
      const timeoutSession = new ModelWireTraceSession(
        {
          persist: () => new Promise<void>((resolve) => (neverResolve = resolve)),
          captureFailed: async () => undefined,
        },
        1024,
        `http://127.0.0.1:${port}/v1`,
      );
      const second = await timeoutSession.run(
        { tenantId: "tenant_f", threadId: "thread_f", runId: "run_f", attemptId: "attempt_f" },
        () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            body: "timeout-capture",
          }),
      );
      expect(await second.text()).toBe("provider-ok");
      await eventually(() => neverResolve !== undefined);
      vi.useFakeTimers();
      const baselineTimers = vi.getTimerCount();
      const timedOut = timeoutSession.drain(25);
      expect(vi.getTimerCount()).toBe(baselineTimers + 1);
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;
      neverResolve?.();
    } finally {
      vi.useRealTimers();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("Abort 与响应断流分别保留失败事实，且不把诊断异常替换成成功", async () => {
    installModelWireFetchInstrumentation();
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: partial\n\n");
      response.destroy(new Error("test disconnect"));
    });
    const port = await listen(server);
    const traces = new TracePort();
    const session = new ModelWireTraceSession(traces, 1024, `http://127.0.0.1:${port}/v1`);
    const context = {
      tenantId: "tenant_g",
      threadId: "thread_g",
      runId: "run_g",
      attemptId: "attempt_g",
    };
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        session.run(context, () =>
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            body: "abort-before-send",
            signal: controller.signal,
          }),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });

      await expect(
        session.run(context, async () => {
          const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            body: "disconnect",
          });
          return response.text();
        }),
      ).rejects.toBeInstanceOf(Error);
      await session.drain();
      expect(requestCount).toBe(1);
      expect(traces.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ part: "response", code: "BODY_UNREADABLE", modelTurn: 0 }),
          expect.objectContaining({ part: "response", modelTurn: 1 }),
        ]),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("自定义 AbortSignal reason 记为正文不可读并向调用方原样抛回", async () => {
    installModelWireFetchInstrumentation();
    const traces = new TracePort();
    const session = new ModelWireTraceSession(traces, 1024, "https://model.invalid/v1");
    const controller = new AbortController();
    const reason = new Error("custom abort reason");
    controller.abort(reason);

    let rejection: unknown;
    try {
      await session.run(
        {
          tenantId: "tenant_custom_abort",
          threadId: "thread_custom_abort",
          runId: "run_custom_abort",
          attemptId: "attempt_custom_abort",
        },
        () =>
          fetch("https://model.invalid/v1/chat/completions", {
            method: "POST",
            body: "abort-with-custom-reason",
            signal: controller.signal,
          }),
      );
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBe(reason);
    await session.drain();
    expect(traces.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          part: "response",
          code: "BODY_UNREADABLE",
          modelTurn: 0,
          transportAttempt: 0,
        }),
      ]),
    );
    expect(
      traces.failures.some(
        (failure) => failure.part === "response" && failure.code === "CAPTURE_UNAVAILABLE",
      ),
    ).toBe(false);
  });
});
