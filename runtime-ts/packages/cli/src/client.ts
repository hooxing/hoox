import { CliError, type FieldError } from "./errors.js";

const maximumResponseBytes = 6_500_000;
const retryStatuses = new Set([408, 429, 500, 502, 503, 504]);
const base = "/v1/admin/control/agent-definitions";

export function controlOrigin(value: string | undefined): URL {
  try {
    const url = new URL(value ?? "");
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error();
    return url;
  } catch {
    throw new CliError(
      "usage",
      "INVALID_URL",
      "HOOX_URL 必须是后台 HTTPS origin（本机可用 HTTP），不能带凭据、路径或查询参数",
    );
  }
}

const fieldErrorMessages = new Map<string, string>([
  ["INVALID", "字段值无效"],
  ["REQUIRED", "缺少必填字段"],
  ["UNKNOWN_FIELD", "包含未知字段"],
  ["TOO_SMALL", "字段值低于允许范围"],
  ["TOO_LARGE", "字段值超过允许范围"],
  ["INVALID_TYPE", "字段类型无效"],
  ["INVALID_FORMAT", "字段格式无效"],
  ["CONFLICT", "字段与当前状态冲突"],
  ["UNKNOWN_SCHEMA_VERSION", "不支持的配置格式版本"],
  ["INVALID_VALUE", "字段值无效"],
  ["YAML_SYNTAX", "YAML 语法无效"],
  ["YAML_DUPLICATE_KEY", "YAML 中存在重复键"],
  ["YAML_ALIAS", "YAML 别名无效"],
  ["YAML_COMPLEXITY_LIMIT", "YAML 结构超过复杂度限制"],
  ["DOCUMENT_TOO_LARGE", "配置文件超过允许大小"],
]);

const knownAgentConfigurationPaths = [
  /^\/(?:schemaVersion|definition|revision)$/u,
  /^\/definition\/(?:id|availability)$/u,
  /^\/revision\/(?:versionNotes|content)$/u,
  /^\/revision\/content\/(?:displayName|description|avatarRef|welcomeMessage|suggestedQuestions|operatorInstructions|replyLanguage|model|tools|skillVersions|includeTenantSkills|sandboxTemplateId|sandboxIdleAction|memory)$/u,
  /^\/revision\/content\/(?:suggestedQuestions|skillVersions)\/\d+(?:\/(?:skillId|version))?$/u,
  /^\/revision\/content\/(?:model|tools|memory)\/(?:mode|provider|model|toolCallingMode|longTermEnabled|builtinTools|externalTools|clientTools)$/u,
  /^\/revision\/content\/tools\/(?:builtinTools|externalTools|clientTools)\/\d+(?:\/(?:kind|versionId|name|description|inputSchema|waitTimeoutMs))?$/u,
  /^\/revision\/content\/tools\/clientTools\/\d+\/inputSchema\/.+$/u,
];

function knownAgentConfigurationPath(path: string): boolean {
  return knownAgentConfigurationPaths.some((pattern) => pattern.test(path));
}

export function fieldErrors(value: unknown): FieldError[] {
  if (!Array.isArray(value)) return [];
  const result: FieldError[] = [];
  let hiddenField = false;
  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== "object") continue;
    const error = item as Record<string, unknown>;
    if (typeof error.path !== "string" || typeof error.code !== "string") continue;
    const path = error.path.slice(0, 256);
    if (!knownAgentConfigurationPath(path)) {
      hiddenField = true;
      continue;
    }
    const knownMessage = fieldErrorMessages.get(error.code.slice(0, 64));
    result.push({
      path,
      code: knownMessage ? error.code : "INVALID_VALUE",
      message: knownMessage ?? "字段值未通过校验",
    });
  }
  if (hiddenField) {
    result.push({ path: "配置", code: "INVALID_VALUE", message: "另有字段未通过校验" });
  }
  return result;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

export function invalidResponse(): never {
  throw new CliError("service", "INVALID_RESPONSE", "后台返回了无效响应");
}

export class ControlClient {
  constructor(
    private readonly origin: URL,
    private readonly token: string,
    private readonly fetcher: typeof fetch,
    private readonly sleep: (milliseconds: number) => Promise<void>,
  ) {}

  async request(
    path: string,
    options: { body?: object; key?: string; yaml?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: options.yaml ? "application/yaml" : "application/json",
    };
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.key) headers["idempotency-key"] = options.key;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      let text: string;
      try {
        response = await this.fetcher(new URL(`${base}${path}`, this.origin), {
          method: body === undefined ? "GET" : "POST",
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 401 || response.status === 403) {
          void response.body?.cancel().catch(() => {});
          throw new CliError(
            "authentication",
            response.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
            "后台凭据无效、已过期或当前身份无权执行此操作",
          );
        }
        if (retryStatuses.has(response.status) && attempt < 2) {
          await response.body?.cancel();
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
        if (response.status >= 500) {
          void response.body?.cancel().catch(() => {});
          throw new CliError("service", "HTTP_ERROR", "后台服务暂时不可用");
        }
        text = await readResponse(response);
      } catch (error) {
        if (error instanceof CliError) throw error;
        if (attempt === 2)
          throw new CliError(
            "service",
            "NETWORK_ERROR",
            "后台请求失败或超时；未确认 push 结果时请先核对后台草稿，勿直接重复推送",
          );
        await this.sleep(250 * 2 ** attempt);
        continue;
      }
      if (response.ok && options.yaml) {
        if (!response.headers.get("content-type")?.startsWith("application/yaml"))
          invalidResponse();
        if (text.includes(this.token))
          throw new CliError("service", "SENSITIVE_RESPONSE", "后台响应包含敏感凭据，已拒绝输出");
        return text;
      }
      let envelope: Record<string, unknown>;
      try {
        envelope = record(JSON.parse(text));
      } catch {
        return invalidResponse();
      }
      if (!response.ok) {
        if ([400, 404, 409, 422].includes(response.status))
          throw new CliError(
            "validation",
            `HTTP_${response.status}`,
            "配置校验失败、目标不存在或版本冲突",
            fieldErrors(envelope.validationErrors),
          );
        throw new CliError("service", `HTTP_${response.status}`, "后台服务未能完成请求");
      }
      return envelope.data ?? invalidResponse();
    }
    return invalidResponse();
  }
}

async function readResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumResponseBytes) {
        await reader.cancel();
        return invalidResponse();
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    reader.releaseLock();
  }
}
