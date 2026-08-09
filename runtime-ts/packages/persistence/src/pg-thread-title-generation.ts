import { randomUUID } from "node:crypto";
import {
  historyFilesystemCollisionName,
  historyFilesystemDirectoryName,
  stripAttachmentsFromUserFacingPrompt,
} from "@cube-runtime/resource";
import type {
  GeneratedThreadTitle,
  ThreadTitleGenerationClaim,
  ThreadTitleGenerationErrorCode,
  ThreadTitleGenerationStore,
} from "@cube-runtime/thread-title";
import type { Pool, PoolClient } from "pg";
import { mapPersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";

interface ClaimedRow {
  readonly thread_id: string;
  readonly source_receipt_id: string;
  readonly request_digest: string;
  readonly expected_title_generation_version: number;
  readonly claim_generation: string;
  readonly attempt_count: number;
  readonly input_text: string;
}

interface ThreadTitleRow {
  readonly title: string;
  readonly title_source: "deterministic" | "model" | "user";
  readonly created_at: Date;
}

export async function enqueueThreadTitleGeneration(
  client: PoolClient,
  input: { readonly tenantId: string; readonly threadId: string; readonly receiptId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO thread_title_generation_outbox(
       tenant_id,thread_id,source_receipt_id,request_digest,expected_title_generation_version
     )
     SELECT thread.tenant_id,thread.id,receipt.receipt_id,receipt.request_digest,
            thread.title_generation_version
       FROM threads thread
       JOIN tenants tenant ON tenant.id=thread.tenant_id AND tenant.kind IN ('personal','team')
       JOIN thread_input_receipts receipt
         ON receipt.tenant_id=thread.tenant_id AND receipt.thread_id=thread.id
      WHERE thread.tenant_id=$1 AND thread.id=$2 AND receipt.receipt_id=$3
        AND thread.title_source='deterministic'
        AND receipt.disposition IN ('queued','pending_steer','steered')
     ON CONFLICT (tenant_id,thread_id) DO NOTHING`,
    [input.tenantId, input.threadId, input.receiptId],
  );
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

export function pendingHistoryDirectoryName(threadId: string): string {
  const value = `pending-${threadId}`;
  if (
    Buffer.byteLength(value, "utf8") > 255 ||
    containsControlCharacter(value) ||
    /[\\/]/u.test(value)
  ) {
    throw new TypeError("Thread ID 无法构造 pending 历史目录");
  }
  return value;
}

async function allocateDirectoryName(
  client: PoolClient,
  input: { readonly tenantId: string; readonly threadId: string; readonly baseName: string },
): Promise<string> {
  for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) {
    const candidate = historyFilesystemCollisionName(input.baseName, ordinal);
    const found = await client.query(
      `SELECT 1 FROM thread_history_directories
        WHERE tenant_id=$1 AND directory_name=$2 AND thread_id<>$3`,
      [input.tenantId, candidate, input.threadId],
    );
    if (found.rowCount === 0) return candidate;
  }
  throw new TypeError("历史文件语义名称冲突过多");
}

async function finalizePendingDirectory(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly thread: ThreadTitleRow;
    readonly namingState: "ready" | "fallback";
  },
): Promise<void> {
  const directory = await client.query<{
    readonly naming_state: "pending" | "ready" | "fallback";
  }>(
    `SELECT naming_state
       FROM thread_history_directories
      WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
    [input.tenantId, input.threadId],
  );
  const row = directory.rows[0];
  if (row === undefined || row.naming_state !== "pending") return;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
    `${input.tenantId}\u001fpersonal-history-names`,
  ]);
  const baseName = historyFilesystemDirectoryName({ title: input.thread.title });
  const directoryName = await allocateDirectoryName(client, {
    tenantId: input.tenantId,
    threadId: input.threadId,
    baseName,
  });
  await client.query(
    `UPDATE thread_history_directories
        SET directory_name=$3,naming_state=$4,version=version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND thread_id=$2 AND naming_state='pending'`,
    [input.tenantId, input.threadId, directoryName, input.namingState],
  );
}

function safeInteger(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${name} 无效`);
  return parsed;
}

export class PgThreadTitleGenerationStore implements ThreadTitleGenerationStore {
  constructor(private readonly pool: Pool) {}

  async claimNext(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<ThreadTitleGenerationClaim | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.tenantId },
        async (client) => {
          const selected = await client.query<ClaimedRow>(
            `SELECT outbox.thread_id,outbox.source_receipt_id,outbox.request_digest,
                    outbox.expected_title_generation_version,
                    outbox.claim_generation::text,outbox.attempt_count,receipt.input_text
               FROM thread_title_generation_outbox outbox
               JOIN tenants tenant ON tenant.id=outbox.tenant_id AND tenant.kind='personal'
               JOIN thread_input_receipts receipt
                 ON receipt.tenant_id=outbox.tenant_id AND receipt.thread_id=outbox.thread_id
                AND receipt.receipt_id=outbox.source_receipt_id
              WHERE outbox.tenant_id=$1 AND (
                (outbox.state='pending' AND outbox.attempt_count < 10
                  AND outbox.next_attempt_at<=clock_timestamp())
                OR
                (outbox.state='claimed' AND outbox.claim_expires_at<=clock_timestamp())
              )
              ORDER BY outbox.next_attempt_at,outbox.created_at,outbox.thread_id
              FOR UPDATE OF outbox SKIP LOCKED LIMIT 1`,
            [input.tenantId],
          );
          const row = selected.rows[0];
          if (row === undefined) return undefined;
          const threadId = row.thread_id;
          const claimToken = `title-${randomUUID()}`;
          const updated = await client.query<{
            readonly claim_generation: string;
            readonly attempt_count: number;
          }>(
            `UPDATE thread_title_generation_outbox
                SET state='claimed',claim_token=$3,claimed_by=$4,
                    claim_generation=claim_generation+1,
                    claim_expires_at=clock_timestamp()+($5::bigint*interval '1 millisecond'),
                    attempt_count=CASE WHEN state='pending' THEN attempt_count+1 ELSE attempt_count END,
                    updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND thread_id=$2
              RETURNING claim_generation::text,attempt_count`,
            [input.tenantId, threadId, claimToken, input.workerId, input.leaseMs],
          );
          const claimState = updated.rows[0];
          if (claimState === undefined) return undefined;
          const attachments = await client.query<{
            readonly name: string;
            readonly media_type: string;
            readonly ordinal: number;
          }>(
            `SELECT resource.name,version.media_type,(version_item.value #>> '{}')::integer AS ordinal
               FROM thread_input_receipts receipt
               CROSS JOIN LATERAL jsonb_each(receipt.input_attachments) resource_item
               CROSS JOIN LATERAL jsonb_each(resource_item.value) version_item
               JOIN resources resource
                 ON resource.tenant_id=receipt.tenant_id AND resource.id=resource_item.key
               JOIN resource_versions version
                 ON version.tenant_id=receipt.tenant_id AND version.resource_id=resource_item.key
                AND version.id=version_item.key
              WHERE receipt.tenant_id=$1 AND receipt.thread_id=$2 AND receipt.receipt_id=$3
              ORDER BY ordinal`,
            [input.tenantId, threadId, row.source_receipt_id],
          );
          return Object.freeze({
            tenantId: input.tenantId,
            threadId,
            sourceReceiptId: row.source_receipt_id,
            requestDigest: row.request_digest,
            expectedTitleGenerationVersion: row.expected_title_generation_version,
            claimToken,
            claimGeneration: safeInteger(claimState.claim_generation, "标题 claim generation"),
            attemptCount: safeInteger(claimState.attempt_count, "标题 attempt count"),
            sourceText: stripAttachmentsFromUserFacingPrompt(row.input_text),
            attachments: Object.freeze(
              attachments.rows.map((attachment) =>
                Object.freeze({ name: attachment.name, mediaType: attachment.media_type }),
              ),
            ),
          });
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      throw mapPersistenceError(error, "领取标题生成任务");
    }
  }

  async complete(
    claim: ThreadTitleGenerationClaim,
    result: GeneratedThreadTitle,
  ): Promise<boolean> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: claim.tenantId },
        async (client) => {
          const locked = await this.lockClaim(client, claim);
          if (!locked) return false;
          const applied = await client.query(
            `UPDATE threads
                SET title=$3,title_source='model',title_generated_at=clock_timestamp(),
                    title_generation_version=title_generation_version+1,
                    version=version+1,updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND id=$2 AND title_source='deterministic'
                AND title_generation_version=$4`,
            [claim.tenantId, claim.threadId, result.title, claim.expectedTitleGenerationVersion],
          );
          const thread = await this.readThread(client, claim.tenantId, claim.threadId);
          const outcome = applied.rowCount === 1 ? "succeeded" : "superseded";
          await finalizePendingDirectory(client, {
            tenantId: claim.tenantId,
            threadId: claim.threadId,
            thread,
            namingState: thread.title_source === "deterministic" ? "fallback" : "ready",
          });
          const completed = await client.query(
            `UPDATE thread_title_generation_outbox
                SET state=$6,claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
                    model_key=$7,prompt_tokens=$8,completion_tokens=$9,duration_ms=$10,
                    completed_at=clock_timestamp(),updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND thread_id=$2 AND state='claimed'
                AND claim_token=$3 AND claim_generation=$4 AND request_digest=$5`,
            [
              claim.tenantId,
              claim.threadId,
              claim.claimToken,
              claim.claimGeneration,
              claim.requestDigest,
              outcome,
              result.modelKey,
              result.promptTokens ?? null,
              result.completionTokens ?? null,
              result.durationMs,
            ],
          );
          if (completed.rowCount !== 1) throw new TypeError("标题完成状态写回失去栅栏");
          return true;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      throw mapPersistenceError(error, "完成标题生成任务");
    }
  }

  async fail(
    claim: ThreadTitleGenerationClaim,
    input: {
      readonly errorCode: ThreadTitleGenerationErrorCode;
      readonly maximumAttempts: number;
      readonly retryBaseMs: number;
    },
  ): Promise<boolean> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: claim.tenantId },
        async (client) => {
          const locked = await this.lockClaim(client, claim);
          if (!locked) return false;
          if (claim.attemptCount < input.maximumAttempts) {
            const retryMs = Math.min(
              3_600_000,
              input.retryBaseMs * 2 ** Math.max(0, claim.attemptCount - 1),
            );
            const retried = await client.query(
              `UPDATE thread_title_generation_outbox
                  SET state='pending',claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
                      next_attempt_at=clock_timestamp()+($6::bigint*interval '1 millisecond'),
                      last_error_code=$7,updated_at=clock_timestamp()
                WHERE tenant_id=$1 AND thread_id=$2 AND state='claimed'
                  AND claim_token=$3 AND claim_generation=$4 AND request_digest=$5`,
              [
                claim.tenantId,
                claim.threadId,
                claim.claimToken,
                claim.claimGeneration,
                claim.requestDigest,
                retryMs,
                input.errorCode,
              ],
            );
            return retried.rowCount === 1;
          }
          const thread = await this.readThread(client, claim.tenantId, claim.threadId);
          const outcome = thread.title_source === "deterministic" ? "fallback" : "superseded";
          await finalizePendingDirectory(client, {
            tenantId: claim.tenantId,
            threadId: claim.threadId,
            thread,
            namingState: thread.title_source === "deterministic" ? "fallback" : "ready",
          });
          const failed = await client.query(
            `UPDATE thread_title_generation_outbox
                SET state=$6,claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,
                    last_error_code=$7,completed_at=clock_timestamp(),updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND thread_id=$2 AND state='claimed'
                AND claim_token=$3 AND claim_generation=$4 AND request_digest=$5`,
            [
              claim.tenantId,
              claim.threadId,
              claim.claimToken,
              claim.claimGeneration,
              claim.requestDigest,
              outcome,
              input.errorCode,
            ],
          );
          if (failed.rowCount !== 1) throw new TypeError("标题 fallback 状态写回失去栅栏");
          return true;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      throw mapPersistenceError(error, "处理标题生成失败");
    }
  }

  private async lockClaim(client: PoolClient, claim: ThreadTitleGenerationClaim): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM thread_title_generation_outbox
        WHERE tenant_id=$1 AND thread_id=$2 AND state='claimed'
          AND claim_token=$3 AND claim_generation=$4 AND request_digest=$5
          AND source_receipt_id=$6 AND claim_expires_at>clock_timestamp()
        FOR UPDATE`,
      [
        claim.tenantId,
        claim.threadId,
        claim.claimToken,
        claim.claimGeneration,
        claim.requestDigest,
        claim.sourceReceiptId,
      ],
    );
    return result.rowCount === 1;
  }

  private async readThread(
    client: PoolClient,
    tenantId: string,
    threadId: string,
  ): Promise<ThreadTitleRow> {
    const result = await client.query<ThreadTitleRow>(
      `SELECT title,title_source,created_at FROM threads
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, threadId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new TypeError("标题生成 Thread 缺失");
    return row;
  }
}
