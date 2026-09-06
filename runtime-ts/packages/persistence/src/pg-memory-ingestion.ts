import { randomUUID } from "node:crypto";
import { sha256Digest } from "@hoox/domain";
import type {
  MemoryConversationMessage,
  MemoryIngestionClaim,
  MemoryIngestionStore,
  MemoryProviderErrorCode,
  MemorySubmission,
} from "@hoox/memory";
import type { ThreadContextBodyV1 } from "@hoox/run-contracts";
import type { Pool, PoolClient } from "pg";
import type { BlobStore } from "./blob-store.js";
import { mapPersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";
import { readThreadContextBody } from "./thread-context.js";
import { scheduleWorkerTenant } from "./pg-worker-tenant-assignment.js";

interface ClaimedMemoryRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly attempt_id: string;
  readonly subject_user_id: string;
  readonly tenant_kind: "personal" | "team";
  readonly source_through_sequence: string;
  readonly provider_event_id: string | null;
  readonly claim_generation: string;
  readonly attempt_count: number;
}

interface MemoryContextRow {
  readonly sequence: string;
  readonly kind: "user_message" | "assistant_message";
  readonly body_inline: Record<string, unknown> | string | null;
  readonly body_reference_id: string | null;
  readonly body_sha256: string;
  readonly body_size: string;
  readonly body_incarnation_id: string | null;
  readonly body_physical_object_key: string | null;
}

export async function enqueueMemoryIngestion(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly sourceThroughSequence: number;
  },
): Promise<void> {
  if (!Number.isSafeInteger(input.sourceThroughSequence) || input.sourceThroughSequence < 1) {
    throw new TypeError("记忆来源 sequence 无效");
  }
  const inserted = await client.query(
    `INSERT INTO memory_ingestion_outbox(
       tenant_id,run_id,thread_id,attempt_id,subject_user_id,tenant_kind,
       source_through_sequence
     )
     SELECT tenant.id,$2,thread.id,$4,
            COALESCE(tenant.owner_user_id,thread.created_by_user_id),tenant.kind,$5
       FROM tenants tenant
       JOIN threads thread ON thread.tenant_id=tenant.id AND thread.id=$3
       JOIN runs run ON run.tenant_id=tenant.id AND run.id=$2 AND run.thread_id=thread.id
       JOIN execution_attempts attempt
         ON attempt.tenant_id=tenant.id AND attempt.attempt_id=$4
        AND attempt.run_id=run.id AND attempt.thread_id=thread.id
      WHERE tenant.id=$1 AND tenant.kind IN ('personal','team')
     ON CONFLICT (tenant_id,run_id) DO NOTHING`,
    [input.tenantId, input.runId, input.threadId, input.attemptId, input.sourceThroughSequence],
  );
  if (inserted.rowCount !== 1) {
    const replay = await client.query(
      `SELECT 1 FROM memory_ingestion_outbox
        WHERE tenant_id=$1 AND run_id=$2 AND thread_id=$3 AND attempt_id=$4
          AND source_through_sequence=$5`,
      [input.tenantId, input.runId, input.threadId, input.attemptId, input.sourceThroughSequence],
    );
    if (replay.rowCount !== 1) throw new TypeError("记忆 Outbox 幂等冲突");
  }
  // 只登记本地 durable 任务并唤醒后台调度；终态事务不得直接等待第三方 Mem0。
  await scheduleWorkerTenant(client, input.tenantId);
}

export class PgMemoryIngestionStore implements MemoryIngestionStore {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
  ) {}

  async claimNext(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<MemoryIngestionClaim | undefined> {
    try {
      const selected = await withTenantTransaction(
        this.pool,
        { tenantId: input.tenantId },
        async (client) => {
          const result = await client.query<ClaimedMemoryRow>(
            `SELECT run_id,thread_id,attempt_id,subject_user_id,tenant_kind,
                    source_through_sequence::text,provider_event_id::text,
                    claim_generation::text,attempt_count
               FROM memory_ingestion_outbox
              WHERE tenant_id=$1 AND (
                (state IN ('pending','submitted') AND next_attempt_at<=clock_timestamp())
                OR (state='claimed' AND claim_expires_at<=clock_timestamp())
              )
              ORDER BY next_attempt_at,created_at,run_id
              FOR UPDATE SKIP LOCKED LIMIT 1`,
            [input.tenantId],
          );
          const row = result.rows[0];
          if (row === undefined) return undefined;
          const claimToken = `memory-${randomUUID()}`;
          const updated = await client.query<{ readonly claim_generation: string }>(
            `UPDATE memory_ingestion_outbox
                SET state='claimed',claim_token=$3,claimed_by=$4,
                    claim_generation=claim_generation+1,
                    claim_expires_at=clock_timestamp()+($5::bigint*interval '1 millisecond'),
                    updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND run_id=$2
              RETURNING claim_generation::text`,
            [input.tenantId, row.run_id, claimToken, input.workerId, input.leaseMs],
          );
          const generation = safeInteger(
            updated.rows[0]?.claim_generation,
            "记忆 claim generation",
          );
          const context = await client.query<MemoryContextRow>(
            `SELECT sequence::text,kind,body_inline,body_reference_id,body_sha256,
                    body_size::text,body_incarnation_id::text,body_physical_object_key
               FROM (
                 SELECT sequence,kind,body_inline,body_reference_id,body_sha256,body_size,
                        body_incarnation_id,body_physical_object_key
                   FROM thread_context_entries
                  WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND sequence<=$4
                    AND kind IN ('user_message','assistant_message')
                  ORDER BY sequence DESC LIMIT 128
               ) visible
              ORDER BY visible.sequence`,
            [input.tenantId, row.thread_id, row.run_id, row.source_through_sequence],
          );
          return { row, claimToken, generation, context: context.rows } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
      if (selected === undefined) return undefined;
      const messages = await loadMemoryMessages(input.tenantId, selected.context, this.blobs);
      return Object.freeze({
        tenantId: input.tenantId,
        tenantKind: selected.row.tenant_kind,
        userId: selected.row.subject_user_id,
        threadId: selected.row.thread_id,
        runId: selected.row.run_id,
        messages,
        claimToken: selected.claimToken,
        claimGeneration: selected.generation,
        attemptCount: selected.row.attempt_count + 1,
        ...(selected.row.provider_event_id === null
          ? {}
          : { providerEventId: selected.row.provider_event_id }),
      });
    } catch (error) {
      throw mapPersistenceError(error, "领取记忆写入任务");
    }
  }

  async submitted(claim: MemoryIngestionClaim, submission: MemorySubmission): Promise<boolean> {
    return await this.updateClaim(
      claim,
      `state='submitted',provider_event_id=$5::uuid,submitted_at=clock_timestamp(),
       claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
       next_attempt_at=clock_timestamp()+interval '1 second',last_error_code=NULL,
       updated_at=clock_timestamp()`,
      [submission.eventId],
    );
  }

  async deferPoll(claim: MemoryIngestionClaim, delayMs: number): Promise<boolean> {
    return await this.updateClaim(
      claim,
      `state='submitted',claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
       next_attempt_at=clock_timestamp()+($5::bigint*interval '1 millisecond'),
       updated_at=clock_timestamp()`,
      [delayMs],
    );
  }

  async complete(claim: MemoryIngestionClaim, submission?: MemorySubmission): Promise<boolean> {
    if (submission !== undefined && submission.status !== "SUCCEEDED") {
      throw new TypeError("只有已成功的记忆提交可以直接完成");
    }
    if (submission === undefined && claim.providerEventId === undefined) {
      throw new TypeError("记忆成功必须具有 Provider 事件；关闭记忆应跳过消费");
    }
    return await this.updateClaim(
      claim,
      `state='succeeded',provider_event_id=COALESCE($5::uuid,provider_event_id),
       submitted_at=COALESCE(submitted_at,CASE WHEN $5::uuid IS NULL THEN NULL ELSE clock_timestamp() END),
       claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,completed_at=clock_timestamp(),
       last_error_code=NULL,updated_at=clock_timestamp()`,
      [submission?.eventId ?? null],
    );
  }

  async skip(claim: MemoryIngestionClaim): Promise<boolean> {
    return await this.updateClaim(
      claim,
      `state='skipped',claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
       completed_at=clock_timestamp(),last_error_code=NULL,updated_at=clock_timestamp()`,
      [],
    );
  }

  async fail(
    claim: MemoryIngestionClaim,
    input: {
      readonly errorCode: MemoryProviderErrorCode;
      readonly maximumAttempts: number;
      readonly retryBaseMs: number;
      readonly retryable: boolean;
    },
  ): Promise<boolean> {
    const retry = input.retryable && claim.attemptCount < input.maximumAttempts;
    if (!retry) {
      return await this.updateClaim(
        claim,
        `state='failed',claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
         attempt_count=$5,last_error_code=$6,completed_at=clock_timestamp(),
         updated_at=clock_timestamp()`,
        [claim.attemptCount, input.errorCode],
      );
    }
    const retryMs = Math.min(
      3_600_000,
      input.retryBaseMs * 2 ** Math.max(0, claim.attemptCount - 1),
    );
    return await this.updateClaim(
      claim,
      `state=CASE WHEN provider_event_id IS NULL THEN 'pending' ELSE 'submitted' END,
       claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,attempt_count=$5,
       next_attempt_at=clock_timestamp()+($6::bigint*interval '1 millisecond'),
       last_error_code=$7,updated_at=clock_timestamp()`,
      [claim.attemptCount, retryMs, input.errorCode],
    );
  }

  private async updateClaim(
    claim: MemoryIngestionClaim,
    assignments: string,
    values: readonly unknown[],
  ): Promise<boolean> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: claim.tenantId },
        async (client) => {
          const result = await client.query(
            `UPDATE memory_ingestion_outbox SET ${assignments}
            WHERE tenant_id=$1 AND run_id=$2 AND state='claimed'
              AND claim_token=$3 AND claim_generation=$4
              AND claim_expires_at>clock_timestamp()`,
            [claim.tenantId, claim.runId, claim.claimToken, claim.claimGeneration, ...values],
          );
          return result.rowCount === 1;
        },
      );
    } catch (error) {
      throw mapPersistenceError(error, "写回记忆任务状态");
    }
  }
}

async function loadMemoryMessages(
  tenantId: string,
  rows: readonly MemoryContextRow[],
  blobs: BlobStore,
): Promise<readonly MemoryConversationMessage[]> {
  const messages: MemoryConversationMessage[] = [];
  for (const row of rows) {
    const body = await readThreadContextBody(tenantId, contextBody(row), blobs);
    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim().length === 0) continue;
    messages.push({ role: row.kind === "user_message" ? "user" : "assistant", content: text });
  }
  if (!messages.some((message) => message.role === "user")) {
    throw new TypeError("记忆来源缺少用户消息");
  }
  return Object.freeze(messages.map((message) => Object.freeze(message)));
}

function contextBody(row: MemoryContextRow): ThreadContextBodyV1 {
  if (row.body_inline !== null) {
    const value =
      typeof row.body_inline === "string" ? JSON.parse(row.body_inline) : row.body_inline;
    return {
      storage: "inline",
      value,
      sha256: sha256Digest(row.body_sha256),
      size: safeInteger(row.body_size, "记忆正文大小"),
    };
  }
  if (
    row.body_reference_id === null ||
    row.body_incarnation_id === null ||
    row.body_physical_object_key === null
  ) {
    throw new TypeError("记忆 Blob 正文身份不完整");
  }
  return {
    storage: "blob",
    referenceId: row.body_reference_id,
    sha256: sha256Digest(row.body_sha256),
    size: safeInteger(row.body_size, "记忆正文大小"),
    incarnationId: row.body_incarnation_id,
    physicalObjectKey: row.body_physical_object_key,
  };
}

function safeInteger(value: string | number | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${name} 无效`);
  return parsed;
}
