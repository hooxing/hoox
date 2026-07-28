import { describe, expect, it, vi } from "vitest";
import { canPreviewArtifact, normalizeRunEvent, RuntimeApi } from "./api.js";

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

  it("兼容追加日志基线并从 agent_event 派生消息类型", () => {
    expect(
      normalizeRunEvent({
        sequence: 7,
        kind: "agent_event",
        occurredAt: "2026-01-01T00:00:00Z",
        payload: { type: "message.delta", delta: "正在输出" },
      }),
    ).toMatchObject({ eventId: "event-7", type: "message.delta", kind: "agent_event" });
  });

  it("agent_event 优先使用 payload.type，兼容旧 raw.type", () => {
    expect(
      normalizeRunEvent({
        sequence: 8,
        kind: "agent_event",
        type: "agent_event",
        payload: { type: "message.delta", delta: "旧进程" },
      }),
    ).toMatchObject({ type: "message.delta" });
  });

  it("下载只使用 Run 嵌套地址", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "v1",
          requestId: "req_1",
          data: { url: "https://example.test/file" },
        }),
      ),
    );
    const api = new RuntimeApi(fetcher);
    await expect(api.downloadArtifact("thread_1", "run_1", "artifact_1")).resolves.toBe(
      "https://example.test/file",
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/v1/threads/thread_1/runs/run_1/artifacts/artifact_1/download",
    );
    expect(fetcher.mock.calls[0]?.[1]).not.toMatchObject({ method: "POST" });
  });

  it("事件页保留 attemptId", async () => {
    const api = new RuntimeApi(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req_1",
            data: {
              attemptId: "attempt_2",
              items: [
                {
                  sequence: 1,
                  kind: "agent_event",
                  payload: { type: "message.delta", delta: "x" },
                },
              ],
            },
          }),
        ),
      ),
    );
    await expect(api.listEvents("thread_1", "run_1")).resolves.toMatchObject({
      attemptId: "attempt_2",
      items: [{ eventId: "event-1", type: "message.delta" }],
    });
  });

  it("仅允许安全媒体类型预览", () => {
    expect(canPreviewArtifact("text/plain")).toBe(true);
    expect(canPreviewArtifact("text/plain; charset=utf-8")).toBe(true);
    expect(canPreviewArtifact('TEXT/PLAIN; charset="us-ascii"')).toBe(true);
    expect(canPreviewArtifact("text/plain; charset=iso-8859-1")).toBe(true);
    expect(canPreviewArtifact("text/plain; charset=windows-1252")).toBe(true);
    expect(canPreviewArtifact("image/png")).toBe(true);
    expect(canPreviewArtifact("image/jpeg")).toBe(true);
    expect(canPreviewArtifact("image/gif")).toBe(true);
    expect(canPreviewArtifact("image/webp")).toBe(true);
    expect(canPreviewArtifact("application/pdf")).toBe(true);
    expect(canPreviewArtifact("text/html")).toBe(false);
    expect(canPreviewArtifact("text/plain; charset=utf-7")).toBe(false);
    expect(canPreviewArtifact("image/svg+xml")).toBe(false);
    expect(canPreviewArtifact("image/avif")).toBe(false);
    expect(canPreviewArtifact("image/png; charset=utf-8")).toBe(false);
    expect(canPreviewArtifact("application/pdf; version=1.7")).toBe(false);
    expect(canPreviewArtifact("application/zip")).toBe(false);
    expect(canPreviewArtifact(undefined)).toBe(false);
  });
});
