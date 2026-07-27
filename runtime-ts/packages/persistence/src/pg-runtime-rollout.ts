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
  readonly entries: readonly RolloutEntryDraft[];
}

export interface WriteCheckpointInput {
  readonly context: TrustedRolloutContext;
  readonly idempotencyKey: string;
  readonly checkpointId: string;
  readonly windowStartSequence: number;
  readonly throughSequence: number;
  readonly projection: Readonly<Record<string, unknown>>;
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
  readonly occurred_at: Date | string;
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

interface RecoveryRow extends QueryResultRow {
  readonly model_id: string;
  readonly model_compatibility_hash: string;
  readonly prompt_policy_hash: string;
  readonly tool_schema_hash: string;
  readonly skill_manifest_hash: string;
  readonly checkpoint_id: string | null;
  readonly window_start_sequence: string | null;
  readonly through_sequence: string | null;
  readonly projection: unknown | null;
  readonly projection_digest: string | null;
  readonly replacement_history: unknown;
  readonly created_at: Date | null;
  readonly tail_entries: unknown;
}

export type RolloutCompatibilityField =
  | "modelId"
  | "modelCompatibilityHash"
  | "promptPolicyHash"
  | "toolSchemaHash"
  | "skillManifestHash";

export type LoadRecoveryResult =
  | {
      readonly outcome: "loaded";
      readonly checkpoint?: RuntimeRolloutCheckpoint;
      readonly tail: readonly RuntimeRolloutEntry[];
    }
  | {
      readonly outcome: "compatibility_mismatch";
      readonly action: "rebuild_attempt";
      readonly mismatches: readonly RolloutCompatibilityField[];
    }
  | { readonly outcome: "not_found" };

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

/**
 * 写事务持有 SHARE row lock 到 COMMIT；Membership revoke 的 UPDATE 必须等待，
 * 从而写入的授权判定与事实提交不可交错。读恢复改用单 SQL snapshot，避免只读请求制造 row-lock WAL。
 */
async function lockActiveMembership(
  client: PoolClient,
  context: TrustedRolloutContext,
): Promise<boolean> {
  const result = await client.query(
    `SELECT membership.user_id
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
        FOR SHARE OF membership
    `,
    [context.scope.tenantId, context.scope.threadId, context.scope.runId, context.userId],
  );
  return result.rowCount === 1;
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
    occurredAt: isoTimestamp(
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : new Date(row.occurred_at).toISOString(),
    ),
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

interface NormalizedRolloutEntryDraft extends Omit<RolloutEntryDraft, "body"> {
  readonly body: Readonly<Record<string, unknown>>;
  readonly bodyDigest: Sha256Digest;
}

function normalizeDraft(draft: RolloutEntryDraft): NormalizedRolloutEntryDraft {
  if (
    !["user", "assistant", "tool_call", "tool_result", "waiting", "terminal"].includes(draft.kind)
  ) {
    throw new TypeError("Rollout entry kind 无效");
  }
  assertJsonRecord(draft.body, "Rollout body");
  const body = JSON.parse(JSON.stringify(draft.body)) as Record<string, unknown>;
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
  return Object.freeze({
    kind: draft.kind,
    ...(draft.toolCallId === undefined ? {} : { toolCallId: draft.toolCallId }),
    body: Object.freeze(body),
    bodyDigest: digestCanonical(body),
    isTruncated: draft.isTruncated ?? false,
    ...(draft.blob === undefined ? {} : { blob: Object.freeze({ ...draft.blob }) }),
  });
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
          if (!(await lockActiveMembership(client, input.context))) return "not_authorized";
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
            thread_id: string;
            run_id: string;
            agent_thread_id: string;
            workspace_id: string;
            root_run_id: string;
            agent_kind: string;
            model_id: string;
            model_compatibility_hash: string;
            prompt_policy_hash: string;
            tool_schema_hash: string;
            skill_manifest_hash: string;
          }>(
            `SELECT thread_id, run_id, agent_thread_id, workspace_id, root_run_id,
                    agent_kind, model_id, model_compatibility_hash,
                    prompt_policy_hash, tool_schema_hash, skill_manifest_hash
               FROM runtime_rollout_streams
              WHERE tenant_id=$1 AND attempt_id=$2`,
            [input.context.scope.tenantId, input.context.scope.attemptId],
          );
          const row = existing.rows[0];
          if (row === undefined) return "not_found";
          return row.thread_id === input.context.scope.threadId &&
            row.run_id === input.context.scope.runId &&
            row.agent_thread_id === input.context.scope.agentThreadId &&
            row.workspace_id === input.workspaceId &&
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
    if (input.entries.length < 1 || input.entries.length > 128) {
      throw new TypeError("单次 append 必须包含 1 到 128 个 entry");
    }
    const entries = Object.freeze(input.entries.map(normalizeDraft));
    const commandDigest = digestCanonical({ schemaVersion: 1, entries });
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          if (!(await lockActiveMembership(client, input.context))) {
            return { outcome: "not_authorized" };
          }
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
            if (replay.command_digest !== commandDigest) return { outcome: "conflict" };
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
          for (const [offset, draft] of entries.entries()) {
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
          const lastSequence = firstSequence + entries.length - 1;
          await client.query(
            `INSERT INTO runtime_rollout_append_commands(
               tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
               idempotency_key, command_digest, first_sequence, last_sequence
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [...params, input.idempotencyKey, commandDigest, firstSequence, lastSequence],
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
    assertIdentifier(input.checkpointId, "Checkpoint ID");
    assertJsonRecord(input.projection, "Checkpoint projection");
    const projection = Object.freeze(
      JSON.parse(JSON.stringify(input.projection)) as Record<string, unknown>,
    );
    const projectionDigest = digestCanonical(projection);
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
    const replacementHistory = Object.freeze(
      input.replacementHistory.map((item) =>
        Object.freeze(JSON.parse(JSON.stringify(item)) as Record<string, unknown>),
      ),
    );
    const commandDigest = digestCanonical({
      schemaVersion: 1,
      checkpointId: input.checkpointId,
      windowStartSequence: input.windowStartSequence,
      throughSequence: input.throughSequence,
      projection,
      replacementHistory,
    });
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          if (!(await lockActiveMembership(client, input.context))) {
            return { outcome: "not_authorized" };
          }
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
            if (replay.command_digest !== commandDigest) return { outcome: "conflict" };
            const value = await this.readCheckpoint(client, input.context, replay.checkpoint_id);
            return value === undefined ? { outcome: "not_found" } : { outcome: "replayed", value };
          }
          const boundaries = await client.query<{
            through_kind: string;
            through_tool_call_id: string;
            window_start_kind: string;
            window_start_tool_call_id: string;
          }>(
            `SELECT through_entry.kind AS through_kind,
                    through_entry.normalized_tool_call_id AS through_tool_call_id,
                    window_entry.kind AS window_start_kind,
                    window_entry.normalized_tool_call_id AS window_start_tool_call_id
               FROM runtime_rollout_entries through_entry
               JOIN runtime_rollout_entries window_entry
                 ON window_entry.tenant_id=through_entry.tenant_id
                AND window_entry.thread_id=through_entry.thread_id
                AND window_entry.run_id=through_entry.run_id
                AND window_entry.attempt_id=through_entry.attempt_id
                AND window_entry.agent_thread_id=through_entry.agent_thread_id
                AND window_entry.sequence=$7
              WHERE through_entry.tenant_id=$1 AND through_entry.thread_id=$2
                AND through_entry.run_id=$3 AND through_entry.attempt_id=$4
                AND through_entry.agent_thread_id=$5 AND through_entry.sequence=$6`,
            [...params, input.throughSequence, input.windowStartSequence],
          );
          const boundary = boundaries.rows[0];
          if (boundary === undefined) return { outcome: "not_found" };
          if (
            boundary.through_kind === "tool_call" ||
            boundary.window_start_kind === "tool_result"
          ) {
            return { outcome: "conflict" };
          }
          const previousCheckpoint = await client.query<{
            checkpoint_sequence: string;
            through_sequence: string;
            window_start_sequence: string;
            replacement_history_length: string;
          }>(
            `SELECT checkpoint_sequence, through_sequence, window_start_sequence,
                    replacement_history_length
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
          if (
            previousCheckpointRow !== undefined &&
            (input.throughSequence <= Number(previousCheckpointRow.through_sequence) ||
              input.windowStartSequence < Number(previousCheckpointRow.window_start_sequence) ||
              replacementHistory.length < Number(previousCheckpointRow.replacement_history_length))
          ) {
            return { outcome: "conflict" };
          }
          const storedHistory = await client.query<{
            replacement_sequence: string;
            replacement: unknown;
            replacement_digest: string;
          }>(
            `SELECT replacement_sequence, replacement, replacement_digest
               FROM runtime_rollout_replacements
              WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4
                AND agent_thread_id=$5 ORDER BY replacement_sequence`,
            params,
          );
          if (
            storedHistory.rows.length > replacementHistory.length ||
            storedHistory.rows.some(
              (row, index) => digestCanonical(replacementHistory[index]) !== row.replacement_digest,
            )
          ) {
            return { outcome: "conflict" };
          }
          let previousReplacementDigest = storedHistory.rows.at(-1)?.replacement_digest;
          for (
            let index = storedHistory.rows.length;
            index < replacementHistory.length;
            index += 1
          ) {
            const replacement = replacementHistory[index];
            if (replacement === undefined) throw new Error("Replacement history 索引无效");
            const replacementDigest = digestCanonical(replacement);
            await client.query(
              `INSERT INTO runtime_rollout_replacements(
                 tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
                 replacement_sequence, previous_replacement_sequence,
                 previous_replacement_digest, replacement, replacement_digest
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
              [
                ...params,
                index,
                index === 0 ? null : index - 1,
                previousReplacementDigest ?? null,
                JSON.stringify(replacement),
                replacementDigest,
              ],
            );
            previousReplacementDigest = replacementDigest;
          }
          const inserted = await client.query<CheckpointRow>(
            `INSERT INTO runtime_rollout_checkpoints(
               tenant_id, thread_id, run_id, attempt_id, agent_thread_id, checkpoint_id,
               checkpoint_sequence, previous_checkpoint_sequence, previous_through_sequence,
               previous_window_start_sequence, previous_replacement_history_length,
               window_start_sequence, window_start_kind, window_start_tool_call_id,
               through_sequence, through_kind, through_tool_call_id,
               projection, projection_digest, replacement_history_length,
               replacement_history_tail_digest
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               $18::jsonb,$19,$20,$21
             )
             RETURNING checkpoint_id, window_start_sequence, through_sequence, projection,
                       projection_digest,
                       (SELECT coalesce(jsonb_agg(replacement ORDER BY replacement_sequence), '[]')
                          FROM runtime_rollout_replacements history
                         WHERE history.tenant_id=$1 AND history.thread_id=$2
                           AND history.run_id=$3 AND history.attempt_id=$4
                           AND history.agent_thread_id=$5
                           AND history.replacement_sequence < $20) AS replacement_history,
                       created_at`,
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
              previousCheckpointRow === undefined
                ? null
                : Number(previousCheckpointRow.window_start_sequence),
              previousCheckpointRow === undefined
                ? null
                : Number(previousCheckpointRow.replacement_history_length),
              input.windowStartSequence,
              boundary.window_start_kind,
              boundary.window_start_tool_call_id,
              input.throughSequence,
              boundary.through_kind,
              boundary.through_tool_call_id,
              JSON.stringify(projection),
              projectionDigest,
              replacementHistory.length,
              previousReplacementDigest ?? null,
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
              commandDigest,
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

  async loadRecovery(input: {
    readonly context: TrustedRolloutContext;
    readonly compatibility: RolloutCompatibilityIdentity;
  }): Promise<LoadRecoveryResult> {
    assertContext(input.context);
    assertBoundedText(input.compatibility.modelId, "Model ID", 255);
    for (const hash of [
      input.compatibility.modelCompatibilityHash,
      input.compatibility.promptPolicyHash,
      input.compatibility.toolSchemaHash,
      input.compatibility.skillManifestHash,
    ]) {
      assertHash(hash, "Rollout compatibility hash");
    }
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          const params = scopeParams(input.context);
          const result = await client.query<RecoveryRow>(
            `WITH authorized_stream AS (
               SELECT stream.*
                 FROM runtime_rollout_streams stream
                 JOIN memberships membership
                   ON membership.tenant_id=stream.tenant_id
                  AND membership.user_id=$6 AND membership.status='active'
                WHERE stream.tenant_id=$1 AND stream.thread_id=$2 AND stream.run_id=$3
                  AND stream.attempt_id=$4 AND stream.agent_thread_id=$5
             ), latest_checkpoint AS (
               SELECT checkpoint.*
                 FROM runtime_rollout_checkpoints checkpoint
                 JOIN authorized_stream stream
                   ON stream.tenant_id=checkpoint.tenant_id
                  AND stream.thread_id=checkpoint.thread_id
                  AND stream.run_id=checkpoint.run_id
                  AND stream.attempt_id=checkpoint.attempt_id
                  AND stream.agent_thread_id=checkpoint.agent_thread_id
                ORDER BY checkpoint.checkpoint_sequence DESC LIMIT 1
             )
             SELECT stream.model_id, stream.model_compatibility_hash,
                    stream.prompt_policy_hash, stream.tool_schema_hash,
                    stream.skill_manifest_hash,
                    checkpoint.checkpoint_id, checkpoint.window_start_sequence,
                    checkpoint.through_sequence, checkpoint.projection,
                    checkpoint.projection_digest, checkpoint.created_at,
                    coalesce((
                      SELECT jsonb_agg(history.replacement ORDER BY history.replacement_sequence)
                        FROM runtime_rollout_replacements history
                       WHERE history.tenant_id=stream.tenant_id
                         AND history.thread_id=stream.thread_id
                         AND history.run_id=stream.run_id
                         AND history.attempt_id=stream.attempt_id
                         AND history.agent_thread_id=stream.agent_thread_id
                         AND history.replacement_sequence < checkpoint.replacement_history_length
                    ), '[]'::jsonb) AS replacement_history,
                    coalesce((
                      SELECT jsonb_agg(jsonb_build_object(
                        'sequence', entry.sequence::text,
                        'kind', entry.kind,
                        'tool_call_id', entry.tool_call_id,
                        'body', entry.body,
                        'body_digest', entry.body_digest,
                        'is_truncated', entry.is_truncated,
                        'blob_reference_id', entry.blob_reference_id,
                        'blob_sha256', entry.blob_sha256,
                        'blob_size', entry.blob_size::text,
                        'occurred_at', entry.occurred_at
                      ) ORDER BY entry.sequence)
                        FROM runtime_rollout_entries entry
                       WHERE entry.tenant_id=stream.tenant_id
                         AND entry.thread_id=stream.thread_id
                         AND entry.run_id=stream.run_id
                         AND entry.attempt_id=stream.attempt_id
                         AND entry.agent_thread_id=stream.agent_thread_id
                         AND entry.sequence > coalesce(checkpoint.through_sequence, -1)
                    ), '[]'::jsonb) AS tail_entries
               FROM authorized_stream stream
               LEFT JOIN latest_checkpoint checkpoint ON true`,
            [...params, input.context.userId],
          );
          const row = result.rows[0];
          if (row === undefined) return { outcome: "not_found" };
          const mismatches: RolloutCompatibilityField[] = [];
          if (row.model_id !== input.compatibility.modelId) mismatches.push("modelId");
          if (row.model_compatibility_hash !== input.compatibility.modelCompatibilityHash) {
            mismatches.push("modelCompatibilityHash");
          }
          if (row.prompt_policy_hash !== input.compatibility.promptPolicyHash) {
            mismatches.push("promptPolicyHash");
          }
          if (row.tool_schema_hash !== input.compatibility.toolSchemaHash) {
            mismatches.push("toolSchemaHash");
          }
          if (row.skill_manifest_hash !== input.compatibility.skillManifestHash) {
            mismatches.push("skillManifestHash");
          }
          if (mismatches.length > 0) {
            return Object.freeze({
              outcome: "compatibility_mismatch" as const,
              action: "rebuild_attempt" as const,
              mismatches: Object.freeze(mismatches),
            });
          }
          if (!Array.isArray(row.tail_entries)) {
            throw new Error("Rollout recovery tail 格式无效");
          }
          const checkpoint =
            row.checkpoint_id === null ? undefined : mapCheckpoint(row as unknown as CheckpointRow);
          return Object.freeze({
            outcome: "loaded" as const,
            ...(checkpoint === undefined ? {} : { checkpoint }),
            tail: Object.freeze(row.tail_entries.map((entry) => mapEntry(entry as EntryRow))),
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
              projection_digest,
              (SELECT coalesce(jsonb_agg(replacement ORDER BY replacement_sequence), '[]')
                 FROM runtime_rollout_replacements history
                WHERE history.tenant_id=checkpoint.tenant_id
                  AND history.thread_id=checkpoint.thread_id
                  AND history.run_id=checkpoint.run_id
                  AND history.attempt_id=checkpoint.attempt_id
                  AND history.agent_thread_id=checkpoint.agent_thread_id
                  AND history.replacement_sequence < checkpoint.replacement_history_length
              ) AS replacement_history,
              created_at
         FROM runtime_rollout_checkpoints checkpoint
        WHERE checkpoint.tenant_id=$1 AND checkpoint.thread_id=$2
          AND checkpoint.run_id=$3 AND checkpoint.attempt_id=$4
          AND checkpoint.agent_thread_id=$5 AND checkpoint.checkpoint_id=$6`,
      [...scopeParams(context), checkpointId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapCheckpoint(row);
  }
}
