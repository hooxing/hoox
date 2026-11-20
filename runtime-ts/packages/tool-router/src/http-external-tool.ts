import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate, type TLSSocket } from "node:tls";
import {
  ExternalToolTransportError,
  type ExternalToolTransport,
  type ExternalToolTransportResponse,
  type ValidatedExternalTarget,
} from "@hoox/run-contracts";
import { normalizeExternalToolSchema } from "@hoox/domain";

export interface HttpToolDefinition {
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly sideEffect: "read_only" | "write" | "destructive";
  readonly idempotent: boolean;
  readonly credentialRef: string | null;
}

export const HTTP_TOOL_SIGNATURE_VERSION = "v1";
const SIGNATURE_PREFIX = `${HTTP_TOOL_SIGNATURE_VERSION}=`;
const DEFAULT_MAX_SKEW_MS = 300_000;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,256}$/u;
const IDENTITY_HEADERS = [
  "x-hoox-tenant",
  "x-hoox-end-user",
  "x-hoox-thread",
  "x-hoox-run",
] as const;

type TrustAnchors = string | Buffer | ReadonlyArray<string | Buffer>;

/** 接收端与 Hoox 共用的签名密钥：由工具版本凭据经 HKDF 派生，版本 ID 隔离不同版本。 */
export function deriveHttpToolSigningKey(credential: string, toolVersionId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(credential),
      Buffer.from(`hoox-http-signature:${toolVersionId}`),
      Buffer.from("hmac-sha256-v1"),
      32,
    ),
  );
}

// 身份密钥只从 Hoox 持有的根密钥派生，与发给接收端的验签密钥无关：接收端无法用已知内部 ID
// 验证不透明标识，持有多个工具验签密钥的一方也无法跨工具版本关联同一身份。
function deriveIdentityKey(rootKey: Uint8Array, toolVersionId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      rootKey,
      Buffer.from("hoox-http-identity-v1"),
      Buffer.from(`tool-version:${toolVersionId}`),
      32,
    ),
  );
}

function opaqueId(key: Buffer, name: string, value: string | undefined): string {
  return createHmac("sha256", key)
    .update(`hoox-context-v1\n${name}\n${value ?? ""}`)
    .digest("hex");
}

interface SignedFields {
  readonly timestamp: string;
  readonly method: string;
  readonly path: string;
  readonly bodyDigest: string;
  readonly idempotencyKey: string;
  readonly identities: readonly string[];
}

// 各字段均已限制为不含 LF 的可见 ASCII，按固定顺序以 LF 拼接不会产生歧义。
function signingString(fields: SignedFields): string {
  return [
    `hoox-http-signature-${HTTP_TOOL_SIGNATURE_VERSION}`,
    fields.timestamp,
    fields.method,
    fields.path,
    fields.bodyDigest,
    fields.idempotencyKey,
    ...fields.identities,
  ].join("\n");
}

function headerValue(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  let found: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    // 同名头重复出现时无法确定接收端业务逻辑读取哪一个，按无效处理。
    if (found !== undefined || typeof value !== "string") return undefined;
    found = value;
  }
  return found;
}

/**
 * 校验 `v1` 签名及时间偏差（默认 ±5 分钟）。签名覆盖时间戳、方法、路径与查询、正文摘要、
 * 幂等键和全部身份头。返回 true 只表示请求可信；接收端仍须按幂等键原子去重。
 * `headers` 可直接传 Node `IncomingMessage.headers`。
 */
export function verifyHttpToolSignature(input: {
  readonly key: string | Uint8Array;
  readonly method: string;
  readonly path: string;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly nowMs?: number;
  readonly maxSkewMs?: number;
}): boolean {
  const signature = headerValue(input.headers, "x-hoox-signature");
  const timestamp = headerValue(input.headers, "x-hoox-timestamp");
  const idempotencyKey = headerValue(input.headers, "x-hoox-idempotency-key");
  const identities = IDENTITY_HEADERS.map((name) => headerValue(input.headers, name));
  if (
    !signature?.startsWith(SIGNATURE_PREFIX) ||
    !/^[0-9a-f]{64}$/u.test(signature.slice(SIGNATURE_PREFIX.length)) ||
    !timestamp ||
    !/^\d{13}$/u.test(timestamp) ||
    !idempotencyKey ||
    !IDEMPOTENCY_KEY.test(idempotencyKey) ||
    identities.some((value) => !value || !/^[0-9a-f]{64}$/u.test(value)) ||
    /[\r\n]/u.test(input.path)
  )
    return false;
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now - Number(timestamp)) > (input.maxSkewMs ?? DEFAULT_MAX_SKEW_MS)) return false;
  const expected = createHmac("sha256", input.key)
    .update(
      signingString({
        timestamp,
        method: input.method.toUpperCase(),
        path: input.path,
        bodyDigest: createHash("sha256").update(input.body).digest("hex"),
        idempotencyKey,
        identities: identities as string[],
      }),
    )
    .digest();
  const received = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export interface HttpExternalToolTransportOptions {
  /** 仅 Hoox 持有的身份派生根密钥（至少 32 字节），不得分发给任何接收端。 */
  readonly identityRootKey: Uint8Array;
  /** 覆盖默认信任根；仅用于私有 CA 部署与测试。 */
  readonly ca?: TrustAnchors;
}

const notSent = (code: "EXTERNAL_TOOL_REJECTED" | "EXTERNAL_TOOL_UNAVAILABLE") =>
  new ExternalToolTransportError("not_sent", code);
const respondedFailure = () =>
  new ExternalToolTransportError("responded_failure", "EXTERNAL_TOOL_REJECTED");
// 未分类异常由 Router 统一按 UNKNOWN 转入恢复；消息不得包含对端内容。
const resultUnknown = () => new Error("EXTERNAL_TOOL_RESULT_UNKNOWN");

function mediaType(header: string | undefined): string {
  return (header ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function interpretableMediaType(type: string): boolean {
  return type === "application/json" || type.endsWith("+json") || type.startsWith("text/");
}

/**
 * HTTP 工具 Transport。不重试、不跟随重定向；每次调用新建连接并直接拨已校验 IP，
 * 证书与 SNI 按原主机名校验，`Host` 保留原 URL 的主机部分。返回值携带本次认证材料，
 * 调用方必须从模型可见结果中剔除。
 */
export function createHttpExternalToolTransport(
  options: HttpExternalToolTransportOptions,
): ExternalToolTransport {
  if (options.identityRootKey.byteLength < 32)
    throw new TypeError("HTTP_TOOL_IDENTITY_ROOT_KEY_INVALID");
  const identityRootKey = Buffer.from(options.identityRootKey);
  return {
    async invoke(input) {
      const method = input.method;
      // 方法未绑定时绝不推断：同一路径的 GET 查询与 POST 创建可能语义完全不同。
      if (method !== "GET" && method !== "POST") throw notSent("EXTERNAL_TOOL_REJECTED");
      if (method === "GET" && input.tool.sideEffect !== "read_only")
        throw notSent("EXTERNAL_TOOL_REJECTED");
      if (
        input.redirect !== "error" ||
        !input.credential ||
        !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
        input.target.url.protocol !== "https:" ||
        isIP(input.target.address) === 0
      )
        throw notSent("EXTERNAL_TOOL_REJECTED");
      if (input.signal?.aborted || input.deadlineAt <= Date.now())
        throw notSent("EXTERNAL_TOOL_UNAVAILABLE");

      const query = new URLSearchParams(input.target.url.search);
      let body = Buffer.alloc(0);
      if (method === "GET") {
        const fixed = new Set(query.keys());
        for (const [name, value] of Object.entries(input.arguments).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )) {
          // 模型参数不得覆盖或追加到已发布端点的固定查询键，否则签名会为被改写的范围背书。
          if (fixed.has(name) || value === null || typeof value === "object")
            throw notSent("EXTERNAL_TOOL_REJECTED");
          if (value === undefined) continue;
          query.append(name, String(value));
        }
      } else body = Buffer.from(JSON.stringify(input.arguments), "utf8");
      const queryText = query.toString();
      const path = `${input.target.url.pathname}${queryText ? `?${queryText}` : ""}`;

      const identityKey = deriveIdentityKey(identityRootKey, input.tool.toolVersionId);
      const identities = [
        opaqueId(identityKey, "tenant", input.callContext.tenantId),
        opaqueId(identityKey, "end-user", input.callContext.endUserId),
        opaqueId(identityKey, "thread", input.callContext.threadId),
        opaqueId(identityKey, "run", input.callContext.runId),
      ];
      const timestamp = String(Date.now());
      const signature = createHmac(
        "sha256",
        deriveHttpToolSigningKey(input.credential, input.tool.toolVersionId),
      )
        .update(
          signingString({
            timestamp,
            method,
            path,
            bodyDigest: createHash("sha256").update(body).digest("hex"),
            idempotencyKey: input.idempotencyKey,
            identities,
          }),
        )
        .digest("hex");
      const headers: Record<string, string> = {
        host: input.target.hostHeader,
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "x-hoox-signature": `${SIGNATURE_PREFIX}${signature}`,
        "x-hoox-timestamp": timestamp,
        "x-hoox-idempotency-key": input.idempotencyKey,
      };
      IDENTITY_HEADERS.forEach((name, index) => {
        headers[name] = identities[index] ?? "";
      });
      const response = await send({
        target: input.target,
        method,
        path,
        headers,
        body,
        deadlineAt: input.deadlineAt,
        maxResponseBytes: input.maxResponseBytes,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      });
      return { ...response, authMaterial: [signature, timestamp] };
    },
  };
}

type Outcome = { readonly error: Error } | { readonly ok: ExternalToolTransportResponse };

function send(input: {
  readonly target: ValidatedExternalTarget;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly deadlineAt: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
  readonly ca?: TrustAnchors;
}): Promise<ExternalToolTransportResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // 写出边界：TLS 握手完成前请求字节只在本地缓冲，此前的失败可证明未送达；
    // 握手完成后任何中断、超时或取消都可能已被对端处理，只能按 UNKNOWN 结算。
    let secured = false;
    let req: ClientRequest | undefined;
    let res: IncomingMessage | undefined;
    const interrupted = () => (secured ? resultUnknown() : notSent("EXTERNAL_TOOL_UNAVAILABLE"));
    const onAbort = () => settle({ error: interrupted() });
    const timer = setTimeout(
      () => settle({ error: interrupted() }),
      Math.max(0, input.deadlineAt - Date.now()),
    );
    // 所有终止路径（请求/响应 error、提前 close、超时、取消、超限）只经此处结算一次。
    function settle(outcome: Outcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if ("error" in outcome) {
        // 不再消费的正文直接销毁连接，避免慢速分块正文越过时限与字节预算。
        res?.destroy();
        req?.destroy();
        reject(outcome.error);
      } else resolve(outcome.ok);
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const hostname = input.target.hostname;
    try {
      req = request(
        {
          protocol: "https:",
          // 直接拨号已校验 IP，不经过任何 lookup；agent:false 禁止复用其他解析结果建立的连接。
          host: input.target.address,
          port: Number(input.target.url.port || 443),
          ...(isIP(input.target.servername) ? {} : { servername: input.target.servername }),
          checkServerIdentity: (_host: string, cert: PeerCertificate) =>
            checkServerIdentity(hostname, cert),
          agent: false,
          method: input.method,
          path: input.path,
          headers: input.headers,
          ...(input.ca === undefined
            ? {}
            : { ca: input.ca as string | Buffer | Array<string | Buffer> }),
        },
        (response) => onResponse(response),
      );
    } catch {
      settle({ error: notSent("EXTERNAL_TOOL_REJECTED") });
      return;
    }
    req.on("socket", (socket) => {
      (socket as TLSSocket).once("secureConnect", () => {
        secured = true;
      });
    });
    req.on("error", () => settle({ error: interrupted() }));
    req.on("close", () => {
      if (!res) settle({ error: interrupted() });
    });
    req.end(input.body);

    function onResponse(response: IncomingMessage) {
      res = response;
      const status = response.statusCode ?? 0;
      response.on("error", () => settle({ error: resultUnknown() }));
      response.on("close", () => {
        if (!response.complete) settle({ error: resultUnknown() });
      });
      if (status < 200 || status >= 300) {
        // 3xx（拒绝跟随）与 4xx（含 408、429）是对端明确拒绝；5xx 与其他状态无法排除已执行。
        settle({ error: status >= 300 && status < 500 ? respondedFailure() : resultUnknown() });
        return;
      }
      if (Number(response.headers["content-length"]) > input.maxResponseBytes) {
        settle({ error: resultUnknown() });
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > input.maxResponseBytes) settle({ error: resultUnknown() });
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (!response.complete) {
          settle({ error: resultUnknown() });
          return;
        }
        const body = Buffer.concat(chunks);
        if (
          status === 204 ||
          status === 205 ||
          (body.byteLength === 0 && response.headers["content-length"] === "0")
        ) {
          // 合法空成功响应：明确成功，正文为空。声明为空却带正文时无法解释，按 UNKNOWN。
          settle(
            body.byteLength === 0
              ? { ok: { body: new Uint8Array(), contentType: "" } }
              : { error: resultUnknown() },
          );
          return;
        }
        const contentType = mediaType(response.headers["content-type"]);
        // 已收到 2xx 却无法解释正文时不能证明调用失败，交给恢复协议而不是伪装成明确失败。
        settle(
          interpretableMediaType(contentType)
            ? { ok: { body, contentType } }
            : { error: resultUnknown() },
        );
      });
    }
  });
}

const DOC_KEYS = new Set(["openapi", "server", "path", "method", "operation"]);
const OPERATION_KEYS = new Set([
  "operationId",
  "summary",
  "description",
  "tags",
  "deprecated",
  "parameters",
  "requestBody",
  "responses",
]);
const REQUEST_BODY_KEYS = new Set(["description", "required", "content"]);
const JSON_CONTENT_KEYS = new Set(["application/json"]);
const MEDIA_TYPE_KEYS = new Set(["schema"]);
const PARAMETER_KEYS = new Set(["name", "in", "required", "description", "schema"]);
const HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const SERVER_PATTERN = new RegExp(
  `^https://(?:${HOST_LABEL}(?:\\.${HOST_LABEL})*|\\[[0-9A-Fa-f:.]+\\])(?::\\d{1,5})?` +
    "(?:/[A-Za-z0-9._~-]+)*/?(?:\\?[A-Za-z0-9._~=&%-]*)?$",
  "u",
);
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/u;
const QUERY_NAME = /^[A-Za-z0-9._~-]{1,64}$/u;

function containsRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRef);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => key === "$ref" || containsRef(item));
}

/**
 * 将单个 OpenAPI 3.x operation 转成平台可保存的 HTTP 定义；仅接受 JSON body 与受控 Schema 子集。
 * 参与转换的各层对象使用字段白名单，任何 `$ref`（含与内联字段混用）都会被拒绝而不是静默忽略；
 * GET 查询参数不得与 server 中的固定查询键重名。
 */
export function importOpenApiOperation(input: unknown): HttpToolDefinition {
  const fail = (): never => {
    throw new TypeError("HTTP_OPENAPI_OPERATION_UNSUPPORTED");
  };
  const object = (value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    if (Object.keys(value).some((key) => !allowed.has(key))) return fail();
    return value as Record<string, unknown>;
  };
  const doc = object(input, DOC_KEYS);
  if (typeof doc.openapi !== "string" || !/^3\.[0-9]+\./u.test(doc.openapi)) return fail();
  const method = typeof doc.method === "string" ? doc.method.toUpperCase() : undefined;
  if (method !== "POST" && method !== "GET") return fail();
  const op = object(doc.operation, OPERATION_KEYS);
  // responses 不参与转换，其余字段中的任何引用都会改变实际约束，必须拒绝。
  if (containsRef({ ...op, responses: undefined })) return fail();

  // 先独立校验 server，再拼接严格受限的路径，并在解析后强制 origin 不变，
  // 防止 URL 归一化把路径中的斜杠或控制字符解释成新的主机。
  if (
    typeof doc.server !== "string" ||
    !SERVER_PATTERN.test(doc.server) ||
    /\/\.{1,2}(?=[/?]|$)/u.test(doc.server.slice("https://".length))
  )
    return fail();
  let server: URL;
  try {
    server = new URL(doc.server);
  } catch {
    return fail();
  }
  if (server.protocol !== "https:" || server.username || server.password || server.hash)
    return fail();
  const path = doc.path;
  if (typeof path !== "string" || !path.startsWith("/")) return fail();
  const segments = path === "/" ? [] : path.replace(/\/$/u, "").slice(1).split("/");
  if (segments.some((segment) => !PATH_SEGMENT.test(segment) || /^\.{1,2}$/u.test(segment)))
    return fail();
  const expectedPath = `${server.pathname.replace(/\/$/u, "")}${path}`;
  let endpoint: URL;
  try {
    endpoint = new URL(`${server.origin}${expectedPath}${server.search}`);
  } catch {
    return fail();
  }
  if (endpoint.origin !== server.origin || endpoint.pathname !== expectedPath) return fail();
  const fixedQuery = new Set(new URLSearchParams(server.search).keys());

  let schema: unknown;
  if (method === "POST") {
    if (op.parameters !== undefined) return fail();
    const body = object(op.requestBody, REQUEST_BODY_KEYS);
    if (body.required !== undefined && typeof body.required !== "boolean") return fail();
    const content = object(body.content, JSON_CONTENT_KEYS);
    const json = object(content["application/json"], MEDIA_TYPE_KEYS);
    if (!json.schema) return fail();
    schema = json.schema;
  } else {
    if (op.requestBody !== undefined) return fail();
    const parameters = op.parameters;
    if (parameters !== undefined && !Array.isArray(parameters)) return fail();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const parameter of (parameters ?? []) as unknown[]) {
      const item = object(parameter, PARAMETER_KEYS);
      if (
        item.in !== "query" ||
        typeof item.name !== "string" ||
        !QUERY_NAME.test(item.name) ||
        fixedQuery.has(item.name) ||
        Object.hasOwn(properties, item.name) ||
        (item.required !== undefined && typeof item.required !== "boolean") ||
        !item.schema ||
        typeof item.schema !== "object" ||
        Array.isArray(item.schema)
      )
        return fail();
      const itemSchema = item.schema as Record<string, unknown>;
      if (itemSchema.type === "array" || itemSchema.type === "object") return fail();
      properties[item.name] = item.schema;
      if (item.required === true) required.push(item.name);
    }
    schema = { type: "object", properties, required, additionalProperties: false };
  }
  const normalized = normalizeExternalToolSchema(schema);
  return Object.freeze({
    endpoint: endpoint.toString(),
    method,
    inputSchema: normalized.schema,
    timeoutMs: 10_000,
    maxResponseBytes: 65_536,
    sideEffect: method === "GET" ? "read_only" : "write",
    idempotent: method === "GET",
    credentialRef: null,
  });
}
