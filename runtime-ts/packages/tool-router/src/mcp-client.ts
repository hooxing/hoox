import type { IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { isIP } from "node:net";
import { normalizeExternalToolName, normalizeExternalToolSchema } from "@hoox/domain";
import {
  ExternalToolTransportError,
  type ExternalToolCallContext,
  type ExternalToolTransport,
  type ValidatedExternalTarget,
} from "@hoox/run-contracts";

const PROTOCOL_VERSION = "2025-06-18";
type RpcEnvelope = {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

const notSent = (code: "EXTERNAL_TOOL_UNAVAILABLE" | "EXTERNAL_TOOL_REJECTED") =>
  new ExternalToolTransportError("not_sent", code);
const respondedFailure = () =>
  new ExternalToolTransportError("responded_failure", "EXTERNAL_TOOL_REJECTED");
const resultUnknown = () => new Error("EXTERNAL_TOOL_RESULT_UNKNOWN");

export interface McpExchangeInput {
  readonly target: ValidatedExternalTarget;
  readonly body: Uint8Array;
  readonly credential?: string;
  readonly timeoutMs: number;
  readonly deadlineAt: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
  /** 仅供可信调用边界关联；不会序列化到 MCP 请求或发往远端。 */
  readonly callContext?: ExternalToolCallContext;
}
export type McpExchange = (input: McpExchangeInput) => Promise<{
  status: number;
  contentType: string;
  body: Uint8Array;
}>;

type ExchangeOutcome =
  | { readonly ok: { status: number; contentType: string; body: Uint8Array } }
  | { readonly error: Error };

/** 每次独立建连并直接拨经校验的 IP；原始主机名仍用于 SNI 和证书身份校验。 */
export const exchangeMcpHttp: McpExchange = (input) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let secured = false;
    let req: ReturnType<typeof httpsRequest> | undefined;
    let res: IncomingMessage | undefined;
    const interrupted = () => (secured ? resultUnknown() : notSent("EXTERNAL_TOOL_UNAVAILABLE"));
    const onAbort = () => settle({ error: interrupted() });
    const deadlineAt = Math.min(input.deadlineAt, Date.now() + input.timeoutMs);
    const timer = setTimeout(
      () => settle({ error: interrupted() }),
      Math.max(0, deadlineAt - Date.now()),
    );

    function settle(outcome: ExchangeOutcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if ("error" in outcome) {
        res?.destroy();
        req?.destroy();
        reject(outcome.error);
      } else resolve(outcome.ok);
    }

    if (input.signal?.aborted || deadlineAt <= Date.now()) {
      settle({ error: notSent("EXTERNAL_TOOL_UNAVAILABLE") });
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const hostname = input.target.hostname;
    const port = Number(input.target.url.port || 443);
    const headers: Record<string, string> = {
      host: input.target.hostHeader,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "content-length": String(input.body.byteLength),
      ...(input.credential === undefined ? {} : { authorization: `Bearer ${input.credential}` }),
      ...(input.idempotencyKey === undefined ? {} : { "idempotency-key": input.idempotencyKey }),
    };
    const options: RequestOptions = {
      protocol: "https:",
      host: input.target.address,
      port,
      path: `${input.target.url.pathname}${input.target.url.search}`,
      method: "POST",
      headers,
      agent: false,
      maxHeaderSize: 16 * 1024,
      rejectUnauthorized: true,
      ...(isIP(input.target.servername) ? {} : { servername: input.target.servername }),
      checkServerIdentity: (_host: string, certificate: PeerCertificate) =>
        checkServerIdentity(hostname, certificate),
    };
    try {
      req = httpsRequest(options, onResponse);
    } catch {
      settle({ error: notSent("EXTERNAL_TOOL_REJECTED") });
      return;
    }
    req.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        secured = true;
      });
    });
    req.on("error", () => settle({ error: interrupted() }));
    req.on("close", () => {
      if (!res) settle({ error: interrupted() });
    });
    req.end(Buffer.from(input.body));

    function onResponse(response: IncomingMessage) {
      res = response;
      response.on("error", () => settle({ error: resultUnknown() }));
      response.on("close", () => {
        if (!response.complete) settle({ error: resultUnknown() });
      });
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        settle({ error: status >= 300 && status < 500 ? respondedFailure() : resultUnknown() });
        return;
      }
      if (Number(response.headers["content-length"]) > input.maxResponseBytes) {
        settle({ error: resultUnknown() });
        return;
      }
      const chunks: Buffer[] = [];
      let byteLength = 0;
      response.on("data", (chunk: Buffer) => {
        byteLength += chunk.byteLength;
        if (byteLength > input.maxResponseBytes) settle({ error: resultUnknown() });
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (!response.complete) {
          settle({ error: resultUnknown() });
          return;
        }
        settle({
          ok: {
            status,
            contentType:
              String(response.headers["content-type"] ?? "")
                .split(";", 1)[0]
                ?.trim()
                .toLowerCase() ?? "",
            body: Buffer.concat(chunks),
          },
        });
      });
    }
  });

function decodeRpc(body: Uint8Array, contentType: string, expectedId: number): RpcEnvelope {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  let payload = text;
  if (contentType === "text/event-stream") {
    const events = text.split(/\r?\n\r?\n/u);
    const data = events
      .flatMap((event) => event.split(/\r?\n/u))
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    payload = data.at(-1) ?? "";
  }
  const value: unknown = JSON.parse(payload);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw respondedFailure();
  const envelope = value as RpcEnvelope;
  if (envelope.jsonrpc !== "2.0" || envelope.id !== expectedId) throw respondedFailure();
  if (envelope.error !== undefined) {
    const rpcError = envelope.error;
    if (
      rpcError === null ||
      typeof rpcError !== "object" ||
      typeof (rpcError as Record<string, unknown>).code !== "number" ||
      typeof (rpcError as Record<string, unknown>).message !== "string"
    )
      throw respondedFailure();
    throw respondedFailure();
  }
  if (!Object.hasOwn(envelope, "result")) throw respondedFailure();
  return envelope;
}

function jsonRpcBody(id: number, method: string, params: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

export class McpStreamableHttpClient {
  private readonly exchange: McpExchange;
  constructor(exchange: McpExchange = exchangeMcpHttp) {
    this.exchange = exchange;
  }

  private async rpc(
    target: ValidatedExternalTarget,
    method: string,
    params: unknown,
    options: {
      timeoutMs: number;
      maxResponseBytes: number;
      credential?: string;
      signal?: AbortSignal;
      callContext?: ExternalToolCallContext;
      idempotencyKey?: string;
    },
    id: number,
  ): Promise<Record<string, unknown>> {
    let response: Awaited<ReturnType<McpExchange>>;
    try {
      response = await this.exchange({
        target,
        body: jsonRpcBody(id, method, params),
        timeoutMs: options.timeoutMs,
        deadlineAt: Date.now() + options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        ...(options.credential === undefined ? {} : { credential: options.credential }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.callContext === undefined ? {} : { callContext: options.callContext }),
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      });
    } catch (error) {
      if (error instanceof ExternalToolTransportError) throw error;
      if (error instanceof Error && error.message === "MCP_PROTOCOL_INVALID")
        throw respondedFailure();
      throw resultUnknown();
    }
    if (response.body.byteLength > options.maxResponseBytes) throw resultUnknown();
    if (response.status < 200 || response.status >= 300) {
      if (response.status >= 300 && response.status < 500) throw respondedFailure();
      throw resultUnknown();
    }
    const contentType = response.contentType.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json" && contentType !== "text/event-stream")
      throw resultUnknown();
    let envelope: RpcEnvelope;
    try {
      envelope = decodeRpc(response.body, contentType, id);
    } catch (error) {
      if (error instanceof ExternalToolTransportError) throw error;
      if (error instanceof Error && error.message === "MCP_PROTOCOL_INVALID")
        throw respondedFailure();
      throw resultUnknown();
    }
    if (
      envelope.result === null ||
      typeof envelope.result !== "object" ||
      Array.isArray(envelope.result)
    )
      throw respondedFailure();
    return envelope.result as Record<string, unknown>;
  }

  async initialize(
    target: ValidatedExternalTarget,
    options: { timeoutMs: number; maxResponseBytes: number; credential?: string },
  ): Promise<void> {
    const result = await this.rpc(
      target,
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Hoox", version: "1" },
      },
      options,
      1,
    );
    if (
      result.protocolVersion !== PROTOCOL_VERSION ||
      result.capabilities === null ||
      typeof result.capabilities !== "object"
    )
      throw respondedFailure();
    const body = new TextEncoder().encode(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    let response: Awaited<ReturnType<McpExchange>>;
    try {
      response = await this.exchange({
        target,
        body,
        timeoutMs: options.timeoutMs,
        deadlineAt: Date.now() + options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        ...(options.credential === undefined ? {} : { credential: options.credential }),
      });
    } catch (error) {
      if (error instanceof ExternalToolTransportError) throw error;
      throw resultUnknown();
    }
    if (response.body.byteLength > options.maxResponseBytes) throw resultUnknown();
    if (response.status >= 300 && response.status < 500) throw respondedFailure();
    if (response.status < 200 || response.status >= 500) throw resultUnknown();
  }

  async listTools(
    target: ValidatedExternalTarget,
    options: { timeoutMs: number; maxResponseBytes: number; credential?: string },
  ): Promise<readonly Record<string, unknown>[]> {
    const tools: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    let id = 2;
    do {
      const result = await this.rpc(
        target,
        "tools/list",
        cursor === undefined ? {} : { cursor },
        options,
        id++,
      );
      if (!Array.isArray(result.tools)) throw respondedFailure();
      tools.push(...(result.tools as Record<string, unknown>[]));
      if (tools.length > 64) throw new Error("MCP_TOOL_LIMIT");
      if (result.nextCursor !== undefined && typeof result.nextCursor !== "string")
        throw respondedFailure();
      cursor = result.nextCursor as string | undefined;
    } while (cursor !== undefined);
    return tools;
  }
}

export class McpExternalToolTransport implements ExternalToolTransport {
  private readonly exchange: McpExchange;
  constructor(exchange: McpExchange = exchangeMcpHttp) {
    this.exchange = exchange;
  }

  async invoke(
    input: Parameters<ExternalToolTransport["invoke"]>[0],
  ): Promise<{ body: Uint8Array; contentType: string }> {
    if (input.tool.source !== "mcp" || !input.tool.remoteToolName)
      throw notSent("EXTERNAL_TOOL_REJECTED");
    if (!input.callContext?.tenantId || !input.callContext.threadId || !input.callContext.runId)
      throw notSent("EXTERNAL_TOOL_REJECTED");
    if (input.signal?.aborted || input.deadlineAt <= Date.now())
      throw notSent("EXTERNAL_TOOL_UNAVAILABLE");
    let body: Uint8Array;
    try {
      body = jsonRpcBody(1, "tools/call", {
        name: input.tool.remoteToolName,
        arguments: input.arguments,
      });
    } catch {
      throw notSent("EXTERNAL_TOOL_REJECTED");
    }
    let response: Awaited<ReturnType<McpExchange>>;
    try {
      response = await this.exchange({
        target: input.target,
        body,
        timeoutMs: input.timeoutMs,
        deadlineAt: input.deadlineAt,
        maxResponseBytes: input.maxResponseBytes,
        ...(input.credential === undefined ? {} : { credential: input.credential }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        idempotencyKey: input.idempotencyKey,
        callContext: input.callContext,
      });
    } catch (error) {
      if (error instanceof ExternalToolTransportError) throw error;
      throw resultUnknown();
    }
    if (response.body.byteLength > input.maxResponseBytes) throw resultUnknown();
    if (response.status >= 300 && response.status < 500) throw respondedFailure();
    if (response.status < 200 || response.status >= 500) throw resultUnknown();
    const contentType = response.contentType.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json" && contentType !== "text/event-stream")
      throw resultUnknown();
    let envelope: RpcEnvelope;
    try {
      envelope = decodeRpc(response.body, contentType, 1);
    } catch (error) {
      if (error instanceof ExternalToolTransportError) throw error;
      if (error instanceof Error && error.message === "MCP_PROTOCOL_INVALID")
        throw respondedFailure();
      throw resultUnknown();
    }
    if (
      envelope.result === null ||
      typeof envelope.result !== "object" ||
      Array.isArray(envelope.result)
    )
      throw respondedFailure();
    const result = envelope.result as Record<string, unknown>;
    if (result.isError === true) throw respondedFailure();
    let normalized: string;
    if (result.structuredContent !== undefined) {
      try {
        normalized = JSON.stringify(result.structuredContent);
      } catch {
        throw respondedFailure();
      }
      if (normalized === undefined) throw respondedFailure();
    } else if (Array.isArray(result.content)) {
      normalized = result.content
        .map((item) => {
          if (
            item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).type === "text" &&
            typeof (item as Record<string, unknown>).text === "string"
          )
            return (item as { text: string }).text;
          throw respondedFailure();
        })
        .join("\n");
    } else throw respondedFailure();
    const bytes = new TextEncoder().encode(normalized);
    if (bytes.byteLength > input.maxResponseBytes) throw resultUnknown();
    return {
      body: bytes,
      contentType: result.structuredContent === undefined ? "text/plain" : "application/json",
    };
  }
}

export type McpProbeToolReport =
  | Readonly<{
      accepted: true;
      remoteToolName: string;
      modelToolName: string;
      description: string;
      inputSchema: Readonly<Record<string, unknown>>;
      inputSchemaDigest: string;
    }>
  | Readonly<{
      accepted: false;
      reason: string;
      reasonMessage: string;
    }>;

const probeReasons: Readonly<Record<string, string>> = Object.freeze({
  MCP_TOOL_INVALID: "工具名称或描述格式不受支持",
  MCP_SCHEMA_REJECTED: "工具参数 Schema 不符合平台支持的安全子集",
  MCP_TOOL_DESCRIPTION_INVALID: "工具描述超过允许长度",
  MCP_TOOL_NAME_INVALID: "工具名称无法安全转换为平台名称",
  MCP_TOOL_NAME_COLLISION: "多个工具转换后名称冲突",
});

/** 返回逐工具受控报告；Schema、工具描述和服务端原始异常不会作为拒绝原因透出。 */
export async function probeMcpServerReport(input: {
  client?: McpStreamableHttpClient;
  target: ValidatedExternalTarget;
  serverName: string;
  timeoutMs: number;
  maxResponseBytes: number;
  credential?: string;
}): Promise<readonly McpProbeToolReport[]> {
  const client = input.client ?? new McpStreamableHttpClient();
  const options = {
    timeoutMs: input.timeoutMs,
    maxResponseBytes: input.maxResponseBytes,
    ...(input.credential === undefined ? {} : { credential: input.credential }),
  };
  await client.initialize(input.target, options);
  const tools = await client.listTools(input.target, options);
  const modelNames = new Set<string>();
  return tools.map((tool) => {
    try {
      if (
        typeof tool.name !== "string" ||
        !tool.name ||
        (tool.description !== undefined && typeof tool.description !== "string")
      )
        throw new Error("MCP_TOOL_INVALID");
      let normalized: ReturnType<typeof normalizeExternalToolSchema>;
      try {
        normalized = normalizeExternalToolSchema(tool.inputSchema);
      } catch (error) {
        const reason =
          error instanceof TypeError && /^EXTERNAL_TOOL_[A-Z_]+$/u.test(error.message)
            ? `MCP_SCHEMA_REJECTED:${error.message}`
            : "MCP_SCHEMA_REJECTED:EXTERNAL_TOOL_SCHEMA_INVALID";
        throw new Error(reason);
      }
      const description = (tool.description as string | undefined) ?? "";
      if (Buffer.byteLength(description) > 2048) throw new Error("MCP_TOOL_DESCRIPTION_INVALID");
      const modelToolName = normalizeExternalToolName("mcp", input.serverName, tool.name);
      if (modelNames.has(modelToolName)) throw new Error("MCP_TOOL_NAME_COLLISION");
      modelNames.add(modelToolName);
      return Object.freeze({
        remoteToolName: tool.name,
        modelToolName,
        description,
        inputSchema: normalized.schema,
        inputSchemaDigest: normalized.digest,
        accepted: true,
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : "";
      const reason = raw === "EXTERNAL_TOOL_NAME_INVALID" ? "MCP_TOOL_NAME_INVALID" : raw;
      return Object.freeze({
        accepted: false,
        reason,
        reasonMessage: raw.startsWith("MCP_SCHEMA_REJECTED:")
          ? "工具参数 Schema 不符合平台支持的安全子集"
          : (probeReasons[reason] ?? "工具定义不符合平台要求"),
      });
    }
  });
}

export async function probeMcpServer(input: {
  client?: McpStreamableHttpClient;
  target: ValidatedExternalTarget;
  serverName: string;
  timeoutMs: number;
  maxResponseBytes: number;
  credential?: string;
}): Promise<
  readonly {
    remoteToolName: string;
    modelToolName: string;
    description: string;
    inputSchema: Readonly<Record<string, unknown>>;
    inputSchemaDigest: string;
  }[]
> {
  const report = await probeMcpServerReport(input);
  const rejected = report.find((tool) => !tool.accepted);
  if (rejected) {
    if (rejected.reason?.startsWith("MCP_SCHEMA_REJECTED:")) throw new Error(rejected.reason);
    throw new Error(rejected.reason ?? "MCP_TOOL_INVALID");
  }
  return report.map((tool) => {
    if (!tool.accepted) throw new Error(tool.reason);
    return {
      remoteToolName: tool.remoteToolName,
      modelToolName: tool.modelToolName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      inputSchemaDigest: tool.inputSchemaDigest,
    };
  });
}
