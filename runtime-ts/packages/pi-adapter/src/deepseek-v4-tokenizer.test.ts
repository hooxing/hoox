import { describe, expect, it } from "vitest";
import {
  isTrustedModelTokenizerCapability,
  loadTrustedModelTokenizerCapability,
} from "./deepseek-v4-tokenizer.js";

describe("模型 Token 计数能力", () => {
  it("DeepSeek V4 从固定资源离线加载并按模型 token 计数", async () => {
    const tokenizer = await loadTrustedModelTokenizerCapability("deepseek-v4-flash");

    expect(tokenizer).toMatchObject({
      strategy: "exact",
      modelFamily: "deepseek-v4",
      sourceRevision: "a7aaed80dd2df27620eb534454253ea25eb11c7a",
      identity: "deepseek-v4@a7aaed80-tokenizer-v1",
    });
    expect(isTrustedModelTokenizerCapability(tokenizer)).toBe(true);
    expect(tokenizer.countTokens("你好，世界🙂")).toBe(5);
    expect(tokenizer.countTokens("Hello, world!")).toBe(4);
    expect(tokenizer.countTokens("可信探针🙂 entropy-0123456789")).toBe(11);
    expect(tokenizer.countTokens("")).toBe(0);
  });

  it.each([
    ["custom-model", "openai", "new-api-token-estimator:openai-v1", 6],
    ["gemini-2.5-pro", "gemini", "new-api-token-estimator:gemini-v1", 5],
    ["claude-sonnet", "claude", "new-api-token-estimator:claude-v1", 8],
  ] as const)(
    "%s 无专用 tokenizer 时使用 %s 权重降级",
    async (modelId, family, identity, tokens) => {
      const tokenizer = await loadTrustedModelTokenizerCapability(modelId);

      expect(tokenizer).toMatchObject({
        strategy: "estimated",
        modelFamily: family,
        sourceRevision: "new-api-token-estimator-v1",
        identity,
      });
      expect(isTrustedModelTokenizerCapability(tokenizer)).toBe(true);
      expect(tokenizer.countTokens("你好，世界🙂")).toBe(tokens);
      expect(tokenizer.countTokens("")).toBe(0);
    },
  );

  it("估算器按 new-api 的单词、数字和符号状态机计数", async () => {
    const tokenizer = await loadTrustedModelTokenizerCapability("qwen-custom");

    expect(tokenizer.countTokens("Hello, world!")).toBe(4);
    expect(tokenizer.countTokens("version3.5")).toBe(5);
    expect(tokenizer.countTokens("https://example.com?a=1")).toBe(12);
  });
});
