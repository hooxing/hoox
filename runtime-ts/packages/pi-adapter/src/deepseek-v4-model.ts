import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** DeepSeek 官方 Oh My Pi 集成给出的稳定模型 ID 与 0731 版本能力。 */
export const DEEPSEEK_V4_FLASH_MODEL_ID = "deepseek-v4-flash";
export const DEEPSEEK_V4_FLASH_CONTEXT_WINDOW = 1_048_576;
export const DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS = 65_536;
export const DEEPSEEK_V4_FLASH_SUPPORTS_IMAGES = false;
export const DEEPSEEK_V4_FLASH_DEFAULT_THINKING_LEVEL = "high" as const;

const reasoningEffortMap = Object.freeze<ThinkingLevelMap>({
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: null,
});

export function isOfficialDeepSeekV4FlashModel(modelId: string): boolean {
  return modelId === DEEPSEEK_V4_FLASH_MODEL_ID;
}

export function assertOfficialDeepSeekV4FlashCapabilities(input: {
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly supportsImages: boolean;
}): void {
  if (!isOfficialDeepSeekV4FlashModel(input.modelId)) return;
  if (
    input.contextWindow !== DEEPSEEK_V4_FLASH_CONTEXT_WINDOW ||
    input.maxOutputTokens !== DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS ||
    input.supportsImages !== DEEPSEEK_V4_FLASH_SUPPORTS_IMAGES
  ) {
    throw new TypeError("DeepSeek V4 Flash 模型能力必须使用官方 0731 配置");
  }
}

export function officialDeepSeekV4FlashModelProtocol(): Readonly<
  Pick<Model<"openai-completions">, "reasoning" | "thinkingLevelMap" | "compat">
> {
  return Object.freeze({
    reasoning: true,
    thinkingLevelMap: reasoningEffortMap,
    compat: Object.freeze({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens" as const,
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek" as const,
      supportsStrictMode: true,
    }),
  });
}

export function officialModelThinkingLevel(modelId: string): ModelThinkingLevel {
  return isOfficialDeepSeekV4FlashModel(modelId) ? DEEPSEEK_V4_FLASH_DEFAULT_THINKING_LEVEL : "off";
}

/**
 * 当前 Pi 版本尚未公开 DeepSeek 官方配置中的三个兼容字段。这里在最终 payload
 * 边界补齐同义约束：禁用 tool_choice，并保证工具调用消息携带非空 content 与
 * reasoning_content；thinking 始终使用官方启用格式。
 */
export function normalizeOfficialDeepSeekV4FlashPayload(
  modelId: string,
  payload: unknown,
): unknown {
  if (!isOfficialDeepSeekV4FlashModel(modelId) || !isRecord(payload)) return payload;
  const { tool_choice: _toolChoice, ...rest } = payload;
  return {
    ...rest,
    thinking: { type: "enabled" },
    ...(Array.isArray(payload.messages)
      ? {
          messages: payload.messages.map((message) => {
            if (
              !isRecord(message) ||
              message.role !== "assistant" ||
              !Array.isArray(message.tool_calls)
            ) {
              return message;
            }
            return {
              ...message,
              content: typeof message.content === "string" ? message.content : "",
              reasoning_content:
                typeof message.reasoning_content === "string" ? message.reasoning_content : "",
            };
          }),
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
