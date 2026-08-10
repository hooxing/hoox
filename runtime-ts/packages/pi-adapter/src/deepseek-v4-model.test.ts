import { describe, expect, it } from "vitest";
import {
  assertOfficialDeepSeekV4FlashCapabilities,
  DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
  DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
  DEEPSEEK_V4_FLASH_MODEL_ID,
  normalizeOfficialDeepSeekV4FlashPayload,
  officialDeepSeekV4FlashModelProtocol,
  officialModelThinkingLevel,
} from "./deepseek-v4-model.js";

describe("DeepSeek V4 Flash 0731 官方模型配置", () => {
  it("固定官方 OMP 能力、thinking 与 Chat Completions 兼容项", () => {
    expect(DEEPSEEK_V4_FLASH_MODEL_ID).toBe("deepseek-v4-flash");
    expect(DEEPSEEK_V4_FLASH_CONTEXT_WINDOW).toBe(1_048_576);
    expect(DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS).toBe(65_536);
    expect(officialModelThinkingLevel(DEEPSEEK_V4_FLASH_MODEL_ID)).toBe("high");
    expect(officialDeepSeekV4FlashModelProtocol()).toMatchObject({
      reasoning: true,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
    });
  });

  it("官方模型 ID 拒绝漂移的上下文、输出与图片能力", () => {
    expect(() =>
      assertOfficialDeepSeekV4FlashCapabilities({
        modelId: DEEPSEEK_V4_FLASH_MODEL_ID,
        contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
        maxOutputTokens: 16_384,
        supportsImages: false,
      }),
    ).toThrow("官方 0731 配置");
  });

  it("最终 payload 禁用 tool_choice 并补齐官方工具调用重放字段", () => {
    expect(
      normalizeOfficialDeepSeekV4FlashPayload(DEEPSEEK_V4_FLASH_MODEL_ID, {
        model: DEEPSEEK_V4_FLASH_MODEL_ID,
        tool_choice: "auto",
        messages: [
          { role: "user", content: "开始" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", type: "function" }],
          },
        ],
      }),
    ).toEqual({
      model: DEEPSEEK_V4_FLASH_MODEL_ID,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "开始" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "",
          tool_calls: [{ id: "call-1", type: "function" }],
        },
      ],
    });
  });
});
