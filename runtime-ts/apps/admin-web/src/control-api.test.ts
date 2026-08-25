import { describe, expect, it, vi } from "vitest";
import { AdminApiError } from "./api.js";
import { AdminControlApi } from "./control-api.js";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("后台控制 Web API", () => {
  it("读请求不带幂等键，写请求使用同源路径且不传秘密值", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { items: [] } }))
      .mockResolvedValueOnce(response({ data: { revision: 1 } }));
    const api = new AdminControlApi(fetcher, "/v1/admin/control", () => "control-key-0001");

    await api.listModelProviders();
    await api.createModelDraft({
      providerKey: "main",
      displayName: "主模型",
      protocol: "openai-compatible",
      baseUrl: "https://model.example.com/v1",
      secretRef: "deployment:model",
      defaultModelId: "model-a",
      models: [
        {
          id: "model-a",
          name: "Model A",
          enabled: true,
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
      reason: "创建草稿",
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe("/v1/admin/control/model-providers");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("Idempotency-Key")).toBe(false);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "control-key-0001",
    );
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).not.toContain("apiKey");
  });

  it("身份配置写请求带幂等键且秘密只出现在请求体", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          versionToken: 1,
          emailPasswordEnabled: true,
          registrationEnabled: true,
          phoneEnabled: false,
          smsWebhookSecretConfigured: false,
          providers: [],
        },
      }),
    );
    const api = new AdminControlApi(fetcher, "/v1/admin/control", () => "identity-key-0001");
    await api.updateIdentityConfiguration({
      expectedVersionToken: 0,
      emailPasswordEnabled: true,
      registrationEnabled: true,
      phoneEnabled: false,
      providers: [
        { key: "google", enabled: true, clientId: "google-client", clientSecret: "google-secret" },
        { key: "github", enabled: false, clientId: "" },
        { key: "wechat", enabled: false, clientId: "" },
        { key: "qq", enabled: false, clientId: "" },
      ],
      reason: "启用 Google 登录",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/admin/control/identity",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "identity-key-0001",
    );
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain("google-secret");
  });

  it("不把服务端错误正文或 Provider 细节带入界面", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({ error: { message: "upstream secret response", retryable: true } }, 503),
    );
    const api = new AdminControlApi(fetcher);
    const error = await api.overview().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as Error).message).toBe("Provider 探测失败或依赖暂时不可用。");
    expect((error as Error).message).not.toContain("secret");
  });

  it("按 Provider 或模型名读取 Pi 模型目录", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          items: [
            {
              providerId: "deepseek",
              providerName: "DeepSeek",
              id: "deepseek-chat",
              name: "DeepSeek Chat",
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
          ],
        },
      }),
    );
    const api = new AdminControlApi(fetcher);

    await expect(
      api.findPiModelCatalogModels({ query: "DeepSeek Chat", limit: 10 }),
    ).resolves.toEqual([expect.objectContaining({ id: "deepseek-chat" })]);
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/admin/control/model-catalog/models?query=DeepSeek+Chat&limit=10",
      expect.anything(),
    );
  });

  it("后台不可用时从随前端发布的 Pi 快照读取目录", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network unavailable");
    });
    const api = new AdminControlApi(fetcher);

    await expect(api.listPiModelCatalogProviders()).resolves.toContainEqual(
      expect.objectContaining({ providerId: "deepseek" }),
    );
    await expect(
      api.findPiModelCatalogModels({ query: "DeepSeek V4 Pro", limit: 10 }),
    ).resolves.toContainEqual(expect.objectContaining({ id: "deepseek-v4-pro" }));
  });

  it("权限错误不降级为本地目录", async () => {
    const api = new AdminControlApi(vi.fn<typeof fetch>(async () => response({}, 403)));
    await expect(api.listPiModelCatalogProviders()).rejects.toMatchObject({ status: 403 });
  });

  it("读取用户目录并用带幂等键的请求变更用户状态", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { items: [], total: 0 } }))
      .mockResolvedValueOnce(
        response({
          data: {
            userId: "user_customer",
            email: "customer@example.com",
            displayName: "测试用户",
            status: "disabled",
            createdAt: "2026-08-20T00:00:00.000Z",
            activeSessions: 0,
            conversationCount: 0,
            runCount: 0,
          },
        }),
      );
    const api = new AdminControlApi(fetcher, "/v1/admin/control", () => "user-status-key");

    await api.listUsers({ query: "customer", limit: 20 });
    await api.updateUserStatus("user_customer", {
      status: "disabled",
      reason: "账号风险处置",
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe("/v1/admin/control/users?limit=20&query=customer");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/v1/admin/control/users/user_customer/status");
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "user-status-key",
    );
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).not.toContain("password");
  });
  it("使用当前 Hoox 会话调用控制 API", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: {} }));
    const api = new AdminControlApi(
      fetcher,
      "/v1/admin/control",
      () => "unused-key",
      () => "Bearer hoox_session_demo-token",
    );

    await api.overview();

    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer hoox_session_demo-token",
    );
  });
});
