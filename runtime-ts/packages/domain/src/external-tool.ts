import { createHash } from "node:crypto";

export type ExternalToolSource = "mcp" | "http";
export type ExternalToolSideEffect = "read_only" | "write" | "destructive";
export type ExternalToolJsonSchema = Readonly<Record<string, unknown>>;

export interface ExternalToolVersion {
  readonly toolVersionId: string;
  readonly source: ExternalToolSource;
  readonly endpoint: string;
  readonly modelToolName: string;
  readonly remoteToolName?: string | null;
  readonly description: string;
  readonly inputSchema: ExternalToolJsonSchema;
  readonly inputSchemaDigest: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly sideEffect: ExternalToolSideEffect;
  readonly idempotent: boolean;
  readonly credentialRef: string | null;
}

const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTEXT_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const LIMITS = Object.freeze({
  maxTools: 64,
  maxDescriptionBytes: 2048,
  maxSchemaBytes: 16_384,
  maxResponseBytes: 1_048_576,
});
const SUPPORTED = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
]);

export function normalizeExternalToolName(
  source: ExternalToolSource,
  server: string,
  tool: string,
): string {
  if (source !== "mcp" && source !== "http") throw new TypeError("EXTERNAL_TOOL_SOURCE_INVALID");
  const clean = (part: string) =>
    part
      .replace(/[^A-Za-z0-9._-]+/gu, "_")
      .replace(/^[_-]+|[_-]+$/gu, "")
      .slice(0, 64);
  const a = clean(server),
    b = clean(tool);
  if (!NAME_PART.test(a) || !NAME_PART.test(b)) throw new TypeError("EXTERNAL_TOOL_NAME_INVALID");
  // 两个消费者对长度的约束取交集；组合形式预留分隔符后按最大全长 128 截断工具段。
  const prefix = source === "mcp" ? `mcp__${a}__` : "http__";
  const name = `${prefix}${b.slice(0, Math.max(1, 128 - prefix.length))}`;
  if (!SAFE_TOOL_NAME.test(name) || !CONTEXT_TOOL_NAME.test(name))
    throw new TypeError("EXTERNAL_TOOL_NAME_INVALID");
  return name;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeExternalToolSchema(input: unknown): {
  schema: ExternalToolJsonSchema;
  digest: string;
} {
  let nodes = 0;
  const visit = (raw: unknown, depth: number): Record<string, unknown> => {
    if (
      ++nodes > 256 ||
      depth > 16 ||
      raw === null ||
      Array.isArray(raw) ||
      typeof raw !== "object"
    )
      throw new TypeError("EXTERNAL_TOOL_SCHEMA_INVALID");
    const obj = raw as Record<string, unknown>;
    for (const key of Object.keys(obj))
      if (!SUPPORTED.has(key)) throw new TypeError("EXTERNAL_TOOL_SCHEMA_KEYWORD_UNSUPPORTED");
    const type = obj.type;
    if (!["object", "string", "number", "integer", "boolean", "array"].includes(String(type)))
      throw new TypeError("EXTERNAL_TOOL_SCHEMA_TYPE_UNSUPPORTED");
    if (
      type !== "object" &&
      ["properties", "required", "additionalProperties"].some((key) => Object.hasOwn(obj, key))
    )
      throw new TypeError("EXTERNAL_TOOL_SCHEMA_INVALID");
    if (type !== "array" && Object.hasOwn(obj, "items"))
      throw new TypeError("EXTERNAL_TOOL_SCHEMA_INVALID");
    const result: Record<string, unknown> = { type };
    if (obj.description !== undefined) {
      if (
        typeof obj.description !== "string" ||
        Buffer.byteLength(obj.description) > LIMITS.maxDescriptionBytes
      )
        throw new TypeError("EXTERNAL_TOOL_SCHEMA_INVALID");
      result.description = obj.description;
    }
    if (obj.enum !== undefined) {
      if (
        !Array.isArray(obj.enum) ||
        obj.enum.length === 0 ||
        obj.enum.some(
          (v) =>
            !["string", "number", "boolean"].includes(typeof v) ||
            (typeof v === "number" && !Number.isFinite(v)),
        )
      )
        throw new TypeError("EXTERNAL_TOOL_SCHEMA_INVALID");
      const matchesType = (value: unknown) => {
        if (type === "string") return typeof value === "string";
        if (type === "number") return typeof value === "number" && Number.isFinite(value);
        if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
        if (type === "boolean") return typeof value === "boolean";
        return false;
      };
      if (obj.enum.some((value) => !matchesType(value)))
        throw new TypeError("EXTERNAL_TOOL_SCHEMA_ENUM_TYPE_MISMATCH");
      result.enum = [...new Set(obj.enum)].sort((a, b) =>
        canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0,
      );
    }
    if (type === "object") {
      const props = obj.properties ?? {};
      if (props === null || typeof props !== "object" || Array.isArray(props))
        throw new TypeError("EXTERNAL_TOOL_SCHEMA_INVALID");
      result.properties = Object.fromEntries(
        Object.keys(props as object)
          .sort()
          .map((k) => [k, visit((props as Record<string, unknown>)[k], depth + 1)]),
      );
      const required = obj.required ?? [];
      if (
        !Array.isArray(required) ||
        required.some((x) => typeof x !== "string" || !Object.hasOwn(props, x))
      )
        throw new TypeError("EXTERNAL_TOOL_SCHEMA_INVALID");
      result.required = [...new Set(required)].sort();
      if (obj.additionalProperties !== false)
        throw new TypeError("EXTERNAL_TOOL_SCHEMA_ADDITIONAL_PROPERTIES_REQUIRED");
      result.additionalProperties = false;
    } else if (type === "array") {
      if (obj.items === undefined) throw new TypeError("EXTERNAL_TOOL_SCHEMA_INVALID");
      result.items = visit(obj.items, depth + 1);
    }
    return result;
  };
  const schema = visit(input, 0);
  if (schema.type !== "object" || Buffer.byteLength(canonical(schema)) > LIMITS.maxSchemaBytes)
    throw new TypeError("EXTERNAL_TOOL_SCHEMA_INVALID");
  return Object.freeze({
    schema: deepFreeze(schema),
    digest: createHash("sha256").update(canonical(schema)).digest("hex"),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateExternalToolVersion(input: ExternalToolVersion): ExternalToolVersion {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.toolVersionId))
    throw new TypeError("EXTERNAL_TOOL_VERSION_ID_INVALID");
  if (input.source !== "mcp" && input.source !== "http")
    throw new TypeError("EXTERNAL_TOOL_SOURCE_INVALID");
  if (typeof input.endpoint !== "string" || input.endpoint.length > 2048)
    throw new TypeError("EXTERNAL_TOOL_ENDPOINT_INVALID");
  try {
    const endpoint = new URL(input.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash)
      throw new Error();
  } catch {
    throw new TypeError("EXTERNAL_TOOL_ENDPOINT_INVALID");
  }
  if (
    input.source === "http"
      ? !input.modelToolName.startsWith("http__")
      : !input.modelToolName.startsWith("mcp__")
  )
    throw new TypeError("EXTERNAL_TOOL_NAME_SOURCE_MISMATCH");
  if (!["read_only", "write", "destructive"].includes(input.sideEffect))
    throw new TypeError("EXTERNAL_TOOL_SIDE_EFFECT_INVALID");
  if (typeof input.idempotent !== "boolean")
    throw new TypeError("EXTERNAL_TOOL_IDEMPOTENCY_INVALID");
  if (
    input.credentialRef !== null &&
    (typeof input.credentialRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.credentialRef))
  )
    throw new TypeError("EXTERNAL_TOOL_CREDENTIAL_REF_INVALID");
  if (input.source === "mcp") {
    if (
      typeof input.remoteToolName !== "string" ||
      input.remoteToolName.length === 0 ||
      Buffer.byteLength(input.remoteToolName) > 512
    )
      throw new TypeError("EXTERNAL_TOOL_REMOTE_NAME_REQUIRED");
  } else if (input.remoteToolName != null) {
    throw new TypeError("EXTERNAL_TOOL_REMOTE_NAME_SOURCE_MISMATCH");
  }
  if (typeof input.description !== "string")
    throw new TypeError("EXTERNAL_TOOL_DESCRIPTION_INVALID");
  if (!SAFE_TOOL_NAME.test(input.modelToolName) || !CONTEXT_TOOL_NAME.test(input.modelToolName))
    throw new TypeError("EXTERNAL_TOOL_NAME_INVALID");
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 100 ||
    input.timeoutMs > 120_000 ||
    !Number.isInteger(input.maxResponseBytes) ||
    input.maxResponseBytes < 1 ||
    input.maxResponseBytes > LIMITS.maxResponseBytes
  )
    throw new TypeError("EXTERNAL_TOOL_LIMIT_INVALID");
  if (Buffer.byteLength(input.description) > LIMITS.maxDescriptionBytes)
    throw new TypeError("EXTERNAL_TOOL_DESCRIPTION_INVALID");
  const normalized = normalizeExternalToolSchema(input.inputSchema);
  if (normalized.digest !== input.inputSchemaDigest)
    throw new TypeError("EXTERNAL_TOOL_SCHEMA_DIGEST_MISMATCH");
  return Object.freeze({ ...input, inputSchema: normalized.schema });
}

export const EXTERNAL_TOOL_LIMITS = LIMITS;
