import { createHash } from "node:crypto";
import type { TraceBlobPersistencePort } from "@hoox/context-policy";
import type { Pool } from "pg";
import type { BlobStore, StableBlobGcPort, StableBlobRef } from "./blob-store.js";
import { PersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";

export interface RunTrajectoryEventInput {
  readonly context: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly agentThreadId?: string;
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
  readonly afterCursor?: Readonly<{ occurredAt: string; agentThreadId: string; sequence: number }>;
}

export async function listRunTrajectoryCleanupTenants(
  coordinatorPool: Pool,
): Promise<readonly string[]> {
  const result = await coordinatorPool.query<{ readonly tenant_id: string }>(
    "SELECT tenant_id FROM worker_tenant_assignments ORDER BY tenant_id",
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

export class PgRunTrajectoryStore {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
    private readonly traceBlobs: TraceBlobPersistencePort | undefined,
    private readonly retentionDays = 30,
    private readonly gc?: StableBlobGcPort,
  ) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
      throw new TypeError("运行轨迹保留天数无效");
    }
  }

  async persist(input: RunTrajectoryEventInput): Promise<void> {
    const { context, event } = input;
    const body = Buffer.from(JSON.stringify(event), "utf8");
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (this.traceBlobs === undefined)
      throw new PersistenceError("UNAVAILABLE", "轨迹写入端口未装配");
    const agentThreadId = context.agentThreadId ?? "";
    const idempotencyKey = `run-trajectory:${context.attemptId}:${agentThreadId}:${event.sequence}`;
    const blobOperationId = `trace-${createHash("sha256").update(idempotencyKey).digest("hex")}`;
    await withTenantTransaction(this.pool, { tenantId: context.tenantId }, async (client) => {
      const inserted = await client.query(
        `INSERT INTO run_trajectory_entries(
           tenant_id,thread_id,run_id,attempt_id,agent_thread_id,sequence,source,event_type,occurred_at,
           monotonic_offset_ms,sha256,size,persistence_status,blob_operation_id,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,
           clock_timestamp()+make_interval(days=>$14::integer))
         ON CONFLICT(tenant_id,attempt_id,agent_thread_id,sequence) DO UPDATE
           SET persistence_status='pending',updated_at=clock_timestamp()
         WHERE run_trajectory_entries.sha256=EXCLUDED.sha256
           AND run_trajectory_entries.persistence_status <> 'stored'`,
        [
          context.tenantId,
          context.threadId,
          context.runId,
          context.attemptId,
          agentThreadId,
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
            WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND sequence=$4`,
          [context.tenantId, context.attemptId, agentThreadId, event.sequence],
        );
        if (existing.rows[0]?.sha256 !== sha256) {
          throw new PersistenceError("CONFLICT", "运行轨迹事件幂等键冲突");
        }
      }
    });

    const result = await this.traceBlobs.persistTrace({
      tenantId: context.tenantId,
      idempotencyKey,
      body,
      sha256,
    });
    if (result.outcome !== "persisted" && result.outcome !== "replayed") {
      await this.markUnavailable(
        context.tenantId,
        context.attemptId,
        agentThreadId,
        event.sequence,
      );
      throw new PersistenceError("UNAVAILABLE", "运行轨迹对象写入失败");
    }
    if (result.blob.size !== body.byteLength || result.blob.sha256 !== sha256) {
      throw new PersistenceError("CONSTRAINT_VIOLATION", "运行轨迹对象身份不匹配");
    }
    await withTenantTransaction(this.pool, { tenantId: context.tenantId }, async (client) => {
      const updated = await client.query(
        `UPDATE run_trajectory_entries entry
            SET persistence_status='stored',blob_reference_id=$6,updated_at=clock_timestamp()
           FROM blob_references reference
          WHERE entry.tenant_id=$1 AND entry.attempt_id=$2 AND entry.agent_thread_id=$3 AND entry.sequence=$4
            AND entry.sha256=$5 AND reference.tenant_id=$1
            AND reference.reference_id=$6 AND reference.state='stable'
            AND reference.purpose='trace' AND reference.operation_id=$7`,
        [
          context.tenantId,
          context.attemptId,
          agentThreadId,
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
          `SELECT sequence,agent_thread_id,source,event_type,occurred_at,monotonic_offset_ms,sha256,size,blob_media_type,
                  blob_reference_id,blob_purpose,blob_state,lifecycle_id,incarnation_id,physical_object_key
             FROM admin_run_trajectory_directory
            WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3
              AND ($4::timestamptz IS NULL OR
                (occurred_at,agent_thread_id,sequence)>($4::timestamptz,$5::text,$6::bigint))
            ORDER BY occurred_at,agent_thread_id,sequence LIMIT $7`,
          [
            input.tenantId,
            input.runId,
            input.attemptId,
            input.afterCursor?.occurredAt ?? null,
            input.afterCursor?.agentThreadId ?? "",
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
    const hasMore = page.length > input.limit;
    const selected = page.slice(0, input.limit);
    const records = await Promise.all(
      selected.map(async (row) => {
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
          storedAt: new Date(row.occurred_at as Date).toISOString(),
        });
      }),
    );
    const last = selected.at(-1);
    return Object.freeze({
      records: Object.freeze(records),
      bytes: selected.reduce((total, row) => total + Number(row.size), 0),
      hasMore,
      ...(hasMore && last !== undefined
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                occurredAt: new Date(last.occurred_at as Date).toISOString(),
                agentThreadId: String(last.agent_thread_id),
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
      const result = await client.query<{
        readonly tenant_id: string;
        readonly attempt_id: string;
        readonly agent_thread_id: string;
        readonly sequence: string;
        readonly blob_reference_id: string | null;
        readonly sha256: string;
        readonly size: string;
        readonly blob_media_type: string | null;
        readonly incarnation_id: string | null;
        readonly physical_object_key: string | null;
      }>(
        `SELECT entry.tenant_id,entry.attempt_id,entry.agent_thread_id,entry.sequence::text,
                entry.blob_reference_id,entry.sha256,entry.size::text,
                reference.media_type AS blob_media_type,reference.incarnation_id::text,
                reference.physical_object_key
           FROM run_trajectory_entries entry
           LEFT JOIN blob_references reference
             ON reference.tenant_id=entry.tenant_id AND reference.reference_id=entry.blob_reference_id
          WHERE entry.tenant_id=$1 AND entry.expires_at<=clock_timestamp()
          ORDER BY entry.expires_at,entry.attempt_id,entry.agent_thread_id,entry.sequence
          LIMIT $2 FOR UPDATE OF entry SKIP LOCKED`,
        [tenantId, limit],
      );
      const referenceIds = result.rows
        .map((row) => row.blob_reference_id)
        .filter((value): value is string => value !== null);
      if (referenceIds.length > 0) {
        await client.query(
          `UPDATE blob_references SET state='released',updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND reference_id=ANY($2::text[]) AND state='stable'`,
          [tenantId, referenceIds],
        );
      }
      return result.rows;
    });
    let removed = 0;
    for (const row of expired) {
      if (row.blob_reference_id !== null) {
        if (
          this.gc === undefined ||
          row.blob_media_type === null ||
          row.incarnation_id === null ||
          row.physical_object_key === null
        ) {
          throw new PersistenceError("UNAVAILABLE", "运行轨迹对象清理未装配");
        }
        const outcome = await this.gc.collectIfUnreachable(
          { tenantId },
          {
            kind: "stable",
            tenantId,
            purpose: "trace",
            sha256: row.sha256,
            size: Number(row.size),
            mediaType: row.blob_media_type,
            incarnationId: row.incarnation_id,
            physicalObjectKey: row.physical_object_key,
          },
        );
        if (outcome === "in_progress") continue;
      }
      await withTenantTransaction(this.pool, { tenantId }, async (client) => {
        await client.query(
          `DELETE FROM run_trajectory_entries
            WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND sequence=$4
              AND expires_at<=clock_timestamp()`,
          [tenantId, row.attempt_id, row.agent_thread_id, row.sequence],
        );
      });
      removed += 1;
    }
    return removed;
  }

  private async markUnavailable(
    tenantId: string,
    attemptId: string,
    agentThreadId: string,
    sequence: number,
  ): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId }, async (client) => {
      await client.query(
        `UPDATE run_trajectory_entries SET persistence_status='unavailable',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND sequence=$4 AND persistence_status='pending'`,
        [tenantId, attemptId, agentThreadId, sequence],
      );
    });
  }
}
