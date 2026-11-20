import { describe, expect, it, vi } from "vitest";
import { canPreviewArtifact, normalizeRunEvent, RuntimeApi } from "./api.js";

describe("RuntimeApi", () => {
  it("实时流携带现有身份与 Tenant 头，验证正文和结束帧", async () => {
    const payload = {
      run: { id: "run", threadId: "thread", status: "running" },
      page: {
        attemptId: "attempt",
        hasMore: false,
        items: [
          {
            sequence: 0,
            eventId: "attempt-0",
            kind: "agent_event",
            type: "message.delta",
            payload: { delta: "中文" },
            occurredAt: "2026-09-04T00:00:00Z",
          },
        ],
      },
    };
    const fetcher = vi.fn(
      async () =>
        new Response(
          `event: run-events\ndata: ${JSON.stringify(payload)}\n\nevent: end\ndata: {"reason":"settled"}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const api = new RuntimeApi(fetcher, "/api");
    api.setAccessToken("test-token");
    api.setTenantId("tenant-test");
    const receive = vi.fn();
    expect(
      await api.streamEvents(
        "thread",
        "run",
        { after: -1, attemptId: undefined },
        new AbortController().signal,
        receive,
      ),
    ).toBe("settled");
    expect(receive).toHaveBeenCalledOnce();
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(call[1].headers).get("authorization")).toBe("Bearer test-token");
    expect(new Headers(call[1].headers).get("x-tenant-id")).toBe("tenant-test");
    expect(call[0]).toContain("/events/stream?after=-1");
  });

  it("缺失结束帧的 EOF 会要求重连，跨 Run 数据不能进入正文", async () => {
    for (const body of [
      "",
      'event: run-events\ndata: {"run":{"id":"other","threadId":"thread","status":"running"},"page":{"items":[],"hasMore":false}}\n\n',
    ]) {
      const api = new RuntimeApi(
        async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
      const receive = vi.fn();
      await expect(
        api.streamEvents(
          "thread",
          "run",
          { after: -1, attemptId: undefined },
          new AbortController().signal,
          receive,
        ),
      ).rejects.toMatchObject({ retryable: true });
      expect(receive).not.toHaveBeenCalled();
    }
  });
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

  it("按当前 Tenant 读取可用 Agent，并支持在创建 Thread 时提交选择", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req_agents",
            data: String(input).endsWith("/v1/agents")
              ? {
                  items: [
                    {
                      id: "agent_sales",
                      displayName: "销售助手",
                      description: "销售",
                      suggestedQuestions: [],
                    },
                  ],
                }
              : { id: "thread_sales" },
          }),
          { status: 200 },
        ),
    );
    const api = new RuntimeApi(fetcher, "/api");
    api.setTenantId("tenant_sales");
    await expect(api.listAvailableAgents()).resolves.toMatchObject([{ id: "agent_sales" }]);
    await api.createThread("客户跟进", "agent_sales");
    expect(fetcher.mock.calls[0]?.[0]).toContain("/v1/agents");
    expect(fetcher.mock.calls[1]?.[0]).toContain("/v1/threads");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      title: "客户跟进",
      agentDefinitionId: "agent_sales",
    });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-tenant-id")).toBe(
      "tenant_sales",
    );
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
    api.setAccessToken("dev-user-a");
    await api.createThread("测试", "agent_sales");
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer dev-user-a");
    expect(headers.get("idempotency-key")).toMatch(/^[-a-z0-9]{8,}$/iu);
    expect(url).toContain("/v1/threads");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "测试",
      agentDefinitionId: "agent_sales",
    });
  });

  it("登录注册不携带旧身份，后续请求使用服务端返回的动态令牌", async () => {
    const fetcher = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req_auth",
            data: url.endsWith("/v1/auth/login")
              ? {
                  profile: { id: "user_local", displayName: "林晓", email: "lin@example.com" },
                  accessToken: "hoox_session_new",
                  expiresAt: "2099-12-31T23:59:59.000Z",
                }
              : { items: [] },
          }),
          { status: 200 },
        ),
      ),
    );
    const api = new RuntimeApi(fetcher, "/api");
    api.setAccessToken("stale-token");

    await api.loginAccount({ email: "lin@example.com", password: "secret12" });
    expect(
      new Headers((fetcher.mock.calls[0] as [string, RequestInit])[1].headers).get("authorization"),
    ).toBeNull();

    api.setAccessToken("hoox_session_new");
    await api.listThreads();
    expect(
      new Headers((fetcher.mock.calls[1] as [string, RequestInit])[1].headers).get("authorization"),
    ).toBe("Bearer hoox_session_new");
  });

  it("邮箱身份先调用 Better Auth，再交换为 Hoox 会话", async () => {
    const session = {
      profile: { id: "user_identity", displayName: "身份用户", email: "identity@example.com" },
      accessToken: "hoox_session_identity-token-with-more-than-thirty-two-characters",
      expiresAt: "2099-12-31T23:59:59.000Z",
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/sign-in/email")) {
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "better-user" } }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ version: "v1", requestId: "req_identity", data: session }), {
          status: 200,
        }),
      );
    });
    const api = new RuntimeApi(fetcher, "/api");
    await expect(
      api.signInWithEmail({ email: "identity@example.com", password: "secret12" }),
    ).resolves.toEqual(session);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/api/auth/sign-in/email",
      "/api/v1/auth/exchange",
    ]);
    const firstRequest = fetcher.mock.calls[0]?.[1];
    expect(firstRequest).toBeDefined();
    expect((firstRequest as RequestInit).credentials).toBe("same-origin");
  });

  it("首次管理员可在 Better Auth 拒绝密码后使用本地管理员登录", async () => {
    const session = { accessToken: "hoox_session_setup" };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: session }));
    const api = new RuntimeApi(fetcher, "/api");
    await expect(
      api.signInWithEmail({ email: "setup@example.invalid", password: "setup-password" }),
    ).resolves.toEqual(session);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/api/auth/sign-in/email",
      "/api/v1/installation/login",
    ]);
  });
  it("身份服务故障时不会降级到管理员登录", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 503 }));
    await expect(
      new RuntimeApi(fetcher, "/api").signInWithEmail({
        email: "setup@example.invalid",
        password: "setup-password",
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("邮箱注册在验证码验证后才交换 Hoox 会话", async () => {
    const session = {
      profile: { id: "user_identity", displayName: "身份用户", email: "identity@example.com" },
      accessToken: "hoox_session_identity-token-with-more-than-thirty-two-characters",
      expiresAt: "2099-12-31T23:59:59.000Z",
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/sign-up/email")) {
        return Promise.resolve(new Response(JSON.stringify({ token: null }), { status: 200 }));
      }
      if (url.endsWith("/api/auth/email-otp/send-verification-otp")) {
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      }
      if (url.endsWith("/api/auth/email-otp/verify-email")) {
        return Promise.resolve(new Response(JSON.stringify({ status: true }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ version: "v1", requestId: "req_identity", data: session }), {
          status: 200,
        }),
      );
    });
    const api = new RuntimeApi(fetcher, "/api");

    await expect(
      api.signUpWithEmail({
        displayName: "身份用户",
        email: "identity@example.com",
        password: "secret12",
      }),
    ).resolves.toEqual({
      emailVerificationRequired: true,
      emailVerificationCodeSent: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await api.resendEmailVerificationOtp("identity@example.com");
    await expect(api.verifyEmailOtp("identity@example.com", "123456")).resolves.toEqual(session);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/api/auth/sign-up/email",
      "/api/api/auth/email-otp/send-verification-otp",
      "/api/api/auth/email-otp/verify-email",
      "/api/v1/auth/exchange",
    ]);
  });

  it("注册请求在账号已创建但发信失败时恢复为待验证状态", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/sign-up/email")) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "SMTP failed" }), { status: 502 }),
        );
      }
      if (url.endsWith("/api/auth/sign-in/email")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }),
            { status: 403 },
          ),
        );
      }
      throw new Error(`未预期请求：${url}`);
    });
    const api = new RuntimeApi(fetcher, "/api");

    await expect(
      api.signUpWithEmail({
        displayName: "身份用户",
        email: "identity@example.com",
        password: "secret12",
      }),
    ).resolves.toEqual({
      emailVerificationRequired: true,
      emailVerificationCodeSent: false,
    });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/api/auth/sign-up/email",
      "/api/api/auth/sign-in/email",
    ]);
  });

  it("可并行读取个人与团队任务列表且不改变当前活动租户", async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ version: "v1", requestId: "req_1", data: { items: [] } }), {
          status: 200,
        }),
      ),
    );
    const api = new RuntimeApi(fetcher, "/api");
    api.setTenantId("tenant_active");

    await api.listThreadsForTenant(undefined);
    await api.listThreadsForTenant("tenant_product");

    const personalRequest = fetcher.mock.calls[0] as [string, RequestInit];
    const teamRequest = fetcher.mock.calls[1] as [string, RequestInit];
    const personalHeaders = new Headers(personalRequest[1].headers);
    const teamHeaders = new Headers(teamRequest[1].headers);
    expect(personalHeaders.has("x-tenant-id")).toBe(false);
    expect(teamHeaders.get("x-tenant-id")).toBe("tenant_product");
    expect(api.getTenantId()).toBe("tenant_active");
  });

  it("个人任务改名和删除可以显式忽略当前团队选择", async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req_personal_task",
            data: {
              id: "thread_personal",
              title: "新名称",
              status: "active",
              createdAt: "2026-08-28T00:00:00.000Z",
              updatedAt: "2026-08-28T00:00:01.000Z",
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const api = new RuntimeApi(fetcher, "/api");
    api.setTenantId("tenant_active_team");

    await api.renamePersonalThreadForTenant("thread_personal", "新名称", undefined);
    await api.archiveThreadForTenant("thread_personal", undefined);

    const renameRequest = fetcher.mock.calls[0] as [string, RequestInit];
    const deleteRequest = fetcher.mock.calls[1] as [string, RequestInit];
    expect(renameRequest[0]).toBe("/api/v1/threads/thread_personal");
    expect(renameRequest[1].method).toBe("PATCH");
    expect(renameRequest[1].body).toBe(JSON.stringify({ title: "新名称" }));
    expect(new Headers(renameRequest[1].headers).has("x-tenant-id")).toBe(false);
    expect(deleteRequest[1].method).toBe("DELETE");
    expect(new Headers(deleteRequest[1].headers).has("x-tenant-id")).toBe(false);
    expect(api.getTenantId()).toBe("tenant_active_team");
  });

  it("团队目录使用个人身份，团队管理请求显式绑定路径中的目标 Tenant", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ version: "v1", requestId: "req_teams", data: { items: [] } }),
            { status: 200 },
          ),
        ),
      );
    const api = new RuntimeApi(fetcher, "/api");
    api.setTenantId("tenant_stale");

    await api.listTeams();
    await api.createTeam("新团队");
    await api.listTeamMembers("tenant_target");
    await api.dissolveTeam("tenant_target");

    const requests = fetcher.mock.calls.map((call) => {
      const [url, init] = call as [string, RequestInit];
      return { url, tenantId: new Headers(init.headers).get("x-tenant-id") };
    });
    expect(requests).toEqual([
      { url: "/api/v1/me/teams", tenantId: null },
      { url: "/api/v1/teams", tenantId: null },
      { url: "/api/v1/teams/tenant_target/members", tenantId: "tenant_target" },
      { url: "/api/v1/teams/tenant_target", tenantId: "tenant_target" },
    ]);
    expect(api.getTenantId()).toBe("tenant_stale");
  });

  it("个人个性化固定使用个人身份，团队个性化固定绑定目标团队", async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req_personalization",
            data: { content: "", version: 0, applyToTeamTasks: true, canEdit: true },
          }),
          { status: 200 },
        ),
      ),
    );
    const api = new RuntimeApi(fetcher, "/api");
    api.setTenantId("tenant_active");

    await api.getPersonalPersonalization();
    await api.updatePersonalPersonalization({
      content: "默认中文",
      applyToTeamTasks: false,
      expectedVersion: 0,
    });
    await api.getTeamPersonalization("tenant_product");
    await api.updateTeamPersonalization("tenant_product", {
      content: "默认 TypeScript",
      expectedVersion: 0,
    });

    const requests = fetcher.mock.calls.map((call) => {
      const [url, init] = call as [string, RequestInit];
      return { url, tenantId: new Headers(init.headers).get("x-tenant-id") };
    });
    expect(requests).toEqual([
      { url: "/api/v1/me/personalization", tenantId: null },
      { url: "/api/v1/me/personalization", tenantId: null },
      { url: "/api/v1/teams/tenant_product/personalization", tenantId: "tenant_product" },
      { url: "/api/v1/teams/tenant_product/personalization", tenantId: "tenant_product" },
    ]);
    expect(api.getTenantId()).toBe("tenant_active");
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

  it("图片附件预览使用历史文件的 inline 交付入口", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "v1",
          requestId: "req_preview",
          data: { url: "https://example.test/image-preview" },
        }),
        { status: 200 },
      ),
    );
    const api = new RuntimeApi(fetcher);

    await expect(
      api.previewHistoryFile({ resourceId: "resource_image", versionId: "version_image" }),
    ).resolves.toBe("https://example.test/image-preview");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/v1/me/history-files/resource_image/versions/version_image/preview",
    );
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
                  attachments: [
                    {
                      resourceId: "resource_a",
                      versionId: "version_a",
                      name: "图.png",
                      mediaType: "image/png",
                      sizeBytes: 12,
                    },
                  ],
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
      {
        sequence: 1,
        text: "A",
        attachments: [{ resourceId: "resource_a", versionId: "version_a", name: "图.png" }],
      },
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

  it("历史文件列表保留搜索、时间和游标，下载使用个人云盘路由", async () => {
    const file = {
      threadId: "thread_history",
      taskName: "合同审查",
      resourceId: "resource_history",
      versionId: "version_history",
      name: "合同.docx",
      entryName: "合同.docx",
      path: "/resources/resource_history/version_history/合同.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 128,
      attachedAt: "2026-08-07T08:00:00.000Z",
    };
    const page = {
      items: [
        {
          threadId: file.threadId,
          name: file.taskName,
          createdAt: "2026-08-07T07:00:00.000Z",
          lastFileAt: file.attachedAt,
          fileCount: 1,
          files: [file],
        },
      ],
      range: { activeBefore: "2026-02-07T00:00:00.000Z" },
      hasMore: false,
      hasOlder: false,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "v1", requestId: "req-list", data: page }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: "v1",
            requestId: "req-download",
            data: { file, url: "http://127.0.0.1:19000/history-download", expiresInSeconds: 300 },
          }),
          { status: 200 },
        ),
      );
    const api = new RuntimeApi(fetcher, "/api");

    await expect(
      api.listHistoryFiles({
        query: " 合同 ",
        activeBefore: "2026-02-07T00:00:00.000Z",
        before: { lastFileAt: "2026-01-31T00:00:00.000Z", threadId: "thread_cursor" },
        limit: 8,
      }),
    ).resolves.toEqual(page);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/v1/me/history-files?q=%E5%90%88%E5%90%8C&activeBefore=2026-02-07T00%3A00%3A00.000Z&beforeLastFileAt=2026-01-31T00%3A00%3A00.000Z&beforeThreadId=thread_cursor&limit=8",
    );

    await expect(api.downloadHistoryFile(file)).resolves.toBe(
      "http://127.0.0.1:19000/history-download",
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/v1/me/history-files/resource_history/versions/version_history/download",
    );
  });
});
