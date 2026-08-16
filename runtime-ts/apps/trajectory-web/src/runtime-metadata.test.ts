import { describe, expect, it, vi } from "vitest";
import { DevelopmentRuntimeApiMetadataProvider } from "./runtime-metadata.js";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("DevelopmentRuntimeApiMetadataProvider", () => {
  it("通过 development API 把 Run 映射为 Thread 标题并缓存结果", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get("Authorization");
      if (url.pathname === "/v1/me/teams") return response({ items: [] });
      if (url.pathname === "/v1/threads") {
        return authorization === "Bearer dev-user-a"
          ? response({ items: [{ id: "thread_1", title: "轨迹聚合修复" }] })
          : response({ items: [] });
      }
      if (url.pathname === "/v1/threads/thread_1/runs") {
        return response({
          items: [{ id: "run_1", threadId: "thread_1", createdAt: "2026-08-16T12:00:00.000Z" }],
        });
      }
      return response({}, 404);
    });
    let now = 100;
    const provider = new DevelopmentRuntimeApiMetadataProvider({
      origin: "http://localhost:3001",
      fetcher,
      cacheTtlMs: 1_000,
      now: () => now,
    });

    await expect(provider.resolve(["run_1", "run_missing"])).resolves.toEqual(
      new Map([
        [
          "run_1",
          {
            runId: "run_1",
            threadId: "thread_1",
            title: "轨迹聚合修复",
            createdAt: "2026-08-16T12:00:00.000Z",
          },
        ],
      ]),
    );
    const calls = fetcher.mock.calls.length;
    now = 200;
    await provider.resolve(["run_1"]);
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });

  it("支持团队 Tenant 并且 API 失败时安全退回空元数据", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer dev-user-b") {
        return response({}, 503);
      }
      if (url.pathname === "/v1/me/teams") return response({ items: [{ id: "team_1" }] });
      if (url.pathname === "/v1/threads" && headers.get("X-Tenant-ID") === "team_1") {
        return response({ items: [{ id: "thread_team", title: "团队轨迹" }] });
      }
      if (url.pathname === "/v1/threads") return response({ items: [] });
      if (url.pathname === "/v1/threads/thread_team/runs") {
        expect(headers.get("X-Tenant-ID")).toBe("team_1");
        return response({ items: [{ id: "run_team" }] });
      }
      return response({}, 404);
    });
    const provider = new DevelopmentRuntimeApiMetadataProvider({
      origin: "http://127.0.0.1:3001",
      fetcher,
      cacheTtlMs: 0,
    });

    await expect(provider.resolve(["run_team"])).resolves.toEqual(
      new Map([["run_team", { runId: "run_team", threadId: "thread_team", title: "团队轨迹" }]]),
    );
  });

  it("拒绝非回环或带凭据的 API origin", () => {
    expect(
      () => new DevelopmentRuntimeApiMetadataProvider({ origin: "https://example.com" }),
    ).toThrow("回环 HTTP origin");
    expect(
      () =>
        new DevelopmentRuntimeApiMetadataProvider({ origin: "http://user:pass@127.0.0.1:3001" }),
    ).toThrow("回环 HTTP origin");
  });
});
