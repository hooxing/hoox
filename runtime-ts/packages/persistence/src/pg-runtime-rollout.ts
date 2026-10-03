import { createHash } from "node:crypto";
import {
  assertControlledToolObservation,
  encodeControlledToolReceipt,
  parseControlledToolReceipt,
} from "@hoox/context-policy";
import type {
  RolloutCompatibilityIdentity,
  RolloutScope,
  RuntimeRolloutCheckpoint,
  RuntimeRolloutEntry,
  RuntimeRolloutEntryKind,
  Sha256Digest,
  UserId,
} from "@hoox/domain";
import { agentThreadId, isoTimestamp, sha256Digest, userId } from "@hoox/domain";
import type { ExecutionFence } from "@hoox/run-contracts";
import { digestCanonical } from "@hoox/run-contracts/mutation-protocol";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import {
  withRetriedRepeatableReadTenantTransaction,
  withRetriedSerializableTenantTransaction,
  withTenantTransaction,
} from "./postgres.js";

const HASH = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const KEY = /^[\x21-\x7e]{1,512}$/u;

export interface TrustedRolloutContext {
  readonly scope: RolloutScope;
  readonly userId: UserId;
  /** 每次读写都会在同一事务重新验证；对象本身不是绕过 PG 的授权证明。 */
  readonly fence: ExecutionFence;
}

export interface OpenRootRolloutInput {
  readonly context: TrustedRolloutContext;
  readonly workspaceId: string;
  readonly rootRunId: string;
  readonly compatibility: RolloutCompatibilityIdentity;
}

export interface OpenRootRolloutFromClaimInput {
  readonly fence: ExecutionFence;
  readonly attemptId: string;
  readonly compatibility: RolloutCompatibilityIdentity;
}

export interface OpenAgentRolloutFromClaimInput extends OpenRootRolloutFromClaimInput {
  readonly agentThreadId: ReturnType<typeof agentThreadId>;
  readonly agentKind: "root" | "subagent";
}

export type OpenRootRolloutFromClaimResult =
  | { readonly outcome: "ready"; readonly context: TrustedRolloutContext }
  | { readonly outcome: "conflict" | "not_authorized" | "not_found" };

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

export interface AppendPtcToolCallInput {
  readonly context: TrustedRolloutContext;
  readonly idempotencyKey: string;
  readonly toolCallId: string;
  readonly parentToolCallId: string;
  readonly toolName: string;
}

export interface AppendPtcToolResultInput {
  readonly context: TrustedRolloutContext;
  readonly idempotencyKey: string;
  readonly toolCallId: string;
  readonly parentToolCallId: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly isTruncated: boolean;
  readonly blob: NonNullable<RolloutEntryDraft["blob"]>;
}

export interface RuntimePtcDispatch {
  readonly toolCallId: string;
  readonly parentToolCallId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly runClaimToken: string;
  readonly runClaimEpoch: number;
  readonly workspaceLeaseEpoch: number;
  readonly result?: {
    readonly body: Readonly<Record<string, unknown>>;
    readonly isTruncated: boolean;
    readonly completedAt: string;
    readonly blob: NonNullable<RolloutEntryDraft["blob"]> & {
      readonly kind: "stable";
      readonly purpose: "trace";
      readonly incarnationId: string;
      readonly physicalObjectKey: string;
    };
  };
}

interface PtcDispatchRow extends QueryResultRow {
  readonly tool_call_id: string;
  readonly parent_tool_call_id: string;
  readonly tool_name: string;
  readonly thread_id: string;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly agent_thread_id: string;
  readonly start_idempotency_key: string;
  readonly start_digest: string;
  readonly started_at: Date;
  readonly run_claim_token: string;
  readonly run_claim_epoch: string;
  readonly workspace_lease_epoch: string;
  readonly result_idempotency_key: string | null;
  readonly result_digest: string | null;
  readonly result_body: Readonly<Record<string, unknown>> | null;
  readonly is_truncated: boolean | null;
  readonly blob_reference_id: string | null;
  readonly blob_sha256: string | null;
  readonly blob_size: string | null;
  readonly completed_at: Date | null;
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
      /** 已由同一只读快照读取的 Stream 身份，恢复投影器仍须逐项复核。 */
      readonly recordedCompatibility: RolloutCompatibilityIdentity;
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

function assertCompatibility(compatibility: RolloutCompatibilityIdentity): void {
  assertBoundedText(compatibility.modelId, "Model ID", 255);
  for (const [label, hash] of [
    ["Model compatibility hash", compatibility.modelCompatibilityHash],
    ["Prompt policy hash", compatibility.promptPolicyHash],
    ["Tool schema hash", compatibility.toolSchemaHash],
    ["Skill manifest hash", compatibility.skillManifestHash],
  ] as const) {
    assertHash(hash, label);
  }
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
  const execution = context.fence.scope;
  for (const [label, value] of [
    ["Workspace ID", execution.workspaceId],
    ["Root Run ID", execution.rootRunId],
    ["Run claim token", context.fence.runClaim.token],
    ["Workspace lease root Run ID", context.fence.workspaceLease.rootRunId],
  ] as const) {
    assertIdentifier(value, label);
  }
  if (execution.baseRevisionId !== undefined) {
    assertIdentifier(execution.baseRevisionId, "Base revision ID");
  }
  if (
    execution.tenantId !== scope.tenantId ||
    execution.threadId !== scope.threadId ||
    execution.runId !== scope.runId ||
    execution.rootRunId !== context.fence.workspaceLease.rootRunId ||
    !Number.isSafeInteger(context.fence.runClaim.epoch) ||
    context.fence.runClaim.epoch < 0 ||
    !Number.isSafeInteger(context.fence.workspaceLease.epoch) ||
    context.fence.workspaceLease.epoch < 0
  ) {
    throw new TypeError("Rollout 双栅栏与执行 scope 不匹配");
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
async function lockActiveExecutionFence(
  client: PoolClient,
  context: TrustedRolloutContext,
): Promise<boolean> {
  const result = await client.query(
    `SELECT membership.user_id
       FROM execution_attempts attempt
       JOIN run_claims claim
         ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
       JOIN workspace_write_leases lease
         ON lease.tenant_id=attempt.tenant_id AND lease.workspace_id=attempt.workspace_id
        AND lease.root_run_id=attempt.root_run_id AND lease.epoch=claim.workspace_lease_epoch
       JOIN threads thread_state
         ON thread_state.tenant_id=attempt.tenant_id AND thread_state.id=attempt.thread_id
       JOIN memberships membership
         ON membership.tenant_id=thread_state.tenant_id
        AND membership.user_id=thread_state.created_by_user_id
        AND membership.status='active'
      WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$2
        AND attempt.thread_id=$3 AND attempt.run_id=$4
        AND attempt.workspace_id=$5 AND attempt.root_run_id=$6
        AND attempt.base_revision_id IS NOT DISTINCT FROM $7
        AND attempt.status IN ('claimed','running','finalizing','waiting')
        AND thread_state.created_by_user_id=$8
        AND claim.run_id=attempt.run_id AND claim.thread_id=attempt.thread_id
        AND claim.workspace_id=attempt.workspace_id AND claim.root_run_id=attempt.root_run_id
        AND claim.claim_token=$9 AND claim.claim_epoch=$10
        AND claim.workspace_lease_epoch=$11 AND claim.released_at IS NULL
        AND claim.expires_at > clock_timestamp()
        AND lease.thread_id=attempt.thread_id
        AND lease.expires_at > clock_timestamp()
      FOR SHARE OF attempt,claim,lease,membership
    `,
    [
      context.scope.tenantId,
      context.scope.attemptId,
      context.scope.threadId,
      context.scope.runId,
      context.fence.scope.workspaceId,
      context.fence.scope.rootRunId,
      context.fence.scope.baseRevisionId ?? null,
      context.userId,
      context.fence.runClaim.token,
      context.fence.runClaim.epoch,
      context.fence.workspaceLease.epoch,
    ],
  );
  return result.rowCount === 1;
}

function assertPtcInput(input: AppendPtcToolCallInput | AppendPtcToolResultInput): void {
  assertContext(input.context);
  if (!KEY.test(input.idempotencyKey)) throw new TypeError("PTC 幂等键格式无效");
  assertIdentifier(input.toolCallId, "PTC Tool call ID");
  assertIdentifier(input.parentToolCallId, "PTC 父 Tool call ID");
  if (input.toolCallId === input.parentToolCallId)
    throw new TypeError("PTC 内层调用不能以自身为父调用");
}

function samePtcScope(row: PtcDispatchRow, context: TrustedRolloutContext): boolean {
  return (
    row.thread_id === context.scope.threadId &&
    row.run_id === context.scope.runId &&
    row.attempt_id === context.scope.attemptId &&
    row.agent_thread_id === context.scope.agentThreadId &&
    row.run_claim_token === context.fence.runClaim.token &&
    Number(row.run_claim_epoch) === context.fence.runClaim.epoch &&
    Number(row.workspace_lease_epoch) === context.fence.workspaceLease.epoch
  );
}

function assertPtcReceipt(
  body: Readonly<Record<string, unknown>>,
  blob: NonNullable<RolloutEntryDraft["blob"]>,
  isTruncated: boolean,
): { readonly toolName: string } {
  assertJsonRecord(body.receipt, "PTC 固定受控回执");
  const receipt = body.receipt;
  if (
    typeof receipt.toolName !== "string" ||
    (receipt.outcome !== "succeeded" && receipt.outcome !== "failed")
  ) {
    throw new TypeError("PTC 结果不是固定受控回执");
  }
  const encoded = encodeControlledToolReceipt(receipt.toolName, receipt.outcome);
  if (
    body.schemaVersion !== 2 ||
    body.toolName !== receipt.toolName ||
    digestCanonical(receipt) !== digestCanonical(JSON.parse(encoded)) ||
    body.receiptSha256 !== blob.sha256 ||
    body.receiptBytes !== blob.size ||
    blob.sha256 !== createHash("sha256").update(encoded).digest("hex") ||
    blob.size !== Buffer.byteLength(encoded, "utf8") ||
    digestCanonical(body.traceBlob) !== digestCanonical({ referenceId: blob.referenceId })
  ) {
    throw new TypeError("PTC 回执与 stable trace 身份不匹配");
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "toolName",
    "receiptSha256",
    "receiptBytes",
    "receipt",
    "traceBlob",
    "truncation",
    "observation",
  ]);
  assertJsonRecord(body.truncation, "PTC 回执截断元数据");
  const truncation = body.truncation;
  if (
    Object.keys(body).some((key) => !allowedKeys.has(key)) ||
    typeof body.observation !== "string" ||
    truncation.isTruncated !== isTruncated ||
    typeof truncation.modelVisibleBytes !== "number" ||
    (truncation.reason !== undefined && typeof truncation.reason !== "string") ||
    Object.keys(truncation).some(
      (key) => !["isTruncated", "reason", "modelVisibleBytes"].includes(key),
    )
  ) {
    throw new TypeError("PTC journal 只允许固定受控回执与有界投影");
  }
  assertControlledToolObservation({
    receipt: parseControlledToolReceipt(encoded),
    observation: body.observation,
    isTruncated,
    modelVisibleBytes: truncation.modelVisibleBytes,
    ...(truncation.reason === undefined ? {} : { reason: truncation.reason as string }),
  });
  return { toolName: receipt.toolName };
}

function mapPtcDispatch(
  row: PtcDispatchRow & {
    readonly incarnation_id: string | null;
    readonly physical_object_key: string | null;
  },
): RuntimePtcDispatch {
  let result: RuntimePtcDispatch["result"];
  if (row.result_body !== null) {
    if (
      row.is_truncated === null ||
      row.completed_at === null ||
      row.blob_reference_id === null ||
      row.blob_sha256 === null ||
      row.blob_size === null ||
      row.incarnation_id === null ||
      row.physical_object_key === null
    )
      throw new Error("PTC journal 回执缺少 stable trace 身份");
    result = Object.freeze({
      body: Object.freeze(row.result_body),
      isTruncated: row.is_truncated,
      completedAt: row.completed_at.toISOString(),
      blob: Object.freeze({
        referenceId: row.blob_reference_id,
        sha256: sha256Digest(row.blob_sha256),
        size: Number(row.blob_size),
        kind: "stable",
        purpose: "trace",
        incarnationId: row.incarnation_id,
        physicalObjectKey: row.physical_object_key,
      }),
    });
  }
  return Object.freeze({
    toolCallId: row.tool_call_id,
    parentToolCallId: row.parent_tool_call_id,
    toolName: row.tool_name,
    startedAt: row.started_at.toISOString(),
    runClaimToken: row.run_claim_token,
    runClaimEpoch: Number(row.run_claim_epoch),
    workspaceLeaseEpoch: Number(row.workspace_lease_epoch),
    ...(result === undefined ? {} : { result }),
  });
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
    if (draft.kind !== "tool_result") throw new TypeError("只有 Tool result 可以引用受控回执 Blob");
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

  /**
   * 生产 Worker 的唯一 root stream 入口：调用方只持有当前双栅栏，userId 与 AgentThread
   * 均由同一 PG 事务中的 claim、Thread owner 和 active Membership 事实推导。
   */
  async openRootStreamFromClaim(
    input: OpenRootRolloutFromClaimInput,
  ): Promise<OpenRootRolloutFromClaimResult> {
    return await this.openAgentStreamFromClaim({
      ...input,
      agentThreadId: agentThreadId(
        `root_${createHash("sha256").update(input.attemptId, "utf8").digest("hex")}`,
      ),
      agentKind: "root",
    });
  }

  /** 子 Agent 与 root 共享执行双栅栏，但使用独立 agent_thread_id 和 Rollout sequence。 */
  async openAgentStreamFromClaim(
    input: OpenAgentRolloutFromClaimInput,
  ): Promise<OpenRootRolloutFromClaimResult> {
    const { fence } = input;
    for (const [label, value] of [
      ["Tenant ID", fence.scope.tenantId],
      ["Thread ID", fence.scope.threadId],
      ["Run ID", fence.scope.runId],
      ["Attempt ID", input.attemptId],
      ["Workspace ID", fence.scope.workspaceId],
      ["Root Run ID", fence.scope.rootRunId],
      ["Run claim token", fence.runClaim.token],
    ] as const) {
      assertIdentifier(value, label);
    }
    if (fence.scope.baseRevisionId !== undefined) {
      assertIdentifier(fence.scope.baseRevisionId, "Base revision ID");
    }
    if (
      !Number.isSafeInteger(fence.runClaim.epoch) ||
      fence.runClaim.epoch < 0 ||
      !Number.isSafeInteger(fence.workspaceLease.epoch) ||
      fence.workspaceLease.epoch < 0 ||
      fence.workspaceLease.rootRunId !== fence.scope.rootRunId
    ) {
      throw new TypeError("执行栅栏 epoch 格式无效");
    }
    assertIdentifier(input.agentThreadId, "Agent Thread ID");
    assertCompatibility(input.compatibility);
    try {
      return await withRetriedSerializableTenantTransaction(
        this.pool,
        { tenantId: fence.scope.tenantId },
        async (client) => {
          const actor = await client.query<{ created_by_user_id: string }>(
            `SELECT thread_state.created_by_user_id
               FROM execution_attempts attempt
               JOIN run_claims claim
                 ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
               JOIN threads thread_state
                 ON thread_state.tenant_id=attempt.tenant_id AND thread_state.id=attempt.thread_id
               JOIN workspace_write_leases lease
                 ON lease.tenant_id=attempt.tenant_id
                AND lease.workspace_id=attempt.workspace_id
                AND lease.root_run_id=attempt.root_run_id
                AND lease.epoch=claim.workspace_lease_epoch
               JOIN memberships membership
                 ON membership.tenant_id=thread_state.tenant_id
                AND membership.user_id=thread_state.created_by_user_id
                AND membership.status='active'
              WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$2
                AND attempt.run_id=$3 AND attempt.thread_id=$4
                AND attempt.workspace_id=$5 AND attempt.root_run_id=$6
                AND attempt.base_revision_id IS NOT DISTINCT FROM $7
                AND attempt.status IN ('claimed','running','finalizing','waiting')
                AND claim.run_id=attempt.run_id AND claim.thread_id=attempt.thread_id
                AND claim.workspace_id=attempt.workspace_id
                AND claim.root_run_id=attempt.root_run_id
                AND claim.claim_token=$8 AND claim.claim_epoch=$9
                AND claim.workspace_lease_epoch=$10
                AND claim.released_at IS NULL
                AND claim.expires_at > clock_timestamp()
                AND lease.thread_id=attempt.thread_id
                AND lease.expires_at > clock_timestamp()
              FOR SHARE OF attempt,claim,lease,membership`,
            [
              fence.scope.tenantId,
              input.attemptId,
              fence.scope.runId,
              fence.scope.threadId,
              fence.scope.workspaceId,
              fence.scope.rootRunId,
              fence.scope.baseRevisionId ?? null,
              fence.runClaim.token,
              fence.runClaim.epoch,
              fence.workspaceLease.epoch,
            ],
          );
          const actorUserId = actor.rows[0]?.created_by_user_id;
          if (actorUserId === undefined) return { outcome: "not_authorized" } as const;
          await client.query("SELECT set_config('app.user_id',$1,true)", [actorUserId]);
          const context: TrustedRolloutContext = Object.freeze({
            scope: Object.freeze({
              tenantId: fence.scope.tenantId,
              threadId: fence.scope.threadId,
              runId: fence.scope.runId,
              attemptId: input.attemptId,
              agentThreadId: input.agentThreadId,
            }),
            userId: userId(actorUserId),
            fence: Object.freeze({
              scope: Object.freeze({ ...fence.scope }),
              runClaim: Object.freeze({ ...fence.runClaim }),
              workspaceLease: Object.freeze({ ...fence.workspaceLease }),
            }),
          });
          const opened = await this.openStreamLocked(
            client,
            {
              context,
              workspaceId: fence.scope.workspaceId,
              rootRunId: fence.scope.rootRunId,
              compatibility: input.compatibility,
            },
            input.agentKind,
          );
          return opened === "created" || opened === "already_exists"
            ? ({ outcome: "ready", context } as const)
            : ({ outcome: opened } as const);
        },
      );
    } catch (error) {
      throw mapPersistenceError(error, "从执行 claim 打开 Runtime Rollout stream");
    }
  }

  async openRootStream(
    input: OpenRootRolloutInput,
  ): Promise<"created" | "already_exists" | "conflict" | "not_authorized" | "not_found"> {
    assertContext(input.context);
    assertIdentifier(input.workspaceId, "Workspace ID");
    assertIdentifier(input.rootRunId, "Root Run ID");
    if (
      input.workspaceId !== input.context.fence.scope.workspaceId ||
      input.rootRunId !== input.context.fence.scope.rootRunId
    ) {
      throw new TypeError("Rollout stream 与执行 scope 不匹配");
    }
    assertCompatibility(input.compatibility);
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          if (!(await lockActiveExecutionFence(client, input.context))) return "not_authorized";
          return await this.openStreamLocked(client, input, "root");
        },
      );
    } catch (error) {
      throw mapPersistenceError(error, "打开 Runtime Rollout stream");
    }
  }

  private async openStreamLocked(
    client: PoolClient,
    input: OpenRootRolloutInput,
    agentKind: "root" | "subagent",
  ): Promise<"created" | "already_exists" | "conflict" | "not_found"> {
    const params = scopeParams(input.context);
    if (agentKind === "root") {
      await client.query(
        `INSERT INTO runtime_agent_threads(
           tenant_id,thread_id,run_id,attempt_id,agent_thread_id,canonical_path,kind,status
         ) VALUES ($1,$2,$3,$4,$5,'/root','root','open')
         ON CONFLICT DO NOTHING`,
        params,
      );
      const root = await client.query<{ agent_thread_id: string; kind: string }>(
        `SELECT agent_thread_id,kind FROM runtime_agent_threads
          WHERE tenant_id=$1 AND attempt_id=$2 AND canonical_path='/root'`,
        [input.context.scope.tenantId, input.context.scope.attemptId],
      );
      if (
        root.rows[0]?.agent_thread_id !== input.context.scope.agentThreadId ||
        root.rows[0]?.kind !== "root"
      ) {
        return "conflict";
      }
    } else {
      const child = await client.query<{ kind: string }>(
        `SELECT kind FROM runtime_agent_threads
          WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3`,
        [
          input.context.scope.tenantId,
          input.context.scope.attemptId,
          input.context.scope.agentThreadId,
        ],
      );
      if (child.rows[0] === undefined) return "not_found";
      if (child.rows[0].kind !== "subagent") return "conflict";
    }
    const inserted = await client.query(
      `INSERT INTO runtime_rollout_streams(
               tenant_id, thread_id, run_id, attempt_id, workspace_id, root_run_id,
               agent_thread_id, agent_kind, model_id, model_compatibility_hash,
               prompt_policy_hash, tool_schema_hash, skill_manifest_hash
             ) VALUES ($1,$2,$3,$4,$6,$7,$5,$13,$8,$9,$10,$11,$12)
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
        agentKind,
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
              WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3`,
      [
        input.context.scope.tenantId,
        input.context.scope.attemptId,
        input.context.scope.agentThreadId,
      ],
    );
    const row = existing.rows[0];
    if (row === undefined) return "not_found";
    return row.thread_id === input.context.scope.threadId &&
      row.run_id === input.context.scope.runId &&
      row.agent_thread_id === input.context.scope.agentThreadId &&
      row.workspace_id === input.workspaceId &&
      row.root_run_id === input.rootRunId &&
      row.agent_kind === agentKind &&
      row.model_id === input.compatibility.modelId &&
      row.model_compatibility_hash === input.compatibility.modelCompatibilityHash &&
      row.prompt_policy_hash === input.compatibility.promptPolicyHash &&
      row.tool_schema_hash === input.compatibility.toolSchemaHash &&
      row.skill_manifest_hash === input.compatibility.skillManifestHash
      ? "already_exists"
      : "conflict";
  }

  /** 开始事实必须先提交才能 dispatch；内层调用不消耗 Rollout sequence。 */
  async appendPtcToolCall(input: AppendPtcToolCallInput): Promise<RolloutWriteResult<void>> {
    assertPtcInput(input);
    assertIdentifier(input.toolName, "PTC Tool 名称");
    const commandDigest = digestCanonical({
      schemaVersion: 1,
      toolCallId: input.toolCallId,
      parentToolCallId: input.parentToolCallId,
      toolName: input.toolName,
    });
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          if (!(await lockActiveExecutionFence(client, input.context)))
            return { outcome: "not_authorized" };
          const parentSequence = await this.lockOpenPtcParent(
            client,
            input.context,
            input.parentToolCallId,
          );
          if (parentSequence === undefined) return { outcome: "conflict" };
          // Provider 可跨 Run/Attempt 复用调用 ID；完整 stream scope 内必须命中同一开始事实。
          const existing = await client.query<PtcDispatchRow>(
            `SELECT * FROM runtime_ptc_dispatches WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3
               AND attempt_id=$4 AND agent_thread_id=$5 AND (tool_call_id=$6 OR start_idempotency_key=$7)`,
            [...scopeParams(input.context), input.toolCallId, input.idempotencyKey],
          );
          if (existing.rows.length > 0) {
            const row = existing.rows[0];
            return existing.rows.length === 1 &&
              row !== undefined &&
              samePtcScope(row, input.context) &&
              row.tool_call_id === input.toolCallId &&
              row.start_idempotency_key === input.idempotencyKey &&
              row.start_digest === commandDigest
              ? { outcome: "replayed", value: undefined }
              : { outcome: "conflict" };
          }
          await client.query(
            `INSERT INTO runtime_ptc_dispatches(
              tenant_id,thread_id,run_id,attempt_id,agent_thread_id,workspace_id,root_run_id,base_revision_id,
              run_claim_token,run_claim_epoch,workspace_lease_epoch,tool_call_id,parent_tool_call_id,
              parent_sequence,tool_name,start_idempotency_key,start_digest
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [
              ...scopeParams(input.context),
              input.context.fence.scope.workspaceId,
              input.context.fence.scope.rootRunId,
              input.context.fence.scope.baseRevisionId ?? null,
              input.context.fence.runClaim.token,
              input.context.fence.runClaim.epoch,
              input.context.fence.workspaceLease.epoch,
              input.toolCallId,
              input.parentToolCallId,
              parentSequence,
              input.toolName,
              input.idempotencyKey,
              commandDigest,
            ],
          );
          return { outcome: "created", value: undefined };
        },
      );
    } catch (error) {
      throw mapPersistenceError(error, "记录 PTC 内层调用开始");
    }
  }

  /** 只补齐已有开始事实的固定受控回执；未知结果不能自行合成 succeeded。 */
  async appendPtcToolResult(input: AppendPtcToolResultInput): Promise<RolloutWriteResult<void>> {
    assertPtcInput(input);
    const draft = normalizeDraft({
      kind: "tool_result",
      toolCallId: input.toolCallId,
      body: input.body,
      isTruncated: input.isTruncated,
      blob: input.blob,
    });
    const blob = draft.blob;
    if (blob === undefined) throw new TypeError("PTC 回执必须引用 stable trace Blob");
    const receipt = assertPtcReceipt(draft.body, blob, input.isTruncated);
    const commandDigest = digestCanonical({
      schemaVersion: 1,
      toolCallId: input.toolCallId,
      parentToolCallId: input.parentToolCallId,
      body: draft.body,
      isTruncated: draft.isTruncated,
      blob,
    });
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          if (!(await lockActiveExecutionFence(client, input.context)))
            return { outcome: "not_authorized" };
          if (
            (await this.lockOpenPtcParent(client, input.context, input.parentToolCallId)) ===
            undefined
          ) {
            return { outcome: "conflict" };
          }
          const existing = await client.query<PtcDispatchRow>(
            `SELECT * FROM runtime_ptc_dispatches WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3
               AND attempt_id=$4 AND agent_thread_id=$5 AND tool_call_id=$6 FOR UPDATE`,
            [...scopeParams(input.context), input.toolCallId],
          );
          const row = existing.rows[0];
          if (row === undefined) return { outcome: "not_found" };
          if (
            !samePtcScope(row, input.context) ||
            row.parent_tool_call_id !== input.parentToolCallId ||
            row.tool_name !== receipt.toolName
          )
            return { outcome: "conflict" };
          if (row.result_digest !== null) {
            return row.result_idempotency_key === input.idempotencyKey &&
              row.result_digest === commandDigest
              ? { outcome: "replayed", value: undefined }
              : { outcome: "conflict" };
          }
          const key = await client.query(
            `SELECT 1 FROM runtime_ptc_dispatches WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3
               AND attempt_id=$4 AND agent_thread_id=$5 AND result_idempotency_key=$6`,
            [...scopeParams(input.context), input.idempotencyKey],
          );
          if (key.rowCount !== 0) return { outcome: "conflict" };
          // FK 在提交时重新约束 stable/trace 引用，不能只信任上传端口返回的身份。
          await client.query(
            `UPDATE runtime_ptc_dispatches SET result_idempotency_key=$7,result_digest=$8,
              result_body=$9::jsonb,is_truncated=$10,blob_reference_id=$11,blob_state='stable',
              blob_purpose='trace',blob_sha256=$12,blob_size=$13,completed_at=clock_timestamp()
             WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4 AND agent_thread_id=$5
               AND tool_call_id=$6 AND result_digest IS NULL`,
            [
              ...scopeParams(input.context),
              input.toolCallId,
              input.idempotencyKey,
              commandDigest,
              JSON.stringify(draft.body),
              draft.isTruncated,
              blob.referenceId,
              blob.sha256,
              blob.size,
            ],
          );
          return { outcome: "created", value: undefined };
        },
      );
    } catch (error) {
      throw mapPersistenceError(error, "记录 PTC 内层受控回执");
    }
  }

  /**
   * 只读核对某个父调用的 journal，允许诊断已失效栅栏；仅验证当前成员与 scope 所有权。
   * 开始而无结果的记录代表未知，绝不授权重放内部副作用，也不进入模型或 Thread 历史。
   */
  async listPtcDispatchesByParent(input: {
    readonly context: TrustedRolloutContext;
    readonly parentToolCallId: string;
  }): Promise<
    | { readonly outcome: "loaded"; readonly dispatches: readonly RuntimePtcDispatch[] }
    | { readonly outcome: "not_authorized" }
  > {
    assertContext(input.context);
    assertIdentifier(input.parentToolCallId, "PTC 父 Tool call ID");
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          const authorized = await client.query(
            `SELECT 1 FROM runtime_rollout_streams stream
               JOIN threads thread_state ON thread_state.tenant_id=stream.tenant_id AND thread_state.id=stream.thread_id
               JOIN memberships member ON member.tenant_id=stream.tenant_id
                 AND member.user_id=thread_state.created_by_user_id AND member.status='active'
               JOIN execution_attempts attempt ON attempt.tenant_id=stream.tenant_id AND attempt.attempt_id=stream.attempt_id
              WHERE stream.tenant_id=$1 AND stream.thread_id=$2 AND stream.run_id=$3 AND stream.attempt_id=$4
                AND stream.agent_thread_id=$5 AND member.user_id=$6 AND stream.workspace_id=$7
                AND stream.root_run_id=$8 AND attempt.base_revision_id IS NOT DISTINCT FROM $9`,
            [
              ...scopeParams(input.context),
              input.context.userId,
              input.context.fence.scope.workspaceId,
              input.context.fence.scope.rootRunId,
              input.context.fence.scope.baseRevisionId ?? null,
            ],
          );
          if (authorized.rowCount !== 1) return { outcome: "not_authorized" };
          const result = await client.query<
            PtcDispatchRow & {
              incarnation_id: string | null;
              physical_object_key: string | null;
            }
          >(
            `SELECT dispatch.*,blob.incarnation_id,blob.physical_object_key FROM runtime_ptc_dispatches dispatch
               LEFT JOIN blob_references blob ON blob.tenant_id=dispatch.tenant_id
                 AND blob.reference_id=dispatch.blob_reference_id
              WHERE dispatch.tenant_id=$1 AND dispatch.thread_id=$2 AND dispatch.run_id=$3
                AND dispatch.attempt_id=$4 AND dispatch.agent_thread_id=$5 AND dispatch.parent_tool_call_id=$6
              ORDER BY dispatch.started_at,dispatch.tool_call_id`,
            [...scopeParams(input.context), input.parentToolCallId],
          );
          return {
            outcome: "loaded",
            dispatches: Object.freeze(result.rows.map(mapPtcDispatch)),
          };
        },
        { isolationLevel: "REPEATABLE READ", readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "核对 PTC 内层调用日志");
    }
  }

  private async lockOpenPtcParent(
    client: PoolClient,
    context: TrustedRolloutContext,
    parentToolCallId: string,
  ): Promise<string | undefined> {
    const params = scopeParams(context);
    // 与外层 append 共用流锁：父调用闭合与 journal 写入必须形成唯一线性化顺序。
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      params.join("\u001f"),
    ]);
    const tail = await client.query<EntryRow>(
      `SELECT sequence,kind,tool_call_id,body FROM runtime_rollout_entries
        WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND attempt_id=$4 AND agent_thread_id=$5
        ORDER BY sequence DESC LIMIT 1`,
      params,
    );
    const row = tail.rows[0];
    return row?.kind === "tool_call" &&
      row.tool_call_id === parentToolCallId &&
      (row.body as Record<string, unknown>).toolName === "run_code"
      ? row.sequence
      : undefined;
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
          if (!(await lockActiveExecutionFence(client, input.context))) {
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
          if (!(await lockActiveExecutionFence(client, input.context))) {
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
      return await withRetriedRepeatableReadTenantTransaction(
        this.pool,
        { tenantId: input.context.scope.tenantId, userId: input.context.userId },
        async (client) => {
          const params = scopeParams(input.context);
          const result = await client.query<RecoveryRow>(
            `WITH authorized_stream AS MATERIALIZED (
               SELECT stream.*
                 FROM runtime_rollout_streams stream
                 JOIN execution_attempts attempt
                   ON attempt.tenant_id=stream.tenant_id
                  AND attempt.attempt_id=stream.attempt_id
                 JOIN run_claims claim
                   ON claim.tenant_id=attempt.tenant_id
                  AND claim.attempt_id=attempt.attempt_id
                 JOIN workspace_write_leases lease
                   ON lease.tenant_id=attempt.tenant_id
                  AND lease.workspace_id=attempt.workspace_id
                  AND lease.root_run_id=attempt.root_run_id
                  AND lease.epoch=claim.workspace_lease_epoch
                 JOIN threads thread_state
                   ON thread_state.tenant_id=attempt.tenant_id
                  AND thread_state.id=attempt.thread_id
                 JOIN memberships membership
                   ON membership.tenant_id=stream.tenant_id
                  AND membership.user_id=thread_state.created_by_user_id
                  AND membership.status='active'
                WHERE stream.tenant_id=$1 AND stream.thread_id=$2 AND stream.run_id=$3
                  AND stream.attempt_id=$4 AND stream.agent_thread_id=$5
                  AND stream.workspace_id=$7 AND stream.root_run_id=$8
                  AND attempt.thread_id=$2 AND attempt.run_id=$3
                  AND attempt.workspace_id=$7 AND attempt.root_run_id=$8
                  AND attempt.base_revision_id IS NOT DISTINCT FROM $9
                  AND attempt.status IN ('claimed','running','finalizing','waiting')
                  AND thread_state.created_by_user_id=$6
                  AND claim.run_id=attempt.run_id AND claim.thread_id=attempt.thread_id
                  AND claim.workspace_id=attempt.workspace_id
                  AND claim.root_run_id=attempt.root_run_id
                  AND claim.claim_token=$10 AND claim.claim_epoch=$11
                  AND claim.workspace_lease_epoch=$12 AND claim.released_at IS NULL
                  AND claim.expires_at > clock_timestamp()
                  AND lease.thread_id=attempt.thread_id
                  AND lease.expires_at > clock_timestamp()
                FOR SHARE OF attempt,claim,lease,membership
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
            [
              ...params,
              input.context.userId,
              input.context.fence.scope.workspaceId,
              input.context.fence.scope.rootRunId,
              input.context.fence.scope.baseRevisionId ?? null,
              input.context.fence.runClaim.token,
              input.context.fence.runClaim.epoch,
              input.context.fence.workspaceLease.epoch,
            ],
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
            recordedCompatibility: Object.freeze({
              modelId: row.model_id,
              modelCompatibilityHash: row.model_compatibility_hash as Sha256Digest,
              promptPolicyHash: row.prompt_policy_hash as Sha256Digest,
              toolSchemaHash: row.tool_schema_hash as Sha256Digest,
              skillManifestHash: row.skill_manifest_hash as Sha256Digest,
            }),
            ...(checkpoint === undefined ? {} : { checkpoint }),
            tail: Object.freeze(row.tail_entries.map((entry) => mapEntry(entry as EntryRow))),
          });
        },
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
