import type { ExternalToolVersion, Sha256Digest } from "@hoox/domain";

export type ExternalToolCallPhase = "preflight" | "request_written" | "response_received";

/** Transport 仅可标注已证明尚未写出的失败；其他异常一律按结果未知处理。 */
export class ExternalToolTransportError extends Error {
  override readonly name = "ExternalToolTransportError";
  constructor(
    readonly phase: "preflight",
    readonly safeCode: "EXTERNAL_TOOL_UNAVAILABLE" | "EXTERNAL_TOOL_REJECTED",
  ) {
    super(safeCode);
  }
}

/** 由 B2/B3 提供；传输实现不得自行重试，结果未知交回恢复协议。 */
export interface ExternalToolTransport {
  invoke(input: {
    readonly tool: ExternalToolVersion;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly credential?: string;
    readonly idempotencyKey: string;
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
