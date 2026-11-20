import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { request } from "node:https";
import { isIP } from "node:net";
import { ExternalToolTransportError, type ExternalToolTransport } from "@hoox/run-contracts";
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

function signatureKey(credential: string | undefined, versionId: string): Buffer {
  if (!credential) throw new ExternalToolTransportError("not_sent", "EXTERNAL_TOOL_REJECTED");
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(credential),
      Buffer.from(`hoox-http-signature:${versionId}`),
      Buffer.from("hmac-sha256-v1"),
      32,
    ),
  );
}

function opaqueId(key: Buffer, name: string, value: string | undefined): string {
  return createHmac("sha256", key)
    .update(`hoox-context-v1\n${name}\n${value ?? ""}`)
    .digest("hex");
}

function requestBody(method: "GET" | "POST", args: Readonly<Record<string, unknown>>): Buffer {
  return Buffer.from(method === "POST" ? JSON.stringify(args) : "", "utf8");
}

/** 独立校验格式：HMAC-SHA256(key, timestamp + LF + method + LF + path + LF + hex(SHA256(body)))。 */
export function verifyHttpToolSignature(input: {
  readonly key: string | Uint8Array;
  readonly timestamp: string;
  readonly method: string;
  readonly path: string;
  readonly body: Uint8Array;
  readonly signature: string;
}): boolean {
  if (!/^\d{10,13}$/u.test(input.timestamp) || !/^[0-9a-f]{64}$/u.test(input.signature))
    return false;
  const digest = createHash("sha256").update(input.body).digest("hex");
  const expected = createHmac("sha256", input.key)
    .update(`${input.timestamp}\n${input.method.toUpperCase()}\n${input.path}\n${digest}`)
    .digest();
  const received = Buffer.from(input.signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export const httpExternalToolTransport: ExternalToolTransport = {
  invoke(input) {
    const method = input.method ?? "POST";
    if (
      method === "GET" &&
      (input.tool.sideEffect !== "read_only" || input.arguments === undefined)
    )
      throw new ExternalToolTransportError("not_sent", "EXTERNAL_TOOL_REJECTED");
    if (input.redirect !== "error")
      throw new ExternalToolTransportError("not_sent", "EXTERNAL_TOOL_REJECTED");
    const key = signatureKey(input.credential, input.tool.toolVersionId);
    const body = requestBody(method, input.arguments);
    const timestamp = String(Date.now());
    const query = new URLSearchParams(input.target.url.search);
    if (method === "GET") {
      for (const [name, value] of Object.entries(input.arguments).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (value !== null && typeof value === "object")
          throw new ExternalToolTransportError("not_sent", "EXTERNAL_TOOL_REJECTED");
        query.set(name, String(value));
      }
    }
    const queryText = query.toString();
    const path = `${input.target.url.pathname}${queryText ? `?${queryText}` : ""}`;
    const digest = createHash("sha256").update(body).digest("hex");
    const signature = createHmac("sha256", key)
      .update(`${timestamp}\n${method}\n${path}\n${digest}`)
      .digest("hex");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(body.byteLength),
      "X-Hoox-Signature": signature,
      "X-Hoox-Timestamp": timestamp,
      "X-Hoox-Idempotency-Key": input.idempotencyKey,
      "X-Hoox-Tenant": opaqueId(key, "tenant", input.callContext.tenantId),
      "X-Hoox-End-User": opaqueId(key, "end-user", input.callContext.endUserId),
      "X-Hoox-Thread": opaqueId(key, "thread", input.callContext.threadId),
      "X-Hoox-Run": opaqueId(key, "run", input.callContext.runId),
    };
    return new Promise((resolve, reject) => {
      let responseSeen = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      };
      const req = request(
        {
          protocol: "https:",
          hostname: input.target.hostname,
          servername: input.target.servername,
          port: input.target.url.port || 443,
          method,
          path,
          headers,
          signal: input.signal,
          lookup: (_hostname, _options, callback) =>
            callback(null, input.target.address, isIP(input.target.address)),
        },
        (res) => {
          responseSeen = true;
          const status = res.statusCode ?? 0;
          if (status >= 400 && status < 500) {
            res.resume();
            finishError(
              new ExternalToolTransportError("responded_failure", "EXTERNAL_TOOL_REJECTED"),
            );
            return;
          }
          if (status >= 500) {
            res.resume();
            finishError(new Error("EXTERNAL_TOOL_RESULT_UNKNOWN"));
            return;
          }
          if (status >= 300) {
            res.resume();
            finishError(
              new ExternalToolTransportError("responded_failure", "EXTERNAL_TOOL_REJECTED"),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          res.on("data", (chunk: Buffer) => {
            length += chunk.byteLength;
            if (length > input.maxResponseBytes) {
              res.destroy();
              finishError(new Error("EXTERNAL_TOOL_RESULT_UNKNOWN"));
            } else chunks.push(chunk);
          });
          res.on("end", () => {
            if (settled) return;
            const contentType =
              String(res.headers["content-type"] ?? "")
                .split(";", 1)[0]
                ?.trim()
                .toLowerCase() ?? "";
            if (
              !(
                contentType === "application/json" ||
                contentType.endsWith("+json") ||
                contentType.startsWith("text/")
              )
            ) {
              finishError(
                new ExternalToolTransportError("responded_failure", "EXTERNAL_TOOL_REJECTED"),
              );
              return;
            }
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ body: Buffer.concat(chunks), contentType });
          });
        },
      );
      timer = setTimeout(() => req.destroy(new Error("timeout")), input.timeoutMs);
      req.on("error", () =>
        finishError(
          responseSeen
            ? new Error("response interrupted")
            : req.socket?.bytesWritten === 0
              ? new ExternalToolTransportError("not_sent", "EXTERNAL_TOOL_UNAVAILABLE")
              : new Error("request interrupted after write"),
        ),
      );
      req.end(body);
    });
  },
};

/** 将单个 OpenAPI 3.x operation 转成平台可保存的 HTTP 定义；仅接受 JSON body 与受控 Schema 子集。 */
export function importOpenApiOperation(input: unknown): HttpToolDefinition {
  const fail = (): never => {
    throw new TypeError("HTTP_OPENAPI_OPERATION_UNSUPPORTED");
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const doc = input as Record<string, unknown>;
  if (typeof doc.openapi !== "string" || !/^3\.[0-9]+\./u.test(doc.openapi)) return fail();
  const path = typeof doc.path === "string" ? doc.path : undefined;
  const method = typeof doc.method === "string" ? doc.method.toUpperCase() : undefined;
  const operation = doc.operation;
  if (
    !path?.startsWith("/") ||
    path.startsWith("//") ||
    /[{}]/u.test(path) ||
    (method !== "POST" && method !== "GET") ||
    !operation ||
    typeof operation !== "object" ||
    Array.isArray(operation)
  )
    return fail();
  const op = operation as Record<string, unknown>;
  if (op.security !== undefined || op.callbacks !== undefined || op.servers !== undefined)
    return fail();
  const server = doc.server;
  if (typeof server !== "string" || /[{}]/u.test(server)) return fail();
  let endpoint: URL;
  try {
    endpoint = new URL(path, server);
  } catch {
    return fail();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    /[{}]/u.test(path)
  )
    return fail();
  let schema: unknown = { type: "object", properties: {}, additionalProperties: false };
  if (method === "POST") {
    const body = op.requestBody as Record<string, unknown> | undefined;
    const content = body?.content as Record<string, unknown> | undefined;
    const json = content?.["application/json"] as Record<string, unknown> | undefined;
    if (!json?.schema || !content || Object.keys(content).length !== 1) return fail();
    schema = json.schema;
    if (op.parameters !== undefined) return fail();
  } else {
    if (op.requestBody !== undefined) return fail();
    const parameters = op.parameters;
    if (parameters !== undefined && !Array.isArray(parameters)) return fail();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const parameter of (parameters ?? []) as unknown[]) {
      if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) return fail();
      const item = parameter as Record<string, unknown>;
      if (
        item.in !== "query" ||
        typeof item.name !== "string" ||
        !item.name ||
        !item.schema ||
        (item.required !== undefined && typeof item.required !== "boolean") ||
        Object.hasOwn(properties, item.name)
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
