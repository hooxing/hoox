import type {
  RolloutCompatibilityIdentity,
  RolloutScope,
  RuntimeRolloutCheckpoint,
  RuntimeRolloutEntry,
  RuntimeRolloutEntryKind,
  Sha256Digest,
  UserId,
} from "@cube-runtime/domain";
import { isoTimestamp, sha256Digest } from "@cube-runtime/domain";
import { digestCanonical } from "@cube-runtime/run-contracts/mutation-protocol";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";

const HASH = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const KEY = /^[\x21-\x7e]{1,512}$/u;

export interface TrustedRolloutContext {
  readonly scope: RolloutScope;
  readonly userId: UserId;
}

export interface OpenRootRolloutInput {
  readonly context: TrustedRolloutContext;
  readonly workspaceId: string;
  readonly rootRunId: string;
  readonly compatibility: RolloutCompatibilityIdentity;
}

export interface RolloutEntryDraft {
  readonly kind: RuntimeRolloutEntryKind;
  readonly toolCallId?: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly bodyDigest: Sha256Digest;
  readonly isTruncated?: boolean;
  readonly blob?: {
    readonly referenceId: string;
    readonly sha256: Sha256Digest;
    readonly size: number;
  };
}

export interface AppendRolloutInput {
  readonly context: TrustedRolloutContext;
  readonly idempotencyKey: string;
  readonly commandDigest: Sha256Digest;
  readonly entries: readonly RolloutEntryDraft[];
}

export interface WriteCheckpointInput {
  readonly context: TrustedRolloutContext;
  readonly idempotencyKey: string;
  readonly commandDigest: Sha256Digest;
  readonly checkpointId: string;
  readonly windowStartSequence: number;
  readonly throughSequence: number;
  readonly projection: Readonly<Record<string, unknown>>;
  readonly projectionDigest: Sha256Digest;
  readonly replacementHistory: readonly Readonly<Record<string, unknown>>[];
}

export type RolloutWriteResult<T> =
  | { readonly outcome: "created" | "replayed"; readonly value: T }
  | { readonly outcome: "conflict" | "not_authorized" | "not_found" };

interface EntryRow extends QueryResultRow {
  readonly sequence: string;
  readonly kind: RuntimeRolloutEntryKind;
  readonly tool_call_id: string | null;
  readonly body: unknown;
  readonly body_digest: string;
  readonly is_truncated: boolean;
  readonly blob_reference_id: string | null;
  readonly blob_sha256: string | null;
  readonly blob_size: string | null;
  readonly occurred_at: Date;
}

interface CheckpointRow extends QueryResultRow {
  readonly checkpoint_id: string;
  readonly window_start_sequence: string;
  readonly through_sequence: string;
  readonly projection: unknown;
  readonly projection_digest: string;
  readonly replacement_history: unknown;
  readonly created_at: Date;
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new TypeError(`${label}格式无效`);
}

function assertBoundedText(value: string, label: string, maximumBytes: number): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (value.trim().length === 0 || bytes > maximumBytes) throw new TypeError(`${label}格式无效`);
}

function assertHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new TypeError(`${label}必须是 SHA-256`);
}

function assertJsonRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}必须是 JSON 对象`);
  }
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not-json");
    JSON.parse(encoded);
  } catch {
    throw new TypeError(`${label}必须可序列化为 JSON`);
  }
}

function assertContext(context: TrustedRolloutContext): void {
  const { scope } = context;
  for (const [label, value] of [
    ["Tenant ID", scope.tenantId],
    ["Thread ID", scope.threadId],
    ["Run ID", scope.runId],
    ["Attempt ID", scope.attemptId],
    ["Agent Thread ID", scope.agentThreadId],
    ["User ID", context.userId],
  ] as const) {
    assertIdentifier(value, label);
  }
}

function scopeParams(context: TrustedRolloutContext): string[] {
  const { scope } = context;
  return [scope.tenantId, scope.threadId, scope.runId, scope.attemptId, scope.agentThreadId];
}

async function authorized(client: PoolClient, context: TrustedRolloutContext): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM memberships membership
         JOIN threads thread_state
           ON thread_state.tenant_id=membership.tenant_id
          AND thread_state.id=$2
         JOIN runs run_state
           ON run_state.tenant_id=thread_state.tenant_id
          AND run_state.thread_id=thread_state.id
          AND run_state.id=$3
        WHERE membership.tenant_id=$1 AND membership.user_id=$4
          AND membership.status='active'
     ) AS allowed`,
    [context.scope.tenantId, context.scope.threadId, context.scope.runId, context.userId],
  );
  return result.rows[0]?.allowed === true;
}

function mapEntry(row: EntryRow): RuntimeRolloutEntry {
  assertJsonRecord(row.body, "Rollout body");
  const sequence = Number(row.sequence);
  const size = row.blob_size === null ? undefined : Number(row.blob_size);
  return Object.freeze({
    sequence,
    kind: row.kind,
    ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
    body: Object.freeze(row.body),
    bodyDigest: sha256Digest(row.body_digest),
    isTruncated: row.is_truncated,
    ...(row.blob_reference_id === null || row.blob_sha256 === null || size === undefined
      ? {}
      : {
          blob: Object.freeze({
            referenceId: row.blob_reference_id,
            sha256: sha256Digest(row.blob_sha256),
            size,
          }),
        }),
    occurredAt: isoTimestamp(row.occurred_at.toISOString()),
  });
}

function mapCheckpoint(row: CheckpointRow): RuntimeRolloutCheckpoint {
  assertJsonRecord(row.projection, "Checkpoint projection");
  if (!Array.isArray(row.replacement_history)) {
    throw new PersistenceError("UNEXPECTED", "Checkpoint replacement history 格式无效");
  }
  return Object.freeze({
    checkpointId: row.checkpoint_id,
    windowStartSequence: Number(row.window_start_sequence),
    throughSequence: Number(row.through_sequence),
    projection: Object.freeze(row.projection),
    projectionDigest: sha256Digest(row.projection_digest),
    replacementHistory: Object.freeze(
      row.replacement_history.map((item) => {
        assertJsonRecord(item, "Checkpoint replacement history item");
        return Object.freeze(item);
      }),
    ),
    createdAt: isoTimestamp(row.created_at.toISOString()),
  });
}

function assertDraft(draft: RolloutEntryDraft): void {
  if (
    !["user", "assistant", "tool_call", "tool_result", "waiting", "terminal"].includes(draft.kind)
  ) {
    throw new TypeError("Rollout entry kind 无效");
  }
  assertJsonRecord(draft.body, "Rollout body");
  assertHash(draft.bodyDigest, "Rollout body digest");
  if (digestCanonical(draft.body) !== draft.bodyDigest) {
    throw new TypeError("Rollout body digest 与正文不一致");
  }
  const needsCallId = draft.kind === "tool_call" || draft.kind === "tool_result";
  if (needsCallId) assertIdentifier(draft.toolCallId ?? "", "Tool call ID");
  else if (draft.toolCallId !== undefined) throw new TypeError("非工具 entry 不允许 Tool call ID");
  if (draft.blob !== undefined) {
    if (draft.kind !== "tool_result") throw new TypeError("只有 Tool result 可以引用完整输出 Blob");
    assertIdentifier(draft.blob.referenceId, "Blob reference ID");
    assertHash(draft.blob.sha256, "Blob digest");
    if (!Number.isSafeInteger(draft.blob.size) || draft.blob.size < 0) {
      throw new TypeError("Blob size 无效");
    }
  } else if (draft.isTruncated === true) {
    throw new TypeError("截断输出必须引用完整 Blob");
  }
}

/**
 * 仅负责 Runtime Rollout/Checkpoint 事实；不读取也不写入 Pi Session 本地文件。
 * 所有写入先锁定 scope advisory key，避免并发 append 分配相同 sequence。
 */
export class PgRuntimeRolloutRepository {
  constructor(private readonly pool: Pool) {}

  async openRootStream(
    input: OpenRootRolloutInput,
  ): Promise<"created" | "already_exists" | "conflict" | "not_authorized" | "not_found"> {
    assertContext(input.context);
    assertIdentifier(input.workspaceId, "Workspace ID");
    assertIdentifier(input.rootRunId, "Root Run ID");
    assertBoundedText(input.compatibility.modelId, "Model ID", 255);
    for (const [label, hash] of [
      ["Model compatibility hash", input.compatibility.modelCompatibilityHash],
      ["Prompt policy hash", input.compatibility.promptPolicyHash],
      ["Tool schema hash", input.compatibility.toolSchemaHash],
      ["Skill manifest hash", input.compatibility.skillManifestHash],
    ] as const) {
      assertHash(hash, label);
    }
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          if (!(await authorized(client, input.context))) return "not_authorized";
          const params = scopeParams(input.context);
          const inserted = await client.query(
            `INSERT INTO runtime_rollout_streams(
               tenant_id, thread_id, run_id, attempt_id, workspace_id, root_run_id,
               agent_thread_id, agent_kind, model_id, model_compatibility_hash,
               prompt_policy_hash, tool_schema_hash, skill_manifest_hash
             ) VALUES ($1,$2,$3,$4,$6,$7,$5,'root',$8,$9,$10,$11,$12)
             ON CONFLICT DO NOTHING`,
            [
              ...params,
              input.workspaceId,
              input.rootRunId,
              input.compatibility.modelId,
              input.compatibility.modelCompatibilityHash,
              input.compatibility.promptPolicyHash,
              input.compatibility.toolSchemaHash,
              input.compatibility.skillManifestHash,
            ],
          );
          if (inserted.rowCount === 1) return "created";
          const existing = await client.query<{
            workspace_id: string;
            root_run_id: string;
            agent_kind: string;
            model_id: string;
            model_compatibility_hash: string;
            prompt_policy_hash: string;
            tool_schema_hash: string;
            skill_manifest_hash: string;
          }>(
            `SELECT workspace_id, root_run_id, agent_kind, model_id, model_compatibility_hash,
                    prompt_policy_hash, tool_schema_hash, skill_manifest_hash
               FROM runtime_rollout_streams
              WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
                AND agent_thread_id=$5`,
            params,
          );
          const row = existing.rows[0];
          if (row === undefined) return "not_found";
          return row.workspace_id === input.workspaceId &&
            row.root_run_id === input.rootRunId &&
            row.agent_kind === "root" &&
            row.model_id === input.compatibility.modelId &&
            row.model_compatibility_hash === input.compatibility.modelCompatibilityHash &&
            row.prompt_policy_hash === input.compatibility.promptPolicyHash &&
            row.tool_schema_hash === input.compatibility.toolSchemaHash &&
            row.skill_manifest_hash === input.compatibility.skillManifestHash
            ? "already_exists"
            : "conflict";
        },
      );
    } catch (error) {
      throw mapPersistenceError(error, "打开 Runtime Rollout stream");
    }
  }

  async append(
    input: AppendRolloutInput,
  ): Promise<RolloutWriteResult<readonly RuntimeRolloutEntry[]>> {
    assertContext(input.context);
    if (!KEY.test(input.idempotencyKey)) throw new TypeError("Rollout 幂等键格式无效");
    assertHash(input.commandDigest, "Rollout command digest");
    if (input.entries.length < 1 || input.entries.length > 128) {
      throw new TypeError("单次 append 必须包含 1 到 128 个 entry");
    }
    input.entries.forEach(assertDraft);
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          if (!(await authorized(client, input.context))) return { outcome: "not_authorized" };
          const params = scopeParams(input.context);
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            params.join("\u001f"),
          ]);
          const receipt = await client.query<{
            command_digest: string;
            first_sequence: string;
            last_sequence: string;
          }>(
            `SELECT command_digest, first_sequence, last_sequence
               FROM runtime_rollout_append_commands
              WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3
                AND idempotency_key=$4`,
            [
              input.context.scope.tenantId,
              input.context.scope.attemptId,
              input.context.scope.agentThreadId,
              input.idempotencyKey,
            ],
          );
          const replay = receipt.rows[0];
          if (replay !== undefined) {
            if (replay.command_digest !== input.commandDigest) return { outcome: "conflict" };
            return {
              outcome: "replayed",
              value: await this.readEntriesRange(
                client,
                input.context,
                Number(replay.first_sequence),
                Number(replay.last_sequence),
              ),
            };
          }
          const stream = await client.query(
            `SELECT 1 FROM runtime_rollout_streams
              WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
                AND agent_thread_id=$5`,
            params,
          );
          if (stream.rowCount !== 1) return { outcome: "not_found" };
          const tailResult = await client.query<EntryRow>(
            `SELECT sequence, kind, tool_call_id, body, body_digest, is_truncated,
                    blob_reference_id, blob_sha256, blob_size, occurred_at
               FROM runtime_rollout_entries
              WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
                AND agent_thread_id=$5 ORDER BY sequence DESC LIMIT 1`,
            params,
          );
          let previous = tailResult.rows[0];
          const firstSequence = previous === undefined ? 0 : Number(previous.sequence) + 1;
          const created: RuntimeRolloutEntry[] = [];
          for (const [offset, draft] of input.entries.entries()) {
            const sequence = firstSequence + offset;
            const result = await client.query<EntryRow>(
              `INSERT INTO runtime_rollout_entries(
                 tenant_id, thread_id, run_id, attempt_id, agent_thread_id, sequence, kind,
                 tool_call_id, previous_sequence, previous_kind, previous_tool_call_id,
                 body, body_digest, is_truncated, blob_reference_id, blob_state,
                 blob_purpose, blob_sha256, blob_size
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,
                 CASE WHEN $15::text IS NULL THEN NULL ELSE 'stable' END,
                 CASE WHEN $15::text IS NULL THEN NULL ELSE 'trace' END,$16,$17
               ) RETURNING sequence, kind, tool_call_id, body, body_digest, is_truncated,
                           blob_reference_id, blob_sha256, blob_size, occurred_at`,
              [
                ...params,
                sequence,
                draft.kind,
                draft.toolCallId ?? null,
                previous === undefined ? null : Number(previous.sequence),
                previous?.kind ?? null,
                previous === undefined ? null : (previous.tool_call_id ?? ""),
                JSON.stringify(draft.body),
                draft.bodyDigest,
                draft.isTruncated ?? false,
                draft.blob?.referenceId ?? null,
                draft.blob?.sha256 ?? null,
                draft.blob?.size ?? null,
              ],
            );
            const row = result.rows[0];
            if (row === undefined) throw new Error("Rollout append 未返回事实");
            created.push(mapEntry(row));
            previous = row;
          }
          const lastSequence = firstSequence + input.entries.length - 1;
          await client.query(
            `INSERT INTO runtime_rollout_append_commands(
               tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
               idempotency_key, command_digest, first_sequence, last_sequence
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [...params, input.idempotencyKey, input.commandDigest, firstSequence, lastSequence],
          );
          return { outcome: "created", value: Object.freeze(created) };
        },
      );
    } catch (error) {
      throw mapPersistenceError(error, "追加 Runtime Rollout");
    }
  }

  async writeCheckpoint(
    input: WriteCheckpointInput,
  ): Promise<RolloutWriteResult<RuntimeRolloutCheckpoint>> {
    assertContext(input.context);
    if (!KEY.test(input.idempotencyKey)) throw new TypeError("Checkpoint 幂等键格式无效");
    assertHash(input.commandDigest, "Checkpoint command digest");
    assertHash(input.projectionDigest, "Checkpoint projection digest");
    assertIdentifier(input.checkpointId, "Checkpoint ID");
    assertJsonRecord(input.projection, "Checkpoint projection");
    if (digestCanonical(input.projection) !== input.projectionDigest) {
      throw new TypeError("Checkpoint projection digest 与投影不一致");
    }
    if (
      !Number.isSafeInteger(input.windowStartSequence) ||
      !Number.isSafeInteger(input.throughSequence) ||
      input.windowStartSequence < 0 ||
      input.throughSequence < input.windowStartSequence ||
      !Array.isArray(input.replacementHistory)
    ) {
      throw new TypeError("Checkpoint window 格式无效");
    }
    for (const item of input.replacementHistory) {
      assertJsonRecord(item, "Replacement history item");
    }
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          if (!(await authorized(client, input.context))) return { outcome: "not_authorized" };
          const params = scopeParams(input.context);
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            params.join("\u001f"),
          ]);
          const receipt = await client.query<{ command_digest: string; checkpoint_id: string }>(
            `SELECT command_digest, checkpoint_id
               FROM runtime_rollout_checkpoint_commands
              WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3
                AND idempotency_key=$4`,
            [
              input.context.scope.tenantId,
              input.context.scope.attemptId,
              input.context.scope.agentThreadId,
              input.idempotencyKey,
            ],
          );
          const replay = receipt.rows[0];
          if (replay !== undefined) {
            if (replay.command_digest !== input.commandDigest) return { outcome: "conflict" };
            const value = await this.readCheckpoint(client, input.context, replay.checkpoint_id);
            return value === undefined ? { outcome: "not_found" } : { outcome: "replayed", value };
          }
          const through = await client.query<{ kind: string; normalized_tool_call_id: string }>(
            `SELECT kind, normalized_tool_call_id FROM runtime_rollout_entries
              WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
                AND agent_thread_id=$5 AND sequence=$6`,
            [...params, input.throughSequence],
          );
          const throughRow = through.rows[0];
          if (throughRow === undefined) return { outcome: "not_found" };
          const previousCheckpoint = await client.query<{
            checkpoint_sequence: string;
            through_sequence: string;
          }>(
            `SELECT checkpoint_sequence, through_sequence
               FROM runtime_rollout_checkpoints
              WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
                AND agent_thread_id=$5 ORDER BY checkpoint_sequence DESC LIMIT 1`,
            params,
          );
          const previousCheckpointRow = previousCheckpoint.rows[0];
          const checkpointSequence =
            previousCheckpointRow === undefined
              ? 0
              : Number(previousCheckpointRow.checkpoint_sequence) + 1;
          const inserted = await client.query<CheckpointRow>(
            `INSERT INTO runtime_rollout_checkpoints(
               tenant_id, thread_id, run_id, attempt_id, agent_thread_id, checkpoint_id,
               checkpoint_sequence, previous_checkpoint_sequence, previous_through_sequence,
               window_start_sequence, through_sequence, through_kind, through_tool_call_id,
               projection, projection_digest, replacement_history
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb
             )
             RETURNING checkpoint_id, window_start_sequence, through_sequence, projection,
                       projection_digest, replacement_history, created_at`,
            [
              ...params,
              input.checkpointId,
              checkpointSequence,
              previousCheckpointRow === undefined
                ? null
                : Number(previousCheckpointRow.checkpoint_sequence),
              previousCheckpointRow === undefined
                ? null
                : Number(previousCheckpointRow.through_sequence),
              input.windowStartSequence,
              input.throughSequence,
              throughRow.kind,
              throughRow.normalized_tool_call_id,
              JSON.stringify(input.projection),
              input.projectionDigest,
              JSON.stringify(input.replacementHistory),
            ],
          );
          await client.query(
            `INSERT INTO runtime_rollout_checkpoint_commands(
               tenant_id, attempt_id, agent_thread_id, idempotency_key,
               command_digest, checkpoint_id
             ) VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              input.context.scope.tenantId,
              input.context.scope.attemptId,
              input.context.scope.agentThreadId,
              input.idempotencyKey,
              input.commandDigest,
              input.checkpointId,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error("Checkpoint 写入未返回事实");
          return { outcome: "created", value: mapCheckpoint(row) };
        },
      );
    } catch (error) {
      throw mapPersistenceError(error, "写入 Runtime Rollout checkpoint");
    }
  }

  async loadRecovery(input: { readonly context: TrustedRolloutContext }): Promise<
    | {
        readonly checkpoint?: RuntimeRolloutCheckpoint;
        readonly tail: readonly RuntimeRolloutEntry[];
      }
    | undefined
  > {
    assertContext(input.context);
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          if (!(await authorized(client, input.context))) return undefined;
          const params = scopeParams(input.context);
          const stream = await client.query(
            `SELECT 1 FROM runtime_rollout_streams
              WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
                AND agent_thread_id=$5`,
            params,
          );
          if (stream.rowCount !== 1) return undefined;
          const checkpointResult = await client.query<CheckpointRow>(
            `SELECT checkpoint_id, window_start_sequence, through_sequence, projection,
                    projection_digest, replacement_history, created_at
               FROM runtime_rollout_checkpoints
              WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
                AND agent_thread_id=$5 ORDER BY through_sequence DESC LIMIT 1`,
            params,
          );
          const checkpointRow = checkpointResult.rows[0];
          const checkpoint = checkpointRow === undefined ? undefined : mapCheckpoint(checkpointRow);
          const tailResult = await client.query<EntryRow>(
            `SELECT sequence, kind, tool_call_id, body, body_digest, is_truncated,
                    blob_reference_id, blob_sha256, blob_size, occurred_at
               FROM runtime_rollout_entries
              WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
                AND agent_thread_id=$5 AND sequence > $6 ORDER BY sequence`,
            [...params, checkpoint?.throughSequence ?? -1],
          );
          return Object.freeze({
            ...(checkpoint === undefined ? {} : { checkpoint }),
            tail: Object.freeze(tailResult.rows.map(mapEntry)),
          });
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "恢复 Runtime Rollout");
    }
  }

  private async readEntriesRange(
    client: PoolClient,
    context: TrustedRolloutContext,
    first: number,
    last: number,
  ): Promise<readonly RuntimeRolloutEntry[]> {
    const result = await client.query<EntryRow>(
      `SELECT sequence, kind, tool_call_id, body, body_digest, is_truncated,
              blob_reference_id, blob_sha256, blob_size, occurred_at
         FROM runtime_rollout_entries
        WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
          AND agent_thread_id=$5 AND sequence BETWEEN $6 AND $7 ORDER BY sequence`,
      [...scopeParams(context), first, last],
    );
    return Object.freeze(result.rows.map(mapEntry));
  }

  private async readCheckpoint(
    client: PoolClient,
    context: TrustedRolloutContext,
    checkpointId: string,
  ): Promise<RuntimeRolloutCheckpoint | undefined> {
    const result = await client.query<CheckpointRow>(
      `SELECT checkpoint_id, window_start_sequence, through_sequence, projection,
              projection_digest, replacement_history, created_at
         FROM runtime_rollout_checkpoints
        WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
          AND agent_thread_id=$5 AND checkpoint_id=$6`,
      [...scopeParams(context), checkpointId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapCheckpoint(row);
  }
}
