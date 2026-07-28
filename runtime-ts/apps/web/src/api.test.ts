import { describe, expect, it, vi } from "vitest";
import { RuntimeApi } from "./api.js";

describe("RuntimeApi", () => {
  it("创建请求携带开发身份和幂等键", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ version: "v1", requestId: "req_1", data: { id: "thread_1" } }),
          { status: 200 },
        ),
      );
    const api = new RuntimeApi(fetcher, "/api");
    await api.createThread("测试");
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer dev-user-a");
    expect(headers.get("idempotency-key")).toMatch(/^[-a-z0-9]{8,}$/iu);
  });

  it("将公开错误转为可重试 API 错误", async () => {
    const api = new RuntimeApi(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "暂不可用", retryable: true } }), {
          status: 503,
        }),
      ),
    );
    await expect(api.listThreads()).rejects.toEqual(
      expect.objectContaining({ message: "暂不可用", status: 503, retryable: true }),
    );
  });
});
