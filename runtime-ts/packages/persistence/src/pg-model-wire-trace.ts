import type { BlobStore } from "./blob-store.js";
import { withTenantTransaction, type Pool } from "./postgres.js";
import {
  createDurableTraceBlobPersistence,
  type TraceBlobCommitRepository,
} from "./trace-blob-persistence-adapter.js";

interface ModelWireTraceContext {
  readonly tenantId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly attemptId: string;
}

interface ModelWireTracePort {
  persist(input: {
    readonly context: ModelWireTraceContext;
    readonly modelTurn: number;
    readonly transportAttempt: number;
    readonly part: "request" | "response";
    readonly body: Uint8Array;
    readonly sha256: string;
    readonly size: number;
    readonly status: "complete" | "truncated" | "aborted" | "failed";
    readonly httpStatus?: number;
  }): Promise<void>;
  captureFailed(input: {
    readonly context: ModelWireTraceContext;
    readonly modelTurn: number;
    readonly transportAttempt: number;
    readonly part: "request" | "response";
    readonly code: "CAPTURE_UNAVAILABLE" | "BODY_UNREADABLE";
    readonly httpStatus?: number;
  }): Promise<void>;
}

/**
 * 仅 Worker 持有的模型网络诊断索引。正文仍只在 trace Blob 中；该表不保存 Header、URL 查询
 * 或正文副本，普通 Artifact/Resource 查询也没有引用此表。
 */
export class PgModelWireTraceRepository implements ModelWireTracePort {
  constructor(
    private readonly pool: Pool,
    private readonly commits: TraceBlobCommitRepository,
    private readonly blobs: BlobStore,
    private readonly retentionDays: number,
  ) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1)
      throw new TypeError("模型网络诊断保留天数无效");
  }

  async persist(input: Parameters<ModelWireTracePort["persist"]>[0]): Promise<void> {
    const operation = `wire.${input.context.attemptId}.${input.modelTurn}.${input.transportAttempt}.${input.part}`;
    const traces = createDurableTraceBlobPersistence(this.commits, this.blobs);
    const result = await traces.persistTrace({
      tenantId: input.context.tenantId,
      idempotencyKey: operation,
      body: input.body,
      sha256: input.sha256,
    });
    const blob =
      result.outcome === "persisted" || result.outcome === "replayed" ? result : undefined;
    await this.write({
      context: input.context,
      modelTurn: input.modelTurn,
      transportAttempt: input.transportAttempt,
      part: input.part,
      captureStatus: input.status,
      persistenceStatus:
        blob === undefined
          ? result.outcome === "unknown"
            ? "unknown"
            : result.outcome === "conflict"
              ? "conflict"
              : "unavailable"
          : "stored",
      sha256: input.sha256,
      size: input.size,
      ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
      ...(blob === undefined ? {} : { blobReferenceId: blob.referenceId }),
    });
  }

  async captureFailed(input: Parameters<ModelWireTracePort["captureFailed"]>[0]): Promise<void> {
    await this.write({
      context: input.context,
      modelTurn: input.modelTurn,
      transportAttempt: input.transportAttempt,
      part: input.part,
      captureStatus: input.code === "BODY_UNREADABLE" ? "aborted" : "failed",
      persistenceStatus: "not_captured",
      ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    });
  }

  private async write(input: {
    readonly context: Parameters<ModelWireTracePort["persist"]>[0]["context"];
    readonly modelTurn: number;
    readonly transportAttempt: number;
    readonly part: "request" | "response";
    readonly captureStatus: "complete" | "truncated" | "aborted" | "failed";
    readonly persistenceStatus: "stored" | "unknown" | "conflict" | "unavailable" | "not_captured";
    readonly sha256?: string;
    readonly size?: number;
    readonly httpStatus?: number;
    readonly blobReferenceId?: string;
  }): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId: input.context.tenantId }, async (client) => {
      await client.query(
        `INSERT INTO model_wire_trace_records (
           tenant_id, thread_id, run_id, attempt_id, model_turn, transport_attempt, part, capture_status,
           persistence_status, sha256, size, http_status, blob_reference_id, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   clock_timestamp() + make_interval(days => $14::integer))
         ON CONFLICT (tenant_id, attempt_id, model_turn, transport_attempt, part) DO NOTHING`,
        [
          input.context.tenantId,
          input.context.threadId,
          input.context.runId,
          input.context.attemptId,
          input.modelTurn,
          input.transportAttempt,
          input.part,
          input.captureStatus,
          input.persistenceStatus,
          input.sha256 ?? null,
          input.size ?? null,
          input.httpStatus ?? null,
          input.blobReferenceId ?? null,
          this.retentionDays,
        ],
      );
    });
  }
}
