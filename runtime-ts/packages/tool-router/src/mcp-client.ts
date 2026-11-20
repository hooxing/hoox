import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { normalizeExternalToolName, normalizeExternalToolSchema } from "@hoox/domain";
import { McpResponseFailure } from "./mcp-errors.js";
import {
  ExternalToolTransportError,
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

export interface McpExchangeInput {
  readonly target: ValidatedExternalTarget;
  readonly body: Uint8Array;
  readonly credential?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
}
export type McpExchange = (
  input: McpExchangeInput,
) => Promise<{ status: number; contentType: string; body: Uint8Array }>;

/** Streamable HTTP 的 HTTPS 出站实现；socket lookup 固定使用前置校验过的 IP。 */
export const exchangeMcpHttp: McpExchange = (input) =>
  new Promise((resolve, reject) => {
    let wrote = false;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(
        wrote ? error : new ExternalToolTransportError("preflight", "EXTERNAL_TOOL_UNAVAILABLE"),
      );
    };
    if (input.signal?.aborted) {
      reject(new ExternalToolTransportError("preflight", "EXTERNAL_TOOL_UNAVAILABLE"));
      return;
    }
    const request = httpsRequest(
      input.target.url,
      {
        method: "POST",
        servername: input.target.servername,
        headers: {
          host: input.target.hostHeader,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": PROTOCOL_VERSION,
          ...(input.credential === undefined
            ? {}
            : { authorization: `Bearer ${input.credential}` }),
          "content-length": String(input.body.byteLength),
        },
        maxHeaderSize: 16 * 1024,
        rejectUnauthorized: true,
        lookup: (_hostname, _options, callback) =>
          callback(null, input.target.address, isIP(input.target.address)),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > input.maxResponseBytes) {
            response.destroy(new Error("response_limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    const timer = setTimeout(() => request.destroy(new Error("timeout")), input.timeoutMs);
    timer.unref?.();
    request.on("finish", () => {
      wrote = true;
    });
    request.on("error", fail);
    const abort = () => request.destroy(new Error("aborted"));
    input.signal?.addEventListener("abort", abort, { once: true });
    request.on("close", () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    });
    request.end(Buffer.from(input.body));
  });

function decodeRpc(body: Uint8Array, contentType: string): RpcEnvelope {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  let payload = text;
  if (contentType.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    payload = data.at(-1) ?? "";
  }
  const value: unknown = JSON.parse(payload);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP_PROTOCOL_INVALID");
  const envelope = value as RpcEnvelope;
  if (envelope.jsonrpc !== "2.0") throw new Error("MCP_PROTOCOL_INVALID");
  if (envelope.error !== undefined) throw new McpResponseFailure("MCP_PROTOCOL_ERROR");
  if (!Object.hasOwn(envelope, "result")) throw new Error("MCP_PROTOCOL_INVALID");
  return envelope;
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
    },
    id: number,
  ): Promise<{ result: Record<string, unknown>; contentType: string }> {
    const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    let response: Awaited<ReturnType<McpExchange>>;
    try {
      response = await this.exchange({
        target,
        body,
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        ...(options.credential === undefined ? {} : { credential: options.credential }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (error instanceof ExternalToolTransportError) throw error;
      throw new Error("MCP_RESULT_UNKNOWN");
    }
    if (response.body.byteLength > options.maxResponseBytes) throw new Error("MCP_RESPONSE_LIMIT");
    if (response.status < 200 || response.status >= 300) throw new Error("MCP_PROTOCOL_ERROR");
    const envelope = decodeRpc(response.body, response.contentType);
    if (
      envelope.id !== id ||
      envelope.result === null ||
      typeof envelope.result !== "object" ||
      Array.isArray(envelope.result)
    )
      throw new Error("MCP_PROTOCOL_INVALID");
    return {
      result: envelope.result as Record<string, unknown>,
      contentType: response.contentType,
    };
  }

  async initialize(
    target: ValidatedExternalTarget,
    options: { timeoutMs: number; maxResponseBytes: number; credential?: string },
  ): Promise<void> {
    const { result } = await this.rpc(
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
      typeof result.protocolVersion !== "string" ||
      result.capabilities === null ||
      typeof result.capabilities !== "object"
    )
      throw new Error("MCP_PROTOCOL_INVALID");
    const body = new TextEncoder().encode(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    const response = await this.exchange({
      target,
      body,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      ...(options.credential === undefined ? {} : { credential: options.credential }),
    });
    if (
      response.body.byteLength > options.maxResponseBytes ||
      response.status < 200 ||
      response.status >= 300
    )
      throw new Error("MCP_PROTOCOL_ERROR");
  }

  async listTools(
    target: ValidatedExternalTarget,
    options: { timeoutMs: number; maxResponseBytes: number; credential?: string },
  ): Promise<readonly Record<string, unknown>[]> {
    const tools: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    let id = 2;
    do {
      const { result } = await this.rpc(
        target,
        "tools/list",
        cursor === undefined ? {} : { cursor },
        options,
        id++,
      );
      if (!Array.isArray(result.tools)) throw new Error("MCP_PROTOCOL_INVALID");
      tools.push(...(result.tools as Record<string, unknown>[]));
      if (tools.length > 64) throw new Error("MCP_TOOL_LIMIT");
      if (result.nextCursor !== undefined && typeof result.nextCursor !== "string")
        throw new Error("MCP_PROTOCOL_INVALID");
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
      throw new Error("MCP_REMOTE_NAME_REQUIRED");
    const body = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: input.tool.remoteToolName, arguments: input.arguments },
      }),
    );
    let response: Awaited<ReturnType<McpExchange>>;
    try {
      response = await this.exchange({
        target: input.target,
        body,
        timeoutMs: input.timeoutMs,
        maxResponseBytes: input.maxResponseBytes,
        ...(input.credential === undefined ? {} : { credential: input.credential }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof ExternalToolTransportError) throw error;
      throw new Error("MCP_RESULT_UNKNOWN");
    }
    if (response.body.byteLength > input.maxResponseBytes) throw new Error("MCP_RESPONSE_LIMIT");
    if (response.status >= 300 && response.status < 500)
      throw new McpResponseFailure("MCP_PROTOCOL_ERROR");
    if (response.status < 200 || response.status >= 500) throw new Error("MCP_RESULT_UNKNOWN");
    const envelope = decodeRpc(response.body, response.contentType);
    if (
      envelope.id !== 1 ||
      envelope.result === null ||
      typeof envelope.result !== "object" ||
      Array.isArray(envelope.result)
    )
      throw new Error("MCP_PROTOCOL_INVALID");
    const result = envelope.result as Record<string, unknown>;
    if (result.isError === true) throw new McpResponseFailure("MCP_TOOL_ERROR");
    let normalized: string;
    if (result.structuredContent !== undefined)
      normalized = JSON.stringify(result.structuredContent);
    else if (Array.isArray(result.content))
      normalized = result.content
        .map((item) => {
          if (
            item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).type === "text" &&
            typeof (item as Record<string, unknown>).text === "string"
          )
            return (item as { text: string }).text;
          throw new Error("MCP_RESULT_UNSUPPORTED");
        })
        .join("\n");
    else throw new Error("MCP_RESULT_INVALID");
    const bytes = new TextEncoder().encode(normalized);
    if (bytes.byteLength > input.maxResponseBytes) throw new Error("MCP_RESPONSE_LIMIT");
    return {
      body: bytes,
      contentType:
        result.structuredContent === undefined ? "text/plain; charset=utf-8" : "application/json",
    };
  }
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
  const client = input.client ?? new McpStreamableHttpClient();
  const options = {
    timeoutMs: input.timeoutMs,
    maxResponseBytes: input.maxResponseBytes,
    ...(input.credential === undefined ? {} : { credential: input.credential }),
  };
  await client.initialize(input.target, options);
  const tools = await client.listTools(input.target, options);
  if (tools.length > 64) throw new Error("MCP_TOOL_LIMIT");
  const modelNames = new Set<string>();
  return tools.map((tool) => {
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
          ? error.message
          : "EXTERNAL_TOOL_SCHEMA_INVALID";
      throw new Error(`MCP_SCHEMA_REJECTED:${reason}`);
    }
    const description = (tool.description as string | undefined) ?? "";
    if (Buffer.byteLength(description) > 2048) throw new Error("MCP_TOOL_DESCRIPTION_INVALID");
    let modelToolName: string;
    try {
      modelToolName = normalizeExternalToolName("mcp", input.serverName, tool.name);
    } catch {
      throw new Error("MCP_TOOL_NAME_INVALID");
    }
    if (modelNames.has(modelToolName)) throw new Error("MCP_TOOL_NAME_COLLISION");
    modelNames.add(modelToolName);
    return {
      remoteToolName: tool.name,
      modelToolName,
      description,
      inputSchema: normalized.schema,
      inputSchemaDigest: normalized.digest,
    };
  });
}
