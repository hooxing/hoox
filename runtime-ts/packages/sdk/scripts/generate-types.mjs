import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../", import.meta.url);
const target = new URL("../src/openapi.generated.ts", import.meta.url);
const document = JSON.parse(
  await readFile(new URL("docs/reference/openapi/public-v1.json", root), "utf8"),
);
const name = (value) => value.replace(/^v1\./u, "");
function typeOf(schema) {
  if (schema === undefined || schema === true) return "unknown";
  if (schema === false) return "never";
  if (schema.$ref) return name(schema.$ref.split("/").at(-1));
  if ("const" in schema) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.anyOf || schema.oneOf)
    return `(${(schema.anyOf ?? schema.oneOf).map(typeOf).join(" | ")})`;
  if (schema.allOf) return `(${schema.allOf.map(typeOf).join(" & ")})`;
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${typeOf(schema.items)}>`;
    case "object": {
      const properties = Object.entries(schema.properties ?? {}).map(
        ([key, value]) =>
          `${JSON.stringify(key)}${schema.required?.includes(key) ? "" : "?"}: ${typeOf(value)};`,
      );
      if (schema.additionalProperties !== false) {
        properties.push(`[key: string]: ${typeOf(schema.additionalProperties)};`);
      }
      if (properties.length === 0) return "Record<string, never>";
      return `{ ${properties.join(" ")} }`;
    }
    default:
      if (Object.keys(schema).length === 0) return "unknown";
      throw new Error("SDK 生成器遇到尚未支持的 OpenAPI Schema");
  }
}

const schemas = Object.entries(document.components.schemas).map(
  ([key, schema]) => `export type ${name(key)} = ${typeOf(schema)};`,
);
const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({
    path,
    method: method.toUpperCase(),
    ...operation,
  })),
);
const types = operations.map((operation) => {
  const query = operation.parameters?.filter((parameter) => parameter.in === "query") ?? [];
  const body = operation.requestBody?.content["application/json"]?.schema;
  const response = operation.responses[200]?.content["application/json"]?.schema;
  return `${operation.operationId}: { body: ${body ? typeOf(body) : "never"}; query: ${typeOf({
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(query.map((parameter) => [parameter.name, parameter.schema])),
    required: query.filter((parameter) => parameter.required).map((parameter) => parameter.name),
  })}; response: ${response ? typeOf(response) : "never"}; };`;
});
const routes = Object.fromEntries(
  operations.map((operation) => [
    operation.operationId,
    { method: operation.method, path: operation.path },
  ]),
);
const source = `// 此文件由 OpenAPI 生成；请运行 @hoox/sdk 的 types:generate，不要手工修改。\n${schemas.join("\n")}\nexport interface Operations { ${types.join("\n")} }\nexport const routes = ${JSON.stringify(routes)} as const;\n`;
const output = execFileSync(
  "corepack",
  ["pnpm", "exec", "biome", "format", "--stdin-file-path", fileURLToPath(target)],
  { cwd: root, input: source, encoding: "utf8" },
);
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== output) {
    throw new Error(
      "SDK 类型与 OpenAPI 不一致；请运行 corepack pnpm --filter @hoox/sdk types:generate",
    );
  }
} else {
  await writeFile(target, output);
}
