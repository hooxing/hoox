import { describe, expect, it } from "vitest";
import type { PiModelCatalogModelDto } from "./admin-control.js";
import { createPiModelCatalog } from "./pi-model-catalog.js";

function model(id: string, name: string, providerId = "first"): PiModelCatalogModelDto {
  return {
    providerId,
    providerName: providerId,
    id,
    name,
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function catalogFixture() {
  return createPiModelCatalog({
    providers: [
      {
        providerId: "second",
        displayName: "Zulu",
        baseUrl: "https://second.example.com/v1",
        modelCount: 1,
      },
      {
        providerId: "first",
        displayName: "Alpha",
        baseUrl: "https://first.example.com/v1",
        modelCount: 6,
      },
    ],
    models: [
      model("other", "A DeepSeek model"),
      model("prefix-deepseek", "Unrelated"),
      model("prefix-name", "DeepSeek Name Prefix"),
      model("deepseek-id-prefix", "Unrelated"),
      model("name-exact", "DeepSeek"),
      model("deepseek", "Unrelated", "second"),
      model("deepseek", "Unrelated"),
    ],
  });
}

describe("共享 Pi 模型目录查询", () => {
  it("按名称排列 Provider，保留地址及模型数", () => {
    expect(catalogFixture().listProviders()).toEqual([
      {
        providerId: "first",
        displayName: "Alpha",
        baseUrl: "https://first.example.com/v1",
        modelCount: 6,
      },
      {
        providerId: "second",
        displayName: "Zulu",
        baseUrl: "https://second.example.com/v1",
        modelCount: 1,
      },
    ]);
  });

  it("保留 ID/名称的精确、前缀、包含优先级及同名 Provider 排序", () => {
    expect(
      catalogFixture()
        .findModels({ query: "  DeEpSeEk  ", limit: 100 })
        .map(({ id, providerId }) => [id, providerId]),
    ).toEqual([
      ["deepseek", "first"],
      ["deepseek", "second"],
      ["name-exact", "first"],
      ["deepseek-id-prefix", "first"],
      ["prefix-name", "first"],
      ["prefix-deepseek", "first"],
      ["other", "first"],
    ]);
  });

  it("支持 Provider 内查询、过滤后的限额及空查询边界", () => {
    const catalog = catalogFixture();
    expect(
      catalog.findModels({ query: "deepseek", providerId: "first", limit: 2 }).map(({ id }) => id),
    ).toEqual(["deepseek", "name-exact"]);
    expect(
      catalog.findModels({ providerId: "first", query: "  ", limit: 2 }).map(({ id }) => id),
    ).toEqual(["deepseek", "deepseek-id-prefix"]);
    expect(catalog.findModels({ limit: 10 })).toEqual([]);
    expect(catalog.findModels({ query: "  ", limit: 10 })).toEqual([]);
    expect(catalog.findModels({ providerId: "missing", limit: 10 })).toEqual([]);
    expect(catalog.findModels({ query: "missing", limit: 10 })).toEqual([]);
    expect(catalog.findModels({ providerId: "first", limit: 0 })).toEqual([]);
  });

  it("调用方修改结果不会污染共享快照", () => {
    const catalog = catalogFixture();
    const providers = catalog.listProviders();
    const models = catalog.findModels({ providerId: "first", limit: 1 });
    if (providers[0] === undefined || models[0] === undefined) throw new Error("测试目录为空");
    providers[0].displayName = "Changed";
    models[0].name = "Changed";
    models[0].input.pop();
    expect(catalog.listProviders()[0]?.displayName).toBe("Alpha");
    expect(catalog.findModels({ providerId: "first", limit: 1 })[0]).toMatchObject({
      name: "Unrelated",
      input: ["text", "image"],
    });
  });
});
