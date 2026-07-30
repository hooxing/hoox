import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  installModelWireFetchInstrumentation,
  ModelWireTraceSession,
  type ModelWireTracePort,
  type ModelWireTraceRecord,
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

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("诊断记录未完成");
}

describe("模型网络原始报文诊断", () => {
  it("保存最终发送的 UTF-8 body 和原始 SSE 字节，且不保存 Authorization", async () => {
    installModelWireFetchInstrumentation();
    const server = createServer((request, response) => {
      void (async () => {
        const body: Buffer[] = [];
        for await (const chunk of request)
          body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        expect(request.headers.authorization).toBe("Bearer test-secret");
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
            headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
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
});
