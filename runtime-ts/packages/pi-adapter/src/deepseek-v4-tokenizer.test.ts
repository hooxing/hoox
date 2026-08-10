import { describe, expect, it } from "vitest";
import {
  isTrustedModelTokenizerCapability,
  loadTrustedModelTokenizerCapability,
} from "./deepseek-v4-tokenizer.js";

describe("DeepSeek V4 固定 tokenizer", () => {
  it("从固定资源离线加载并按模型 token 计数", async () => {
    const tokenizer = await loadTrustedModelTokenizerCapability("deepseek-v4-flash");

    expect(tokenizer).toMatchObject({
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

  it("未知模型失败关闭，不能静默回退到 UTF-8 字节估算", () => {
    expect(() => loadTrustedModelTokenizerCapability("unknown-model")).toThrow(
      "MODEL_TOKENIZER_UNSUPPORTED",
    );
  });
});
