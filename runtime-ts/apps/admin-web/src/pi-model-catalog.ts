import type { PiModelCatalogModelDto, PiModelCatalogProviderDto } from "@hoox/protocol";
import {
  LOCAL_PI_MODEL_CATALOG_MODELS,
  LOCAL_PI_MODEL_CATALOG_PROVIDERS,
} from "./pi-model-catalog.generated.js";

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

/**
 * 浏览器快照只负责展示和填充草稿；保存、发布及运行时事实仍以后台 revision 为准。
 */
export function listLocalPiModelCatalogProviders(): readonly PiModelCatalogProviderDto[] {
  return LOCAL_PI_MODEL_CATALOG_PROVIDERS;
}

export function findLocalPiModelCatalogModels(input: {
  readonly providerId?: string;
  readonly query?: string;
  readonly limit: number;
}): readonly PiModelCatalogModelDto[] {
  const normalizedQuery = input.query?.trim().toLocaleLowerCase("en-US") ?? "";
  if (input.providerId === undefined && normalizedQuery === "") return [];
  return LOCAL_PI_MODEL_CATALOG_MODELS.flatMap((model) => {
    if (input.providerId !== undefined && model.providerId !== input.providerId) return [];
    const score = normalizedQuery === "" ? 0 : matchScore(model, normalizedQuery);
    return score === undefined ? [] : [{ model, score }];
  })
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.model.id.localeCompare(right.model.id, "en-US") ||
        left.model.providerId.localeCompare(right.model.providerId, "en-US"),
    )
    .slice(0, input.limit)
    .map(({ model }) => model);
}
