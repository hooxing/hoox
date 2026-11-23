import { createHash } from "node:crypto";
import type { TraceBlobPersistencePort } from "@hoox/context-policy";
import { sha256Digest } from "@hoox/domain";
import type {
  ExecutionScope,
  ThreadContextAppendCommandV1,
  ThreadContextBodyPersistencePort,
  ThreadContextBodyV1,
  ThreadContextCompactionCommitPort,
  ThreadContextHistoryPort,
} from "@hoox/run-contracts";
import {
  assertThreadActiveHistory,
  type ThreadActiveHistoryV1,
  type ThreadHistoryMessageV1,
  threadActiveHistoryDigest,
} from "@hoox/run-contracts";
import { digestCanonical } from "@hoox/run-contracts/mutation-protocol";
import type { Pool, PoolClient } from "pg";
import type { BlobStore, StableBlobRef } from "./blob-store.js";
import type { ThreadContextMessageView, ThreadContextReadPort } from "./ports.js";
import { withTenantTransaction } from "./postgres.js";

export interface ThreadContextAppendBinding {
  readonly scope: ExecutionScope;
  readonly attemptId?: string;
}

export interface ThreadContextAppendReceipt {
  readonly schemaVersion: 1;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly entryCount: number;
}

/** 调用方必须先锁定 Thread execution head；本函数只做幂等 append 和 cursor 单调推进。 */
export async function appendThreadContext(
  client: PoolClient,
  binding: ThreadContextAppendBinding,
  command: ThreadContextAppendCommandV1,
  occurredAt: string,
): Promise<ThreadContextAppendReceipt> {
  if (
    command.schemaVersion !== 1 ||
    !bounded(command.idempotencyKey, 512) ||
    command.entries.length < 1 ||
    command.entries.length > 512
  ) {
    throw new TypeError("Thread Context append command 无效");
  }
  const commandDigest = digestCanonical(command);
  const replay = await client.query<{
    command_digest: string;
    first_sequence: string;
    last_sequence: string;
    entry_count: number;
  }>(
    `SELECT command_digest,first_sequence::text,last_sequence::text,entry_count
       FROM thread_context_append_commands
      WHERE tenant_id=$1 AND thread_id=$2 AND idempotency_key=$3`,
    [binding.scope.tenantId, binding.scope.threadId, command.idempotencyKey],
  );
  const existing = replay.rows[0];
  if (existing !== undefined) {
    if (existing.command_digest !== commandDigest) throw new TypeError("Thread Context 幂等冲突");
    return {
      schemaVersion: 1,
      firstSequence: safeSequence(existing.first_sequence),
      lastSequence: safeSequence(existing.last_sequence),
      entryCount: existing.entry_count,
    };
  }
  await client.query(
    `INSERT INTO thread_context_streams(tenant_id,thread_id)
     VALUES ($1,$2) ON CONFLICT (tenant_id,thread_id) DO NOTHING`,
    [binding.scope.tenantId, binding.scope.threadId],
  );
  const stream = await client.query<{ next_sequence: string }>(
    `SELECT next_sequence::text FROM thread_context_streams
      WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
    [binding.scope.tenantId, binding.scope.threadId],
  );
  const firstSequence = safeSequence(stream.rows[0]?.next_sequence);
  const entryIds = new Set<string>();
  const calls = new Map<string, { readonly sequence: number; readonly name: string }>();
  for (const [index, entry] of command.entries.entries()) {
    if (!bounded(entry.entryId, 512) || entryIds.has(entry.entryId)) {
      throw new TypeError("Thread Context entryId 无效或重复");
    }
    entryIds.add(entry.entryId);
    validateBody(entry.body);
    let stableIdentity: { readonly operationId: string; readonly lifecycleId: string } | undefined;
    if (entry.body.storage === "blob") {
      const stable = await client.query<{ operation_id: string; lifecycle_id: string }>(
        `SELECT operation_id,lifecycle_id::text FROM blob_references
          WHERE tenant_id=$1 AND reference_id=$2 AND state='stable' AND purpose='trace'
            AND sha256=$3 AND size=$4 AND incarnation_id=$5::uuid
            AND physical_object_key=$6`,
        [
          binding.scope.tenantId,
          entry.body.referenceId,
          entry.body.sha256,
          entry.body.size,
          entry.body.incarnationId,
          entry.body.physicalObjectKey,
        ],
      );
      if (stable.rowCount !== 1) throw new TypeError("Thread Context Blob identity 不匹配");
      stableIdentity = {
        operationId: requiredString(stable.rows[0]?.operation_id),
        lifecycleId: requiredString(stable.rows[0]?.lifecycle_id),
      };
    }
    const callId = entry.toolCallId;
    if (entry.kind === "tool_call") {
      if (
        callId === undefined ||
        entry.toolName === undefined ||
        !bounded(callId, 200) ||
        !bounded(entry.toolName, 200) ||
        calls.has(callId)
      ) {
        throw new TypeError("Thread Context tool call 无效或重复");
      }
      calls.set(callId, { sequence: firstSequence + index, name: entry.toolName });
    } else if (entry.kind === "tool_result") {
      if (
        callId === undefined ||
        entry.toolName === undefined ||
        !bounded(callId, 200) ||
        !bounded(entry.toolName, 200)
      ) {
        throw new TypeError("Thread Context tool result 无效");
      }
      if (!calls.has(callId)) {
        const prior = await client.query<{ sequence: string; tool_name: string }>(
          `SELECT call.sequence::text,call.tool_name
             FROM thread_context_entries call
            WHERE call.tenant_id=$1 AND call.thread_id=$2
              AND call.kind='tool_call' AND call.tool_call_id=$3
              AND NOT EXISTS (
                SELECT 1 FROM thread_context_entries result
                 WHERE result.tenant_id=call.tenant_id AND result.thread_id=call.thread_id
                   AND result.kind='tool_result' AND result.tool_call_sequence=call.sequence
              )
            ORDER BY call.sequence DESC LIMIT 1`,
          [binding.scope.tenantId, binding.scope.threadId, callId],
        );
        const priorSequence = prior.rows[0]?.sequence;
        if (priorSequence === undefined) throw new TypeError("Thread Context tool result 无前驱");
        calls.set(callId, {
          sequence: safeSequence(priorSequence),
          name: requiredString(prior.rows[0]?.tool_name),
        });
      }
      if (calls.get(callId)?.name !== entry.toolName) {
        throw new TypeError("Thread Context tool result 名称不匹配");
      }
    } else if (callId !== undefined || entry.toolName !== undefined) {
      throw new TypeError("非工具 Thread Context entry 携带 callId");
    }
    const toolCallSequence =
      entry.kind === "tool_result" && callId !== undefined
        ? calls.get(callId)?.sequence
        : undefined;
    if (entry.kind === "tool_result" && toolCallSequence === undefined) {
      throw new TypeError("Thread Context tool result 无前驱");
    }
    const sequence = firstSequence + index;
    const body = entry.body;
    const inserted = await client.query(
      `INSERT INTO thread_context_entries(
         tenant_id,thread_id,sequence,entry_id,run_id,attempt_id,kind,tool_call_id,tool_name,
         tool_call_sequence,body_inline,body_reference_id,body_operation_id,body_state,body_purpose,
         body_sha256,body_size,body_lifecycle_id,body_incarnation_id,body_physical_object_key,occurred_at
       ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18::uuid,
                $19::uuid,$20,$21
        WHERE $6::text IS NULL OR EXISTS (
          SELECT 1 FROM execution_attempts attempt
           WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$6
             AND attempt.run_id=$5 AND attempt.thread_id=$2
        )`,
      [
        binding.scope.tenantId,
        binding.scope.threadId,
        sequence,
        entry.entryId,
        binding.scope.runId,
        binding.attemptId ?? null,
        entry.kind,
        callId ?? null,
        entry.toolName ?? null,
        toolCallSequence ?? null,
        body.storage === "inline" ? JSON.stringify(body.value) : null,
        body.storage === "blob" ? body.referenceId : null,
        stableIdentity?.operationId ?? null,
        body.storage === "blob" ? "stable" : null,
        body.storage === "blob" ? "trace" : null,
        body.sha256,
        body.size,
        stableIdentity?.lifecycleId ?? null,
        body.storage === "blob" ? body.incarnationId : null,
        body.storage === "blob" ? body.physicalObjectKey : null,
        occurredAt,
      ],
    );
    if (inserted.rowCount !== 1) throw new TypeError("Thread Context scope 不匹配");
  }
  const lastSequence = firstSequence + command.entries.length - 1;
  await client.query(
    `UPDATE thread_context_streams
        SET next_sequence=$3+1,updated_at=$4
      WHERE tenant_id=$1 AND thread_id=$2 AND next_sequence=$5`,
    [binding.scope.tenantId, binding.scope.threadId, lastSequence, occurredAt, firstSequence],
  );
  const head = await client.query(
    `UPDATE thread_execution_heads
        SET context_through_sequence=$3,version=version+1,updated_at=$4
      WHERE tenant_id=$1 AND thread_id=$2
        AND (context_through_sequence IS NULL OR context_through_sequence < $3)`,
    [binding.scope.tenantId, binding.scope.threadId, lastSequence, occurredAt],
  );
  if (head.rowCount !== 1) throw new TypeError("Thread Context head cursor 未推进");
  await client.query(
    `INSERT INTO thread_context_append_commands(
       tenant_id,thread_id,idempotency_key,command_digest,first_sequence,last_sequence,entry_count,appended_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      binding.scope.tenantId,
      binding.scope.threadId,
      command.idempotencyKey,
      commandDigest,
      firstSequence,
      lastSequence,
      command.entries.length,
      occurredAt,
    ],
  );
  return { schemaVersion: 1, firstSequence, lastSequence, entryCount: command.entries.length };
}

export class ThreadContextBodyPersistence implements ThreadContextBodyPersistencePort {
  constructor(
    private readonly traces: TraceBlobPersistencePort,
    private readonly inlineMaxBytes = 16 * 1024,
  ) {
    if (
      !Number.isSafeInteger(inlineMaxBytes) ||
      inlineMaxBytes < 256 ||
      inlineMaxBytes > 1_048_576
    ) {
      throw new TypeError("Thread Context inline 阈值无效");
    }
  }

  async persist(
    input: Parameters<ThreadContextBodyPersistencePort["persist"]>[0],
  ): Promise<ThreadContextBodyV1> {
    const encoded = Buffer.from(JSON.stringify(input.value), "utf8");
    if (encoded.byteLength <= this.inlineMaxBytes) {
      return {
        storage: "inline",
        value: input.value,
        sha256: digestCanonical(input.value),
        size: encoded.byteLength,
      };
    }
    const sha256 = createHash("sha256").update(encoded).digest("hex");
    const result = await this.traces.persistTrace({
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      body: encoded,
      sha256,
    });
    if (result.outcome !== "persisted" && result.outcome !== "replayed") {
      throw new Error(`THREAD_CONTEXT_BLOB_${result.outcome.toUpperCase()}`);
    }
    return {
      storage: "blob",
      referenceId: result.referenceId,
      sha256: sha256Digest(result.blob.sha256),
      size: result.blob.size,
      incarnationId: result.blob.incarnationId,
      physicalObjectKey: result.blob.physicalObjectKey,
    };
  }
}

export class PgThreadContextHistoryRepository implements ThreadContextHistoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
  ) {}

  async readActiveHistory(
    input: Parameters<ThreadContextHistoryPort["readActiveHistory"]>[0],
  ): ReturnType<ThreadContextHistoryPort["readActiveHistory"]> {
    if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0) {
      return { outcome: "unsupported" };
    }
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.scope.tenantId },
        async (client) => {
          const attempt = await client.query(
            `SELECT 1 FROM execution_attempts
              WHERE tenant_id=$1 AND attempt_id=$2 AND run_id=$3 AND thread_id=$4`,
            [input.scope.tenantId, input.attemptId, input.scope.runId, input.scope.threadId],
          );
          if (attempt.rowCount !== 1) return { outcome: "unavailable" } as const;
          const history = await readCheckpointAwareHistory(
            client,
            this.blobs,
            input.scope.tenantId,
            input.scope.threadId,
            input.throughSequence,
            input.compatibilityDigest,
          );
          if (history === undefined) return { outcome: "legacy_gap" } as const;
          await client.query(
            `INSERT INTO thread_context_history_audits(
               tenant_id,thread_id,run_id,attempt_id,mode,through_sequence,
               compatibility_digest,history_digest
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (
               tenant_id,attempt_id,mode,through_sequence,compatibility_digest,history_digest
             )
             DO NOTHING`,
            [
              input.scope.tenantId,
              input.scope.threadId,
              input.scope.runId,
              input.attemptId,
              input.mode,
              input.throughSequence,
              input.compatibilityDigest,
              history.digest,
            ],
          );
          return { outcome: "ready", history } as const;
        },
        { isolationLevel: "REPEATABLE READ" },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }
}

/** checkpoint、replacement items、事实 marker 和 stream CAS 在同一 writer 事务提交。 */
export class PgThreadContextCompactionRepository implements ThreadContextCompactionCommitPort {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
  ) {}

  async commit(
    input: Parameters<ThreadContextCompactionCommitPort["commit"]>[0],
  ): ReturnType<ThreadContextCompactionCommitPort["commit"]> {
    try {
      assertThreadActiveHistory(input.replacement);
      const replacementHandoffs = input.replacement.messages.filter(
        (message) => message.role === "compactionHandoff",
      );
      const replacementHandoff = replacementHandoffs[0];
      if (
        !bounded(input.operationId, 480) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(input.checkpointId) ||
        !/^[0-9a-f]{64}$/u.test(input.compatibilityDigest) ||
        !/^[0-9a-f]{64}$/u.test(input.policyDigest) ||
        !/^[0-9a-f]{64}$/u.test(input.sourceHistoryDigest) ||
        !bounded(input.tokenizerIdentity, 200) ||
        !positiveSafe(input.tokensBefore) ||
        !positiveSafe(input.tokensAfter) ||
        !positiveSafe(input.sourceFromSequence) ||
        !positiveSafe(input.sourceThroughSequence) ||
        input.sourceThroughSequence > input.replacement.throughSequence ||
        replacementHandoffs.length !== 1 ||
        replacementHandoff?.checkpointId !== input.checkpointId ||
        replacementHandoff.sourceFromSequence !== input.sourceFromSequence ||
        replacementHandoff.sourceThroughSequence !== input.sourceThroughSequence
      ) {
        return { outcome: "conflict" };
      }
      const requestDigest = digestCanonical({
        operationId: input.operationId,
        checkpointId: input.checkpointId,
        compatibilityDigest: input.compatibilityDigest,
        policyDigest: input.policyDigest,
        tokenizerIdentity: input.tokenizerIdentity,
        tokensBefore: input.tokensBefore,
        tokensAfter: input.tokensAfter,
        path: input.path,
        sourceFromSequence: input.sourceFromSequence,
        sourceThroughSequence: input.sourceThroughSequence,
        sourceHistoryDigest: input.sourceHistoryDigest,
        replacementDigest: input.replacement.digest,
      });
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          const replay = await client.query<{
            checkpoint_id: string;
            request_digest: string;
            window_number: string;
            checkpoint_fact_sequence: string;
          }>(
            `SELECT checkpoint_id,request_digest,window_number::text,checkpoint_fact_sequence::text
               FROM thread_context_compaction_checkpoints
              WHERE tenant_id=$1 AND thread_id=$2 AND operation_id=$3`,
            [input.fence.scope.tenantId, input.fence.scope.threadId, input.operationId],
          );
          const prior = replay.rows[0];
          if (prior !== undefined) {
            if (
              prior.request_digest !== requestDigest ||
              prior.checkpoint_id !== input.checkpointId
            ) {
              return { outcome: "conflict" } as const;
            }
            return {
              outcome: "replayed" as const,
              checkpointId: prior.checkpoint_id,
              windowNumber: safeSequence(prior.window_number),
              checkpointFactSequence: safeSequence(prior.checkpoint_fact_sequence),
            };
          }
          const head = await client.query<{
            active_run_id: string | null;
            writer_token: string | null;
            writer_epoch: string;
            context_through_sequence: string | null;
          }>(
            `SELECT active_run_id,writer_token,writer_epoch::text,context_through_sequence::text
               FROM thread_execution_heads
              WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
            [input.fence.scope.tenantId, input.fence.scope.threadId],
          );
          const h = head.rows[0];
          if (
            h === undefined ||
            h.active_run_id !== input.fence.scope.runId ||
            h.writer_token !== input.fence.runClaim.token ||
            Number(h.writer_epoch) !== input.fence.runClaim.epoch ||
            Number(h.context_through_sequence) < input.replacement.throughSequence
          ) {
            return { outcome: "fence_lost" } as const;
          }
          const fenced = await client.query(
            `SELECT 1
               FROM execution_attempts attempt
               JOIN run_claims claim ON claim.tenant_id=attempt.tenant_id
                AND claim.attempt_id=attempt.attempt_id
               JOIN execution_workspace_fences fence ON fence.tenant_id=attempt.tenant_id
                AND fence.attempt_id=attempt.attempt_id
               JOIN workspace_write_leases lease ON lease.tenant_id=attempt.tenant_id
                AND lease.workspace_id=attempt.workspace_id
              WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$2
                AND attempt.run_id=$3 AND attempt.thread_id=$4
                AND attempt.workspace_id=$5 AND attempt.root_run_id=$6
                AND claim.claim_token=$7 AND claim.claim_epoch=$8
                AND claim.workspace_lease_epoch=$9 AND claim.released_at IS NULL
                AND claim.expires_at > clock_timestamp()
                AND fence.lease_epoch=$9
                AND lease.root_run_id=$6 AND lease.epoch=$9
                AND lease.expires_at > clock_timestamp()`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              input.fence.scope.runId,
              input.fence.scope.threadId,
              input.fence.scope.workspaceId,
              input.fence.scope.rootRunId,
              input.fence.runClaim.token,
              input.fence.runClaim.epoch,
              input.fence.workspaceLease.epoch,
            ],
          );
          if (fenced.rowCount !== 1) return { outcome: "fence_lost" } as const;
          const current = await readCheckpointAwareHistory(
            client,
            this.blobs,
            input.fence.scope.tenantId,
            input.fence.scope.threadId,
            input.replacement.throughSequence,
            input.compatibilityDigest,
          );
          if (current === undefined || current.digest !== input.sourceHistoryDigest) {
            return { outcome: "stale" } as const;
          }
          const stream = await client.query<{
            current_window_number: string;
            current_checkpoint_id: string | null;
            checkpoint_through_sequence: string | null;
          }>(
            `SELECT stream.current_window_number::text,stream.current_checkpoint_id,
                    checkpoint.through_sequence::text AS checkpoint_through_sequence
               FROM thread_context_streams stream
               LEFT JOIN thread_context_compaction_checkpoints checkpoint
                 ON checkpoint.tenant_id=stream.tenant_id AND checkpoint.thread_id=stream.thread_id
                AND checkpoint.checkpoint_id=stream.current_checkpoint_id
              WHERE stream.tenant_id=$1 AND stream.thread_id=$2 FOR UPDATE OF stream`,
            [input.fence.scope.tenantId, input.fence.scope.threadId],
          );
          if (
            Number(stream.rows[0]?.checkpoint_through_sequence ?? "0") >
            input.replacement.throughSequence
          ) {
            return { outcome: "stale" } as const;
          }
          const windowNumber = Number(stream.rows[0]?.current_window_number ?? "0") + 1;
          const previousCheckpointId = stream.rows[0]?.current_checkpoint_id ?? null;
          const nowResult = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
          const occurredAt = new Date(nowResult.rows[0]?.now ?? Date.now()).toISOString();
          const factValue = {
            checkpointId: input.checkpointId,
            windowNumber,
            sourceFromSequence: input.sourceFromSequence,
            sourcePrefixThroughSequence: input.sourceThroughSequence,
            throughSequence: input.replacement.throughSequence,
            compatibilityDigest: input.compatibilityDigest,
            replacementHistoryDigest: input.replacement.digest,
            path: input.path,
          };
          const encodedFact = Buffer.from(JSON.stringify(factValue), "utf8");
          const fact = await appendThreadContext(
            client,
            { scope: input.fence.scope, attemptId: input.attemptId },
            {
              schemaVersion: 1,
              idempotencyKey: `${input.operationId}/fact`,
              entries: [
                {
                  entryId: `${input.operationId}/fact`,
                  kind: "compaction_checkpoint",
                  body: {
                    storage: "inline",
                    value: factValue,
                    sha256: digestCanonical(factValue),
                    size: encodedFact.byteLength,
                  },
                },
              ],
            },
            occurredAt,
          );
          await client.query(
            `INSERT INTO thread_context_compaction_checkpoints(
               tenant_id,thread_id,checkpoint_id,operation_id,request_digest,window_number,
               previous_checkpoint_id,source_from_sequence,source_prefix_through_sequence,
               through_sequence,checkpoint_fact_sequence,compatibility_digest,policy_digest,
               source_history_digest,replacement_history_digest,tokenizer_identity,tokens_before,
               tokens_after,compaction_path,created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [
              input.fence.scope.tenantId,
              input.fence.scope.threadId,
              input.checkpointId,
              input.operationId,
              requestDigest,
              windowNumber,
              previousCheckpointId,
              input.sourceFromSequence,
              input.sourceThroughSequence,
              input.replacement.throughSequence,
              fact.lastSequence,
              input.compatibilityDigest,
              input.policyDigest,
              input.sourceHistoryDigest,
              input.replacement.digest,
              input.tokenizerIdentity,
              input.tokensBefore,
              input.tokensAfter,
              input.path,
              occurredAt,
            ],
          );
          await insertReplacementItems(
            client,
            input.fence.scope.tenantId,
            input.fence.scope.threadId,
            input.checkpointId,
            input.replacement.messages,
          );
          const advanced = await client.query(
            `UPDATE thread_context_streams
                SET current_window_number=$3,current_checkpoint_id=$4,
                    current_compatibility_digest=$5,updated_at=$6
              WHERE tenant_id=$1 AND thread_id=$2 AND current_window_number=$7`,
            [
              input.fence.scope.tenantId,
              input.fence.scope.threadId,
              windowNumber,
              input.checkpointId,
              input.compatibilityDigest,
              occurredAt,
              windowNumber - 1,
            ],
          );
          if (advanced.rowCount !== 1) return { outcome: "stale" } as const;
          return {
            outcome: "applied" as const,
            checkpointId: input.checkpointId,
            windowNumber,
            checkpointFactSequence: fact.lastSequence,
          };
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }
}

export class PgThreadContextReadRepository implements ThreadContextReadPort {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
  ) {}

  async listMessages(
    input: Parameters<ThreadContextReadPort["listMessages"]>[0],
  ): ReturnType<ThreadContextReadPort["listMessages"]> {
    if (
      !Number.isSafeInteger(input.after) ||
      input.after < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 500
    ) {
      throw new TypeError("Thread Context page 参数无效");
    }
    return await withTenantTransaction(
      this.pool,
      input.scope,
      async (client) => {
        const authorized = await client.query<{ readonly has_client_tool_history: boolean }>(
          `SELECT thread.has_client_tool_history FROM threads thread JOIN memberships membership
             ON membership.tenant_id=thread.tenant_id AND membership.user_id=$2
            AND membership.status='active'
            WHERE thread.tenant_id=$1 AND thread.id=$3`,
          [input.scope.tenantId, input.scope.userId, input.threadId],
        );
        if (authorized.rowCount !== 1) return { outcome: "not_found" } as const;
        const result = await client.query<ContextRow & { run_id: string | null }>(
          `SELECT sequence::text,run_id,kind,tool_call_id,tool_name,body_inline,body_reference_id,
                  body_sha256,body_size::text,body_incarnation_id::text,
                  body_physical_object_key,occurred_at
             FROM thread_context_entries
            WHERE tenant_id=$1 AND thread_id=$2 AND sequence>$3
              AND kind IN (
                'user_message','assistant_message','workspace_unchanged','run_terminal',
                'legacy_history_gap'
              )
            ORDER BY thread_context_entries.sequence LIMIT $4`,
          [input.scope.tenantId, input.threadId, input.after, input.limit + 1],
        );
        const hasMore = result.rows.length > input.limit;
        const items: ThreadContextMessageView[] = [];
        for (const row of result.rows.slice(0, input.limit)) {
          const body = await loadBody(input.scope.tenantId, row, this.blobs);
          const sequence = safeSequence(row.sequence);
          const createdAt = new Date(row.occurred_at).toISOString();
          const common = {
            sequence,
            ...(row.run_id === null ? {} : { runId: row.run_id }),
            createdAt,
          };
          if (row.kind === "user_message") {
            items.push({ ...common, role: "user", text: requiredString(body.text) });
          } else if (row.kind === "assistant_message") {
            const text = stringValue(body.text);
            const phase = assistantMessagePhase(body.phase);
            if (text.length > 0) {
              items.push({
                ...common,
                role: "assistant",
                text,
                ...(phase === undefined ? {} : { phase }),
              });
            }
          } else if (row.kind === "workspace_unchanged") {
            items.push({ ...common, role: "runtime", text: "本次运行未产生 Workspace revision。" });
          } else if (row.kind === "legacy_history_gap") {
            items.push({
              ...common,
              role: "runtime",
              text: "旧会话仅恢复了可验证历史；缺失的 Assistant 或工具内容不会被推断或补写。",
            });
          } else {
            const status = requiredString(body.status);
            items.push({
              ...common,
              role: "runtime",
              text:
                status === "failed"
                  ? "运行失败；未提交工作不视为成功。"
                  : status === "cancelled"
                    ? "运行已取消。"
                    : status === "waiting"
                      ? "运行正在等待输入。"
                      : "运行已完成。",
            });
          }
        }
        return {
          outcome: "found",
          items,
          hasMore,
          hasClientToolHistory: authorized.rows[0]?.has_client_tool_history === true,
        } as const;
      },
      { readOnly: true, isolationLevel: "REPEATABLE READ" },
    );
  }
}

interface ContextRow {
  readonly sequence: string;
  readonly kind: string;
  readonly tool_call_id: string | null;
  readonly tool_name: string | null;
  readonly body_inline: Record<string, unknown> | string | null;
  readonly body_reference_id: string | null;
  readonly body_sha256: string;
  readonly body_size: string;
  readonly body_incarnation_id: string | null;
  readonly body_physical_object_key: string | null;
  readonly occurred_at: Date | string;
}

interface CompactionCheckpointRow {
  readonly checkpoint_id: string;
  readonly window_number: string;
  readonly previous_checkpoint_id: string | null;
  readonly through_sequence: string;
  readonly replacement_history_digest: string;
}

async function readCheckpointAwareHistory(
  client: PoolClient,
  blobs: BlobStore,
  tenantId: string,
  threadId: string,
  throughSequence: number,
  compatibilityDigest: string,
): Promise<ThreadActiveHistoryV1 | undefined> {
  if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) return undefined;
  const selected = await client.query<CompactionCheckpointRow>(
    `SELECT checkpoint_id,window_number::text,previous_checkpoint_id,through_sequence::text,
            replacement_history_digest
       FROM thread_context_compaction_checkpoints
      WHERE tenant_id=$1 AND thread_id=$2 AND compatibility_digest=$3
        AND through_sequence <= $4
      ORDER BY thread_context_compaction_checkpoints.window_number DESC LIMIT 1`,
    [tenantId, threadId, compatibilityDigest, throughSequence],
  );
  let baseThrough = 0;
  let baseMessages: readonly ThreadHistoryMessageV1[] = [];
  const checkpoint = selected.rows[0];
  if (checkpoint !== undefined) {
    const windowNumber = safeSequence(checkpoint.window_number);
    const chain = await client.query<CompactionCheckpointRow>(
      `SELECT checkpoint_id,window_number::text,previous_checkpoint_id,through_sequence::text,
              replacement_history_digest
         FROM thread_context_compaction_checkpoints
        WHERE tenant_id=$1 AND thread_id=$2 AND window_number <= $3
        ORDER BY thread_context_compaction_checkpoints.window_number`,
      [tenantId, threadId, windowNumber],
    );
    if (chain.rows.length !== windowNumber) return undefined;
    for (let index = 0; index < chain.rows.length; index += 1) {
      const item = chain.rows[index];
      if (
        item === undefined ||
        Number(item.window_number) !== index + 1 ||
        item.previous_checkpoint_id !== (index === 0 ? null : chain.rows[index - 1]?.checkpoint_id)
      ) {
        return undefined;
      }
    }
    const items = await client.query<{
      item_ordinal: number;
      history_sequence: string;
      item_kind: string;
      message: unknown;
      message_digest: string;
      tool_call_ids: string[];
      tool_call_id: string | null;
      tool_name: string | null;
      predecessor_ordinal: number | null;
    }>(
      `SELECT item_ordinal,history_sequence::text,item_kind,message,message_digest,
              tool_call_ids,tool_call_id,tool_name,predecessor_ordinal
         FROM thread_context_compaction_replacement_items
        WHERE tenant_id=$1 AND thread_id=$2 AND checkpoint_id=$3
        ORDER BY item_ordinal`,
      [tenantId, threadId, checkpoint.checkpoint_id],
    );
    if (items.rows.length < 1 || items.rows.length > 10_000) return undefined;
    const messages = items.rows.map((item, ordinal) => {
      const message = typeof item.message === "string" ? JSON.parse(item.message) : item.message;
      if (digestCanonical(message) !== item.message_digest)
        throw new TypeError("replacement item digest 不匹配");
      const typed = message as ThreadHistoryMessageV1;
      if (
        item.item_ordinal !== ordinal ||
        safeSequence(item.history_sequence) !== typed.sequence ||
        item.item_kind !== replacementItemKind(typed)
      ) {
        throw new TypeError("replacement normalized identity 不匹配");
      }
      const callIds =
        typed.role === "assistant"
          ? typed.content.filter((part) => part.type === "toolCall").map((part) => part.id)
          : [];
      if (JSON.stringify(callIds) !== JSON.stringify(item.tool_call_ids)) {
        throw new TypeError("replacement tool call provenance 不匹配");
      }
      if (typed.role === "toolResult") {
        const predecessor =
          item.predecessor_ordinal === null ? undefined : items.rows[item.predecessor_ordinal];
        const predecessorMessage =
          predecessor === undefined
            ? undefined
            : typeof predecessor.message === "string"
              ? JSON.parse(predecessor.message)
              : predecessor.message;
        const typedPredecessor = predecessorMessage as ThreadHistoryMessageV1 | undefined;
        const matchingCall =
          typedPredecessor?.role === "assistant"
            ? typedPredecessor.content.find(
                (part) =>
                  part.type === "toolCall" &&
                  part.id === typed.toolCallId &&
                  part.name === typed.toolName,
              )
            : undefined;
        if (
          item.tool_call_id !== typed.toolCallId ||
          item.tool_name !== typed.toolName ||
          matchingCall === undefined
        ) {
          throw new TypeError("replacement tool result provenance 不匹配");
        }
      } else if (
        item.tool_call_id !== null ||
        item.tool_name !== null ||
        item.predecessor_ordinal !== null
      ) {
        throw new TypeError("replacement 非工具 item 携带 provenance");
      }
      return typed;
    });
    baseThrough = safeSequence(checkpoint.through_sequence);
    const unsigned = {
      schemaVersion: 1 as const,
      projectionSchemaVersion: 1 as const,
      throughSequence: baseThrough,
      messages,
    };
    const base: ThreadActiveHistoryV1 = {
      ...unsigned,
      digest: threadActiveHistoryDigest(unsigned),
    };
    assertThreadActiveHistory(base);
    if (base.digest !== checkpoint.replacement_history_digest) return undefined;
    baseMessages = base.messages;
  }
  const tail = await client.query<ContextRow>(
    `SELECT sequence::text,kind,tool_call_id,tool_name,body_inline,body_reference_id,
            body_sha256,body_size::text,body_incarnation_id::text,
            body_physical_object_key,occurred_at
       FROM thread_context_entries
      WHERE tenant_id=$1 AND thread_id=$2 AND sequence>$3 AND sequence<=$4
      ORDER BY thread_context_entries.sequence`,
    [tenantId, threadId, baseThrough, throughSequence],
  );
  if (
    tail.rows.length !== throughSequence - baseThrough ||
    (throughSequence > baseThrough && safeSequence(tail.rows.at(-1)?.sequence) !== throughSequence)
  ) {
    return undefined;
  }
  const projectedTail = await projectRows(tenantId, tail.rows, blobs);
  const unsigned = {
    schemaVersion: 1 as const,
    projectionSchemaVersion: 1 as const,
    throughSequence,
    messages: [...baseMessages, ...projectedTail],
  };
  const history: ThreadActiveHistoryV1 = {
    ...unsigned,
    digest: threadActiveHistoryDigest(unsigned),
  };
  assertThreadActiveHistory(history);
  return history;
}

async function insertReplacementItems(
  client: PoolClient,
  tenantId: string,
  threadId: string,
  checkpointId: string,
  messages: readonly ThreadHistoryMessageV1[],
): Promise<void> {
  const callPredecessors = new Map<string, { readonly ordinal: number; readonly name: string }>();
  for (const [ordinal, message] of messages.entries()) {
    const itemKind =
      message.role === "toolResult"
        ? "tool_result"
        : message.role === "runtimeNotice"
          ? "runtime_notice"
          : message.role === "compactionHandoff"
            ? "compaction_handoff"
            : message.role;
    const toolCallIds =
      message.role === "assistant"
        ? message.content.filter((item) => item.type === "toolCall").map((item) => item.id)
        : [];
    if (message.role === "assistant") {
      for (const item of message.content) {
        if (item.type === "toolCall") callPredecessors.set(item.id, { ordinal, name: item.name });
      }
    }
    const predecessor =
      message.role === "toolResult" ? callPredecessors.get(message.toolCallId) : undefined;
    if (
      message.role === "toolResult" &&
      (predecessor === undefined || predecessor.name !== message.toolName)
    ) {
      throw new TypeError("replacement tool provenance 不完整");
    }
    const inserted = await client.query(
      `INSERT INTO thread_context_compaction_replacement_items(
         tenant_id,thread_id,checkpoint_id,item_ordinal,history_sequence,item_kind,message,
         message_digest,tool_call_ids,tool_call_id,tool_name,predecessor_ordinal
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::text[],$10,$11,$12)`,
      [
        tenantId,
        threadId,
        checkpointId,
        ordinal,
        message.sequence,
        itemKind,
        JSON.stringify(message),
        digestCanonical(message),
        toolCallIds,
        message.role === "toolResult" ? message.toolCallId : null,
        message.role === "toolResult" ? message.toolName : null,
        predecessor?.ordinal ?? null,
      ],
    );
    if (inserted.rowCount !== 1) throw new TypeError("replacement item 未提交");
  }
}

function positiveSafe(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function replacementItemKind(message: ThreadHistoryMessageV1): string {
  if (message.role === "toolResult") return "tool_result";
  if (message.role === "runtimeNotice") return "runtime_notice";
  if (message.role === "compactionHandoff") return "compaction_handoff";
  return message.role;
}

async function projectRows(
  tenantId: string,
  rows: readonly ContextRow[],
  blobs: BlobStore,
): Promise<readonly ThreadHistoryMessageV1[]> {
  const messages: ThreadHistoryMessageV1[] = [];
  let activeAssistant: Extract<ThreadHistoryMessageV1, { role: "assistant" }> | undefined;
  for (const row of rows) {
    const sequence = safeSequence(row.sequence);
    const body = await loadBody(tenantId, row, blobs);
    const occurred = new Date(row.occurred_at).getTime();
    if (row.kind === "user_message") {
      messages.push({
        sequence,
        role: "user",
        text: requiredString(body.text),
        timestamp: occurred,
      });
      activeAssistant = undefined;
    } else if (row.kind === "assistant_message") {
      const message = projectAssistantHistoryMessage(sequence, body, occurred);
      messages.push(message);
      activeAssistant = message;
    } else if (row.kind === "tool_call") {
      if (activeAssistant === undefined) throw new TypeError("tool_call 不紧随 assistant");
      const callId = row.tool_call_id;
      if (callId === null || row.tool_name === null) throw new TypeError("tool call 无效");
      const call = {
        type: "toolCall" as const,
        id: callId,
        name: row.tool_name,
        arguments: recordValue(body.arguments),
        ...(body.thoughtSignature === undefined
          ? {}
          : { thoughtSignature: requiredString(body.thoughtSignature) }),
      };
      const replaced = { ...activeAssistant, content: [...activeAssistant.content, call] };
      messages[messages.length - 1] = replaced;
      activeAssistant = replaced;
    } else if (row.kind === "tool_result") {
      const callId = row.tool_call_id;
      if (callId === null) throw new TypeError("tool result 无 callId");
      messages.push({
        sequence,
        role: "toolResult",
        toolCallId: callId,
        toolName: requiredString(row.tool_name),
        text: stringValue(body.text),
        isError: body.isError === true,
        timestamp: numberValue(body.timestamp, occurred),
      });
    } else if (row.kind === "run_terminal") {
      if (body.status === "failed" || body.status === "cancelled") {
        messages.push({
          sequence,
          role: "runtimeNotice",
          code: body.status === "failed" ? "run_failed" : "run_cancelled",
          text:
            body.status === "failed"
              ? "上一运行失败；不得推断其未提交工作已成功。"
              : "上一运行已取消。",
          timestamp: occurred,
        });
      }
      activeAssistant = undefined;
    } else if (row.kind === "workspace_unchanged") {
      messages.push({
        sequence,
        role: "runtimeNotice",
        code: "workspace_unchanged",
        text: "上一运行未产生 Workspace revision。",
        timestamp: occurred,
      });
    } else if (row.kind === "legacy_history_gap") {
      messages.push({
        sequence,
        role: "runtimeNotice",
        code: "legacy_history_gap",
        text: "旧 Thread 历史不完整；只可依赖其后明确列出的可验证事实，不得推断缺失对话。",
        timestamp: occurred,
      });
    }
  }
  return messages;
}

function assistantMessagePhase(value: unknown): "commentary" | "final_answer" | undefined {
  if (value === undefined) return undefined;
  if (value === "commentary" || value === "final_answer") return value;
  throw new TypeError("assistant message phase 无效");
}

/** 展示 phase 不属于 Provider 历史协议，任何时候都不得进入 Active History。 */
export function projectAssistantHistoryMessage(
  sequence: number,
  body: Readonly<Record<string, unknown>>,
  occurredAt: number,
): Extract<ThreadHistoryMessageV1, { role: "assistant" }> {
  const assistantText = stringValue(body.text);
  return {
    sequence,
    role: "assistant",
    content: assistantHistoryContent(body.content, assistantText),
    api: requiredString(body.api),
    provider: requiredString(body.provider),
    model: requiredString(body.model),
    stopReason: stopReason(body.stopReason),
    timestamp: numberValue(body.timestamp, occurredAt),
  };
}

async function loadBody(
  tenantId: string,
  row: ContextRow,
  blobs: BlobStore,
): Promise<Record<string, unknown>> {
  if (row.body_inline !== null) {
    const value =
      typeof row.body_inline === "string" ? JSON.parse(row.body_inline) : row.body_inline;
    return readThreadContextBody(
      tenantId,
      {
        storage: "inline",
        value: recordValue(value),
        sha256: sha256Digest(row.body_sha256),
        size: safeNonnegative(row.body_size),
      },
      blobs,
    );
  }
  if (
    row.body_reference_id === null ||
    row.body_incarnation_id === null ||
    row.body_physical_object_key === null
  ) {
    throw new TypeError("Blob body identity 不完整");
  }
  return readThreadContextBody(
    tenantId,
    {
      storage: "blob",
      referenceId: row.body_reference_id,
      sha256: sha256Digest(row.body_sha256),
      size: safeNonnegative(row.body_size),
      incarnationId: row.body_incarnation_id,
      physicalObjectKey: row.body_physical_object_key,
    },
    blobs,
  );
}

/** 按持久化的 exact Stable Blob identity 恢复正文，并在解析前校验字节级完整性。 */
export async function readThreadContextBody(
  tenantId: string,
  body: ThreadContextBodyV1,
  blobs: BlobStore,
): Promise<Record<string, unknown>> {
  validateBody(body);
  if (body.storage === "inline") return recordValue(body.value);
  const blob: StableBlobRef = {
    kind: "stable",
    tenantId,
    purpose: "trace",
    sha256: body.sha256,
    size: body.size,
    mediaType: "application/json; charset=utf-8",
    incarnationId: body.incarnationId,
    physicalObjectKey: body.physicalObjectKey,
  };
  const bytes = await blobs.getBytes({ tenantId }, blob);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== body.sha256 || bytes.byteLength !== blob.size) {
    throw new TypeError("Blob body 完整性校验失败");
  }
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  return recordValue(value);
}

function validateBody(body: ThreadContextBodyV1): void {
  if (!/^[0-9a-f]{64}$/u.test(body.sha256) || !Number.isSafeInteger(body.size) || body.size < 0) {
    throw new TypeError("Thread Context body identity 无效");
  }
  if (body.storage === "inline") {
    if (digestCanonical(body.value) !== body.sha256 || body.size > 2 * 1_048_576) {
      throw new TypeError("Thread Context inline body 无效");
    }
  } else if (
    !bounded(body.referenceId, 512) ||
    !bounded(body.incarnationId, 200) ||
    !bounded(body.physicalObjectKey, 2_048)
  ) {
    throw new TypeError("Thread Context Blob identity 无效");
  }
}

function bounded(value: string, max: number): boolean {
  return value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max;
}

function safeSequence(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError("Thread sequence 无效");
  return parsed;
}

function safeNonnegative(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError("Thread body size 无效");
  return parsed;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Thread body 文本无效");
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Thread body 文本无效");
  return value;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Thread body 对象无效");
  }
  return value as Readonly<Record<string, unknown>>;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function assistantHistoryContent(
  value: unknown,
  fallbackText: string,
): Extract<ThreadHistoryMessageV1, { role: "assistant" }>["content"] {
  if (value === undefined)
    return fallbackText.length === 0 ? [] : [{ type: "text", text: fallbackText }];
  if (!Array.isArray(value)) throw new TypeError("Thread assistant content 无效");
  return value.map((raw) => {
    const item = recordValue(raw);
    if (item.type === "text") return { type: "text" as const, text: requiredString(item.text) };
    if (item.type !== "thinking") throw new TypeError("Thread assistant content 类型无效");
    const thinking = typeof item.thinking === "string" ? item.thinking : undefined;
    if (thinking === undefined) throw new TypeError("Thread thinking 正文无效");
    const redacted = item.redacted === true;
    const signature =
      item.thinkingSignature === undefined ? undefined : requiredString(item.thinkingSignature);
    if (!thinking.trim() && (!redacted || signature === undefined)) {
      throw new TypeError("Thread thinking 正文无效");
    }
    return {
      type: "thinking" as const,
      thinking,
      ...(signature === undefined ? {} : { thinkingSignature: signature }),
      ...(item.redacted === undefined ? {} : { redacted }),
    };
  });
}

function stopReason(value: unknown): "stop" | "length" | "toolUse" {
  if (value !== "stop" && value !== "length" && value !== "toolUse") {
    throw new TypeError("Thread assistant stopReason 无效");
  }
  return value;
}
