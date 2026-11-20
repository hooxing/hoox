import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  sha256Digest,
  validateExternalToolVersion,
  type ExternalToolVersion,
  type Sha256Digest,
} from "@hoox/domain";
import {
  ExternalToolTransportError,
  type ExternalToolReconciliationPort,
  type ExternalToolTransport,
} from "@hoox/run-contracts";
import { encodeControlledToolReceipt } from "@hoox/context-policy";

export interface ValidatedExternalTarget {
  readonly url: URL;
  readonly addresses: readonly string[];
}
export type ExternalAddressResolver = (hostname: string) => Promise<readonly string[]>;

function ipv4Private(address: string): boolean {
  const n = address.split(".").map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a = 0, b = 0] = n;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
function ipv6Value(address: string): bigint | undefined {
  let value = address.toLowerCase().split("%", 1)[0] ?? "";
  const lastColon = value.lastIndexOf(":");
  if (value.includes(".")) {
    const v4 = value
      .slice(lastColon + 1)
      .split(".")
      .map(Number);
    if (v4.length !== 4) return;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    value = `${value.slice(0, lastColon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [leftRaw = "", rightRaw = ""] = value.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const groups = value.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : value.split(":");
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return;
  return groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
}
function privateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return ipv4Private(address);
  if (kind !== 6) return true;
  const n = ipv6Value(address);
  if (n === undefined) return true;
  const prefix = (bits: number, length: number) => n >> BigInt(128 - length) === BigInt(bits);
  if (n === 0n || n === 1n || prefix(0x7e, 7) || prefix(0x3fa, 10) || prefix(0xff, 8)) return true;
  // 兼容地址及 6to4 隧道仍可能指向 IPv4 私网，按内嵌目标重复执行 IPv4 策略。
  if (n >> 32n === 0n) {
    const embedded = Number(n & 0xffffffffn);
    return ipv4Private(
      [embedded >>> 24, (embedded >>> 16) & 255, (embedded >>> 8) & 255, embedded & 255].join("."),
    );
  }
  if (prefix(0x2002, 16)) {
    const embedded = Number((n >> 80n) & 0xffffffffn);
    if (
      ipv4Private(
        [embedded >>> 24, (embedded >>> 16) & 255, (embedded >>> 8) & 255, embedded & 255].join(
          ".",
        ),
      )
    )
      return true;
  }
  // IPv4-mapped IPv6 follows the mapped IPv4 destination's policy.
  if (n >> 32n === 0xffffn) {
    const v4n = Number(n & 0xffffffffn);
    return ipv4Private([v4n >>> 24, (v4n >>> 16) & 255, (v4n >>> 8) & 255, v4n & 255].join("."));
  }
  return false;
}

export async function validateExternalHttpsTarget(
  input: string,
  options: { readonly allowPrivate?: boolean; readonly resolve?: ExternalAddressResolver } = {},
): Promise<ValidatedExternalTarget> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("EXTERNAL_TARGET_INVALID");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("EXTERNAL_TARGET_REJECTED");
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = isIP(hostname)
    ? [hostname]
    : await (
        options.resolve ??
        (async (host) =>
          (await lookup(host, { all: true, verbatim: true })).map((item) => item.address))
      )(hostname);
  if (
    addresses.length === 0 ||
    addresses.some(
      (address) => isIP(address) === 0 || (!options.allowPrivate && privateAddress(address)),
    )
  )
    throw new Error("EXTERNAL_TARGET_REJECTED");
  // Transport must pin one of these checked addresses for the connection and disable redirects.
  return Object.freeze({ url, addresses: Object.freeze([...addresses]) });
}

function toTypeBox(schema: Record<string, unknown>): TSchema {
  const description =
    typeof schema.description === "string" ? { description: schema.description } : {};
  let result: TSchema;
  if (schema.enum) {
    const values = (schema.enum as Array<string | number | boolean>).map((v) => Type.Literal(v));
    const [first, ...rest] = values;
    const nonEmpty = [first ?? Type.Never(), ...rest] as [TSchema, ...TSchema[]];
    result = rest.length === 0 ? nonEmpty[0] : Type.Union(nonEmpty);
  } else
    switch (schema.type) {
      case "object": {
        const required = new Set(schema.required as string[]);
        result = Type.Object(
          Object.fromEntries(
            Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(
              ([k, v]) => [k, required.has(k) ? toTypeBox(v) : Type.Optional(toTypeBox(v))],
            ),
          ) as Record<string, TSchema>,
          { additionalProperties: false, ...description },
        );
        break;
      }
      case "array":
        result = Type.Array(toTypeBox(schema.items as Record<string, unknown>), description);
        break;
      case "string":
        result = Type.String(description);
        break;
      case "number":
        result = Type.Number(description);
        break;
      case "integer":
        result = Type.Integer(description);
        break;
      case "boolean":
        result = Type.Boolean(description);
        break;
      default:
        throw new Error("EXTERNAL_TOOL_SCHEMA_INVALID");
    }
  return result;
}

export interface ExternalToolExecutionPorts {
  readonly persistStarted: (input: {
    readonly callId: string;
    readonly toolName: string;
  }) => Promise<void>;
  /** 必须完成一次性 permit 领取和消费，返回后不得插入额外异步持久化操作。 */
  readonly authorizeAndConsume: (input: {
    readonly callId: string;
    readonly toolName: string;
    readonly argsDigest: Sha256Digest;
  }) => Promise<void>;
  readonly transport: ExternalToolTransport;
  readonly reconciliation?: ExternalToolReconciliationPort;
  readonly recordReceipt: (input: {
    readonly callId: string;
    readonly receipt: string;
  }) => Promise<void>;
  /** 请求写出后必须将 Attempt 持久化转入恢复。 */
  readonly requireRecovery: (input: {
    readonly callId: string;
    readonly code: "EXTERNAL_TOOL_RESULT_UNKNOWN";
  }) => Promise<void>;
  readonly maxModelVisibleBytes?: number;
  readonly isExplicitlyReconciledRetry?: (input: {
    readonly toolVersionId: string;
    readonly argsDigest: Sha256Digest;
    readonly idempotencyKey: string;
  }) => Promise<boolean>;
}

export function createExternalToolAgentTool(
  version: ExternalToolVersion,
  ports: ExternalToolExecutionPorts,
  credential?: string,
): AgentTool<TSchema, unknown> {
  const tool = validateExternalToolVersion(version);
  const parameters = toTypeBox(tool.inputSchema as Record<string, unknown>);
  let recoveryRequired = false;
  return {
    name: tool.modelToolName,
    label: tool.modelToolName,
    description: tool.description,
    parameters,
    execute: async (callId: string, rawArgs: unknown, signal?: AbortSignal) => {
      if (recoveryRequired) throw new Error("EXTERNAL_TOOL_RECOVERY_REQUIRED");
      const receipt = (outcome: "succeeded" | "failed") =>
        encodeControlledToolReceipt(tool.modelToolName, outcome);
      if (!validateExternalToolArguments(tool, rawArgs)) {
        await ports.persistStarted({ callId, toolName: tool.modelToolName });
        await ports.recordReceipt({ callId, receipt: receipt("failed") });
        return {
          content: [{ type: "text", text: "工具参数不符合已发布的输入约束。" }],
          details: { error: "EXTERNAL_TOOL_INVALID_ARGUMENTS" },
        };
      }
      const args = rawArgs;
      const serialized = canonicalJson(args);
      const argsDigest = sha256Digest(createHash("sha256").update(serialized).digest("hex"));
      let wrote = false;
      try {
        const retry = ports.isExplicitlyReconciledRetry
          ? await ports.isExplicitlyReconciledRetry({
              toolVersionId: tool.toolVersionId,
              argsDigest,
              idempotencyKey: callId,
            })
          : false;
        if (retry) {
          if (
            !tool.idempotent ||
            !ports.reconciliation ||
            (await ports.reconciliation.authorizeRetry({
              toolVersionId: tool.toolVersionId,
              argsDigest,
              idempotencyKey: callId,
              idempotent: tool.idempotent,
            })) !== "authorized"
          )
            throw new Error("EXTERNAL_TOOL_RETRY_REJECTED");
        } else {
          await ports.persistStarted({ callId, toolName: tool.modelToolName });
          await ports.authorizeAndConsume({ callId, toolName: tool.modelToolName, argsDigest });
        }
        wrote = true;
        const response = await ports.transport.invoke({
          tool,
          arguments: args,
          ...(credential === undefined ? {} : { credential }),
          idempotencyKey: callId,
          timeoutMs: tool.timeoutMs,
          maxResponseBytes: tool.maxResponseBytes,
          redirect: "error",
          ...(signal === undefined ? {} : { signal }),
        });
        if (response.body.byteLength > tool.maxResponseBytes)
          throw new Error("EXTERNAL_TOOL_RESPONSE_LIMIT");
        const raw = new TextDecoder().decode(response.body);
        let visible = raw;
        if (/json/i.test(response.contentType)) {
          try {
            visible = JSON.stringify(JSON.parse(raw));
          } catch {
            throw new Error("EXTERNAL_TOOL_RESPONSE_INVALID");
          }
        }
        if (credential) visible = visible.replaceAll(credential, "[凭据已隐藏]");
        const cap = Math.max(1, Math.min(8192, ports.maxModelVisibleBytes ?? 8192));
        const bytes = new TextEncoder().encode(visible);
        if (bytes.byteLength > cap) visible = decodeUtf8Prefix(bytes, cap);
        await ports.recordReceipt({ callId, receipt: receipt("succeeded") });
        return {
          content: [{ type: "text", text: visible }],
          details: { truncated: bytes.byteLength > cap },
        };
      } catch (error) {
        if (error instanceof ExternalToolTransportError && error.phase === "preflight")
          wrote = false;
        if (wrote) {
          recoveryRequired = true;
          try {
            await ports.requireRecovery({ callId, code: "EXTERNAL_TOOL_RESULT_UNKNOWN" });
          } catch {
            throw new Error("EXTERNAL_TOOL_RECOVERY_UNAVAILABLE");
          }
          throw new Error("EXTERNAL_TOOL_RESULT_UNKNOWN");
        }
        await ports.recordReceipt({ callId, receipt: receipt("failed") });
        return {
          content: [{ type: "text", text: "外部工具调用未完成。" }],
          details: { error: "EXTERNAL_TOOL_FAILED" },
        };
      }
    },
  };
}

export function validateExternalToolArguments(
  tool: ExternalToolVersion,
  value: unknown,
): value is Record<string, unknown> {
  return Value.Check(toTypeBox(tool.inputSchema as Record<string, unknown>), value);
}
function decodeUtf8Prefix(bytes: Uint8Array, maxBytes: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = Math.min(maxBytes, bytes.byteLength); end >= 0; end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // 截断点落在多字节字符中时向前回退，保证最终编码字节数也不越界。
    }
  }
  return "";
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("EXTERNAL_TOOL_ARGUMENTS_INVALID");
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("EXTERNAL_TOOL_ARGUMENTS_INVALID");
}
