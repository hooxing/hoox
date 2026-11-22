import { createHash } from "node:crypto";
import type { TraceBlobPersistencePort } from "@hoox/context-policy";
import type { Pool } from "pg";
import type { BlobStore, StableBlobGcPort, StableBlobRef } from "./blob-store.js";
import { PersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";

export const RUN_TRAJECTORY_PAGE_BYTE_BUDGET = 2 * 1024 * 1024;
const RUN_TRAJECTORY_READ_CONCURRENCY = 4;

export interface RunTrajectoryEventInput {
  readonly context: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly agentThreadId?: string;
    readonly agentTurnId?: string;
  };
  readonly event: {
    readonly schemaVersion: 1;
    readonly sequence: number;
    readonly occurredAt: string;
    readonly monotonicOffsetMs: number;
    readonly source: "pi" | "runtime";
    readonly type: string;
    readonly event: unknown;
  };
}

export interface RunTrajectoryPageInput {
  readonly actorUserId: string;
  readonly auditId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly limit: number;
  readonly afterCursor?: Readonly<{
    occurredAt: string;
    agentThreadId: string;
    agentTurnId: string;
    sequence: number;
  }>;
}

export interface CancellableTraceBlobPersistencePort extends TraceBlobPersistencePort {
  persistTraceCancellable?(
    input: Parameters<TraceBlobPersistencePort["persistTrace"]>[0] & {
      readonly signal?: AbortSignal;
    },
  ): ReturnType<TraceBlobPersistencePort["persistTrace"]>;
}

export interface RunTrajectoryRetentionRecoveryPort {
  recoverForRetention(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly sha256: string;
    readonly size: number;
  }): Promise<"completed" | "abandoned" | "deferred" | "retry" | "conflict">;
}

export async function listRunTrajectoryCleanupTenants(
  cleanupDirectoryPool: Pool,
): Promise<readonly string[]> {
  const result = await cleanupDirectoryPool.query<{ readonly tenant_id: string }>(
    "SELECT tenant_id FROM run_trajectory_cleanup_tenants ORDER BY tenant_id",
  );
  return Object.freeze(result.rows.map((row) => row.tenant_id));
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
interface StoredTrajectoryEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly monotonicOffsetMs: number;
  readonly source: "pi" | "runtime";
  readonly type: string;
  readonly event: JsonValue;
}

function isTrajectoryValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isTrajectoryValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isTrajectoryValue);
}

function parseTrajectoryEvent(value: unknown): StoredTrajectoryEvent {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value && value.schemaVersion === 1) ||
    !("sequence" in value && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0) ||
    !("occurredAt" in value && typeof value.occurredAt === "string") ||
    !(
      "monotonicOffsetMs" in value &&
      typeof value.monotonicOffsetMs === "number" &&
      Number.isFinite(value.monotonicOffsetMs)
    ) ||
    !("source" in value && (value.source === "pi" || value.source === "runtime")) ||
    !("type" in value && typeof value.type === "string") ||
    !("event" in value && isTrajectoryValue(value.event))
  )
    throw new PersistenceError("CONSTRAINT_VIOLATION", "运行轨迹对象格式无效");
  return value as StoredTrajectoryEvent;
}

interface ExpiredTrajectoryRow {
  readonly tenant_id: string;
  readonly attempt_id: string;
  readonly agent_thread_id: string;
  readonly agent_turn_id: string;
  readonly sequence: string;
  readonly blob_reference_id: string | null;
  readonly persistence_status: "pending" | "stored" | "unavailable";
  readonly blob_operation_id: string;
  readonly sha256: string;
  readonly size: string;
  readonly blob_media_type: string | null;
  readonly incarnation_id: string | null;
  readonly physical_object_key: string | null;
}

export class PgRunTrajectoryStore {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
    private readonly traceBlobs: CancellableTraceBlobPersistencePort | undefined,
    private readonly retentionDays = 30,
    private readonly gc?: StableBlobGcPort,
    private readonly retentionRecovery?: RunTrajectoryRetentionRecoveryPort,
  ) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
      throw new TypeError("运行轨迹保留天数无效");
    }
  }

  async persist(
    input: RunTrajectoryEventInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (options?.signal?.aborted) return;
    const { context, event } = input;
    const body = Buffer.from(JSON.stringify(event), "utf8");
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (this.traceBlobs === undefined)
      throw new PersistenceError("UNAVAILABLE", "轨迹写入端口未装配");
    if ((context.agentThreadId === undefined) !== (context.agentTurnId === undefined)) {
      throw new PersistenceError("CONSTRAINT_VIOLATION", "运行轨迹子 Agent Session 身份不完整");
    }
    const agentThreadId = context.agentThreadId ?? "";
    const agentTurnId = context.agentTurnId ?? "";
    const sessionEventDigest = createHash("sha256")
      .update(
        JSON.stringify([context.attemptId, agentThreadId, agentTurnId, event.sequence]),
        "utf8",
      )
      .digest("hex");
    const idempotencyKey = `run-trajectory:${sessionEventDigest}`;
    const blobOperationId = `trace-${createHash("sha256").update(idempotencyKey).digest("hex")}`;
    await withTenantTransaction(this.pool, { tenantId: context.tenantId }, async (client) => {
      const inserted = await client.query(
        `INSERT INTO run_trajectory_entries(
           tenant_id,thread_id,run_id,attempt_id,agent_thread_id,agent_turn_id,sequence,source,event_type,occurred_at,
           monotonic_offset_ms,sha256,size,persistence_status,blob_operation_id,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,
           clock_timestamp()+make_interval(days=>$15::integer))
         ON CONFLICT(tenant_id,attempt_id,agent_thread_id,agent_turn_id,sequence) DO UPDATE
           SET persistence_status='pending',updated_at=clock_timestamp()
         WHERE run_trajectory_entries.sha256=EXCLUDED.sha256
           AND run_trajectory_entries.persistence_status <> 'stored'`,
        [
          context.tenantId,
          context.threadId,
          context.runId,
          context.attemptId,
          agentThreadId,
          agentTurnId,
          event.sequence,
          event.source,
          event.type,
          event.occurredAt,
          event.monotonicOffsetMs,
          sha256,
          body.byteLength,
          blobOperationId,
          this.retentionDays,
        ],
      );
      if (inserted.rowCount !== 1) {
        const existing = await client.query<{ readonly sha256: string }>(
          `SELECT sha256 FROM run_trajectory_entries
            WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND agent_turn_id=$4 AND sequence=$5`,
          [context.tenantId, context.attemptId, agentThreadId, agentTurnId, event.sequence],
        );
        if (existing.rows[0]?.sha256 !== sha256) {
          throw new PersistenceError("CONFLICT", "运行轨迹事件幂等键冲突");
        }
      }
    });

    const traceInput = {
      tenantId: context.tenantId,
      idempotencyKey,
      body,
      sha256,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    };
    const result =
      this.traceBlobs.persistTraceCancellable === undefined
        ? await this.traceBlobs.persistTrace(traceInput)
        : await this.traceBlobs.persistTraceCancellable(traceInput);
    if (result.outcome !== "persisted" && result.outcome !== "replayed") {
      // 端口失败（含取消）并不证明 Blob 已终结；只有恢复端能决定是否可以删除锚点。
      throw new PersistenceError("UNAVAILABLE", "运行轨迹对象写入失败");
    }
    if (result.blob.size !== body.byteLength || result.blob.sha256 !== sha256) {
      throw new PersistenceError("CONSTRAINT_VIOLATION", "运行轨迹对象身份不匹配");
    }
    await withTenantTransaction(this.pool, { tenantId: context.tenantId }, async (client) => {
      const updated = await client.query(
        `UPDATE run_trajectory_entries entry
            SET persistence_status='stored',blob_reference_id=$7,updated_at=clock_timestamp()
           FROM blob_references reference
          WHERE entry.tenant_id=$1 AND entry.attempt_id=$2 AND entry.agent_thread_id=$3 AND entry.agent_turn_id=$4 AND entry.sequence=$5
            AND entry.sha256=$6 AND reference.tenant_id=$1
            AND reference.reference_id=$7 AND reference.state='stable'
            AND reference.purpose='trace' AND reference.operation_id=$8`,
        [
          context.tenantId,
          context.attemptId,
          agentThreadId,
          agentTurnId,
          event.sequence,
          sha256,
          result.referenceId,
          blobOperationId,
        ],
      );
      if (updated.rowCount !== 1) throw new PersistenceError("CONFLICT", "运行轨迹索引提交冲突");
    });
  }

  async readPage(input: RunTrajectoryPageInput) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError("运行轨迹分页大小无效");
    }
    const rows = await this.pool.connect();
    const page = await (async () => {
      try {
        await rows.query("BEGIN");
        await rows.query("SELECT set_config('app.user_id',$1,true)", [input.actorUserId]);
        await rows.query(
          `INSERT INTO admin_run_content_access_audits(audit_id,actor_user_id,tenant_id,run_id,attempt_id,query_summary)
           VALUES($1,$2,$3,$4,$5,'{"type":"run_trajectory_page"}'::jsonb)`,
          [input.auditId, input.actorUserId, input.tenantId, input.runId, input.attemptId],
        );
        await rows.query("SELECT set_config('app.run_content_audit_id',$1,true)", [input.auditId]);
        const result = await rows.query(
          `SELECT sequence,agent_thread_id,agent_turn_id,source,event_type,occurred_at,monotonic_offset_ms,sha256,size,blob_media_type,
                  blob_reference_id,blob_purpose,blob_state,lifecycle_id,incarnation_id,physical_object_key
             FROM admin_run_trajectory_directory
            WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3
              AND ($4::timestamptz IS NULL OR
                (occurred_at,agent_thread_id,agent_turn_id,sequence)>($4::timestamptz,$5::text,$6::text,$7::bigint))
            ORDER BY occurred_at,agent_thread_id,agent_turn_id,sequence LIMIT $8`,
          [
            input.tenantId,
            input.runId,
            input.attemptId,
            input.afterCursor?.occurredAt ?? null,
            input.afterCursor?.agentThreadId ?? "",
            input.afterCursor?.agentTurnId ?? "",
            input.afterCursor?.sequence ?? 0,
            input.limit + 1,
          ],
        );
        await rows.query("COMMIT");
        return result.rows;
      } catch (error) {
        await rows.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        rows.release();
      }
    })();
    let selectedBytes = 0;
    let byteLimited = false;
    const selected = [] as typeof page;
    for (const row of page.slice(0, input.limit)) {
      const rowBytes = Number(row.size);
      if (selected.length > 0 && selectedBytes + rowBytes > RUN_TRAJECTORY_PAGE_BYTE_BUDGET) {
        byteLimited = true;
        break;
      }
      selected.push(row);
      selectedBytes += rowBytes;
      if (rowBytes > RUN_TRAJECTORY_PAGE_BYTE_BUDGET) {
        byteLimited = true;
        break;
      }
    }
    const hasMore = byteLimited || page.length > selected.length;
    const records: (StoredTrajectoryEvent & {
      readonly agentThreadId: string;
      readonly agentTurnId: string;
      readonly storedAt: string;
      readonly truncated?: boolean;
    })[] = [];
    for (let offset = 0; offset < selected.length; offset += RUN_TRAJECTORY_READ_CONCURRENCY) {
      const batch = selected.slice(offset, offset + RUN_TRAJECTORY_READ_CONCURRENCY);
      const loaded = await Promise.all(
        batch.map(async (row) => {
          if (Number(row.size) > RUN_TRAJECTORY_PAGE_BYTE_BUDGET) {
            return Object.freeze({
              schemaVersion: 1 as const,
              sequence: Number(row.sequence),
              occurredAt: new Date(row.occurred_at as Date).toISOString(),
              monotonicOffsetMs: Number(row.monotonic_offset_ms),
              source: row.source as "pi" | "runtime",
              type: String(row.event_type),
              event: { $cubeInternalType: "truncated", originalSize: Number(row.size) },
              agentThreadId: String(row.agent_thread_id),
              agentTurnId: String(row.agent_turn_id),
              storedAt: new Date(row.occurred_at as Date).toISOString(),
              truncated: true,
            });
          }
          const blob: StableBlobRef = {
            kind: "stable",
            tenantId: input.tenantId,
            purpose: "trace",
            sha256: String(row.sha256),
            size: Number(row.size),
            mediaType: String(row.blob_media_type),
            incarnationId: String(row.incarnation_id),
            physicalObjectKey: String(row.physical_object_key),
          };
          const body = await this.blobs.getBytes({ tenantId: input.tenantId }, blob);
          const event = parseTrajectoryEvent(
            JSON.parse(Buffer.from(body).toString("utf8")) as unknown,
          );
          return Object.freeze({
            ...event,
            agentThreadId: String(row.agent_thread_id),
            agentTurnId: String(row.agent_turn_id),
            storedAt: new Date(row.occurred_at as Date).toISOString(),
          });
        }),
      );
      records.push(...loaded);
    }
    const last = selected.at(-1);
    return Object.freeze({
      records: Object.freeze(records),
      bytes: selected.reduce(
        (total, row) =>
          total + (Number(row.size) > RUN_TRAJECTORY_PAGE_BYTE_BUDGET ? 0 : Number(row.size)),
        0,
      ),
      hasMore,
      ...(hasMore && last !== undefined
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                occurredAt: new Date(last.occurred_at as Date).toISOString(),
                agentThreadId: String(last.agent_thread_id),
                agentTurnId: String(last.agent_turn_id),
                sequence: Number(last.sequence),
              }),
            ).toString("base64url"),
          }
        : {}),
    });
  }

  async cleanupExpired(tenantId: string, limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("运行轨迹清理批次大小无效");
    }
    const expired = await withTenantTransaction(this.pool, { tenantId }, async (client) => {
      const result = await client.query<ExpiredTrajectoryRow>(
        `SELECT entry.tenant_id,entry.attempt_id,entry.agent_thread_id,entry.agent_turn_id,entry.sequence::text,
                entry.blob_reference_id,
                entry.persistence_status,entry.blob_operation_id,entry.sha256,entry.size::text,
                reference.media_type AS blob_media_type,reference.incarnation_id::text,
                reference.physical_object_key
           FROM run_trajectory_entries entry
           LEFT JOIN blob_references reference
             ON reference.tenant_id=entry.tenant_id
            AND reference.reference_id=entry.blob_reference_id
          WHERE entry.tenant_id=$1 AND GREATEST(entry.expires_at,entry.updated_at)<=statement_timestamp()
          ORDER BY GREATEST(entry.expires_at,entry.updated_at),entry.attempt_id,entry.agent_thread_id,entry.agent_turn_id,entry.sequence
          LIMIT $2 FOR UPDATE OF entry SKIP LOCKED`,
        [tenantId, limit],
      );
      return result.rows;
    });
    let removed = 0;
    for (const row of expired) {
      const entryKey = [
        tenantId,
        row.attempt_id,
        row.agent_thread_id,
        row.agent_turn_id,
        row.sequence,
      ];
      let count = 0;
      try {
        count = await this.cleanupExpiredRow(tenantId, row, entryKey);
        removed += count;
      } finally {
        if (count === 0) {
          // 永久在途或暂时失败的提交仍保留锚点，但不能一直占据下一批的队首。
          await withTenantTransaction(this.pool, { tenantId }, async (client) => {
            await client.query(
              `UPDATE run_trajectory_entries SET updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND agent_turn_id=$4 AND sequence=$5`,
              entryKey,
            );
          });
        }
      }
    }
    return removed;
  }

  private async cleanupExpiredRow(
    tenantId: string,
    row: ExpiredTrajectoryRow,
    entryKey: string[],
  ): Promise<number> {
    type Reference = Pick<
      typeof row,
      "blob_reference_id" | "blob_media_type" | "incarnation_id" | "physical_object_key"
    >;
    let reference: Reference = row;
    if (row.persistence_status !== "stored") {
      if (this.retentionRecovery === undefined) return 0;
      const recovered = await this.retentionRecovery.recoverForRetention({
        tenantId,
        operationId: row.blob_operation_id,
        sha256: row.sha256,
        size: Number(row.size),
      });
      if (recovered === "deferred" || recovered === "retry" || recovered === "conflict") return 0;
      if (recovered === "completed") {
        const bound = await withTenantTransaction(this.pool, { tenantId }, async (client) => {
          const result = await client.query<Reference>(
            `UPDATE run_trajectory_entries entry
                  SET persistence_status='stored',blob_reference_id=reference.reference_id,
                      updated_at=clock_timestamp()
                 FROM blob_references reference
                WHERE entry.tenant_id=$1 AND entry.attempt_id=$2 AND entry.agent_thread_id=$3 AND entry.agent_turn_id=$4
                  AND entry.sequence=$5 AND entry.persistence_status<>'stored'
                  AND reference.tenant_id=entry.tenant_id
                  AND reference.operation_id=entry.blob_operation_id
                  AND reference.state='stable' AND reference.purpose='trace'
              RETURNING reference.reference_id AS blob_reference_id, reference.media_type AS blob_media_type,
                        reference.incarnation_id::text, reference.physical_object_key`,
            entryKey,
          );
          return result.rows[0];
        });
        if (bound === undefined) return 0;
        reference = bound;
      }
    }
    if (reference.blob_reference_id !== null) {
      if (
        this.gc === undefined ||
        reference.blob_media_type === null ||
        reference.incarnation_id === null ||
        reference.physical_object_key === null
      ) {
        throw new PersistenceError("UNAVAILABLE", "运行轨迹对象清理未装配");
      }
      await withTenantTransaction(this.pool, { tenantId }, async (client) => {
        await client.query(
          `UPDATE blob_references SET state='released',updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND reference_id=$2 AND state='stable'`,
          [tenantId, reference.blob_reference_id],
        );
      });
      const outcome = await this.gc.collectIfUnreachable(
        { tenantId },
        {
          kind: "stable",
          tenantId,
          purpose: "trace",
          sha256: row.sha256,
          size: Number(row.size),
          mediaType: reference.blob_media_type,
          incarnationId: reference.incarnation_id,
          physicalObjectKey: reference.physical_object_key,
        },
      );
      if (outcome === "in_progress") return 0;
    }
    return await withTenantTransaction(this.pool, { tenantId }, async (client) => {
      const result = await client.query(
        `DELETE FROM run_trajectory_entries
            WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND agent_turn_id=$4 AND sequence=$5
              AND expires_at<=clock_timestamp() AND blob_reference_id IS NOT DISTINCT FROM $6`,
        [...entryKey, reference.blob_reference_id],
      );
      return result.rowCount ?? 0;
    });
  }
}
