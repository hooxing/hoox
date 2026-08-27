import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_V4_FLASH_MODEL_ID,
  isOfficialDeepSeekV4FlashModel,
  normalizeOfficialDeepSeekV4FlashPayload,
  officialDeepSeekV4FlashModelProtocol,
  defaultModelThinkingLevel,
} from "./deepseek-v4-model.js";

describe("DeepSeek V4 Flash 官方协议配置", () => {
  it("仅 exact 模型 ID 使用 thinking 与 Chat Completions 兼容项", () => {
    expect(DEEPSEEK_V4_FLASH_MODEL_ID).toBe("deepseek-v4-flash");
    expect(isOfficialDeepSeekV4FlashModel(DEEPSEEK_V4_FLASH_MODEL_ID)).toBe(true);
    expect(isOfficialDeepSeekV4FlashModel("deepseek-v4-flash-vision-exp")).toBe(false);
    expect(defaultModelThinkingLevel({ id: DEEPSEEK_V4_FLASH_MODEL_ID, reasoning: true })).toBe(
      "high",
    );
    expect(
      defaultModelThinkingLevel({ id: "deepseek-v4-flash-vision-exp", reasoning: false }),
    ).toBe("off");
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

  it("任意声明 reasoning 的已发布模型默认启用高等级思考", () => {
    expect(defaultModelThinkingLevel({ id: "GLM-5.3-Flash", reasoning: true })).toBe("high");
    expect(defaultModelThinkingLevel({ id: "custom-chat-model", reasoning: false })).toBe("off");
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
