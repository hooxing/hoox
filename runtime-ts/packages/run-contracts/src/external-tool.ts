import type { ExternalToolVersion, Sha256Digest } from "@hoox/domain";

export interface ValidatedExternalTarget {
  readonly url: URL;
  readonly hostname: string;
  readonly servername: string;
  readonly hostHeader: string;
  /** 唯一允许用于 TCP 连接的、已完成策略校验的地址。 */
  readonly address: string;
  readonly addresses: readonly string[];
}

export type ExternalToolFailureDisposition = "not_sent" | "responded_failure";

/** 可安全归一化的失败明确排除结果未知；其余传输异常由调用方按 UNKNOWN 处理。 */
export class ExternalToolTransportError extends Error {
  override readonly name = "ExternalToolTransportError";
  constructor(
    readonly disposition: ExternalToolFailureDisposition,
    readonly safeCode: "EXTERNAL_TOOL_UNAVAILABLE" | "EXTERNAL_TOOL_REJECTED",
  ) {
    super(safeCode);
  }
}

export interface ExternalToolCallContext {
  readonly tenantId: string;
  readonly endUserId?: string;
  readonly threadId: string;
  readonly runId: string;
}

/** 由 MCP/HTTP 传输实现；不得重试，未分类异常交回恢复协议。 */
export interface ExternalToolTransport {
  invoke(input: {
    readonly tool: ExternalToolVersion;
    readonly target: ValidatedExternalTarget;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly callContext: ExternalToolCallContext;
    readonly credential?: string;
    readonly idempotencyKey: string;
    readonly method?: "GET" | "POST";
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
    readonly redirect: "error";
    readonly signal?: AbortSignal;
  }): Promise<{ readonly body: Uint8Array; readonly contentType: string }>;
}

export interface ExternalToolRuntimeSnapshot {
  readonly tool: ExternalToolVersion;
  /** 只供传输适配器使用，禁止投影到日志、事件或模型结果。 */
  readonly credential?: string;
}

/** 快照接入前只允许假实现；生产实现须按 RunAgentSnapshot 限定版本并处理密文。 */
export interface ExternalToolSnapshotReader {
  read(input: {
    readonly runId: string;
    readonly toolVersionIds: readonly string[];
  }): Promise<readonly ExternalToolRuntimeSnapshot[]>;
}

export interface ExternalToolReconciliationFacts {
  readonly toolVersionId: string;
  readonly argsDigest: Sha256Digest;
  readonly idempotencyKey: string;
  readonly idempotent: boolean;
}

export interface ExternalToolReconciliationPort {
  authorizeRetry(
    input: ExternalToolReconciliationFacts,
  ): Promise<"authorized" | "unknown" | "mismatch" | "not_idempotent">;
}

export const fakeExternalToolSnapshotReader: ExternalToolSnapshotReader = {
  async read() {
    return [];
  },
};

export interface ExternalToolUnknownCallReader {
  readUnknownCall(callId: string): Promise<ExternalToolReconciliationFacts | undefined>;
}

/** 将显式对账输入与 durable 原调用事实逐字段比较；不相符时绝不签发重试授权。 */
export async function validateExternalToolRetry(input: {
  readonly callId: string;
  readonly requested: ExternalToolReconciliationFacts;
  readonly reader: ExternalToolUnknownCallReader;
}): Promise<"authorized" | "unknown" | "mismatch" | "not_idempotent"> {
  const persisted = await input.reader.readUnknownCall(input.callId);
  if (!persisted) return "unknown";
  if (!persisted.idempotent || !input.requested.idempotent) return "not_idempotent";
  return persisted.toolVersionId === input.requested.toolVersionId &&
    persisted.argsDigest === input.requested.argsDigest &&
    persisted.idempotencyKey === input.requested.idempotencyKey
    ? "authorized"
    : "mismatch";
}
