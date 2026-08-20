import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const targetUrl = new URL(
  "../runtime-ts/apps/admin-web/src/pi-model-catalog.generated.ts",
  import.meta.url,
);

function compatibleProviders() {
  return builtinProviders().flatMap((provider) => {
    const models = provider.getModels().filter((model) => model.api === "openai-completions");
    const baseUrl = provider.baseUrl ?? models[0]?.baseUrl;
    return models.length > 0 && baseUrl !== undefined ? [{ provider, models, baseUrl }] : [];
  });
}

function render() {
  const indexed = compatibleProviders();
  const providers = indexed
    .map(({ provider, models, baseUrl }) => ({
      providerId: provider.id,
      displayName: provider.name,
      baseUrl,
      modelCount: models.length,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  const models = indexed
    .flatMap(({ provider, models: providerModels }) =>
      providerModels.map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        id: model.id,
        name: model.name,
        api: "openai-completions",
        reasoning: model.reasoning,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    )
    .sort(
      (left, right) =>
        left.id.localeCompare(right.id, "en-US") ||
        left.providerId.localeCompare(right.providerId, "en-US"),
    );
  const header = [
    "// 此文件由 scripts/generate-admin-pi-model-catalog.mjs 从精确锁定的 Pi 版本生成。",
    "// 请勿手工修改；升级 Pi 后运行 pnpm admin:pi-catalog:generate。",
    'import type { PiModelCatalogModelDto, PiModelCatalogProviderDto } from "@hoox/protocol";',
    "",
  ].join("\n");
  return `${header}export const LOCAL_PI_MODEL_CATALOG_PROVIDERS: readonly PiModelCatalogProviderDto[] = ${JSON.stringify(
    providers,
    null,
    2,
  )};\n\nexport const LOCAL_PI_MODEL_CATALOG_MODELS: readonly PiModelCatalogModelDto[] = ${JSON.stringify(
    models,
    null,
    2,
  )};\n`;
}

const expected = render();
if (process.argv.includes("--check")) {
  const actual = await readFile(targetUrl, "utf8").catch(() => "");
  if (actual !== expected) {
    throw new Error(
      "前端 Pi 模型目录已过期，请运行 pnpm admin:pi-catalog:generate 并提交生成结果。",
    );
  }
  console.log("前端 Pi 模型目录与当前锁定版本一致。");
} else {
  await writeFile(targetUrl, expected, "utf8");
  console.log(`已生成 ${fileURLToPath(targetUrl)}`);
}
