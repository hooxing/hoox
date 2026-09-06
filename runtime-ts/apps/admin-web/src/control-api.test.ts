import type { SaveModelProviderConfigurationRequest } from "@hoox/protocol";
import { describe, expect, it, vi } from "vitest";
import { AdminApiError } from "./api.js";
import { AdminControlApi } from "./control-api.js";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const saveModelInput: SaveModelProviderConfigurationRequest = {
  expectedGeneration: 0,
  providerKey: "main",
  displayName: "主模型",
  protocol: "openai-compatible",
  baseUrl: "https://model.example.com/v1",
  apiKey: "test-model-key",
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
};

function requestKeys(fetcher: ReturnType<typeof vi.fn<typeof fetch>>): (string | null)[] {
  return fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));
}

describe("后台控制 Web API", () => {
  it("保存已提交但响应丢失时复用原幂等键，成功后新操作释放旧键", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(response({ data: { status: "active", revision: 1 } }))
      .mockResolvedValueOnce(response({ data: { status: "active", revision: 1 } }));
    const createKey = vi
      .fn()
      .mockReturnValueOnce("save-key-0001")
      .mockReturnValueOnce("save-key-0002");
    const api = new AdminControlApi(fetcher, "/v1/admin/control", createKey);
    await expect(api.saveModelConfiguration(saveModelInput)).rejects.toMatchObject({
      status: 0,
      retryable: true,
    });
    await expect(api.saveModelConfiguration({ ...saveModelInput })).resolves.toMatchObject({
      status: "active",
    });
    await api.saveModelConfiguration(saveModelInput);
    expect(requestKeys(fetcher)).toEqual(["save-key-0001", "save-key-0001", "save-key-0002"]);
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["可重试错误", () => response({ error: { retryable: true } }, 503)],
    ["未知服务错误", () => response({}, 500)],
    ["成功响应缺少数据", () => response({})],
    ["成功响应无法解析", () => new Response("invalid json", { status: 200 })],
  ] as const)("%s 保留重试身份", async (_label, unknownResponse) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unknownResponse())
      .mockResolvedValueOnce(response({ data: { status: "active" } }));
    const createKey = vi
      .fn()
      .mockReturnValueOnce("save-unknown-0001")
      .mockReturnValueOnce("save-unknown-0002");
    const api = new AdminControlApi(fetcher, "/v1/admin/control", createKey);
    await expect(api.saveModelConfiguration(saveModelInput)).rejects.toMatchObject({
      retryable: true,
    });
    await api.saveModelConfiguration(saveModelInput);
    expect(requestKeys(fetcher)).toEqual(["save-unknown-0001", "save-unknown-0001"]);
  });

  it("明确失败释放旧键，内容或目标改变分别使用新键", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: { retryable: false } }, 409))
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(response({ data: { status: "active" } }))
      .mockResolvedValueOnce(response({ data: { status: "active" } }));
    let nextKey = 0;
    const api = new AdminControlApi(fetcher, "/v1/admin/control", () => `save-key-${++nextKey}`);
    await expect(api.saveModelConfiguration(saveModelInput)).rejects.toMatchObject({
      status: 409,
      retryable: false,
    });
    await expect(api.saveModelConfiguration(saveModelInput)).rejects.toMatchObject({ status: 0 });
    await expect(
      api.saveModelConfiguration({ ...saveModelInput, displayName: "另一名称" }),
    ).rejects.toMatchObject({ status: 0 });
    await api.saveModelConfiguration(saveModelInput);
    await api.publish("model-providers", "main", 1, { expectedVersionToken: 0 });
    expect(requestKeys(fetcher)).toEqual([
      "save-key-1",
      "save-key-2",
      "save-key-3",
      "save-key-2",
      "save-key-4",
    ]);
  });
  it("读请求不带幂等键，写入密钥只进入一次性请求体", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { items: [] } }))
      .mockResolvedValueOnce(response({ data: { revision: 1 } }));
    const api = new AdminControlApi(fetcher, "/v1/admin/control", () => "control-key-0001");

    await api.listModelProviders();
    await api.saveModelConfiguration({
      expectedGeneration: 0,
      providerKey: "main",
      displayName: "主模型",
      protocol: "openai-compatible",
      baseUrl: "https://model.example.com/v1",
      apiKey: "test-model-key",
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
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe("/v1/admin/control/model-providers");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("Idempotency-Key")).toBe(false);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "control-key-0001",
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe("/v1/admin/control/model-providers/current");
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      apiKey: "test-model-key",
      expectedGeneration: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("一次请求保存记忆配置并生效，携带并发检查且不要求原因", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ data: { status: "active" } }));
    const api = new AdminControlApi(fetcher, "/v1/admin/control", () => "memory-save-key");
    const input = {
      expectedGeneration: 7,
      providerKey: "mem0",
      displayName: "Mem0 Platform",
      providerKind: "mem0" as const,
      baseUrl: "https://memory.example.com/",
      apiSecretRef: "deployment:memory-api" as const,
      scopeSecretRef: "deployment:memory-scope" as const,
      requestTimeoutMs: 15000,
      enabled: false,
    };
    await api.saveMemoryConfiguration(input);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/v1/admin/control/memory-providers/current",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(input);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "memory-save-key",
    );
  });

  it("运行设置直接 PUT 当前配置并带幂等键", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ data: { status: "active" } }));
    const api = new AdminControlApi(fetcher, "/v1/admin/control", () => "runtime-save-key");
    const input = {
      workerMaxConcurrentRuns: 20,
      userMaxConcurrentRunsPerTenant: 2,
      compactionSoftLimitPercent: 80,
      compactionTargetPercent: 55,
      compactionRecentUserTokens: 4096,
      compactionMaxOutputTokens: 4096,
      compactionTimeoutMs: 60000,
      expectedGeneration: 0,
    };
    await api.saveRuntimeSettingsConfiguration(input);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/v1/admin/control/runtime-settings/current",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(input);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "runtime-save-key",
    );
  });

  it("并发保存冲突提示刷新，不暴露内部版本", async () => {
    const api = new AdminControlApi(vi.fn<typeof fetch>(async () => response({}, 409)));
    await expect(api.overview()).rejects.toMatchObject({ message: "配置已被更新，请刷新后重试。" });
  });

  it("身份配置写请求带幂等键且秘密只出现在请求体", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          versionToken: 1,
          emailPasswordEnabled: true,
          emailVerificationEnabled: false,
          smtpPort: 465,
          smtpSecure: true,
          smtpPasswordConfigured: false,
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
      emailVerificationEnabled: true,
      emailFromAddress: "no-reply@example.com",
      emailFromName: "Hoox",
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      smtpUsername: "mailer@example.com",
      smtpPassword: "smtp-secret",
      registrationEnabled: true,
      phoneEnabled: false,
      providers: [
        { key: "google", enabled: true, clientId: "google-client", clientSecret: "google-secret" },
        { key: "github", enabled: false, clientId: "" },
        { key: "wechat", enabled: false, clientId: "" },
        { key: "qq", enabled: false, clientId: "" },
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/admin/control/identity",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "identity-key-0001",
    );
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain("google-secret");
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain("smtp-secret");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).not.toHaveProperty("reason");
  });

  it("不把服务端错误正文或 Provider 细节带入界面", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({ error: { message: "upstream secret response", retryable: true } }, 503),
    );
    const api = new AdminControlApi(fetcher);
    const error = await api.overview().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as Error).message).toBe("服务连接测试失败或依赖暂时不可用。");
    expect((error as Error).message).not.toContain("secret");
  });

  it("模型字段校验失败时展示服务端的安全说明", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response(
        {
          error: {
            message: "Provider 地址必须是无凭据 HTTPS URL",
            retryable: false,
          },
        },
        400,
      ),
    );
    const api = new AdminControlApi(fetcher);

    const error = await api.overview().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as Error).message).toBe("Provider 地址必须是无凭据 HTTPS URL");
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
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe("/v1/admin/control/users?limit=20&query=customer");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/v1/admin/control/users/user_customer/status");
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "user-status-key",
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ status: "disabled" });
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
