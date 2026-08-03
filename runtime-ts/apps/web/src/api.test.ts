import { describe, expect, it, vi } from "vitest";
import {
  canPreviewArtifact,
  normalizeModelWireTrace,
  normalizeRunEvent,
  RuntimeApi,
} from "./api.js";

describe("RuntimeApi", () => {
  it("默认 fetch 保留浏览器全局 receiver，不会以 RuntimeApi 实例调用", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(function (
      this: typeof globalThis,
    ) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response(JSON.stringify({ version: "v1", requestId: "req_1", data: { items: [] } }), {
          status: 200,
        }),
      );
    } as typeof fetch);
    try {
      await expect(new RuntimeApi().listThreads()).resolves.toEqual([]);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.contexts[0]).toBe(globalThis);
    } finally {
      fetcher.mockRestore();
    }
  });

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

  it("统一输入发送 auto/expected Run，并在入口关闭时回退 legacy follow-up", async () => {
    const receipt = {
      receiptId: "input-1",
      inputSequence: 2,
      requestedMode: "auto",
      disposition: "pending_steer",
      targetRunId: "run_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "v1", requestId: "req", data: receipt }), {
        status: 200,
      }),
    );
    const api = new RuntimeApi(fetcher);
    await expect(api.submitThreadInput("thread_1", "只改配色", "auto", "run_1")).resolves.toEqual(
      receipt,
    );
    const requestInit = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(requestInit).toBeDefined();
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      input: "只改配色",
      mode: "auto",
      expectedRunId: "run_1",
    });

    const fallbackFetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: {} }), { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req",
            data: {
              id: "run_2",
              threadId: "thread_1",
              status: "queued",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          }),
          { status: 200 },
        ),
      );
    const fallback = await new RuntimeApi(fallbackFetcher).submitThreadInput(
      "thread_1",
      "下一任务",
    );
    expect(fallback).toMatchObject({
      requestedMode: "follow_up",
      disposition: "queued",
      queuedRunId: "run_2",
    });
    expect(fallbackFetcher.mock.calls[1]?.[0]).toBe("/api/v1/threads/thread_1/runs");
  });

  it("上传原始文件字节，并把返回的 Resource 版本附到统一输入", async () => {
    const uploaded = {
      resourceId: "resource_upload_1",
      versionId: "resource_version_upload_1",
      name: "数据.csv",
      path: "/resources/resource_upload_1/resource_version_upload_1/数据.csv",
      mediaType: "text/csv",
      sizeBytes: 3,
    };
    const receipt = {
      receiptId: "input-upload-1",
      inputSequence: 1,
      requestedMode: "follow_up",
      disposition: "queued",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "v1", requestId: "req-1", data: uploaded }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "v1", requestId: "req-2", data: receipt }), {
          status: 200,
        }),
      );
    const api = new RuntimeApi(fetcher);
    const result = await api.uploadResource(
      new File([new Uint8Array([1, 2, 3])], "数据.csv", { type: "text/csv" }),
    );
    await api.submitThreadInput("thread_1", "请分析", "follow_up", undefined, [result]);

    const uploadInit = fetcher.mock.calls[0]?.[1] as RequestInit;
    const uploadHeaders = new Headers(uploadInit.headers);
    expect(uploadHeaders.get("content-type")).toBe("application/octet-stream");
    expect(uploadHeaders.get("x-file-name")).toBe(encodeURIComponent("数据.csv"));
    expect(new Uint8Array(uploadInit.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    const inputInit = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(inputInit.body))).toEqual({
      input: "请分析",
      mode: "follow_up",
      attachments: [
        {
          resourceId: uploaded.resourceId,
          versionId: uploaded.versionId,
        },
      ],
    });
  });

  it("恢复读取走 Thread 嵌套的最新 Run 快照接口", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ version: "v1", requestId: "req_1", data: { items: [{ id: "run_2" }] } }),
          { status: 200 },
        ),
      );
    const api = new RuntimeApi(fetcher);
    await expect(api.listLatestRuns("thread_1")).resolves.toEqual([{ id: "run_2" }]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/threads/thread_1/runs?limit=1");
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

  it("纯文本预览只接受 API 内联文本，不将其解释为 URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "v1",
          requestId: "req_1",
          data: { disposition: "preview", text: "<script>window.pwned=true</script>" },
        }),
      ),
    );
    const api = new RuntimeApi(fetcher);
    await expect(api.previewArtifact("thread_1", "run_1", "artifact_1")).resolves.toEqual({
      kind: "text",
      text: "<script>window.pwned=true</script>",
    });
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

  it("Thread Context 跨页读取且旧 API 404 时回到旧投影", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req_1",
            data: {
              items: [
                {
                  sequence: 1,
                  runId: "run_a",
                  role: "user",
                  text: "A",
                  createdAt: "2026-07-31T00:00:00.000Z",
                },
              ],
              hasMore: true,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req_2",
            data: {
              items: [
                {
                  sequence: 2,
                  runId: "run_a",
                  role: "assistant",
                  text: "B",
                  createdAt: "2026-07-31T00:00:01.000Z",
                },
              ],
              hasMore: false,
            },
          }),
        ),
      );
    const api = new RuntimeApi(fetcher);
    await expect(api.listThreadContext("thread_1")).resolves.toMatchObject([
      { sequence: 1, text: "A" },
      { sequence: 2, text: "B" },
    ]);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/threads/thread_1/context?after=1&limit=500");

    const legacy = new RuntimeApi(
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { message: "不存在" } }), { status: 404 }),
        ),
    );
    await expect(legacy.listThreadContext("thread_1")).resolves.toBeUndefined();
  });

  it("读取连续性状态，并在独立开关关闭时兼容 404", async () => {
    const status = {
      boundary: "legacy_anchor",
      readMode: "v2",
      anchorState: "completed",
      queueDepth: 2,
      contextSequence: 17,
      compactionWindow: 3,
      sandboxState: "resuming",
    } as const;
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "v1", requestId: "req_1", data: status }), {
        status: 200,
      }),
    );
    const api = new RuntimeApi(fetcher);
    await expect(api.getThreadContinuity("thread/1")).resolves.toEqual(status);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/threads/thread%2F1/continuity");

    const disabled = new RuntimeApi(
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { message: "不存在" } }), { status: 404 }),
        ),
    );
    await expect(disabled.getThreadContinuity("thread_1")).resolves.toBeUndefined();
  });

  it("读取模型网络诊断元数据并保留轮次、重试与采集错误", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "v1",
          requestId: "req_1",
          data: {
            hasMore: true,
            nextCursor: "cursor_page_2",
            items: [
              {
                attemptId: "attempt_1",
                modelTurn: 2,
                transportAttempt: 1,
                part: "response",
                captureStatus: "aborted",
                persistenceStatus: "not_captured",
                captureErrorCode: "BODY_UNREADABLE",
                bodyAvailable: false,
                createdAt: "2026-07-30T00:00:00.000Z",
                expiresAt: "2026-08-06T00:00:00.000Z",
              },
            ],
          },
        }),
      ),
    );
    const api = new RuntimeApi(fetcher);
    await expect(api.listModelWireTraces("thread_1", "run_1")).resolves.toMatchObject({
      hasMore: true,
      nextCursor: "cursor_page_2",
      items: [
        {
          modelTurn: 2,
          transportAttempt: 1,
          captureErrorCode: "BODY_UNREADABLE",
        },
      ],
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/v1/threads/thread_1/runs/run_1/model-wire-traces?limit=500",
    );
  });

  it("后续模型网络诊断页携带服务端游标", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "v1",
          requestId: "req_1",
          data: { hasMore: false, nextCursor: "cursor_terminal", items: [] },
        }),
      ),
    );
    const api = new RuntimeApi(fetcher);
    await expect(api.listModelWireTraces("thread_1", "run_1", "cursor+/=")).resolves.toEqual({
      items: [],
      hasMore: false,
      nextCursor: "cursor_terminal",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/v1/threads/thread_1/runs/run_1/model-wire-traces?limit=500&cursor=cursor%2B%2F%3D",
    );
  });

  it("旧 API 或诊断关闭返回 404 时保持空诊断面", async () => {
    const api = new RuntimeApi(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "不存在", retryable: false } }), {
          status: 404,
        }),
      ),
    );
    await expect(api.listModelWireTraces("thread_1", "run_1")).resolves.toEqual({
      items: [],
      hasMore: false,
    });
  });

  it("模型网络正文按原始 ArrayBuffer 读取，不经过 JSON 或文本改写", async () => {
    const raw = new Uint8Array([0, 13, 10, 255, 1]);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(raw, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const api = new RuntimeApi(fetcher);
    await expect(
      api.getModelWireTraceBody("thread_1", "run_1", {
        attemptId: "attempt_1",
        modelTurn: 0,
        transportAttempt: 1,
        part: "response",
      }),
    ).resolves.toEqual(raw);
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("accept")).toBe("application/octet-stream");
  });

  it("拒绝形状异常的模型网络元数据", () => {
    expect(
      normalizeModelWireTrace({
        attemptId: "attempt_1",
        modelTurn: -1,
        transportAttempt: 0,
        part: "response",
        captureStatus: "complete",
        persistenceStatus: "stored",
        bodyAvailable: true,
        createdAt: "x",
        expiresAt: "y",
      }),
    ).toBeUndefined();
  });

  it("技能安装、配置和卸载请求都携带幂等键与 CAS 版本", async () => {
    const installed = {
      canonicalKey: "code-review",
      displayName: "代码审阅",
      publisher: "Cube",
      description: "按照团队检查清单审阅代码变更",
      skillVersion: "1.2.3",
      invocationName: "review",
      status: "enabled" as const,
      versionToken: 2,
      installedAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "v1", requestId: "req-1", data: installed })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req-2",
            data: { ...installed, status: "disabled", versionToken: 3 },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req-3",
            data: { canonicalKey: "code-review", uninstalled: true },
          }),
        ),
      );
    const api = new RuntimeApi(fetcher);
    await api.installSkill("code-review", "review");
    await api.setSkillEnabled(installed, false);
    await api.uninstallSkill({ ...installed, versionToken: 3 });

    const [, installInit] = fetcher.mock.calls[0] as [string, RequestInit];
    const [configureUrl, configureInit] = fetcher.mock.calls[1] as [string, RequestInit];
    const [uninstallUrl, uninstallInit] = fetcher.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(String(installInit.body))).toEqual({
      version: "recommended",
      invocationName: "review",
    });
    expect(JSON.parse(String(configureInit.body))).toEqual({
      expectedVersionToken: 2,
      enabled: false,
    });
    expect(configureUrl).toBe("/api/v1/me/skills/code-review");
    expect(uninstallUrl).toBe("/api/v1/me/skills/code-review?expectedVersionToken=3");
    expect(new Headers(uninstallInit.headers).get("idempotency-key")).toBeTruthy();
  });

  it("仅允许安全媒体类型预览", () => {
    expect(canPreviewArtifact("text/plain")).toBe(false);
    expect(canPreviewArtifact("text/plain; charset=utf-8")).toBe(true);
    expect(canPreviewArtifact('TEXT/PLAIN; charset="us-ascii"')).toBe(false);
    expect(canPreviewArtifact("text/plain; charset=iso-8859-1")).toBe(false);
    expect(canPreviewArtifact("text/plain; charset=windows-1252")).toBe(false);
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
