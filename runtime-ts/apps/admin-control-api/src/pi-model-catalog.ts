import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { PiModelCatalogModelDto, PiModelCatalogProviderDto } from "@hoox/protocol";

interface CatalogModelSource {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly baseUrl: string;
}

interface CatalogProviderSource {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  getModels(): readonly CatalogModelSource[];
}

export interface PiModelCatalogPort {
  listProviders(): readonly PiModelCatalogProviderDto[];
  findModels(input: {
    readonly providerId?: string;
    readonly query?: string;
    readonly limit: number;
  }): readonly PiModelCatalogModelDto[];
}

interface IndexedProvider {
  readonly provider: CatalogProviderSource;
  readonly models: readonly CatalogModelSource[];
  readonly baseUrl: string;
}

function compatibleProviders(
  sources: readonly CatalogProviderSource[],
): readonly IndexedProvider[] {
  return sources.flatMap((provider) => {
    const models = provider.getModels().filter((model) => model.api === "openai-completions");
    const baseUrl = provider.baseUrl ?? models[0]?.baseUrl;
    return models.length > 0 && baseUrl !== undefined ? [{ provider, models, baseUrl }] : [];
  });
}

function matchScore(model: CatalogModelSource, query: string): number | undefined {
  const id = model.id.toLocaleLowerCase("en-US");
  const name = model.name.toLocaleLowerCase("en-US");
  if (id === query) return 0;
  if (name === query) return 1;
  if (id.startsWith(query)) return 2;
  if (name.startsWith(query)) return 3;
  if (id.includes(query)) return 4;
  if (name.includes(query)) return 5;
  return undefined;
}

/** Pi 目录只生成管理草稿初始值；发布事实仍由后台控制面保存。 */
export function createPiModelCatalog(
  sources: readonly CatalogProviderSource[] = builtinProviders(),
): PiModelCatalogPort {
  const providers = compatibleProviders(sources);
  return Object.freeze({
    listProviders: () =>
      providers
        .map(({ provider, models, baseUrl }) => ({
          providerId: provider.id,
          displayName: provider.name,
          baseUrl,
          modelCount: models.length,
        }))
        .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN")),
    findModels: ({ providerId, query, limit }: Parameters<PiModelCatalogPort["findModels"]>[0]) => {
      const normalizedQuery = query?.trim().toLocaleLowerCase("en-US") ?? "";
      if (providerId === undefined && normalizedQuery === "") return [];
      return providers
        .filter(({ provider }) => providerId === undefined || provider.id === providerId)
        .flatMap(({ provider, models }) =>
          models.flatMap((model) => {
            const score = normalizedQuery === "" ? 0 : matchScore(model, normalizedQuery);
            return score === undefined ? [] : [{ provider, model, score }];
          }),
        )
        .sort(
          (left, right) =>
            left.score - right.score ||
            left.model.id.localeCompare(right.model.id, "en-US") ||
            left.provider.id.localeCompare(right.provider.id, "en-US"),
        )
        .slice(0, limit)
        .map(({ provider, model }) => ({
          providerId: provider.id,
          providerName: provider.name,
          id: model.id,
          name: model.name,
          api: "openai-completions" as const,
          reasoning: model.reasoning,
          input: [...model.input],
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        }));
    },
  });
}
