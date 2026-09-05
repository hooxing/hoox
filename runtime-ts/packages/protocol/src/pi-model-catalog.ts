import type { PiModelCatalogModelDto, PiModelCatalogProviderDto } from "./admin-control.js";
import {
  LOCAL_PI_MODEL_CATALOG_MODELS,
  LOCAL_PI_MODEL_CATALOG_PROVIDERS,
} from "./pi-model-catalog.generated.js";

export interface PiModelCatalogPort {
  listProviders(): readonly PiModelCatalogProviderDto[];
  findModels(input: {
    readonly providerId?: string;
    readonly query?: string;
    readonly limit: number;
  }): readonly PiModelCatalogModelDto[];
}

export interface PiModelCatalogSnapshot {
  readonly providers: readonly PiModelCatalogProviderDto[];
  readonly models: readonly PiModelCatalogModelDto[];
}

function matchScore(model: PiModelCatalogModelDto, query: string): number | undefined {
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

/** 目录只提供管理草稿初始值；保存、发布及运行时事实仍以后台 revision 为准。 */
export function createPiModelCatalog(
  snapshot: PiModelCatalogSnapshot = {
    providers: LOCAL_PI_MODEL_CATALOG_PROVIDERS,
    models: LOCAL_PI_MODEL_CATALOG_MODELS,
  },
): PiModelCatalogPort {
  return Object.freeze({
    listProviders: () =>
      snapshot.providers
        .map((provider) => ({ ...provider }))
        .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN")),
    findModels: ({ providerId, query, limit }: Parameters<PiModelCatalogPort["findModels"]>[0]) => {
      const normalizedQuery = query?.trim().toLocaleLowerCase("en-US") ?? "";
      if (providerId === undefined && normalizedQuery === "") return [];
      return snapshot.models
        .flatMap((model) => {
          if (providerId !== undefined && model.providerId !== providerId) return [];
          const score = normalizedQuery === "" ? 0 : matchScore(model, normalizedQuery);
          return score === undefined ? [] : [{ model, score }];
        })
        .sort(
          (left, right) =>
            left.score - right.score ||
            left.model.id.localeCompare(right.model.id, "en-US") ||
            left.model.providerId.localeCompare(right.model.providerId, "en-US"),
        )
        .slice(0, limit)
        .map(({ model }) => ({ ...model, input: [...model.input] }));
    },
  });
}
