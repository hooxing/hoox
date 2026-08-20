import { describe, expect, it } from "vitest";
import {
  findLocalPiModelCatalogModels,
  listLocalPiModelCatalogProviders,
} from "./pi-model-catalog.js";

describe("前端 Pi 模型目录快照", () => {
  it("后台不可用时仍可列出 Provider 并按模型名检索", () => {
    const providers = listLocalPiModelCatalogProviders();
    expect(providers.length).toBeGreaterThan(20);
    expect(providers).toContainEqual(
      expect.objectContaining({ providerId: "deepseek", displayName: "DeepSeek" }),
    );

    expect(findLocalPiModelCatalogModels({ query: "DeepSeek V4", limit: 20 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "deepseek", id: "deepseek-v4-flash" }),
        expect.objectContaining({ providerId: "deepseek", id: "deepseek-v4-pro" }),
      ]),
    );
  });

  it("按 Provider 查询时保留当前 Worker 支持的协议边界", () => {
    const models = findLocalPiModelCatalogModels({ providerId: "deepseek", limit: 100 });
    expect(models).toHaveLength(2);
    expect(models.every((model) => model.api === "openai-completions")).toBe(true);
  });
});
