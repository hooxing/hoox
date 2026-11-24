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

export function fieldErrors(value: unknown): FieldError[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const error = item as Record<string, unknown>;
    return typeof error.path === "string" &&
      typeof error.code === "string" &&
      typeof error.message === "string"
      ? [
          {
            path: error.path.slice(0, 1024),
            code: error.code.slice(0, 128),
            message: error.message.slice(0, 2048),
          },
        ]
      : [];
  });
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
        if (retryStatuses.has(response.status) && attempt < 2) {
          await response.body?.cancel();
          await this.sleep(250 * 2 ** attempt);
          continue;
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
      if (response.status === 401 || response.status === 403)
        throw new CliError(
          "authentication",
          response.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
          "后台凭据无效、已过期或当前身份无权执行此操作",
        );
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
