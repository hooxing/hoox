import { describe, expect, it, vi } from "vitest";
import { evaluationCommandClient, startEvaluationLoop } from "./evaluation-loop.js";

describe("评测循环", () => {
  it("停机等候在途 tick，不重叠轮询或重新启动定时器", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const tick = vi.fn(
        () =>
          new Promise<boolean>((r) => {
            finish = () => r(true);
          }),
      );
      const stop = startEvaluationLoop({ tick }, 50);
      await vi.advanceTimersByTimeAsync(200);
      expect(tick).toHaveBeenCalledTimes(1);
      const closed = stop();
      finish();
      await closed;
      await vi.advanceTimersByTimeAsync(200);
      expect(tick).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("租约只放认证头，禁止重定向；不可确认的响应不当作 Run 失败", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: "active" }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ status: "maybe" }));
    vi.stubGlobal("fetch", transport);
    try {
      const execute = evaluationCommandClient("https://internal.example.invalid");
      const input = {
        token: crypto.randomUUID(),
        tenantId: "tenant",
        userId: "user",
        generation: "2",
        plannedRunId: crypto.randomUUID(),
      };
      expect(await execute(input)).toBe("active");
      const options = transport.mock.calls[0]?.[1];
      expect(options?.redirect).toBe("error");
      expect(options?.body.includes(input.token)).toBe(false);
      await expect(execute(input)).rejects.toThrow("响应未知");
      await expect(execute(input)).rejects.toThrow("响应无效");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
