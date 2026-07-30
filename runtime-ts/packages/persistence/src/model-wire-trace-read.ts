import { PersistenceError } from "./errors.js";
import type { StableBlobRef } from "./blob-store.js";
import { withTenantTransaction, type Pool } from "./postgres.js";
import type { TenantScope } from "./ports.js";

export type ModelWireTracePart = "request" | "response";
export type ModelWireTraceCaptureStatus = "complete" | "truncated" | "aborted" | "failed";
export type ModelWireTracePersistenceStatus =
  | "pending"
  | "stored"
  | "unknown"
  | "conflict"
  | "unavailable"
  | "not_captured";

export interface ModelWireTraceMetadata {
  readonly attemptId: string;
  readonly modelTurn: number;
  readonly transportAttempt: number;
  readonly part: ModelWireTracePart;
  readonly captureStatus: ModelWireTraceCaptureStatus;
  readonly persistenceStatus: ModelWireTracePersistenceStatus;
  readonly captureErrorCode?: "CAPTURE_UNAVAILABLE" | "BODY_UNREADABLE";
  readonly httpStatus?: number;
  readonly sha256?: string;
  readonly size?: number;
  readonly bodyAvailable: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ModelWireTraceBody {
  readonly metadata: ModelWireTraceMetadata;
  readonly blob: StableBlobRef;
}

export type ModelWireTraceCursor = Pick<
  ModelWireTraceMetadata,
  "createdAt" | "attemptId" | "modelTurn" | "transportAttempt" | "part"
>;

export interface ModelWireTraceReadPort {
  list(input: {
    readonly scope: TenantScope;
    readonly threadId: string;
    readonly runId: string;
    readonly limit: number;
    readonly after?: ModelWireTraceCursor;
  }): Promise<
    | {
        readonly outcome: "found";
        readonly records: readonly ModelWireTraceMetadata[];
        readonly hasMore: boolean;
        readonly nextCursor?: ModelWireTraceCursor;
      }
    | { readonly outcome: "not_found" }
  >;
  getBody(input: {
    readonly scope: TenantScope;
    readonly threadId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly modelTurn: number;
    readonly transportAttempt: number;
    readonly part: ModelWireTracePart;
  }): Promise<
    | { readonly outcome: "found"; readonly body: ModelWireTraceBody }
    | { readonly outcome: "not_found" }
  >;
}

interface TraceRow {
  readonly attempt_id: string;
  readonly model_turn: string | number;
  readonly transport_attempt: string | number;
  readonly part: string;
  readonly capture_status: string;
  readonly persistence_status: string;
  readonly capture_error_code: string | null;
  readonly http_status: number | null;
  readonly sha256: string | null;
  readonly size: string | number | null;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly body_available: boolean;
  readonly blob_media_type?: string | null;
  readonly blob_incarnation_id?: string | null;
  readonly blob_physical_object_key?: string | null;
}

const captureStatuses = new Set<ModelWireTraceCaptureStatus>([
  "complete",
  "truncated",
  "aborted",
  "failed",
]);
const persistenceStatuses = new Set<ModelWireTracePersistenceStatus>([
  "pending",
  "stored",
  "unknown",
  "conflict",
  "unavailable",
  "not_captured",
]);
const parts = new Set<ModelWireTracePart>(["request", "response"]);
const sha256Pattern = /^[a-f0-9]{64}$/u;

function safeInteger(value: string | number, name: string): number {
  const converted = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error(`${name} 不是安全非负整数`);
  }
  return converted;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("模型网络诊断时间无效");
  return date.toISOString();
}

/** 数据库行先经严格形状校验，异常事实不得被宽松投影成可下载正文。 */
export function mapModelWireTraceRow(row: TraceRow): ModelWireTraceMetadata {
  if (!parts.has(row.part as ModelWireTracePart)) throw new Error("模型网络诊断 part 无效");
  if (!captureStatuses.has(row.capture_status as ModelWireTraceCaptureStatus)) {
    throw new Error("模型网络诊断 capture status 无效");
  }
  if (!persistenceStatuses.has(row.persistence_status as ModelWireTracePersistenceStatus)) {
    throw new Error("模型网络诊断 persistence status 无效");
  }
  const size = row.size === null ? undefined : safeInteger(row.size, "模型网络诊断 size");
  const sha256 = row.sha256 === null ? undefined : row.sha256;
  if (sha256 !== undefined && !sha256Pattern.test(sha256)) {
    throw new Error("模型网络诊断 SHA-256 无效");
  }
  if (
    row.http_status !== null &&
    (!Number.isInteger(row.http_status) || row.http_status < 100 || row.http_status > 599)
  ) {
    throw new Error("模型网络诊断 HTTP status 无效");
  }
  if (
    row.capture_error_code !== null &&
    row.capture_error_code !== "CAPTURE_UNAVAILABLE" &&
    row.capture_error_code !== "BODY_UNREADABLE"
  ) {
    throw new Error("模型网络诊断 capture error code 无效");
  }
  return Object.freeze({
    attemptId: row.attempt_id,
    modelTurn: safeInteger(row.model_turn, "model turn"),
    transportAttempt: safeInteger(row.transport_attempt, "transport attempt"),
    part: row.part as ModelWireTracePart,
    captureStatus: row.capture_status as ModelWireTraceCaptureStatus,
    persistenceStatus: row.persistence_status as ModelWireTracePersistenceStatus,
    ...(row.capture_error_code === null ? {} : { captureErrorCode: row.capture_error_code }),
    ...(row.http_status === null ? {} : { httpStatus: row.http_status }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(size === undefined ? {} : { size }),
    bodyAvailable: row.body_available,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  });
}

const authorizedRun = `SELECT run.id
  FROM runs AS run
  JOIN memberships AS membership
    ON membership.tenant_id = run.tenant_id
   AND membership.user_id = $2
   AND membership.status = 'active'
 WHERE run.tenant_id = $1 AND run.thread_id = $3 AND run.id = $4`;

const bodyShape = `record.persistence_status = 'stored'
  AND record.expires_at > clock_timestamp()
  AND record.blob_state = 'stable'
  AND record.blob_purpose = 'trace'
  AND reference.state = 'stable'
  AND reference.purpose = 'trace'
  AND reference.operation_id = record.blob_operation_id
  AND reference.sha256 = record.sha256
  AND reference.size = record.size
  AND reference.lifecycle_id = record.blob_lifecycle_id
  AND reference.incarnation_id = record.blob_incarnation_id
  AND reference.physical_object_key = record.physical_object_key
  AND lifecycle.state = 'active'
  AND lifecycle.purpose = 'trace'
  AND lifecycle.sha256 = record.sha256
  AND lifecycle.size = record.size
  AND lifecycle.current_incarnation_id = record.blob_incarnation_id
  AND incarnation.state = 'active'
  AND incarnation.purpose = 'trace'
  AND incarnation.sha256 = record.sha256
  AND incarnation.size = record.size
  AND incarnation.incarnation_id = record.blob_incarnation_id
  AND incarnation.physical_object_key = record.physical_object_key`;

const joins = `LEFT JOIN blob_references AS reference
    ON reference.tenant_id = record.tenant_id
   AND reference.reference_id = record.blob_reference_id
  LEFT JOIN blob_lifecycles AS lifecycle
    ON lifecycle.tenant_id = reference.tenant_id
   AND lifecycle.lifecycle_id = reference.lifecycle_id
  LEFT JOIN blob_incarnations AS incarnation
    ON incarnation.tenant_id = reference.tenant_id
   AND incarnation.lifecycle_id = reference.lifecycle_id
   AND incarnation.incarnation_id = reference.incarnation_id`;

function selectColumns(includeBlob: boolean): string {
  return `record.attempt_id, record.model_turn, record.transport_attempt, record.part,
          record.capture_status, record.persistence_status, record.capture_error_code, record.http_status,
          record.sha256, record.size, record.created_at, record.expires_at,
          (${bodyShape}) AS body_available${
            includeBlob
              ? ", reference.media_type AS blob_media_type, reference.incarnation_id AS blob_incarnation_id, reference.physical_object_key AS blob_physical_object_key"
              : ""
          }`;
}

/**
 * API 专用只读投影。Membership、Run/Thread 归属、未过期索引与 stable trace Blob 的完整
 * 身份在同一个 REPEATABLE READ 快照中验证；任一事实缺失均失败关闭为 not_found。
 */
export class PgModelWireTraceReadRepository implements ModelWireTraceReadPort {
  constructor(private readonly pool: Pool) {}

  async list(input: Parameters<ModelWireTraceReadPort["list"]>[0]) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new TypeError("模型网络诊断分页大小无效");
    }
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const run = await client.query(authorizedRun, [
            input.scope.tenantId,
            input.scope.userId,
            input.threadId,
            input.runId,
          ]);
          if (run.rowCount !== 1) return { outcome: "not_found" } as const;
          const records = await client.query<TraceRow>(
            `SELECT ${selectColumns(false)}
               FROM model_wire_trace_records AS record
               ${joins}
              WHERE record.tenant_id = $1 AND record.thread_id = $2 AND record.run_id = $3
                AND record.expires_at > clock_timestamp()
                AND (
                  $4::timestamptz IS NULL OR
                  (record.created_at, record.attempt_id, record.model_turn,
                   record.transport_attempt, record.part) >
                  ($4::timestamptz, $5::text, $6::bigint, $7::bigint, $8::text)
                )
              ORDER BY record.created_at ASC, record.attempt_id ASC, record.model_turn ASC,
                       record.transport_attempt ASC, record.part ASC
              LIMIT $9`,
            [
              input.scope.tenantId,
              input.threadId,
              input.runId,
              input.after?.createdAt ?? null,
              input.after?.attemptId ?? "",
              input.after?.modelTurn ?? 0,
              input.after?.transportAttempt ?? 0,
              input.after?.part ?? "request",
              input.limit + 1,
            ],
          );
          const hasMore = records.rows.length > input.limit;
          const mapped = Object.freeze(
            records.rows.slice(0, input.limit).map(mapModelWireTraceRow),
          );
          const last = mapped.at(-1);
          return {
            outcome: "found" as const,
            records: mapped,
            hasMore,
            ...(hasMore && last !== undefined
              ? {
                  nextCursor: Object.freeze({
                    createdAt: last.createdAt,
                    attemptId: last.attemptId,
                    modelTurn: last.modelTurn,
                    transportAttempt: last.transportAttempt,
                    part: last.part,
                  }),
                }
              : {}),
          };
        },
        { readOnly: true, isolationLevel: "REPEATABLE READ" },
      );
    } catch {
      throw new PersistenceError("UNAVAILABLE", "读取模型网络诊断索引暂时不可用");
    }
  }

  async getBody(input: Parameters<ModelWireTraceReadPort["getBody"]>[0]) {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const result = await client.query<TraceRow>(
            `WITH authorized_run AS (${authorizedRun})
             SELECT ${selectColumns(true)}
               FROM authorized_run
               JOIN model_wire_trace_records AS record
                 ON record.tenant_id = $1 AND record.thread_id = $3
                AND record.run_id = authorized_run.id
               ${joins}
              WHERE record.attempt_id = $5 AND record.model_turn = $6
                AND record.transport_attempt = $7 AND record.part = $8
                AND ${bodyShape}`,
            [
              input.scope.tenantId,
              input.scope.userId,
              input.threadId,
              input.runId,
              input.attemptId,
              input.modelTurn,
              input.transportAttempt,
              input.part,
            ],
          );
          const row = result.rows[0];
          if (
            row === undefined ||
            row.blob_media_type === null ||
            row.blob_media_type === undefined ||
            row.blob_incarnation_id === null ||
            row.blob_incarnation_id === undefined ||
            row.blob_physical_object_key === null ||
            row.blob_physical_object_key === undefined
          ) {
            return { outcome: "not_found" } as const;
          }
          const metadata = mapModelWireTraceRow(row);
          if (
            !metadata.bodyAvailable ||
            metadata.sha256 === undefined ||
            metadata.size === undefined
          ) {
            return { outcome: "not_found" } as const;
          }
          return {
            outcome: "found" as const,
            body: Object.freeze({
              metadata,
              blob: Object.freeze({
                kind: "stable" as const,
                tenantId: input.scope.tenantId,
                purpose: "trace" as const,
                sha256: metadata.sha256,
                size: metadata.size,
                mediaType: row.blob_media_type,
                incarnationId: row.blob_incarnation_id,
                physicalObjectKey: row.blob_physical_object_key,
              }),
            }),
          };
        },
        { readOnly: true, isolationLevel: "REPEATABLE READ" },
      );
    } catch {
      throw new PersistenceError("UNAVAILABLE", "读取模型网络诊断正文授权暂时不可用");
    }
  }
}
