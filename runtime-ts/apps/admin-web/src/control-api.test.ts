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
});
