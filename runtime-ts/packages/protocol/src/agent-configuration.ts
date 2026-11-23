import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isAlias, parseDocument, stringify } from "yaml";
import {
  AgentAvailabilitySchema,
  AgentRevisionContentSchema,
  AgentVersionNotesSchema,
} from "./agent-definition.js";
import { IdSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
const allowedCoreTags = new Set([
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:str",
]);
const AgentConfigurationSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    definition: Type.Object({ id: IdSchema, availability: AgentAvailabilitySchema }, strict),
    revision: Type.Object(
      {
        content: AgentRevisionContentSchema,
        versionNotes: Type.Optional(AgentVersionNotesSchema),
      },
      strict,
    ),
  },
  strict,
);

export type AgentConfiguration = Static<typeof AgentConfigurationSchema>;
export const AGENT_CONFIGURATION_MAX_BYTES = 1_048_576;
export const AgentConfigurationImportRequestSchema = Type.Object(
  {
    yaml: Type.String({ minLength: 1, maxLength: AGENT_CONFIGURATION_MAX_BYTES }),
    dryRun: Type.Boolean(),
    expectedGeneration: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  },
  strict,
);

export interface AgentConfigurationValidationError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class AgentConfigurationError extends Error {
  constructor(readonly errors: readonly AgentConfigurationValidationError[]) {
    super(errors.map(({ path, message }) => `${path}: ${message}`).join("; "));
    this.name = "AgentConfigurationError";
  }
}

function fail(path: string, code: string, message: string): never {
  throw new AgentConfigurationError([{ path, code, message }]);
}

function orderKeys(value: unknown, preferred: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => orderKeys(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => {
        const leftIndex = preferred.indexOf(left);
        const rightIndex = preferred.indexOf(right);
        if (leftIndex !== -1 || rightIndex !== -1) {
          if (leftIndex === -1) return 1;
          if (rightIndex === -1) return -1;
          return leftIndex - rightIndex;
        }
        return left < right ? -1 : left > right ? 1 : 0;
      })
      .map(([key, item]) => [key, orderKeys(item)]),
  );
}

function validate(value: unknown): AgentConfiguration {
  if (typeof value === "object" && value !== null && "schemaVersion" in value) {
    const version = (value as { schemaVersion?: unknown }).schemaVersion;
    if (version !== 1) fail("/schemaVersion", "UNKNOWN_SCHEMA_VERSION", "不支持的配置格式版本");
  }
  const errors = [...Value.Errors(AgentConfigurationSchema, value)].slice(0, 100).map((error) => ({
    path: error.path || "/",
    code: error.message.includes("Unexpected property") ? "UNKNOWN_FIELD" : "INVALID_VALUE",
    message: error.message,
  }));
  if (errors.length) throw new AgentConfigurationError(errors);
  return orderKeys(value, ["schemaVersion", "definition", "revision"]) as AgentConfiguration;
}

function ensureJsonValues(value: unknown, path = "", depth = 0): void {
  if (depth > 64) fail(path || "/", "YAML_COMPLEXITY_LIMIT", "YAML 结构超过复杂度限制");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      ensureJsonValues(item, `${path}/${index}`, depth + 1);
    });
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path || "/", "INVALID_VALUE", "YAML 值必须能无损表示为 JSON");
    }
    for (const [key, item] of Object.entries(value)) {
      ensureJsonValues(
        item,
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        depth + 1,
      );
    }
    return;
  }
  fail(path || "/", "INVALID_VALUE", "YAML 值必须能无损表示为 JSON");
}

export function parseAgentConfiguration(source: string): AgentConfiguration {
  if (new TextEncoder().encode(source).byteLength > AGENT_CONFIGURATION_MAX_BYTES) {
    fail("/", "DOCUMENT_TOO_LARGE", "配置文件不得超过 1 MiB");
  }
  const document = parseDocument(source, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    customTags: [],
  });
  if (document.warnings.length > 0) {
    fail("/", "YAML_TAG_NOT_ALLOWED", "配置文件包含未解析或不允许的 YAML 标签");
  }
  if (document.errors.length) {
    fail("/", "INVALID_YAML", "YAML 无效，或包含不允许的标签、别名或重复键");
  }
  if (document.contents === null) fail("/", "EMPTY_DOCUMENT", "配置文件不能为空");
  let nodeCount = 0;
  const inspect = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== "object") return;
    if (isAlias(node)) fail("/", "YAML_ALIAS_NOT_ALLOWED", "配置文件不允许 YAML 别名");
    const tagged = node as { tag?: string };
    if (tagged.tag && !allowedCoreTags.has(tagged.tag)) {
      fail("/", "YAML_TAG_NOT_ALLOWED", "配置文件不允许自定义 YAML 标签");
    }
    nodeCount += 1;
    if (nodeCount > 100_000 || depth > 64) {
      fail("/", "YAML_COMPLEXITY_LIMIT", "YAML 结构超过复杂度限制");
    }
    const candidate = node as { items?: readonly unknown[]; key?: unknown; value?: unknown };
    if (candidate.items) {
      for (const item of candidate.items) {
        if (typeof item === "object" && item !== null && "key" in item) {
          inspect((item as { key: unknown }).key, depth + 1);
          inspect((item as unknown as { value: unknown }).value, depth + 1);
        } else inspect(item, depth + 1);
      }
    }
  };
  inspect(document.contents, 0);
  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    fail("/", "INVALID_YAML", "YAML 无法安全解析");
  }
  ensureJsonValues(parsed);
  return validate(parsed);
}

export function serializeAgentConfiguration(input: unknown): string {
  const configuration = validate(input);
  return stringify(configuration, { indent: 2, lineWidth: 0 });
}
