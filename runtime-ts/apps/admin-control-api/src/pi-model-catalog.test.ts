import { describe, expect, it } from "vitest";
import { createPiModelCatalog } from "./pi-model-catalog.js";

function model(id: string, name: string, api = "openai-completions") {
  return {
    id,
    name,
    api,
    reasoning: id.includes("reasoner"),
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8_192,
    baseUrl: "https://model.example.com/v1",
  };
}

describe("Pi 后台模型目录", () => {
  const catalog = createPiModelCatalog([
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      getModels: () => [
        model("deepseek-chat", "DeepSeek Chat"),
        model("deepseek-reasoner", "DeepSeek Reasoner"),
      ],
    },
    {
      id: "other",
      name: "Other",
      getModels: () => [model("deepseek-chat-proxy", "DeepSeek Chat Proxy")],
    },
    {
      id: "responses-only",
      name: "Responses Only",
      getModels: () => [model("gpt", "GPT", "openai-responses")],
    },
  ]);

  it("只列出当前 Worker 支持且拥有 Base URL 的 Provider", () => {
    expect(catalog.listProviders()).toEqual([
      expect.objectContaining({ providerId: "deepseek", modelCount: 2 }),
      expect.objectContaining({ providerId: "other", modelCount: 1 }),
    ]);
  });

  it("可按 Provider 获取目录，并按模型 ID 或名称跨 Provider 查询", () => {
    expect(catalog.findModels({ providerId: "deepseek", limit: 10 })).toHaveLength(2);
    expect(
      catalog.findModels({ query: "DeepSeek Chat", limit: 10 }).map((item) => item.id),
    ).toEqual(["deepseek-chat", "deepseek-chat-proxy"]);
    expect(catalog.findModels({ query: "reasoner", limit: 1 })).toEqual([
      expect.objectContaining({ id: "deepseek-reasoner", reasoning: true }),
    ]);
  });
});
