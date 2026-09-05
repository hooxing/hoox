import { describe, expect, it } from "vitest";
import { createPiModelCatalog } from "./pi-model-catalog.js";

describe("Pi 后台模型目录快照", () => {
  const catalog = createPiModelCatalog();

  it("无需加载 Provider 运行时即可取得管理草稿初始值", () => {
    expect(catalog.listProviders()).toContainEqual({
      providerId: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      modelCount: 2,
    });
    expect(catalog.findModels({ providerId: "deepseek", limit: 100 })).toEqual([
      expect.objectContaining({
        id: "deepseek-v4-flash",
        api: "openai-completions",
        reasoning: true,
      }),
      expect.objectContaining({
        id: "deepseek-v4-pro",
        api: "openai-completions",
        reasoning: true,
      }),
    ]);
  });

  it("支持跨 Provider 检索并保留空查询边界", () => {
    expect(catalog.findModels({ query: "  DEEPSEEK-V4-FLASH  ", limit: 1 })).toEqual([
      expect.objectContaining({ providerId: "deepseek", id: "deepseek-v4-flash" }),
    ]);
    expect(catalog.findModels({ limit: 100 })).toEqual([]);
  });

  it("快照只包含拥有 Base URL 的兼容模型，Provider 模型数与查询结果一致", () => {
    const providers = catalog.listProviders();
    expect(providers.length).toBeGreaterThan(20);
    for (const provider of providers) {
      expect(provider.baseUrl).not.toBe("");
      const models = catalog.findModels({
        providerId: provider.providerId,
        limit: Number.MAX_SAFE_INTEGER,
      });
      expect(models).toHaveLength(provider.modelCount);
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((model) => model.api === "openai-completions")).toBe(true);
    }
  });
});
