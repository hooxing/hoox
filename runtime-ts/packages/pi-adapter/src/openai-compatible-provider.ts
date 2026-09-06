import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  lazyApi,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import {
  isOfficialDeepSeekV4FlashModel,
  officialDeepSeekV4FlashModelProtocol,
} from "./deepseek-v4-model.js";

const providerId = "runtime-openai-compatible";

/** 仅注册已发布配置中的启用模型；凭据留在内存，不读取宿主机模型目录或认证文件。 */
export async function createOpenAiCompatiblePiProvider(configuration: {
  readonly displayName?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModelId: string;
  readonly models: readonly {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly reasoning: boolean;
    readonly input: readonly ("text" | "image")[];
    readonly contextWindow: number;
    readonly maxTokens: number;
  }[];
}): Promise<Readonly<{ modelRuntime: Models; model: Model<"openai-completions"> }>> {
  const enabledModels = configuration.models.filter((model) => model.enabled);
  if (!enabledModels.some((model) => model.id === configuration.defaultModelId)) {
    throw new Error("模型 Provider 默认模型无效");
  }
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(providerId, async () => ({
    type: "api_key",
    key: configuration.apiKey,
  }));
  const modelRuntime = createModels({ credentials });
  const models: Model<"openai-completions">[] = enabledModels.map((model) => ({
    id: model.id,
    name: model.name,
    provider: providerId,
    baseUrl: configuration.baseUrl,
    api: "openai-completions",
    ...(isOfficialDeepSeekV4FlashModel(model.id)
      ? officialDeepSeekV4FlashModelProtocol()
      : { reasoning: model.reasoning }),
    input: [...model.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
  modelRuntime.setProvider(
    createProvider({
      id: providerId,
      name: configuration.displayName ?? "Runtime OpenAI-compatible Provider",
      baseUrl: configuration.baseUrl,
      auth: { apiKey: envApiKeyAuth("Runtime API key", []) },
      models,
      api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
    }),
  );
  const model = models.find((candidate) => candidate.id === configuration.defaultModelId);
  if (!model) throw new Error("模型配置无法解析");
  return Object.freeze({ modelRuntime, model });
}
