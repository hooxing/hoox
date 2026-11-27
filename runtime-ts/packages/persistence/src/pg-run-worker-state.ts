import { randomUUID } from "node:crypto";
import {
  isoTimestamp,
  type Run,
  resourceId,
  resourceVersionId,
  type Sha256Digest,
  type Workspace,
  workspaceRevisionId,
} from "@hoox/domain";
import type {
  ClaimExecutionResult,
  ControlledRolloutProjection,
  ExecutionAttemptSnapshot,
  ExecutionFence,
  ExecutionPersistencePort,
  ExecutionScope,
  ExternalEffectCall,
  ExternalEffectPermit,
  FenceInspectionResult,
  OrphanSandboxCleanupPort,
  RuntimeMutation,
  RuntimeMutationReceiptV1,
  RuntimeMutationResult,
  RuntimeOutboxReceiptV1,
  RuntimeOutboxV1,
  SandboxAcquireResult,
  SandboxSessionRegistryPort,
  SandboxSettlementResult,
  UserInputAttachmentReference,
} from "@hoox/run-contracts";
import {
  assertControlledRolloutProjection,
  digestCanonical,
  isExternalCancellationFinalizationMutation,
  outboxPayloadDigest,
  rolloutProjectionDigest,
  runtimeMutationDigest,
  sandboxCleanupIdentityDigest,
  workspaceChangeDigest,
} from "@hoox/run-contracts/mutation-protocol";
import { parseWorkspaceManifest } from "@hoox/workspace";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { PersistenceError } from "./errors.js";
import { persistClientAction, scheduleClientWait } from "./pg-client-tool-calls.js";
import { enqueueMemoryIngestion } from "./pg-memory-ingestion.js";
import {
  DEFAULT_HISTORY_DIRECTORY_TIME_ZONE,
  insertHistoryAgentDeliverable,
  shouldIndexArtifactInHistory,
} from "./pg-personal-history.js";
import { isRunAgentRevoked, readRunAgentSnapshot } from "./pg-run-agent-snapshot.js";
import { RUN_EVENT_WAKE_CHANNEL, runEventWakeKey } from "./pg-run-event-wake.js";
import { readRunSkillSnapshot } from "./pg-skill-runtime.js";
import { lockThreadExecutionHead, settleActiveThreadRun } from "./pg-thread-run-queue.js";
import {
  artifactWebhookPayload,
  enqueueRunStatusWebhook,
  enqueueWebhookEvent,
} from "./pg-webhooks.js";
import {
  TransactionCommitUnknownError,
  withRetriedSerializableTenantTransaction,
  withTenantTransaction,
} from "./postgres.js";
import { mapRun, mapTenant, mapThread, mapWorkspace } from "./row-mappers.js";
import { appendThreadContext } from "./thread-context.js";
import { applyThreadSandboxTerminal } from "./thread-sandbox-session.js";
import { workspaceArtifactMediaType } from "./workspace-artifact-media.js";

type AppliedMutation = Extract<
  RuntimeMutationResult,
  { readonly outcome: "applied" | "already_applied" }
>;

class RuntimeWriteAbort extends Error {
  constructor(
    readonly outcome: "conflict" | "idempotency_conflict" | "protocol_invalid" | "fence_lost",
  ) {
    super(outcome);
  }
}

export interface PgRunWorkerStateOptions {
  /** 故障测试可在 COMMIT 后抛错，模拟客户端没有收到提交响应。 */
  readonly afterCommit?: (operation: "mutate") => void | Promise<void>;
  readonly threadContextWriteEnabled?: boolean;
  readonly threadInputRoutingV2Enabled?: boolean;
  readonly threadSandboxSessionReuseEnabled?: boolean;
  readonly threadSandboxHandoffLeaseMs?: number;
  readonly historyFilesystemEnabled?: boolean;
  readonly historyDirectoryTimeZone?: string;
  readonly memoryIngestionEnabled?: boolean;
}

const mutationSerializableRetryDelaysMs = Object.freeze([5, 15, 45]);
const permitConsumptionRetryDelaysMs = Object.freeze([0, 25, 100, 250, 500]);

export interface InitializeRunExecutionInput {
  readonly scope: ExecutionScope;
  readonly input: string;
  readonly answer?: string;
  readonly rolloutProjection: ControlledRolloutProjection;
}

const aggregateColumns = `
  t.id AS tenant_id, t.kind AS tenant_kind, t.owner_user_id, t.display_name,
  t.created_by_user_id, t.created_at AS tenant_created_at,
  tenant_actor.id AS tenant_actor_id, tenant_actor.kind AS tenant_actor_kind,
  tenant_actor.created_at AS tenant_actor_created_at,
  th.id AS thread_id, th.created_by_user_id AS thread_created_by_user_id,
  th.title AS thread_title, th.status AS thread_status,
  th.created_at AS thread_created_at, th.updated_at AS thread_updated_at,
  thread_creator.id AS thread_creator_id, thread_creator.kind AS thread_creator_kind,
  thread_creator.created_at AS thread_creator_created_at,
  creator_membership.id AS thread_creator_membership_id,
  creator_membership.role AS thread_creator_membership_role,
  creator_membership.status AS thread_creator_membership_status,
  creator_membership.created_at AS thread_creator_membership_created_at,
  r.id AS run_id, r.status AS run_status, r.origin AS run_origin,
  r.created_at AS run_created_at, r.updated_at AS run_updated_at,
  w.id AS workspace_id, w.current_revision_number, w.current_revision_id,
  w.lease_epoch, w.created_at AS workspace_created_at, w.updated_at AS workspace_updated_at,
  lease.root_run_id AS lease_root_run_id, lease.epoch AS lease_row_epoch,
  lease.expires_at AS lease_expires_at`;

const aggregateJoins = `
  JOIN threads th ON th.tenant_id = r.tenant_id AND th.id = r.thread_id
  JOIN tenants t ON t.id = r.tenant_id
  JOIN app_users tenant_actor
    ON tenant_actor.id = COALESCE(t.owner_user_id, t.created_by_user_id)
  JOIN app_users thread_creator ON thread_creator.id = th.created_by_user_id
  JOIN memberships creator_membership
    ON creator_membership.tenant_id = th.tenant_id
   AND creator_membership.user_id = th.created_by_user_id
   AND creator_membership.status = 'active'
  JOIN run_execution_inputs input
    ON input.tenant_id = r.tenant_id AND input.run_id = r.id
  JOIN workspaces w
    ON w.tenant_id = input.tenant_id AND w.id = input.workspace_id
  LEFT JOIN workspace_write_leases lease
    ON lease.tenant_id = w.tenant_id AND lease.workspace_id = w.id`;

function boundedDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400_000) {
    throw new TypeError(`${name} 必须是 1 到 86400000 毫秒之间的整数`);
  }
  return value;
}

function validWorkspaceManifest(value: unknown, tenantId: string): boolean {
  try {
    parseWorkspaceManifest(value, tenantId, {
      maxFiles: 10_000,
      maxTotalBytes: 512 * 1024 * 1024,
      maxSingleFileBytes: 512 * 1024 * 1024,
      maxPathUtf8Bytes: 4_096,
    });
    return true;
  } catch {
    return false;
  }
}

function isPgCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRetryablePersistenceFailure(error: unknown): boolean {
  if (error instanceof PersistenceError) return error.code === "UNAVAILABLE";
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = String(error.code);
  return (
    code.startsWith("08") ||
    code === "57P01" ||
    [
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ECONNRESET",
      "ECONNABORTED",
      "EPIPE",
    ].includes(code)
  );
}

function dbTimestamp(value: unknown): ReturnType<typeof isoTimestamp> {
  if (value instanceof Date) return isoTimestamp(value.toISOString());
  if (typeof value === "string") return isoTimestamp(new Date(value).toISOString());
  throw new TypeError("PostgreSQL 时间字段无效");
}

function mapAggregate(row: QueryResultRow): { readonly run: Run; readonly workspace: Workspace } {
  const tenant = mapTenant(row);
  const thread = mapThread(row, tenant);
  const run = mapRun(row, thread);
  const workspace = mapWorkspace(row, thread, row.lease_root_run_id === null ? undefined : run);
  return { run, workspace };
}

function mapAttempt(row: QueryResultRow): ExecutionAttemptSnapshot {
  return {
    attemptId: String(row.attempt_id),
    status: row.attempt_status,
    stage: row.attempt_stage,
    version: Number(row.attempt_version),
    nextEventSequence: Number(row.next_event_sequence),
    modelExecutionStarted: row.model_execution_started,
    projectionVersion: Number(row.projection_version),
    ...(row.attempt_current_revision_id === null
      ? {}
      : { currentRevisionId: workspaceRevisionId(String(row.attempt_current_revision_id)) }),
  };
}

function scopeMatches(row: QueryResultRow, scope: ExecutionScope): boolean {
  return (
    row.tenant_id === scope.tenantId &&
    row.thread_id === scope.threadId &&
    row.run_id === scope.runId &&
    row.root_run_id === scope.rootRunId &&
    row.workspace_id === scope.workspaceId &&
    (row.base_revision_id ?? undefined) === scope.baseRevisionId
  );
}

function durableFenceIdentityMatches(row: QueryResultRow, fence: ExecutionFence): boolean {
  return (
    scopeMatches(row, fence.scope) &&
    row.claim_token === fence.runClaim.token &&
    Number(row.claim_epoch) === fence.runClaim.epoch &&
    Number(row.claim_workspace_lease_epoch) === fence.workspaceLease.epoch &&
    Number(row.fence_lease_epoch) === fence.workspaceLease.epoch &&
    row.lease_root_run_id === fence.workspaceLease.rootRunId &&
    Number(row.lease_row_epoch) === fence.workspaceLease.epoch
  );
}

function fenceMatches(row: QueryResultRow, fence: ExecutionFence): boolean {
  if (!durableFenceIdentityMatches(row, fence)) return false;
  if (row.queue_state === null || row.queue_state === undefined) return true;
  return (
    row.queue_state === "active" &&
    row.head_active_run_id === fence.scope.runId &&
    row.head_writer_owner === row.worker_id &&
    row.head_writer_token === fence.runClaim.token &&
    Number(row.head_writer_epoch) === fence.runClaim.epoch &&
    row.queue_claim_owner === row.worker_id &&
    row.queue_claim_token === fence.runClaim.token &&
    Number(row.queue_claim_epoch) === fence.runClaim.epoch
  );
}

function jsonValue<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

const MAX_PROTOCOL_BYTES = 64 * 1024;

function boundedIdentifier(value: string, maxBytes = 200): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return value.trim().length > 0 && bytes <= maxBytes;
}

function serializedJson(value: unknown): string | undefined {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : undefined;
  } catch {
    return undefined;
  }
}

function parseUserInputAttachments(value: unknown): readonly UserInputAttachmentReference[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("持久化输入附件无效");
  }
  const ordered: Array<Readonly<{ ordinal: number; attachment: UserInputAttachmentReference }>> =
    [];
  const ordinals = new Set<number>();
  for (const [rawResourceId, rawVersions] of Object.entries(value)) {
    if (typeof rawVersions !== "object" || rawVersions === null || Array.isArray(rawVersions)) {
      throw new TypeError("持久化输入附件无效");
    }
    const versions = Object.entries(rawVersions);
    if (versions.length === 0) throw new TypeError("持久化输入附件无效");
    for (const [rawVersionId, ordinal] of versions) {
      if (
        typeof ordinal !== "number" ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < 0 ||
        ordinal >= 20 ||
        ordinals.has(ordinal)
      ) {
        throw new TypeError("持久化输入附件顺序无效");
      }
      ordinals.add(ordinal);
      ordered.push({
        ordinal,
        attachment: Object.freeze({
          resourceId: resourceId(rawResourceId),
          versionId: resourceVersionId(rawVersionId),
        }),
      });
    }
  }
  if (ordered.length > 20) throw new TypeError("持久化输入附件无效");
  ordered.sort((left, right) => left.ordinal - right.ordinal);
  if (ordered.some((entry, index) => entry.ordinal !== index)) {
    throw new TypeError("持久化输入附件顺序无效");
  }
  return Object.freeze(ordered.map((entry) => entry.attachment));
}

async function readRunInputAttachments(
  client: PoolClient,
  tenantId: string,
  threadId: string,
  runId: string,
): Promise<readonly UserInputAttachmentReference[]> {
  const result = await client.query<{ readonly input_attachments: unknown }>(
    `SELECT receipt.input_attachments
       FROM thread_follow_up_queue queue
       JOIN thread_input_receipts receipt
         ON receipt.tenant_id=queue.tenant_id AND receipt.thread_id=queue.thread_id
        AND receipt.receipt_id=queue.receipt_id
      WHERE queue.tenant_id=$1 AND queue.thread_id=$2 AND queue.run_id=$3`,
    [tenantId, threadId, runId],
  );
  const row = result.rows[0];
  return row === undefined ? Object.freeze([]) : parseUserInputAttachments(row.input_attachments);
}

/** 与数据库 CHECK 使用同一个 jsonb 规范化表达，避免紧凑 JSON 与 jsonb::text 的字节差异。 */
async function jsonValuesFitStorage(
  client: PoolClient,
  encodedValues: readonly string[],
  maxBytes = MAX_PROTOCOL_BYTES,
): Promise<boolean> {
  const result = await client.query<{ fits: boolean }>(
    `SELECT COALESCE(bool_and(octet_length(value::jsonb::text) <= $2), true) AS fits
       FROM unnest($1::text[]) AS encoded(value)`,
    [encodedValues, maxBytes],
  );
  return result.rows[0]?.fits === true;
}

/** 应用层先拒绝，数据库 CHECK 再防止其他受限 SQL 调用方绕过端口。 */
function mutationStorageShapeValid(command: RuntimeMutation): boolean {
  if (
    !boundedIdentifier(command.idempotencyKey, 512) ||
    !boundedIdentifier(command.fence.runClaim.token) ||
    !/^[0-9a-f]{64}$/.test(command.commandDigest) ||
    !command.events.every((event) => serializedJson(event.payload) !== undefined) ||
    !command.outbox.every(
      (item) =>
        boundedIdentifier(item.idempotencyKey, 512) &&
        serializedJson(
          item.kind === "sandbox_lifecycle_unknown" ? item.payload.uncertainEvent : item.payload,
        ) !== undefined,
    ) ||
    (command.rolloutProjection !== undefined &&
      serializedJson(command.rolloutProjection) === undefined) ||
    (command.threadContextAppend !== undefined &&
      serializedJson(command.threadContextAppend) === undefined) ||
    (command.threadSteer !== undefined &&
      (!boundedIdentifier(command.threadSteer.receiptId) ||
        !/^turn-[1-9][0-9]{0,15}$/.test(command.threadSteer.targetTurnId) ||
        !/^[0-9a-f]{64}$/.test(command.threadSteer.bodyDigest))) ||
    (command.threadSteer !== undefined && command.threadContextAppend !== undefined) ||
    (command.threadSandboxTerminal !== undefined &&
      (!boundedIdentifier(command.threadSandboxTerminal.sessionId) ||
        !boundedIdentifier(command.threadSandboxTerminal.leaseId) ||
        !boundedIdentifier(command.threadSandboxTerminal.leaseToken) ||
        !Number.isSafeInteger(command.threadSandboxTerminal.generation) ||
        command.threadSandboxTerminal.generation < 1))
  ) {
    return false;
  }
  if (
    command.effectInvocation !== undefined &&
    (!boundedIdentifier(command.effectInvocation.callId) ||
      !boundedIdentifier(command.effectInvocation.toolName))
  ) {
    return false;
  }
  for (const item of command.outbox) {
    if (
      item.kind === "sandbox_cleanup" &&
      (!boundedIdentifier(item.payload.registryId) ||
        !boundedIdentifier(item.payload.providerSandboxId))
    ) {
      return false;
    }
    if (
      item.kind === "sandbox_lifecycle_unknown" &&
      (!boundedIdentifier(item.payload.requestId) ||
        (item.payload.sandboxId !== undefined && !boundedIdentifier(item.payload.sandboxId)))
    ) {
      return false;
    }
  }
  return (
    command.workspaceChange === undefined ||
    (boundedIdentifier(command.workspaceChange.revisionId) &&
      boundedIdentifier(command.workspaceChange.candidateOperationKey, 256) &&
      /^[0-9a-f]{64}$/.test(command.workspaceChange.candidateOperationDigest) &&
      validWorkspaceManifest(command.workspaceChange.manifest, command.workspaceChange.tenantId))
  );
}

/** 为 API/调度器写入 claim 所需的不可变输入；不属于 Worker 的执行端口。 */
export class PgRunExecutionSetup {
  constructor(private readonly pool: Pool) {}

  async initialize(
    input: InitializeRunExecutionInput,
  ): Promise<"created" | "already_exists" | "conflict"> {
    const prompt = input.input.trim();
    if (prompt.length === 0 || Buffer.byteLength(prompt, "utf8") > 1_048_576) {
      throw new TypeError("Run 输入长度无效");
    }
    const answer = input.answer?.trim();
    if (
      answer !== undefined &&
      (answer.length === 0 || Buffer.byteLength(answer, "utf8") > 1_048_576)
    ) {
      throw new TypeError("Run 初始回答长度无效");
    }
    const projectionJson = serializedJson(input.rolloutProjection);
    if (projectionJson === undefined) throw new TypeError("初始 Projection 不是合法 JSON");
    const digest = rolloutProjectionDigest(input.rolloutProjection);
    return withTenantTransaction(this.pool, { tenantId: input.scope.tenantId }, async (client) => {
      if (!(await jsonValuesFitStorage(client, [projectionJson]))) {
        throw new TypeError("初始 Projection 超过 PostgreSQL 规范化 64KiB 上限");
      }
      const result = await client.query(
        `INSERT INTO run_execution_inputs(
           tenant_id, run_id, thread_id, workspace_id, root_run_id, base_revision_id,
           input_text, answer_text, initial_projection, initial_projection_digest
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         ON CONFLICT (tenant_id, run_id) DO NOTHING`,
        [
          input.scope.tenantId,
          input.scope.runId,
          input.scope.threadId,
          input.scope.workspaceId,
          input.scope.rootRunId,
          input.scope.baseRevisionId ?? null,
          prompt,
          answer ?? null,
          projectionJson,
          digest,
        ],
      );
      if (result.rowCount === 1) return "created";
      // ON CONFLICT 不能把另一份业务命令伪装成幂等成功；锁行后逐字段核对。
      const existing = await client.query<{
        thread_id: string;
        workspace_id: string;
        root_run_id: string;
        base_revision_id: string | null;
        input_text: string;
        answer_text: string | null;
        initial_projection_digest: string;
        projection_matches: boolean;
      }>(
        `SELECT thread_id,workspace_id,root_run_id,base_revision_id,input_text,answer_text,
                initial_projection_digest,initial_projection=$3::jsonb AS projection_matches
           FROM run_execution_inputs
          WHERE tenant_id=$1 AND run_id=$2
          FOR UPDATE`,
        [input.scope.tenantId, input.scope.runId, projectionJson],
      );
      const row = existing.rows[0];
      return row !== undefined &&
        row.thread_id === input.scope.threadId &&
        row.workspace_id === input.scope.workspaceId &&
        row.root_run_id === input.scope.rootRunId &&
        (row.base_revision_id ?? undefined) === input.scope.baseRevisionId &&
        row.input_text === prompt &&
        (row.answer_text ?? undefined) === answer &&
        row.initial_projection_digest === digest &&
        row.projection_matches
        ? "already_exists"
        : "conflict";
    });
  }

  async setAnswer(input: {
    readonly scope: ExecutionScope;
    readonly answer: string;
    readonly expectedRunVersion: number;
    readonly expectedPreviousAnswer?: string;
  }): Promise<"updated" | "not_found" | "conflict"> {
    const normalized = input.answer.trim();
    if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > 1_048_576) {
      throw new TypeError("Run 回答长度无效");
    }
    const expectedPreviousAnswer = input.expectedPreviousAnswer?.trim();
    if (
      expectedPreviousAnswer !== undefined &&
      (expectedPreviousAnswer.length === 0 ||
        Buffer.byteLength(expectedPreviousAnswer, "utf8") > 1_048_576)
    ) {
      throw new TypeError("预期旧回答长度无效");
    }
    if (!Number.isSafeInteger(input.expectedRunVersion) || input.expectedRunVersion < 0) {
      throw new TypeError("expectedRunVersion 必须是非负安全整数");
    }
    return withTenantTransaction(
      this.pool,
      { tenantId: input.scope.tenantId },
      async (client) => {
        const locked = await client.query<{
          run_status: string;
          run_version: string;
          answer_text: string | null;
        }>(
          `SELECT run.status AS run_status,run.version::text AS run_version,input.answer_text
             FROM runs run JOIN run_execution_inputs input
               ON input.tenant_id=run.tenant_id AND input.run_id=run.id
            WHERE run.tenant_id=$1 AND run.id=$2 AND input.thread_id=$3
              AND input.workspace_id=$4 AND input.root_run_id=$5
              AND input.base_revision_id IS NOT DISTINCT FROM $6
              AND NOT EXISTS (
                SELECT 1 FROM client_tool_calls call JOIN rollout_projections USING(tenant_id,run_id,attempt_id)
                 WHERE call.tenant_id=run.tenant_id AND call.run_id=run.id
              )
            FOR UPDATE OF run,input`,
          [
            input.scope.tenantId,
            input.scope.runId,
            input.scope.threadId,
            input.scope.workspaceId,
            input.scope.rootRunId,
            input.scope.baseRevisionId ?? null,
          ],
        );
        const row = locked.rows[0];
        if (row === undefined) return "not_found";
        if (
          row.run_status !== "waiting" ||
          Number(row.run_version) !== input.expectedRunVersion ||
          (row.answer_text ?? undefined) !== expectedPreviousAnswer
        ) {
          return "conflict";
        }
        const result = await client.query(
          `UPDATE run_execution_inputs SET answer_text=$3,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND run_id=$2`,
          [input.scope.tenantId, input.scope.runId, normalized],
        );
        if (result.rowCount !== 1) throw new Error("锁定的 Run 输入未能更新");
        return "updated";
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }
}

/**
 * 给 CubeSandbox 驱动增加 PostgreSQL registry 事实源。它不消费 cleanup Outbox；
 * settle 仍由当前 Worker 低延迟调用，崩溃恢复由后续 Outbox consumer 接管。
 */
export class PgBackedSandboxSessionRegistry
  implements SandboxSessionRegistryPort, OrphanSandboxCleanupPort
{
  /** 只有本实例成功登记后返回的同一个 session 对象才持有孤儿关闭 capability。 */
  private readonly orphanCapabilities = new WeakSet<object>();

  constructor(
    private readonly pool: Pool,
    private readonly upstream: SandboxSessionRegistryPort,
    private readonly actualTtlSeconds = 120,
  ) {
    if (
      !Number.isSafeInteger(actualTtlSeconds) ||
      actualTtlSeconds < 1 ||
      actualTtlSeconds > 86_400
    ) {
      throw new TypeError("Sandbox registry TTL 无效");
    }
  }

  async acquire(
    input: Parameters<SandboxSessionRegistryPort["acquire"]>[0],
  ): Promise<SandboxAcquireResult> {
    const result = await this.upstream.acquire(input);
    if (result.outcome !== "ready") return result;
    try {
      const registered = await withTenantTransaction(
        this.pool,
        { tenantId: input.scope.tenantId },
        async (client) => {
          const attempt = await client.query<{ attempt_id: string }>(
            `SELECT attempt.attempt_id
               FROM execution_attempts attempt
               JOIN run_claims claim
                 ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
               JOIN workspace_write_leases lease
                 ON lease.tenant_id=attempt.tenant_id
                AND lease.workspace_id=attempt.workspace_id
                AND lease.root_run_id=attempt.root_run_id
                AND lease.epoch=claim.workspace_lease_epoch
              WHERE attempt.tenant_id=$1 AND attempt.run_id=$2 AND attempt.thread_id=$3
                AND attempt.workspace_id=$4 AND attempt.root_run_id=$5
                AND attempt.base_revision_id IS NOT DISTINCT FROM $6
                AND attempt.status IN ('claimed','running','finalizing')
                AND claim.released_at IS NULL
                AND claim.expires_at > clock_timestamp()
                AND lease.expires_at > clock_timestamp()
              ORDER BY attempt.created_at DESC LIMIT 1
              FOR UPDATE OF attempt,claim,lease`,
            [
              input.scope.tenantId,
              input.scope.runId,
              input.scope.threadId,
              input.scope.workspaceId,
              input.scope.rootRunId,
              input.scope.baseRevisionId ?? null,
            ],
          );
          const attemptId = attempt.rows[0]?.attempt_id;
          if (attemptId === undefined) return false;
          const inserted = await client.query(
            `INSERT INTO sandbox_registry(
               tenant_id,registry_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
               provider_key,provider_sandbox_id,request_id,state,actual_ttl_seconds
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$2,'ready',$10)
             ON CONFLICT (tenant_id,registry_id) DO NOTHING`,
            [
              input.scope.tenantId,
              result.session.registryId,
              attemptId,
              input.scope.runId,
              input.scope.threadId,
              input.scope.workspaceId,
              input.scope.rootRunId,
              result.session.providerKey,
              result.session.providerSandboxId,
              this.actualTtlSeconds,
            ],
          );
          return inserted.rowCount === 1;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
      if (registered) {
        this.orphanCapabilities.add(result.session);
        return result;
      }
    } catch {
      // registry 没有提交时不能把 Sandbox 暴露给 Worker；用 registry 恢复键尽力关闭。
    }
    await this.upstream
      .settle({
        scope: input.scope,
        session: result.session,
        cleanupIntentId: `registry:${result.session.registryId}:orphan-cleanup`,
        disposition: "close",
      })
      .catch(() => undefined);
    return { outcome: "failed", code: "SANDBOX_FAILED" };
  }

  async settle(
    input: Parameters<SandboxSessionRegistryPort["settle"]>[0],
  ): Promise<SandboxSettlementResult> {
    const expectedState = input.disposition === "pause" ? "pausing" : "closing";
    const valid = await withTenantTransaction(
      this.pool,
      { tenantId: input.scope.tenantId },
      async (client) => {
        const result = await client.query(
          `SELECT 1
             FROM cleanup_outbox cleanup
             JOIN sandbox_registry registry
               ON registry.tenant_id=cleanup.tenant_id
              AND registry.registry_id=cleanup.registry_id
             JOIN execution_attempts attempt
               ON attempt.tenant_id=registry.tenant_id
              AND attempt.attempt_id=registry.attempt_id
            WHERE cleanup.tenant_id=$1 AND cleanup.idempotency_key=$2
              AND cleanup.registry_id=$3 AND cleanup.provider_sandbox_id=$4
              AND cleanup.state='started' AND cleanup.disposition=$5
              -- 正常 Worker 只能推进自己尚未被 Scheduler claim 的 cleanup，并在同一事务重验双栅栏。
              AND cleanup.claim_token IS NULL
              AND EXISTS (
                SELECT 1 FROM run_claims worker_claim
                JOIN workspace_write_leases worker_lease
                  ON worker_lease.tenant_id=worker_claim.tenant_id
                 AND worker_lease.workspace_id=attempt.workspace_id
                 AND worker_lease.root_run_id=attempt.root_run_id
                 AND worker_lease.epoch=worker_claim.workspace_lease_epoch
                WHERE worker_claim.tenant_id=attempt.tenant_id
                  AND worker_claim.attempt_id=attempt.attempt_id
                  AND worker_claim.released_at IS NULL
                  AND worker_claim.expires_at > clock_timestamp()
                  AND worker_lease.expires_at > clock_timestamp()
              )
              AND attempt.run_id=$6 AND attempt.thread_id=$7
              AND attempt.workspace_id=$8 AND attempt.root_run_id=$9
              AND attempt.base_revision_id IS NOT DISTINCT FROM $10
            FOR UPDATE OF cleanup,registry`,
          [
            input.scope.tenantId,
            input.cleanupIntentId,
            input.session.registryId,
            input.session.providerSandboxId,
            input.disposition,
            input.scope.runId,
            input.scope.threadId,
            input.scope.workspaceId,
            input.scope.rootRunId,
            input.scope.baseRevisionId ?? null,
          ],
        );
        if (result.rowCount !== 1) return false;
        // 正常 Worker 与 Scheduler Consumer 共用 remote_call_started_at 这个不可逆边界。
        // Worker 仍持有双栅栏，且登记/状态推进在同一事务，避免两个表各自讲不同故事。
        const started = await client.query(
          `UPDATE cleanup_outbox SET remote_call_started_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND idempotency_key=$2 AND registry_id=$3 AND provider_sandbox_id=$4
              AND state='started' AND disposition=$5 AND remote_call_started_at IS NULL`,
          [
            input.scope.tenantId,
            input.cleanupIntentId,
            input.session.registryId,
            input.session.providerSandboxId,
            input.disposition,
          ],
        );
        if (started.rowCount !== 1) return false;
        const registryUpdate = await client.query(
          `UPDATE sandbox_registry SET state=$3,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND registry_id=$2 AND state IN ('ready','paused')`,
          [input.scope.tenantId, input.session.registryId, expectedState],
        );
        // marker 已写入而 registry 未能同步时，绝不能提交半个状态机；
        // 抛错让同一事务回滚，避免没有远端调用却留下不可逆 remote marker。
        if (registryUpdate.rowCount !== 1) {
          throw new Error("Sandbox cleanup 开始态未能原子同步");
        }
        return true;
      },
      { isolationLevel: "SERIALIZABLE" },
    );
    if (!valid) throw new Error("Sandbox cleanup intent 未持久化或身份不匹配");
    const result = await this.upstream.settle(input);
    await withTenantTransaction(this.pool, { tenantId: input.scope.tenantId }, async (client) => {
      const terminal = result.outcome === "unknown" ? "unknown" : "completed";
      const registryTerminal =
        result.outcome === "unknown"
          ? "unknown"
          : input.disposition === "pause"
            ? "paused"
            : "closed";
      const cleanup = await client.query(
        `UPDATE cleanup_outbox SET state=$5,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND idempotency_key=$2 AND registry_id=$3 AND provider_sandbox_id=$4
            AND state='started' AND remote_call_started_at IS NOT NULL`,
        [
          input.scope.tenantId,
          input.cleanupIntentId,
          input.session.registryId,
          input.session.providerSandboxId,
          terminal,
        ],
      );
      const registry = await client.query(
        `UPDATE sandbox_registry SET state=$3,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2 AND state=$4`,
        [input.scope.tenantId, input.session.registryId, registryTerminal, expectedState],
      );
      if (cleanup.rowCount !== 1 || registry.rowCount !== 1)
        throw new Error("Sandbox cleanup 终态未能原子同步");
    });
    return result;
  }

  async closeOrphan(
    input: Parameters<OrphanSandboxCleanupPort["closeOrphan"]>[0],
  ): Promise<SandboxSettlementResult> {
    if (!this.orphanCapabilities.has(input.session)) {
      throw new Error("Sandbox orphan cleanup capability 无效");
    }
    const cleanupIntentId = `registry:${input.session.registryId}:orphan-cleanup`;
    const valid = await withTenantTransaction(
      this.pool,
      { tenantId: input.scope.tenantId },
      async (client) => {
        const result = await client.query(
          `SELECT 1
             FROM sandbox_registry registry
             JOIN execution_attempts attempt
               ON attempt.tenant_id=registry.tenant_id
              AND attempt.attempt_id=registry.attempt_id
            WHERE registry.tenant_id=$1 AND registry.registry_id=$2
              AND registry.provider_sandbox_id=$3
              AND attempt.run_id=$4 AND attempt.thread_id=$5
              AND attempt.workspace_id=$6 AND attempt.root_run_id=$7
              AND attempt.base_revision_id IS NOT DISTINCT FROM $8
            FOR UPDATE OF registry`,
          [
            input.scope.tenantId,
            input.session.registryId,
            input.session.providerSandboxId,
            input.scope.runId,
            input.scope.threadId,
            input.scope.workspaceId,
            input.scope.rootRunId,
            input.scope.baseRevisionId ?? null,
          ],
        );
        if (result.rowCount !== 1) return false;
        await client.query(
          `UPDATE sandbox_registry SET state='closing',updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND registry_id=$2 AND provider_sandbox_id=$3`,
          [input.scope.tenantId, input.session.registryId, input.session.providerSandboxId],
        );
        return true;
      },
      { isolationLevel: "SERIALIZABLE" },
    );
    if (!valid) throw new Error("Sandbox orphan cleanup scope 或身份不匹配");
    const result = await this.upstream.settle({
      scope: input.scope,
      session: input.session,
      cleanupIntentId,
      disposition: "close",
    });
    await withTenantTransaction(this.pool, { tenantId: input.scope.tenantId }, (client) =>
      client.query(
        `UPDATE sandbox_registry SET state=$4,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2 AND provider_sandbox_id=$3`,
        [
          input.scope.tenantId,
          input.session.registryId,
          input.session.providerSandboxId,
          result.outcome === "unknown" ? "unknown" : "closed",
        ],
      ),
    );
    return result;
  }
}

export class PgExecutionPersistence implements ExecutionPersistencePort {
  constructor(
    private readonly pool: Pool,
    private readonly options: PgRunWorkerStateOptions = {},
  ) {}

  async claim(input: {
    readonly scope: ExecutionScope;
    readonly workerId: string;
    readonly leaseDurationMs: number;
  }): Promise<ClaimExecutionResult> {
    const leaseDurationMs = boundedDuration(input.leaseDurationMs, "leaseDurationMs");
    const workerId = input.workerId.trim();
    if (!boundedIdentifier(workerId)) {
      throw new TypeError("workerId 的 UTF-8 字节长度必须在 1 到 200 之间");
    }
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.scope.tenantId },
        async (client) => {
          const threadHead = await lockThreadExecutionHead(
            client,
            input.scope.tenantId,
            input.scope.threadId,
          );
          const queuedItem = await client.query<{
            readonly state: string;
            readonly claim_owner: string | null;
            readonly claim_token: string | null;
            readonly claim_epoch: string;
            readonly claim_expires_at: Date | null;
          }>(
            `SELECT state,claim_owner,claim_token,claim_epoch::text,claim_expires_at
               FROM thread_follow_up_queue
              WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 FOR UPDATE`,
            [input.scope.tenantId, input.scope.threadId, input.scope.runId],
          );
          const queueRow = queuedItem.rows[0];
          if (
            queueRow !== undefined &&
            (queueRow.state !== "active" || threadHead?.active_run_id !== input.scope.runId)
          ) {
            return { outcome: "busy" } as const;
          }
          const aggregate = await client.query(
            `SELECT ${aggregateColumns}, input.root_run_id, input.base_revision_id,
                    input.input_text, input.answer_text,
                    input.initial_projection, input.initial_projection_digest,
                    input.context_through_sequence
               FROM runs r ${aggregateJoins}
              WHERE r.tenant_id=$1 AND r.id=$2
              FOR UPDATE OF r, w, input`,
            [input.scope.tenantId, input.scope.runId],
          );
          const row = aggregate.rows[0];
          if (row === undefined) return { outcome: "not_found" } as const;
          if (!scopeMatches(row, input.scope)) return { outcome: "scope_mismatch" } as const;
          if (["succeeded", "failed", "cancelled"].includes(row.run_status)) {
            return { outcome: "terminal" } as const;
          }
          // queued Run 必须从提交时绑定的 base head 开始；waiting 恢复则沿用已持久化的新 head。
          if (
            row.run_status === "queued" &&
            (row.current_revision_id ?? undefined) !== input.scope.baseRevisionId
          ) {
            return { outcome: "scope_mismatch" } as const;
          }
          const nowResult = await client.query<{ database_now: Date; expires_at: Date }>(
            `SELECT clock_timestamp() AS database_now,
                    clock_timestamp() + ($1::bigint * interval '1 millisecond') AS expires_at`,
            [leaseDurationMs],
          );
          const nowRow = nowResult.rows[0];
          if (nowRow === undefined) throw new Error("数据库时钟查询没有返回行");
          const databaseNow = dbTimestamp(nowRow.database_now);
          const expiresAt = dbTimestamp(nowRow.expires_at);
          if (row.run_status === "running") {
            const active = await client.query<{ expires_at: Date }>(
              `SELECT claim.expires_at
                 FROM execution_attempts attempt
                 LEFT JOIN run_claims claim
                   ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
                WHERE attempt.tenant_id=$1 AND attempt.run_id=$2
                  AND attempt.status IN ('claimed','running','finalizing')
                ORDER BY attempt.created_at DESC LIMIT 1`,
              [input.scope.tenantId, input.scope.runId],
            );
            const activeClaim = active.rows[0];
            if (
              activeClaim !== undefined &&
              Date.parse(dbTimestamp(activeClaim.expires_at)) > Date.parse(databaseNow)
            ) {
              return { outcome: "busy" } as const;
            }
            return { outcome: "recovery_required" } as const;
          }
          if (row.run_status === "waiting" && row.answer_text === null) {
            return { outcome: "waiting_for_answer" } as const;
          }
          const existingLease = await client.query<{ expires_at: Date }>(
            `SELECT expires_at FROM workspace_write_leases
              WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE`,
            [input.scope.tenantId, input.scope.workspaceId],
          );
          const leaseRow = existingLease.rows[0];
          if (
            leaseRow !== undefined &&
            Date.parse(dbTimestamp(leaseRow.expires_at)) > Date.parse(databaseNow)
          ) {
            return { outcome: "busy" } as const;
          }
          const attemptId = `attempt-${randomUUID()}`;
          const claimToken = `claim-${randomUUID()}`;
          const claimEpoch =
            queueRow === undefined
              ? Number(
                  (
                    await client.query<{ next_epoch: string }>(
                      `SELECT (COALESCE(max(claim_epoch),0)+1)::text AS next_epoch
                         FROM run_claims WHERE tenant_id=$1 AND run_id=$2`,
                      [input.scope.tenantId, input.scope.runId],
                    )
                  ).rows[0]?.next_epoch ?? "1",
                )
              : Number(threadHead?.writer_epoch ?? "0") + 1;
          if (!Number.isSafeInteger(claimEpoch) || claimEpoch < 1) {
            throw new TypeError("Thread writer epoch 无效");
          }
          const leaseEpoch = Number(row.lease_epoch) + 1;
          const previousProjection = await client.query<{
            version: string;
            projection: ControlledRolloutProjection;
            digest: string;
          }>(
            `SELECT version::text, projection, digest FROM rollout_projections
              WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
            [input.scope.tenantId, input.scope.runId],
          );
          const projectionVersion = Number(previousProjection.rows[0]?.version ?? 0);
          const projection =
            previousProjection.rows[0]?.projection ??
            jsonValue<ControlledRolloutProjection>(row.initial_projection);
          const projectionDigest =
            previousProjection.rows[0]?.digest ?? String(row.initial_projection_digest);

          // 领取前验证值与摘要；数据库可被受限 SQL 写入，不能只相信 API 的初始化路径。
          try {
            assertControlledRolloutProjection(projection);
            if (rolloutProjectionDigest(projection) !== projectionDigest) {
              return { outcome: "recovery_required" } as const;
            }
          } catch {
            return { outcome: "recovery_required" } as const;
          }

          await client.query(
            `UPDATE runs SET status='running', version=version+1, updated_at=$3
              WHERE tenant_id=$1 AND id=$2`,
            [input.scope.tenantId, input.scope.runId, databaseNow],
          );
          await client.query(
            `UPDATE workspaces SET lease_epoch=$3, updated_at=$4
              WHERE tenant_id=$1 AND id=$2`,
            [input.scope.tenantId, input.scope.workspaceId, leaseEpoch, databaseNow],
          );
          await client.query(
            `INSERT INTO workspace_write_leases(
               tenant_id, workspace_id, thread_id, root_run_id, epoch, expires_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (tenant_id, workspace_id) DO UPDATE SET
               thread_id=EXCLUDED.thread_id, root_run_id=EXCLUDED.root_run_id,
               epoch=EXCLUDED.epoch, expires_at=EXCLUDED.expires_at, updated_at=EXCLUDED.updated_at`,
            [
              input.scope.tenantId,
              input.scope.workspaceId,
              input.scope.threadId,
              input.scope.rootRunId,
              leaseEpoch,
              expiresAt,
              databaseNow,
            ],
          );
          await client.query(
            `INSERT INTO execution_attempts(
               tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id,
               base_revision_id, current_revision_id, status, stage, projection_version
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'claimed','claimed',$9)`,
            [
              input.scope.tenantId,
              attemptId,
              input.scope.runId,
              input.scope.threadId,
              input.scope.workspaceId,
              input.scope.rootRunId,
              input.scope.baseRevisionId ?? null,
              row.current_revision_id ?? null,
              projectionVersion,
            ],
          );
          await client.query(
            `INSERT INTO execution_workspace_fences(
               tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id,
               lease_epoch, initial_expires_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              input.scope.tenantId,
              attemptId,
              input.scope.runId,
              input.scope.threadId,
              input.scope.workspaceId,
              input.scope.rootRunId,
              leaseEpoch,
              expiresAt,
            ],
          );
          await client.query(
            `INSERT INTO run_claims(
               tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id,
               worker_id, claim_token, claim_epoch, workspace_lease_epoch, expires_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              input.scope.tenantId,
              attemptId,
              input.scope.runId,
              input.scope.threadId,
              input.scope.workspaceId,
              input.scope.rootRunId,
              workerId,
              claimToken,
              claimEpoch,
              leaseEpoch,
              expiresAt,
            ],
          );
          if (queueRow !== undefined) {
            const writer = await client.query(
              `UPDATE thread_execution_heads
                  SET writer_owner=$4,writer_token=$5,writer_epoch=$6,writer_expires_at=$7,
                      version=version+1,updated_at=$8
                WHERE tenant_id=$1 AND thread_id=$2 AND active_run_id=$3
                  AND writer_owner IS NULL AND writer_token IS NULL AND writer_expires_at IS NULL`,
              [
                input.scope.tenantId,
                input.scope.threadId,
                input.scope.runId,
                workerId,
                claimToken,
                claimEpoch,
                expiresAt,
                databaseNow,
              ],
            );
            const queueClaim = await client.query(
              `UPDATE thread_follow_up_queue
                  SET claim_owner=$4,claim_token=$5,claim_epoch=$6,claim_expires_at=$7
                WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND state='active'
                  AND claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL`,
              [
                input.scope.tenantId,
                input.scope.threadId,
                input.scope.runId,
                workerId,
                claimToken,
                claimEpoch,
                expiresAt,
              ],
            );
            if (writer.rowCount !== 1 || queueClaim.rowCount !== 1) {
              throw new TypeError("Thread writer claim 冲突");
            }
          }
          const clientResume =
            row.run_status === "waiting" &&
            (
              await client.query(
                `SELECT 1 FROM client_tool_calls JOIN rollout_projections USING(tenant_id,run_id,attempt_id)
                      WHERE tenant_id=$1 AND run_id=$2 LIMIT 1`,
                [input.scope.tenantId, input.scope.runId],
              )
            ).rowCount === 1;
          let contextThroughSequence = row.context_through_sequence;
          if (this.options.threadContextWriteEnabled === true) {
            if (clientResume)
              contextThroughSequence =
                (
                  await client.query(
                    `SELECT next_sequence-1 AS cursor FROM thread_context_streams WHERE tenant_id=$1 AND thread_id=$2`,
                    [input.scope.tenantId, input.scope.threadId],
                  )
                ).rows[0]?.cursor ?? contextThroughSequence;
            if (queueRow === undefined) return { outcome: "recovery_required" } as const;
            const userText = String(row.answer_text ?? row.input_text);
            const startedBody = {
              attemptId,
              runId: input.scope.runId,
              baseRevisionId: input.scope.baseRevisionId ?? null,
            };
            const userBody = { role: "user", text: userText };
            await appendThreadContext(
              client,
              { scope: input.scope, attemptId },
              {
                schemaVersion: 1,
                idempotencyKey: `${attemptId}/claim`,
                entries: [
                  {
                    entryId: `${attemptId}/run-started`,
                    kind: "run_started",
                    body: {
                      storage: "inline",
                      value: startedBody,
                      sha256: digestCanonical(startedBody),
                      size: Buffer.byteLength(JSON.stringify(startedBody), "utf8"),
                    },
                  },
                  {
                    entryId: `${attemptId}/user-message`,
                    kind: "user_message",
                    body: {
                      storage: "inline",
                      value: userBody,
                      sha256: digestCanonical(userBody),
                      size: Buffer.byteLength(JSON.stringify(userBody), "utf8"),
                    },
                  },
                ],
              },
              databaseNow,
            );
          }
          await client.query(
            `INSERT INTO rollout_projections(tenant_id,run_id,attempt_id,version,projection,digest)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6)
             ON CONFLICT (tenant_id,run_id) DO UPDATE SET
               attempt_id=EXCLUDED.attempt_id, updated_at=clock_timestamp()`,
            [
              input.scope.tenantId,
              input.scope.runId,
              attemptId,
              projectionVersion,
              JSON.stringify(projection),
              projectionDigest,
            ],
          );
          const state = await this.loadState(client, input.scope, attemptId);
          if (state === undefined) throw new Error("claim 提交前无法读回执行状态");
          const attachments = await readRunInputAttachments(
            client,
            input.scope.tenantId,
            input.scope.threadId,
            input.scope.runId,
          );
          const agent = await readRunAgentSnapshot(client, input.scope);
          const runOrigin: "normal" | "playground" | "evaluation" | "api" = row.run_origin;
          const playgroundMocks =
            runOrigin === "playground"
              ? ((
                  await client.query<{ mock_results: Readonly<Record<string, unknown>> }>(
                    `SELECT mock_results FROM run_playground_mocks WHERE tenant_id=$1 AND run_id=$2`,
                    [input.scope.tenantId, input.scope.runId],
                  )
                ).rows[0]?.mock_results ?? {})
              : {};
          const agentRevoked =
            agent !== undefined && (await isRunAgentRevoked(client, input.scope));
          const skills = await readRunSkillSnapshot(
            client,
            input.scope.tenantId,
            input.scope.runId,
          );
          const requestUser = await client.query<{ readonly user_id: string }>(
            `SELECT user_id FROM run_skill_snapshots WHERE tenant_id=$1 AND run_id=$2`,
            [input.scope.tenantId, input.scope.runId],
          );
          const fence: ExecutionFence = {
            scope: input.scope,
            runClaim: { token: claimToken, epoch: claimEpoch, expiresAt },
            workspaceLease: { rootRunId: input.scope.rootRunId, epoch: leaseEpoch, expiresAt },
          };
          return {
            outcome: "claimed",
            snapshot: {
              agent: agentRevoked ? "AGENT_REVISION_REVOKED" : (agent ?? "AGENT_SNAPSHOT_INVALID"),
              run: state.run,
              origin: runOrigin,
              playgroundMocks,
              tenantKind: row.tenant_kind === "personal" ? "personal" : "team",
              memorySubjectUserId: String(row.owner_user_id ?? row.thread_created_by_user_id),
              requestedByUserId: String(
                requestUser.rows[0]?.user_id ?? row.owner_user_id ?? row.thread_created_by_user_id,
              ),
              workspace: state.workspace,
              attempt: state.attempt,
              input: String(row.input_text),
              ...(attachments.length === 0 ? {} : { attachments }),
              ...(row.answer_text === null ? {} : { answer: String(row.answer_text) }),
              rolloutProjection: projection,
              skills,
              ...(clientResume ? { clientToolResume: true as const } : {}),
              ...(contextThroughSequence === null
                ? {}
                : { contextThroughSequence: Number(contextThroughSequence) }),
            },
            fence,
            databaseNow,
          } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async inspectAndRenew(input: {
    readonly fence: ExecutionFence;
    readonly leaseDurationMs: number;
  }): Promise<FenceInspectionResult> {
    const leaseDurationMs = boundedDuration(input.leaseDurationMs, "leaseDurationMs");
    try {
      return await withRetriedSerializableTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          const row = await this.lockFenceState(client, input.fence.scope);
          if (row === undefined) return { outcome: "fence_lost" } as const;
          if (!scopeMatches(row, input.fence.scope)) return { outcome: "scope_mismatch" } as const;
          if (!fenceMatches(row, input.fence)) return { outcome: "fence_lost" } as const;
          if (row.run_status === "cancelled") return { outcome: "cancelled" } as const;
          if (row.run_status !== "running") return { outcome: "fence_lost" } as const;
          const nowResult = await client.query<{ database_now: Date; expires_at: Date }>(
            `SELECT clock_timestamp() AS database_now,
                     GREATEST(
                       clock_timestamp() + ($1::bigint * interval '1 millisecond'),
                       $2::timestamptz + interval '1 millisecond',
                       $3::timestamptz + interval '1 millisecond',
                       $4::timestamptz + interval '1 millisecond',
                       $5::timestamptz + interval '1 millisecond'
                     ) AS expires_at`,
            [
              leaseDurationMs,
              row.claim_expires_at,
              row.lease_expires_at,
              row.head_writer_expires_at,
              row.queue_claim_expires_at,
            ],
          );
          const nowRow = nowResult.rows[0];
          if (nowRow === undefined) throw new Error("数据库时钟查询没有返回行");
          const databaseNow = dbTimestamp(nowRow.database_now);
          if (
            Date.parse(dbTimestamp(row.claim_expires_at)) <= Date.parse(databaseNow) ||
            Date.parse(dbTimestamp(row.lease_expires_at)) <= Date.parse(databaseNow) ||
            (row.queue_state !== null &&
              (Date.parse(dbTimestamp(row.head_writer_expires_at)) <= Date.parse(databaseNow) ||
                Date.parse(dbTimestamp(row.queue_claim_expires_at)) <= Date.parse(databaseNow))) ||
            row.claim_released_at !== null
          ) {
            return { outcome: "fence_lost" } as const;
          }
          const expiresAt = dbTimestamp(nowRow.expires_at);
          if (this.options.threadSandboxSessionReuseEnabled === true) {
            const sandboxLease = await client.query<{
              session_id: string;
              lease_id: string;
              attempt_id: string | null;
            }>(
              `SELECT session_id,lease_id,attempt_id
                 FROM thread_sandbox_leases
                WHERE tenant_id=$1 AND run_id=$2 AND released_at IS NULL
                FOR UPDATE`,
              [input.fence.scope.tenantId, input.fence.scope.runId],
            );
            const activeSandboxLease = sandboxLease.rows[0];
            if (
              activeSandboxLease !== undefined &&
              activeSandboxLease.attempt_id !== null &&
              activeSandboxLease.attempt_id !== String(row.attempt_id)
            ) {
              return { outcome: "fence_lost" } as const;
            }
            if (activeSandboxLease !== undefined) {
              const renewed = await client.query(
                `UPDATE thread_sandbox_leases
                    SET expires_at=GREATEST(expires_at,$5::timestamptz),updated_at=$6
                  WHERE tenant_id=$1 AND session_id=$2 AND lease_id=$3 AND run_id=$4
                    AND released_at IS NULL AND (attempt_id IS NULL OR attempt_id=$7)`,
                [
                  input.fence.scope.tenantId,
                  activeSandboxLease.session_id,
                  activeSandboxLease.lease_id,
                  input.fence.scope.runId,
                  expiresAt,
                  databaseNow,
                  row.attempt_id,
                ],
              );
              if (renewed.rowCount !== 1) return { outcome: "fence_lost" } as const;
            }
          }
          if (row.queue_state !== null) {
            const writer = await client.query(
              `UPDATE thread_execution_heads SET writer_expires_at=$6,updated_at=$7
                 WHERE tenant_id=$1 AND thread_id=$2 AND active_run_id=$3
                   AND writer_token=$4 AND writer_epoch=$5`,
              [
                input.fence.scope.tenantId,
                input.fence.scope.threadId,
                input.fence.scope.runId,
                input.fence.runClaim.token,
                input.fence.runClaim.epoch,
                expiresAt,
                databaseNow,
              ],
            );
            const queue = await client.query(
              `UPDATE thread_follow_up_queue SET claim_expires_at=$6
                 WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND state='active'
                   AND claim_token=$4 AND claim_epoch=$5`,
              [
                input.fence.scope.tenantId,
                input.fence.scope.threadId,
                input.fence.scope.runId,
                input.fence.runClaim.token,
                input.fence.runClaim.epoch,
                expiresAt,
              ],
            );
            if (writer.rowCount !== 1 || queue.rowCount !== 1) {
              return { outcome: "fence_lost" } as const;
            }
          }
          await client.query(
            `UPDATE run_claims SET expires_at=$3, updated_at=$4
              WHERE tenant_id=$1 AND attempt_id=$2`,
            [input.fence.scope.tenantId, row.attempt_id, expiresAt, databaseNow],
          );
          await client.query(
            `UPDATE workspace_write_leases SET expires_at=$3, updated_at=$4
              WHERE tenant_id=$1 AND workspace_id=$2`,
            [input.fence.scope.tenantId, input.fence.scope.workspaceId, expiresAt, databaseNow],
          );
          const state = await this.loadState(client, input.fence.scope, String(row.attempt_id));
          if (state === undefined) throw new Error("续租后无法读回状态");
          return {
            outcome: "active",
            fence: {
              scope: input.fence.scope,
              runClaim: { ...input.fence.runClaim, expiresAt },
              workspaceLease: { ...input.fence.workspaceLease, expiresAt },
            },
            databaseNow,
            run: state.run,
            workspace: state.workspace,
            ...((await isRunAgentRevoked(client, input.fence.scope))
              ? { agentRevisionRevoked: true }
              : {}),
          } as const;
        },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async issueExternalEffectPermit(input: {
    readonly fence: ExecutionFence;
    readonly expectedAttemptVersion: number;
    readonly effect: ExternalEffectPermit["effect"];
    readonly call: ExternalEffectCall;
    readonly permitDurationMs: number;
  }): ReturnType<ExecutionPersistencePort["issueExternalEffectPermit"]> {
    const permitDurationMs = boundedDuration(input.permitDurationMs, "permitDurationMs");
    if (
      !boundedIdentifier(input.call.callId) ||
      !boundedIdentifier(input.call.toolName) ||
      (input.effect === "tool_execution" && /^(?:http|mcp)__/u.test(input.call.toolName)) !==
        (input.call.toolVersionId !== undefined) ||
      (input.call.toolVersionId !== undefined &&
        !boundedIdentifier(input.call.toolVersionId, 128)) ||
      !/^[0-9a-f]{64}$/.test(input.call.argsDigest)
    ) {
      return { outcome: "conflict" };
    }
    try {
      return await withRetriedSerializableTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          const row = await this.lockFenceState(client, input.fence.scope);
          const fenceOutcome = await this.validateLockedFence(client, row, input.fence);
          if (fenceOutcome !== "active") return { outcome: fenceOutcome } as const;
          if (await isRunAgentRevoked(client, input.fence.scope))
            return { outcome: "agent_revision_revoked" } as const;
          if (Number(row?.attempt_version) !== input.expectedAttemptVersion) {
            return { outcome: "conflict" } as const;
          }
          if (
            input.effect === "model_start" &&
            (row?.model_execution_started !== true ||
              row?.attempt_stage !== "model_execution_started")
          ) {
            return { outcome: "conflict" } as const;
          }
          if (input.effect === "agent_model_start") {
            const childTurn = await client.query(
              `SELECT 1 FROM runtime_agent_turns
                WHERE tenant_id=$1 AND attempt_id=$2 AND status='running'
                  AND $3 = agent_thread_id || ':' || agent_turn_id || ':model'
                LIMIT 1`,
              [input.fence.scope.tenantId, row?.attempt_id, input.call.callId],
            );
            if (childTurn.rowCount !== 1) return { outcome: "conflict" } as const;
          }
          if (input.effect === "model_continue") {
            const steer =
              row?.attempt_stage === "model_execution_started"
                ? await client.query(
                    `SELECT 1 FROM thread_input_receipts
                      WHERE tenant_id=$1 AND thread_id=$2 AND target_run_id=$3
                        AND state='consumed' AND disposition='steered'
                        AND applied_context_sequence IS NOT NULL
                        AND $4 = $5 || '/model/steer/' || receipt_id
                      LIMIT 1`,
                    [
                      input.fence.scope.tenantId,
                      input.fence.scope.threadId,
                      input.fence.scope.runId,
                      input.call.callId,
                      row.attempt_id,
                    ],
                  )
                : undefined;
            if (steer?.rowCount !== 1) {
              const outputLimitContinuation =
                row?.attempt_stage === "model_execution_started"
                  ? await client.query(
                      `SELECT 1 FROM run_events
                        WHERE tenant_id=$1 AND attempt_id=$2
                          AND kind='agent_event'
                          AND payload->>'type'='message.completed'
                          AND payload->>'stopReason'='length'
                          AND $3 = attempt_id || '/model/output-limit/1'
                        LIMIT 1`,
                      [input.fence.scope.tenantId, row.attempt_id, input.call.callId],
                    )
                  : undefined;
              if (outputLimitContinuation?.rowCount !== 1) {
                if (row?.attempt_stage !== "workspace_verified") {
                  return { outcome: "conflict" } as const;
                }
                const correction = await client.query(
                  `SELECT 1 FROM run_events
                    WHERE tenant_id=$1 AND attempt_id=$2
                      AND kind='artifact_correction_requested'
                      AND payload->>'code'='ARTIFACT_NOT_READY'
                      AND $3 = attempt_id || '/model/correction/' || (payload->>'round')
                    LIMIT 1`,
                  [input.fence.scope.tenantId, row.attempt_id, input.call.callId],
                );
                if (correction.rowCount !== 1) return { outcome: "conflict" } as const;
                const budget = await client.query<{
                  correction_count: string;
                  feedback_bytes: string;
                }>(
                  `SELECT count(*)::text AS correction_count,
                          COALESCE(sum(octet_length(payload->>'feedback')), 0)::text AS feedback_bytes
                     FROM run_events
                    WHERE tenant_id=$1 AND attempt_id=$2
                      AND kind='artifact_correction_requested'`,
                  [input.fence.scope.tenantId, row.attempt_id],
                );
                const correctionCount = Number(budget.rows[0]?.correction_count);
                const feedbackBytes = Number(budget.rows[0]?.feedback_bytes);
                if (
                  !Number.isSafeInteger(correctionCount) ||
                  correctionCount < 1 ||
                  correctionCount > 2 ||
                  !Number.isSafeInteger(feedbackBytes) ||
                  feedbackBytes < 1 ||
                  feedbackBytes > 8 * 1_024
                ) {
                  return { outcome: "conflict" } as const;
                }
              }
            }
          }
          if (input.effect === "tool_execution") {
            const invocation = await client.query<{ tool_name: string }>(
              `SELECT tool_name FROM effect_invocations
                WHERE tenant_id=$1 AND attempt_id=$2 AND call_id=$3`,
              [input.fence.scope.tenantId, row?.attempt_id, input.call.callId],
            );
            if (invocation.rows[0]?.tool_name !== input.call.toolName) {
              return { outcome: "conflict" } as const;
            }
          }
          const permitId = `permit-${randomUUID()}`;
          const inserted = await client.query<{ issued_at: Date; expires_at: Date }>(
            `WITH permit_clock AS (
               SELECT date_trunc('milliseconds', clock_timestamp()) AS issued_at
             )
             INSERT INTO external_effect_permits(
               tenant_id,permit_id,attempt_id,effect,call_id,tool_name,args_digest,
               attempt_version,run_claim_token,run_claim_epoch,workspace_root_run_id,
               workspace_lease_epoch,tool_version_id,issued_at,expires_at
             ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$14,
                      permit_clock.issued_at,
                      permit_clock.issued_at + ($13::bigint * interval '1 millisecond')
                 FROM permit_clock
             RETURNING issued_at,expires_at`,
            [
              input.fence.scope.tenantId,
              permitId,
              row?.attempt_id,
              input.effect,
              input.call.callId,
              input.call.toolName,
              input.call.argsDigest,
              input.expectedAttemptVersion,
              input.fence.runClaim.token,
              input.fence.runClaim.epoch,
              input.fence.workspaceLease.rootRunId,
              input.fence.workspaceLease.epoch,
              permitDurationMs,
              input.call.toolVersionId ?? null,
            ],
          );
          const permitRow = inserted.rows[0];
          if (permitRow === undefined) throw new Error("许可插入没有返回行");
          return {
            outcome: "authorized",
            permit: {
              permitId,
              scope: input.fence.scope,
              runClaimToken: input.fence.runClaim.token,
              runClaimEpoch: input.fence.runClaim.epoch,
              workspaceRootRunId: input.fence.workspaceLease.rootRunId,
              workspaceLeaseEpoch: input.fence.workspaceLease.epoch,
              attemptVersion: input.expectedAttemptVersion,
              effect: input.effect,
              callId: input.call.callId,
              toolName: input.call.toolName,
              argsDigest: input.call.argsDigest,
              ...(input.call.toolVersionId === undefined
                ? {}
                : { toolVersionId: input.call.toolVersionId }),
              issuedAt: dbTimestamp(permitRow.issued_at),
              expiresAt: dbTimestamp(permitRow.expires_at),
            },
          } as const;
        },
      );
    } catch (error) {
      if (isPgCode(error, "23505") || isPgCode(error, "23503") || isPgCode(error, "23514")) {
        return { outcome: "conflict" };
      }
      return { outcome: "unavailable" };
    }
  }

  async readPendingThreadSteers(input: {
    readonly fence: ExecutionFence;
  }): ReturnType<ExecutionPersistencePort["readPendingThreadSteers"]> {
    if (this.options.threadInputRoutingV2Enabled !== true) return { outcome: "none" };
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          const row = await this.lockFenceState(client, input.fence.scope);
          const fenceOutcome = await this.validateLockedFence(client, row, input.fence);
          if (fenceOutcome !== "active") return { outcome: fenceOutcome } as const;
          if (
            row?.attempt_stage !== "model_execution_started" ||
            row.head_active_turn_id === null
          ) {
            return { outcome: "none" } as const;
          }
          const receipt = await client.query<{
            readonly receipt_id: string;
            readonly target_turn_id: string;
            readonly input_text: string;
            readonly input_attachments: unknown;
            readonly body_digest: Sha256Digest;
          }>(
            `SELECT receipt_id,target_turn_id,input_text,input_attachments,body_digest
               FROM thread_input_receipts
              WHERE tenant_id=$1 AND thread_id=$2 AND target_run_id=$3
                AND target_turn_id=$4 AND state='pending' AND disposition='pending_steer'
              ORDER BY input_sequence FOR UPDATE`,
            [
              input.fence.scope.tenantId,
              input.fence.scope.threadId,
              input.fence.scope.runId,
              row.head_active_turn_id,
            ],
          );
          if (receipt.rows.length === 0) return { outcome: "none" } as const;
          return {
            outcome: "pending",
            items: receipt.rows.map((pending) => {
              const attachments = parseUserInputAttachments(pending.input_attachments);
              return {
                receiptId: pending.receipt_id,
                targetTurnId: pending.target_turn_id,
                inputText: pending.input_text,
                ...(attachments.length === 0 ? {} : { attachments }),
                bodyDigest: pending.body_digest,
              };
            }),
          } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async consumeExternalEffectPermit(input: {
    readonly fence: ExecutionFence;
    readonly expectedAttemptVersion: number;
    readonly permit: ExternalEffectPermit;
  }): ReturnType<ExecutionPersistencePort["consumeExternalEffectPermit"]> {
    const externalTool =
      input.permit.effect === "tool_execution" && /^(?:http|mcp)__/u.test(input.permit.toolName);
    if (
      externalTool !== (input.permit.toolVersionId !== undefined) ||
      (input.permit.toolVersionId !== undefined &&
        !boundedIdentifier(input.permit.toolVersionId, 128))
    ) {
      return { outcome: "external_tool_snapshot_invalid" };
    }
    let commitOutcomeUnknown = false;
    for (let retry = 0; ; retry += 1) {
      try {
        const transact =
          input.permit.toolVersionId === undefined
            ? withRetriedSerializableTenantTransaction
            : withTenantTransaction;
        const result = await transact(
          this.pool,
          { tenantId: input.fence.scope.tenantId },
          async (client) => {
            if (input.permit.toolVersionId !== undefined) {
              // 撤销插入的外键检查必须拿同一版本的 KEY SHARE。先取得冲突行锁，再用
              // READ COMMITTED 的新语句快照观察撤销；不能复用等待前的 SERIALIZABLE 快照。
              const gate = `SELECT revoked FROM runtime_external_tool_permit_gate
                  WHERE tenant_id=$1 AND run_id=$2 AND tool_version_id=$3 AND model_tool_name=$4`;
              const binding = [
                input.fence.scope.tenantId,
                input.fence.scope.runId,
                input.permit.toolVersionId,
                input.permit.toolName,
              ];
              const locked = await client.query(gate, binding);
              if (locked.rows.length !== 1)
                return { outcome: "external_tool_snapshot_invalid" } as const;
              const status = await client.query<{ revoked: boolean }>(gate, binding);
              if (status.rows.length !== 1)
                return { outcome: "external_tool_snapshot_invalid" } as const;
              if (status.rows[0]?.revoked) return { outcome: "external_tool_revoked" } as const;
            }
            const row = await this.lockFenceState(client, input.fence.scope);
            const fenceOutcome = await this.validateLockedFence(client, row, input.fence);
            if (fenceOutcome !== "active") return { outcome: fenceOutcome } as const;
            if (await isRunAgentRevoked(client, input.fence.scope))
              return { outcome: "agent_revision_revoked" } as const;
            if (Number(row?.attempt_version) !== input.expectedAttemptVersion) {
              return { outcome: "conflict" } as const;
            }
            const stored = await client.query(
              `SELECT * FROM external_effect_permits
                WHERE tenant_id=$1 AND permit_id=$2 FOR UPDATE`,
              [input.fence.scope.tenantId, input.permit.permitId],
            );
            const permitRow = stored.rows[0];
            if (permitRow === undefined) return { outcome: "fence_lost" } as const;
            if (!storedPermitMatches(permitRow, row, input)) {
              return { outcome: "conflict" } as const;
            }
            if (permitRow.consumed_at !== null) {
              return {
                outcome: "already_consumed",
                databaseNow: dbTimestamp(permitRow.consumed_at),
              } as const;
            }
            const nowResult = await client.query<{ database_now: Date }>(
              "SELECT clock_timestamp() AS database_now",
            );
            const databaseNow = dbTimestamp(nowResult.rows[0]?.database_now);
            if (Date.parse(dbTimestamp(permitRow.expires_at)) <= Date.parse(databaseNow)) {
              return { outcome: "expired" } as const;
            }
            await client.query(
              `UPDATE external_effect_permits SET consumed_at=$3
                WHERE tenant_id=$1 AND permit_id=$2 AND consumed_at IS NULL`,
              [input.fence.scope.tenantId, input.permit.permitId, databaseNow],
            );
            return { outcome: "consumed", databaseNow } as const;
          },
        );
        if (result.outcome === "already_consumed") {
          // 只有本次调用已经遇到 COMMIT 响应未知时，读回 consumed 才能证明第一次提交成功。
          // 独立的第二次调用仍返回 already_consumed，防止重复放行外部副作用。
          return commitOutcomeUnknown
            ? { outcome: "consumed", databaseNow: result.databaseNow }
            : { outcome: "already_consumed" };
        }
        return result;
      } catch (error) {
        if (isPgCode(error, "23505") || isPgCode(error, "23503") || isPgCode(error, "23514")) {
          return { outcome: "conflict" };
        }
        if (error instanceof TransactionCommitUnknownError) {
          commitOutcomeUnknown = true;
        } else if (!isRetryablePersistenceFailure(error)) {
          return { outcome: "unavailable" };
        }
        const retryDelay = permitConsumptionRetryDelaysMs[retry];
        if (retryDelay === undefined) return { outcome: "unavailable" };
        await delay(retryDelay);
      }
    }
  }

  async mutate(command: RuntimeMutation): Promise<RuntimeMutationResult> {
    if (!mutationStorageShapeValid(command)) return { outcome: "protocol_invalid" };
    const { commandDigest: suppliedDigest, ...unsigned } = command;
    if (runtimeMutationDigest(unsigned) !== suppliedDigest) {
      return { outcome: "idempotency_conflict" };
    }
    let result: RuntimeMutationResult | undefined;
    for (let retry = 0; result === undefined; retry += 1) {
      try {
        result = await withTenantTransaction(
          this.pool,
          { tenantId: command.fence.scope.tenantId },
          (client) => this.applyMutation(client, command),
          { isolationLevel: "SERIALIZABLE" },
        );
      } catch (error) {
        if (error instanceof TransactionCommitUnknownError) return { outcome: "response_unknown" };
        if (error instanceof RuntimeWriteAbort) return { outcome: error.outcome };
        if (isPgCode(error, "23514")) return { outcome: "protocol_invalid" };
        if (isPgCode(error, "23505") || isPgCode(error, "23503")) {
          return { outcome: "idempotency_conflict" };
        }
        const retryDelay = mutationSerializableRetryDelaysMs[retry];
        if ((isPgCode(error, "40001") || isPgCode(error, "40P01")) && retryDelay !== undefined) {
          // PostgreSQL 已明确回滚 SERIALIZABLE/deadlock 事务，原幂等命令可安全重放；
          // COMMIT 结果未知仍由上面的独立分支禁止重试。
          await delay(retryDelay);
          continue;
        }
        return { outcome: "unavailable" };
      }
    }
    try {
      await this.options.afterCommit?.("mutate");
      return result;
    } catch {
      // afterCommit 故障无法判断 COMMIT 响应是否抵达，调用方必须按原 scope+key 精确读回。
      return { outcome: "response_unknown" };
    }
  }

  async readMutation(input: {
    readonly scope: ExecutionScope;
    readonly idempotencyKey: string;
  }): Promise<RuntimeMutationResult | { readonly outcome: "not_found" }> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.scope.tenantId },
        async (client) => {
          const result = await client.query<{
            result_snapshot: AppliedMutation;
            attempt_id: string;
            thread_id: string;
            workspace_id: string;
            root_run_id: string;
            base_revision_id: string | null;
          }>(
            `SELECT receipt.result_snapshot, receipt.attempt_id,
                    attempt.thread_id, attempt.workspace_id, attempt.root_run_id,
                    attempt.base_revision_id
               FROM mutation_receipts receipt
               JOIN execution_attempts attempt
                 ON attempt.tenant_id=receipt.tenant_id AND attempt.attempt_id=receipt.attempt_id
              WHERE receipt.tenant_id=$1 AND receipt.run_id=$2 AND receipt.idempotency_key=$3`,
            [input.scope.tenantId, input.scope.runId, input.idempotencyKey],
          );
          const row = result.rows[0];
          if (row === undefined) {
            const sameRun = await client.query("SELECT 1 FROM runs WHERE tenant_id=$1 AND id=$2", [
              input.scope.tenantId,
              input.scope.runId,
            ]);
            return sameRun.rowCount === 0
              ? ({ outcome: "not_found" } as const)
              : ({ outcome: "not_found" } as const);
          }
          if (
            row.thread_id !== input.scope.threadId ||
            row.workspace_id !== input.scope.workspaceId ||
            row.root_run_id !== input.scope.rootRunId ||
            (row.base_revision_id ?? undefined) !== input.scope.baseRevisionId
          ) {
            return { outcome: "scope_mismatch" } as const;
          }
          return { ...jsonValue<AppliedMutation>(row.result_snapshot), outcome: "applied" };
        },
        { readOnly: true },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async recoverExpiredAttempt(input: {
    readonly scope: ExecutionScope;
    readonly decision: "safe_fail" | "require_manual_recovery" | "abandon";
  }): Promise<"recovered" | "not_expired" | "not_found" | "scope_mismatch" | "unavailable"> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.scope.tenantId },
        async (client) => {
          const existingRecovery = await inspectExpiredAttemptRecovery(client, input.scope);
          if (existingRecovery === "scope_mismatch") return "scope_mismatch" as const;
          if (existingRecovery === "recovered") {
            return "recovered" as const;
          }
          const row = await this.lockFenceState(client, input.scope);
          if (row === undefined) return "not_found" as const;
          if (!scopeMatches(row, input.scope)) return "scope_mismatch" as const;
          const nowResult = await client.query<{ database_now: Date }>(
            "SELECT clock_timestamp() AS database_now",
          );
          const databaseNow = dbTimestamp(nowResult.rows[0]?.database_now);
          if (
            row.claim_released_at !== null ||
            (Date.parse(dbTimestamp(row.claim_expires_at)) > Date.parse(databaseNow) &&
              Date.parse(dbTimestamp(row.lease_expires_at)) > Date.parse(databaseNow) &&
              (row.queue_state !== "active" ||
                row.head_active_run_id !== input.scope.runId ||
                (Date.parse(dbTimestamp(row.head_writer_expires_at)) > Date.parse(databaseNow) &&
                  Date.parse(dbTimestamp(row.queue_claim_expires_at)) > Date.parse(databaseNow))))
          ) {
            return "not_expired" as const;
          }
          const forceManual =
            input.decision === "require_manual_recovery" || row.model_execution_started;
          const attemptStatus = forceManual
            ? "recovery_required"
            : input.decision === "safe_fail"
              ? "failed"
              : "abandoned";
          await prepareExpiredThreadSandboxTermination(client, {
            scope: input.scope,
            attemptId: String(row.attempt_id),
            databaseNow,
          });
          await releasePreparedWorkspaceCandidates(client, {
            tenantId: input.scope.tenantId,
            attemptId: String(row.attempt_id),
            reason: "expired_recovery",
          });
          await client.query(
            `UPDATE execution_attempts
                SET status=$3, version=version+1, updated_at=$4, finished_at=$4
              WHERE tenant_id=$1 AND attempt_id=$2`,
            [input.scope.tenantId, row.attempt_id, attemptStatus, databaseNow],
          );
          if (attemptStatus === "failed") {
            const failed = await client.query<{ readonly version: string }>(
              `UPDATE runs SET status='failed', version=version+1, updated_at=$3
                WHERE tenant_id=$1 AND id=$2 AND status='running'
                RETURNING version`,
              [input.scope.tenantId, input.scope.runId, databaseNow],
            );
            const failedVersion = failed.rows[0]?.version;
            // 只有本事务实际完成 running→failed 时才产生事件；外部已终结的 Run 不重复发送。
            if (failedVersion !== undefined)
              await enqueueRunStatusWebhook(client, {
                tenantId: input.scope.tenantId,
                runId: input.scope.runId,
                status: "failed",
                runVersion: failedVersion,
                occurredAt: databaseNow,
              });
          }
          await client.query(
            `UPDATE run_claims SET released_at=$3, updated_at=$3
              WHERE tenant_id=$1 AND attempt_id=$2 AND released_at IS NULL`,
            [input.scope.tenantId, row.attempt_id, databaseNow],
          );
          await client.query(
            `DELETE FROM workspace_write_leases
              WHERE tenant_id=$1 AND workspace_id=$2 AND root_run_id=$3 AND epoch=$4`,
            [
              input.scope.tenantId,
              input.scope.workspaceId,
              input.scope.rootRunId,
              Number(row.lease_row_epoch),
            ],
          );
          if (attemptStatus === "failed") {
            await settleActiveThreadRun(client, {
              tenantId: input.scope.tenantId,
              threadId: input.scope.threadId,
              runId: input.scope.runId,
              runStatus: "failed",
              databaseNow,
            });
          } else if (row.queue_state === "active" && row.head_active_run_id === input.scope.runId) {
            await client.query(
              `UPDATE thread_execution_heads
                  SET writer_owner=NULL,writer_token=NULL,writer_expires_at=NULL,
                      version=version+1,updated_at=$4
                WHERE tenant_id=$1 AND thread_id=$2 AND active_run_id=$3`,
              [input.scope.tenantId, input.scope.threadId, input.scope.runId, databaseNow],
            );
            await client.query(
              `UPDATE thread_follow_up_queue
                  SET claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL
                WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND state='active'`,
              [input.scope.tenantId, input.scope.threadId, input.scope.runId],
            );
          }
          return "recovered" as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch {
      return "unavailable";
    }
  }

  private async applyMutation(
    client: PoolClient,
    command: RuntimeMutation,
  ): Promise<RuntimeMutationResult> {
    const encodedPayloads = [
      ...command.events.map((event) => serializedJson(event.payload)),
      ...command.outbox.map((item) =>
        serializedJson(
          item.kind === "sandbox_lifecycle_unknown" ? item.payload.uncertainEvent : item.payload,
        ),
      ),
      ...(command.rolloutProjection === undefined
        ? []
        : [serializedJson(command.rolloutProjection)]),
    ];
    if (
      encodedPayloads.some((value) => value === undefined) ||
      !(await jsonValuesFitStorage(client, encodedPayloads as string[]))
    ) {
      throw new RuntimeWriteAbort("protocol_invalid");
    }
    const row = await this.lockFenceState(client, command.fence.scope);
    if (row === undefined) return { outcome: "fence_lost" };
    if (!scopeMatches(row, command.fence.scope)) return { outcome: "scope_mismatch" };
    const externallyCancelled =
      row.run_status === "cancelled" &&
      row.claim_released_at === null &&
      durableFenceIdentityMatches(row, command.fence) &&
      isExternalCancellationFinalizationMutation(command, String(row.attempt_id));
    if (!externallyCancelled) {
      if (!fenceMatches(row, command.fence)) return { outcome: "fence_lost" };
      const fenceOutcome = await this.validateLockedFence(client, row, command.fence);
      if (fenceOutcome !== "active") {
        return { outcome: fenceOutcome === "cancelled" ? "fence_lost" : fenceOutcome };
      }
    }

    // EffectInvocation 的永久唯一性高于 mutation key 幂等重放。
    if (command.effectInvocation !== undefined) {
      const duplicate = await client.query(
        `SELECT 1 FROM effect_invocations
          WHERE tenant_id=$1 AND attempt_id=$2 AND call_id=$3`,
        [command.fence.scope.tenantId, row.attempt_id, command.effectInvocation.callId],
      );
      if (duplicate.rowCount !== 0) return { outcome: "idempotency_conflict" };
    }

    const previousReceipt = await client.query<{
      command_digest: string;
      result_snapshot: AppliedMutation;
    }>(
      `SELECT command_digest,result_snapshot FROM mutation_receipts
        WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3`,
      [command.fence.scope.tenantId, row.attempt_id, command.idempotencyKey],
    );
    const replay = previousReceipt.rows[0];
    if (replay !== undefined) {
      return replay.command_digest === command.commandDigest
        ? { ...jsonValue<AppliedMutation>(replay.result_snapshot), outcome: "already_applied" }
        : { outcome: "idempotency_conflict" };
    }
    if (Number(row.attempt_version) !== command.expectedAttemptVersion) {
      return { outcome: "conflict" };
    }
    if (
      command.events.some(
        (event, index) => event.sequence !== Number(row.next_event_sequence) + index,
      )
    ) {
      return { outcome: "conflict" };
    }
    if (
      command.rolloutProjection === undefined
        ? command.expectedProjectionVersion !== undefined
        : command.expectedProjectionVersion !== Number(row.projection_version)
    ) {
      return { outcome: "conflict" };
    }
    if (!attemptTransitionAllowed(row.attempt_status, command.nextAttemptStatus)) {
      return { outcome: "conflict" };
    }
    if (
      command.threadSandboxTerminal !== undefined &&
      (this.options.threadSandboxSessionReuseEnabled !== true ||
        command.releaseFences !== true ||
        command.nextRunStatus === undefined ||
        !["waiting", "succeeded", "failed", "cancelled"].includes(command.nextRunStatus))
    ) {
      return { outcome: "conflict" };
    }
    let pendingSteer:
      | {
          readonly receipt_id: string;
          readonly target_turn_id: string;
          readonly input_text: string;
          readonly body_digest: Sha256Digest;
        }
      | undefined;
    if (command.threadSteer !== undefined) {
      if (
        this.options.threadInputRoutingV2Enabled !== true ||
        this.options.threadContextWriteEnabled !== true ||
        row.attempt_stage !== "model_execution_started" ||
        row.head_active_run_id !== command.fence.scope.runId ||
        row.head_active_turn_id !== command.threadSteer.targetTurnId
      ) {
        return { outcome: "conflict" };
      }
      const receipt = await client.query<NonNullable<typeof pendingSteer>>(
        `SELECT receipt_id,target_turn_id,input_text,body_digest
           FROM thread_input_receipts
          WHERE tenant_id=$1 AND thread_id=$2 AND receipt_id=$3
            AND target_run_id=$4 AND target_turn_id=$5
            AND state='pending' AND disposition='pending_steer'
          FOR UPDATE`,
        [
          command.fence.scope.tenantId,
          command.fence.scope.threadId,
          command.threadSteer.receiptId,
          command.fence.scope.runId,
          command.threadSteer.targetTurnId,
        ],
      );
      pendingSteer = receipt.rows[0];
      if (
        pendingSteer === undefined ||
        pendingSteer.body_digest !== command.threadSteer.bodyDigest
      ) {
        return { outcome: "conflict" };
      }
    }
    if (command.effectInvocation !== undefined) {
      const matchingStarted = command.events.filter(
        (event) =>
          event.kind === "agent_event" &&
          event.payload.type === "tool.started" &&
          event.payload.callId === command.effectInvocation?.callId &&
          event.payload.name === command.effectInvocation.toolName,
      );
      if (matchingStarted.length !== 1) return { outcome: "conflict" };
    } else if (
      command.events.some(
        (event) => event.kind === "agent_event" && event.payload.type === "tool.started",
      )
    ) {
      return { outcome: "conflict" };
    }

    const nowResult = await client.query<{ database_now: Date }>(
      "SELECT clock_timestamp() AS database_now",
    );
    const databaseNow = dbTimestamp(nowResult.rows[0]?.database_now);
    const previousAttemptVersion = Number(row.attempt_version);
    const nextAttemptVersion = previousAttemptVersion + 1;
    const eventSequenceStart = Number(row.next_event_sequence);
    const eventSequenceEnd = eventSequenceStart + command.events.length;

    let workspaceReceipt: RuntimeMutationReceiptV1["workspace"];
    if (command.workspaceChange !== undefined) {
      const change = command.workspaceChange;
      if (
        change.tenantId !== command.fence.scope.tenantId ||
        change.threadId !== command.fence.scope.threadId ||
        change.workspaceId !== command.fence.scope.workspaceId ||
        change.rootRunId !== command.fence.scope.rootRunId ||
        (change.parentRevisionId ?? undefined) !== (row.attempt_current_revision_id ?? undefined) ||
        (row.current_revision_id ?? undefined) !== (row.attempt_current_revision_id ?? undefined)
      ) {
        return { outcome: "conflict" };
      }
      const candidate = await client.query<{
        readonly manifest_digest: string;
        readonly file_count: string;
      }>(
        `SELECT candidate.manifest_digest,
                (SELECT count(*)::text FROM workspace_revision_candidate_files file
                  WHERE file.tenant_id=candidate.tenant_id
                    AND file.workspace_id=candidate.workspace_id
                    AND file.attempt_id=candidate.attempt_id
                    AND file.operation_key=candidate.operation_key) AS file_count
           FROM workspace_revision_candidates candidate
          WHERE candidate.tenant_id=$1 AND candidate.workspace_id=$2
            AND candidate.attempt_id=$3 AND candidate.run_id=$4 AND candidate.thread_id=$5
            AND candidate.root_run_id=$6 AND candidate.parent_revision_key=COALESCE($7,'')
            AND candidate.revision_id=$8 AND candidate.operation_key=$9
            AND candidate.operation_digest=$10 AND candidate.status='prepared'
          FOR UPDATE`,
        [
          change.tenantId,
          change.workspaceId,
          row.attempt_id,
          command.fence.scope.runId,
          change.threadId,
          change.rootRunId,
          change.parentRevisionId ?? null,
          change.revisionId,
          change.candidateOperationKey,
          change.candidateOperationDigest,
        ],
      );
      const prepared = candidate.rows[0];
      if (
        prepared === undefined ||
        prepared.manifest_digest !== change.manifest.digest ||
        prepared.file_count !== String(change.manifest.entries.length)
      ) {
        return { outcome: "conflict" };
      }
      const revisionNumber = Number(row.current_revision_number) + 1;
      await client.query(
        `INSERT INTO workspace_revisions(
           tenant_id,workspace_id,id,thread_id,revision_number,parent_revision_id,
           created_by_run_id,lease_epoch,object_key,digest,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10)`,
        [
          change.tenantId,
          change.workspaceId,
          change.revisionId,
          change.threadId,
          revisionNumber,
          change.parentRevisionId ?? null,
          change.rootRunId,
          command.fence.workspaceLease.epoch,
          change.manifest.digest,
          databaseNow,
        ],
      );
      const totalBytes = change.manifest.entries.reduce(
        (sum, entry) => sum + entry.content.size,
        0,
      );
      await client.query(
        `INSERT INTO workspace_revision_manifests(
           tenant_id,workspace_id,revision_id,thread_id,schema_version,manifest_digest,entry_count,total_bytes,created_at
         ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
        [
          change.tenantId,
          change.workspaceId,
          change.revisionId,
          change.threadId,
          change.manifest.digest,
          change.manifest.entries.length,
          totalBytes,
          databaseNow,
        ],
      );
      for (const entry of change.manifest.entries) {
        // 每一条 manifest entry 都必须在同一事务内锁定 exact stable incarnation；不能只保存
        // digest 或非约束 physical key，否则 GC/重用后会把 revision 指向另一个对象。
        const inserted = await client.query(
          `INSERT INTO workspace_revision_files(
             tenant_id,workspace_id,revision_id,relative_path,content_sha256,size,
             blob_lifecycle_id,blob_incarnation_id,physical_object_key
           )
           SELECT $1,$2,$3,$4,$5,$6,file.blob_lifecycle_id,file.blob_incarnation_id,
                  file.physical_object_key
             FROM workspace_revision_candidate_files file
             JOIN blob_incarnations incarnation
               ON incarnation.tenant_id=file.tenant_id
              AND incarnation.lifecycle_id=file.blob_lifecycle_id
              AND incarnation.incarnation_id=file.blob_incarnation_id
              AND incarnation.physical_object_key=file.physical_object_key
             JOIN blob_lifecycles lifecycle
               ON lifecycle.tenant_id=incarnation.tenant_id
              AND lifecycle.lifecycle_id=incarnation.lifecycle_id
             LEFT JOIN blob_references reference
               ON reference.tenant_id=file.tenant_id
              AND reference.reference_id=file.blob_reference_id
            WHERE file.tenant_id=$1 AND file.workspace_id=$2 AND file.attempt_id=$7
              AND file.operation_key=$8 AND file.operation_digest=$9
              AND file.manifest_digest=$10 AND file.relative_path=$4
              AND file.content_sha256=$5 AND file.size=$6
              AND file.blob_incarnation_id=$11::uuid AND file.physical_object_key=$12
              AND incarnation.purpose='workspace' AND incarnation.state='active'
              AND lifecycle.state='active'
              AND ((file.source='base' AND file.blob_reference_id IS NULL)
                OR (file.source='uploaded' AND reference.state='stable'
                  AND reference.purpose='workspace'
                  AND reference.lifecycle_id=file.blob_lifecycle_id
                  AND reference.incarnation_id=file.blob_incarnation_id
                  AND reference.physical_object_key=file.physical_object_key))`,
          [
            change.tenantId,
            change.workspaceId,
            change.revisionId,
            entry.path,
            entry.content.sha256,
            entry.content.size,
            row.attempt_id,
            change.candidateOperationKey,
            change.candidateOperationDigest,
            change.manifest.digest,
            entry.object.incarnationId,
            entry.object.physicalObjectKey,
          ],
        );
        if (inserted.rowCount !== 1) throw new RuntimeWriteAbort("conflict");
      }
      // Artifact intent 与 Revision 文件使用同一事务内刚写入的 exact path/hash/incarnation。
      // 任一步冲突都会连同 Workspace head 一起回滚，外部读侧永远看不到半发布 Artifact。
      await settleWorkspaceArtifactIntents(client, {
        tenantId: change.tenantId,
        attemptId: String(row.attempt_id),
        runId: command.fence.scope.runId,
        threadId: change.threadId,
        workspaceId: change.workspaceId,
        rootRunId: change.rootRunId,
        revisionId: change.revisionId,
        databaseNow,
        historyFilesystemEnabled: this.options.historyFilesystemEnabled ?? false,
        runOrigin: row.run_origin,
        historyDirectoryTimeZone:
          this.options.historyDirectoryTimeZone ?? DEFAULT_HISTORY_DIRECTORY_TIME_ZONE,
      });
      const uploadedCount = await client.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count FROM workspace_revision_candidate_files
          WHERE tenant_id=$1 AND workspace_id=$2 AND attempt_id=$3 AND operation_key=$4
            AND source='uploaded'`,
        [change.tenantId, change.workspaceId, row.attempt_id, change.candidateOperationKey],
      );
      const released = await client.query(
        `UPDATE blob_references reference SET state='released',updated_at=$5
           FROM workspace_revision_candidate_files file
          WHERE file.tenant_id=$1 AND file.workspace_id=$2 AND file.attempt_id=$3
            AND file.operation_key=$4 AND file.source='uploaded'
            AND reference.tenant_id=file.tenant_id
            AND reference.reference_id=file.blob_reference_id AND reference.state='stable'`,
        [
          change.tenantId,
          change.workspaceId,
          row.attempt_id,
          change.candidateOperationKey,
          databaseNow,
        ],
      );
      if (released.rowCount !== Number(uploadedCount.rows[0]?.count ?? "-1")) {
        throw new RuntimeWriteAbort("conflict");
      }
      const committedCandidate = await client.query(
        `UPDATE workspace_revision_candidates
            SET status='committed',updated_at=$5
          WHERE tenant_id=$1 AND workspace_id=$2 AND attempt_id=$3 AND operation_key=$4
            AND status='prepared'`,
        [
          change.tenantId,
          change.workspaceId,
          row.attempt_id,
          change.candidateOperationKey,
          databaseNow,
        ],
      );
      if (committedCandidate.rowCount !== 1) throw new RuntimeWriteAbort("conflict");
      await client.query(
        `UPDATE workspaces
            SET current_revision_number=$3,current_revision_id=$4,updated_at=$5
          WHERE tenant_id=$1 AND id=$2`,
        [change.tenantId, change.workspaceId, revisionNumber, change.revisionId, databaseNow],
      );
      workspaceReceipt = {
        changeDigest: workspaceChangeDigest(change),
        ...(change.parentRevisionId === undefined ? {} : { previousHead: change.parentRevisionId }),
        currentHead: change.revisionId,
      };
    }

    let threadContextReceipt: RuntimeMutationReceiptV1["threadContext"];
    let threadSteerReceipt: RuntimeMutationReceiptV1["threadSteer"];
    if (pendingSteer !== undefined && command.threadSteer !== undefined) {
      const userBody = { role: "user", text: pendingSteer.input_text };
      threadContextReceipt = await appendThreadContext(
        client,
        { scope: command.fence.scope, attemptId: String(row.attempt_id) },
        {
          schemaVersion: 1,
          idempotencyKey: `${row.attempt_id}/steer/${pendingSteer.receipt_id}`,
          entries: [
            {
              entryId: `${row.attempt_id}/steer/${pendingSteer.receipt_id}/user-message`,
              kind: "user_message",
              body: {
                storage: "inline",
                value: userBody,
                sha256: digestCanonical(userBody),
                size: Buffer.byteLength(JSON.stringify(userBody), "utf8"),
              },
            },
          ],
        },
        databaseNow,
      );
      const applied = await client.query(
        `UPDATE thread_input_receipts
            SET state='consumed',disposition='steered',applied_context_sequence=$4,
                consumed_at=$5,updated_at=$5
          WHERE tenant_id=$1 AND thread_id=$2 AND receipt_id=$3
            AND state='pending' AND disposition='pending_steer'`,
        [
          command.fence.scope.tenantId,
          command.fence.scope.threadId,
          pendingSteer.receipt_id,
          threadContextReceipt.firstSequence,
          databaseNow,
        ],
      );
      if (applied.rowCount !== 1) throw new RuntimeWriteAbort("conflict");
      await client.query(
        `INSERT INTO thread_input_receipt_events(
           tenant_id,thread_id,receipt_id,event_sequence,event_kind,disposition,
           target_run_id,target_turn_id,created_at
         ) VALUES ($1,$2,$3,2,'disposition_changed','steered',$4,$5,$6)`,
        [
          command.fence.scope.tenantId,
          command.fence.scope.threadId,
          pendingSteer.receipt_id,
          command.fence.scope.runId,
          pendingSteer.target_turn_id,
          databaseNow,
        ],
      );
      await client.query(
        `INSERT INTO thread_continuity_metric_observations(
           tenant_id,observation_id,thread_id,run_id,metric_name,value,unit,outcome
         ) SELECT $1,$2,$3,$4,'steer_apply_latency_ms',
                  GREATEST(0,EXTRACT(EPOCH FROM ($5::timestamptz-receipt.created_at))*1000),
                  'milliseconds','steered'
             FROM thread_input_receipts receipt
            WHERE receipt.tenant_id=$1 AND receipt.thread_id=$3 AND receipt.receipt_id=$6
         ON CONFLICT (tenant_id,observation_id) DO NOTHING`,
        [
          command.fence.scope.tenantId,
          `${pendingSteer.receipt_id}:steer-latency`,
          command.fence.scope.threadId,
          command.fence.scope.runId,
          databaseNow,
          pendingSteer.receipt_id,
        ],
      );
      threadSteerReceipt = {
        receiptId: pendingSteer.receipt_id,
        targetTurnId: pendingSteer.target_turn_id,
        appliedContextSequence: threadContextReceipt.firstSequence,
        bodyDigest: pendingSteer.body_digest,
      };
    } else if (command.threadContextAppend !== undefined) {
      threadContextReceipt = await appendThreadContext(
        client,
        { scope: command.fence.scope, attemptId: String(row.attempt_id) },
        command.threadContextAppend,
        databaseNow,
      );
    }

    if (command.effectInvocation !== undefined) {
      await client.query(
        `INSERT INTO effect_invocations(tenant_id,attempt_id,call_id,tool_name,registered_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          command.fence.scope.tenantId,
          row.attempt_id,
          command.effectInvocation.callId,
          command.effectInvocation.toolName,
          databaseNow,
        ],
      );
    }

    const actionCount = command.events.filter(
      (e) => e.kind === "run_waiting" && e.payload.action !== undefined,
    ).length;
    const waitTools =
      actionCount > 0
        ? (await readRunAgentSnapshot(client, command.fence.scope))?.content.tools
        : undefined;
    if (
      actionCount > 0 &&
      (actionCount > 8 ||
        row.run_origin === "playground" ||
        waitTools?.mode !== "configured" ||
        waitTools.toolCallingMode !== "native" ||
        command.nextRunStatus !== "waiting" ||
        command.nextAttemptStatus !== "waiting" ||
        command.releaseFences !== true)
    )
      throw new RuntimeWriteAbort("protocol_invalid");
    for (const event of command.events) {
      let payload: unknown = event.payload;
      if (event.kind === "run_waiting" && event.payload.action !== undefined) {
        const { action, ...waiting } = event.payload;
        const declared =
          waitTools?.mode === "configured"
            ? waitTools.clientTools.find((t) => t.name === action.toolName)
            : undefined;
        if (
          !declared ||
          action.waitTimeoutMs !== (declared.waitTimeoutMs ?? 300_000) ||
          Buffer.byteLength(JSON.stringify(action.arguments)) > 16_384
        )
          throw new RuntimeWriteAbort("protocol_invalid");
        payload = {
          ...waiting,
          ...(await persistClientAction(
            client,
            command.fence.scope,
            String(row.attempt_id),
            action,
            databaseNow,
          )),
        };
      }
      await client.query(
        `WITH inserted AS (INSERT INTO run_events(
           tenant_id,attempt_id,sequence,schema_version,kind,payload,occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING sequence)
         SELECT pg_notify($8,$9) FROM inserted`,
        [
          command.fence.scope.tenantId,
          row.attempt_id,
          event.sequence,
          event.schemaVersion,
          event.kind,
          JSON.stringify(payload),
          databaseNow,
          RUN_EVENT_WAKE_CHANNEL,
          runEventWakeKey(command.fence.scope.tenantId, command.fence.scope.runId),
        ],
      );
    }

    if (actionCount > 0)
      await scheduleClientWait(client, command.fence.scope.tenantId, command.fence.scope.runId);
    const outboxReceipts: RuntimeOutboxReceiptV1[] = [];
    for (const item of command.outbox) {
      outboxReceipts.push(
        await this.applyOutboxItem(
          client,
          command.fence.scope.tenantId,
          String(row.attempt_id),
          item,
          databaseNow,
        ),
      );
    }

    let projectionReceipt: RuntimeMutationReceiptV1["projection"];
    if (command.rolloutProjection !== undefined) {
      const digest = rolloutProjectionDigest(command.rolloutProjection);
      const nextProjectionVersion = Number(row.projection_version) + 1;
      const updated = await client.query(
        `UPDATE rollout_projections
            SET version=$4,projection=$5::jsonb,digest=$6,updated_at=$7
          WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3 AND version=$8`,
        [
          command.fence.scope.tenantId,
          command.fence.scope.runId,
          row.attempt_id,
          nextProjectionVersion,
          JSON.stringify(command.rolloutProjection),
          digest,
          databaseNow,
          command.expectedProjectionVersion,
        ],
      );
      if (updated.rowCount !== 1) throw new RuntimeWriteAbort("conflict");
      projectionReceipt = {
        schemaVersion: 1,
        previousVersion: Number(row.projection_version),
        version: nextProjectionVersion,
        digest,
      };
    }

    if (command.nextRunStatus !== undefined && !externallyCancelled) {
      const updated = await client.query<{ readonly version: string }>(
        `UPDATE runs SET status=$3,version=version+1,updated_at=$4
          WHERE tenant_id=$1 AND id=$2 AND status='running'
          RETURNING version`,
        [
          command.fence.scope.tenantId,
          command.fence.scope.runId,
          command.nextRunStatus,
          databaseNow,
        ],
      );
      const nextVersion = updated.rows[0]?.version;
      if (updated.rowCount !== 1 || nextVersion === undefined)
        throw new RuntimeWriteAbort("conflict");
      await enqueueRunStatusWebhook(client, {
        tenantId: command.fence.scope.tenantId,
        runId: command.fence.scope.runId,
        status: command.nextRunStatus,
        runVersion: nextVersion,
        occurredAt: databaseNow,
      });
    }

    const succeededWithMemory =
      this.options.memoryIngestionEnabled === true && command.nextRunStatus === "succeeded";
    const terminalAgent =
      succeededWithMemory || command.threadSandboxTerminal !== undefined
        ? await readRunAgentSnapshot(client, command.fence.scope)
        : undefined;
    if (
      succeededWithMemory &&
      terminalAgent !== undefined &&
      (terminalAgent.content.memory.mode === "platform_default" ||
        terminalAgent.content.memory.longTermEnabled)
    ) {
      if (threadContextReceipt === undefined) {
        throw new RuntimeWriteAbort("protocol_invalid");
      }
      await enqueueMemoryIngestion(client, {
        tenantId: command.fence.scope.tenantId,
        threadId: command.fence.scope.threadId,
        runId: command.fence.scope.runId,
        attemptId: String(row.attempt_id),
        sourceThroughSequence: threadContextReceipt.lastSequence,
      });
    }

    const nextStatus = command.nextAttemptStatus ?? row.attempt_status;
    const nextStage = command.nextStage ?? row.attempt_stage;
    const finished = [
      "waiting",
      "succeeded",
      "failed",
      "cancelled",
      "recovery_required",
      "abandoned",
    ].includes(nextStatus);
    const updatedAttempt = await client.query(
      `UPDATE execution_attempts SET
         current_revision_id=COALESCE($3,current_revision_id), status=$4, stage=$5,
         version=$6, next_event_sequence=$7,
         projection_version=$8,
         model_execution_started=(model_execution_started OR $5='model_execution_started'),
         updated_at=$9::timestamptz,
         finished_at=CASE WHEN $10::boolean THEN $9::timestamptz ELSE NULL END
       WHERE tenant_id=$1 AND attempt_id=$2 AND version=$11`,
      [
        command.fence.scope.tenantId,
        row.attempt_id,
        command.workspaceChange?.revisionId ?? null,
        nextStatus,
        nextStage,
        nextAttemptVersion,
        eventSequenceEnd,
        command.rolloutProjection === undefined
          ? Number(row.projection_version)
          : Number(row.projection_version) + 1,
        databaseNow,
        finished,
        previousAttemptVersion,
      ],
    );
    if (updatedAttempt.rowCount !== 1) throw new RuntimeWriteAbort("conflict");

    if (command.releaseFences === true) {
      await releasePreparedWorkspaceCandidates(client, {
        tenantId: command.fence.scope.tenantId,
        attemptId: String(row.attempt_id),
        reason: "terminal",
      });
      await client.query(
        `UPDATE run_claims SET released_at=$3,updated_at=$3
          WHERE tenant_id=$1 AND attempt_id=$2 AND released_at IS NULL`,
        [command.fence.scope.tenantId, row.attempt_id, databaseNow],
      );
      await client.query(
        `DELETE FROM workspace_write_leases
          WHERE tenant_id=$1 AND workspace_id=$2 AND root_run_id=$3 AND epoch=$4`,
        [
          command.fence.scope.tenantId,
          command.fence.scope.workspaceId,
          command.fence.scope.rootRunId,
          command.fence.workspaceLease.epoch,
        ],
      );
      if (command.nextRunStatus === "waiting" && row.queue_state === "active") {
        const releasedWriter = await client.query(
          `UPDATE thread_execution_heads
              SET writer_owner=NULL,writer_token=NULL,writer_expires_at=NULL,
                  version=version+1,updated_at=$6
            WHERE tenant_id=$1 AND thread_id=$2 AND active_run_id=$3
              AND writer_token=$4 AND writer_epoch=$5`,
          [
            command.fence.scope.tenantId,
            command.fence.scope.threadId,
            command.fence.scope.runId,
            command.fence.runClaim.token,
            command.fence.runClaim.epoch,
            databaseNow,
          ],
        );
        const releasedQueueClaim = await client.query(
          `UPDATE thread_follow_up_queue
              SET claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL
            WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND state='active'
              AND claim_token=$4 AND claim_epoch=$5`,
          [
            command.fence.scope.tenantId,
            command.fence.scope.threadId,
            command.fence.scope.runId,
            command.fence.runClaim.token,
            command.fence.runClaim.epoch,
          ],
        );
        if (releasedWriter.rowCount !== 1 || releasedQueueClaim.rowCount !== 1) {
          throw new RuntimeWriteAbort("fence_lost");
        }
      }
    }

    let activatedNextRunId: string | undefined;
    if (
      command.releaseFences === true &&
      command.nextRunStatus !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(command.nextRunStatus)
    ) {
      await settleActiveThreadRun(client, {
        tenantId: command.fence.scope.tenantId,
        threadId: command.fence.scope.threadId,
        runId: command.fence.scope.runId,
        runStatus: command.nextRunStatus as "succeeded" | "failed" | "cancelled",
        databaseNow,
      });
      const activeHead = await client.query<{ active_run_id: string | null }>(
        `SELECT active_run_id FROM thread_execution_heads
          WHERE tenant_id=$1 AND thread_id=$2`,
        [command.fence.scope.tenantId, command.fence.scope.threadId],
      );
      const activeRunId = activeHead.rows[0]?.active_run_id ?? null;
      if (activeRunId !== null && activeRunId !== command.fence.scope.runId) {
        activatedNextRunId = activeRunId;
      }
    }

    const threadSandboxReceipt =
      command.threadSandboxTerminal === undefined
        ? undefined
        : await applyThreadSandboxTerminal(client, {
            scope: command.fence.scope,
            attemptId: String(row.attempt_id),
            command: command.threadSandboxTerminal,
            forceClose:
              terminalAgent?.content.sandboxIdleAction !== "pause" ||
              (command.nextRunStatus === "failed" &&
                (await isRunAgentRevoked(client, command.fence.scope))),
            ...(command.workspaceChange?.revisionId === undefined && row.current_revision_id == null
              ? {}
              : {
                  currentRevisionId:
                    command.workspaceChange?.revisionId ?? String(row.current_revision_id),
                }),
            ...(activatedNextRunId === undefined ? {} : { nextRunId: activatedNextRunId }),
            databaseNow,
            handoffLeaseMs: boundedDuration(
              this.options.threadSandboxHandoffLeaseMs ?? 30_000,
              "threadSandboxHandoffLeaseMs",
            ),
          });

    const state = await this.loadState(client, command.fence.scope, String(row.attempt_id));
    if (state === undefined) throw new Error("mutation 后无法读回状态");
    const receipt: RuntimeMutationReceiptV1 = {
      schemaVersion: 1,
      idempotencyKey: command.idempotencyKey,
      commandDigest: command.commandDigest,
      previousAttemptVersion,
      attemptVersion: nextAttemptVersion,
      eventSequenceStart,
      eventSequenceEnd,
      outbox: outboxReceipts,
      ...(command.effectInvocation === undefined
        ? {}
        : { effectInvocation: command.effectInvocation }),
      ...(projectionReceipt === undefined ? {} : { projection: projectionReceipt }),
      ...(workspaceReceipt === undefined ? {} : { workspace: workspaceReceipt }),
      ...(threadContextReceipt === undefined ? {} : { threadContext: threadContextReceipt }),
      ...(threadSteerReceipt === undefined ? {} : { threadSteer: threadSteerReceipt }),
      ...(threadSandboxReceipt === undefined ? {} : { threadSandbox: threadSandboxReceipt }),
    };
    const applied: AppliedMutation = {
      outcome: "applied",
      attemptVersion: nextAttemptVersion,
      nextEventSequence: eventSequenceEnd,
      databaseNow,
      scope: command.fence.scope,
      attempt: state.attempt,
      run: state.run,
      workspace: state.workspace,
      receipt,
    };
    await client.query(
      `INSERT INTO mutation_receipts(
         tenant_id,attempt_id,run_id,idempotency_key,command_digest,
         previous_attempt_version,attempt_version,receipt,result_snapshot,database_now
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
      [
        command.fence.scope.tenantId,
        row.attempt_id,
        command.fence.scope.runId,
        command.idempotencyKey,
        command.commandDigest,
        previousAttemptVersion,
        nextAttemptVersion,
        JSON.stringify(receipt),
        JSON.stringify(applied),
        databaseNow,
      ],
    );
    return applied;
  }

  private async applyOutboxItem(
    client: PoolClient,
    tenant: string,
    attemptId: string,
    item: RuntimeOutboxV1,
    databaseNow: ReturnType<typeof isoTimestamp>,
  ): Promise<RuntimeOutboxReceiptV1> {
    if (item.kind === "sandbox_cleanup") {
      const registry = await client.query(
        `SELECT 1 FROM sandbox_registry
          WHERE tenant_id=$1 AND attempt_id=$2 AND registry_id=$3 AND provider_key=$4 AND provider_sandbox_id=$5`,
        [
          tenant,
          attemptId,
          item.payload.registryId,
          item.payload.providerKey,
          item.payload.providerSandboxId,
        ],
      );
      if (registry.rowCount !== 1) throw new RuntimeWriteAbort("conflict");
      const existing = await client.query<{
        registry_id: string;
        provider_key: string;
        provider_sandbox_id: string;
        state: "pending" | "started" | "completed" | "unknown";
        armed: boolean;
        armed_at: Date;
        identity_digest: string;
        disposition: "pause" | "close" | null;
      }>(
        `SELECT registry_id,provider_key,provider_sandbox_id,state,armed,armed_at,identity_digest,disposition
           FROM cleanup_outbox
          WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3 FOR UPDATE`,
        [tenant, attemptId, item.idempotencyKey],
      );
      const previous = existing.rows[0];
      const identityDigest = sandboxCleanupIdentityDigest(item);
      const disposition = "disposition" in item.payload ? item.payload.disposition : undefined;
      if (previous === undefined) {
        if (item.state !== "pending" || disposition !== undefined) {
          throw new RuntimeWriteAbort("conflict");
        }
      } else {
        if (
          previous.armed !== true ||
          previous.registry_id !== item.payload.registryId ||
          previous.provider_key !== item.payload.providerKey ||
          previous.provider_sandbox_id !== item.payload.providerSandboxId ||
          previous.identity_digest !== identityDigest ||
          !cleanupTransitionAllowed(previous.state, item.state) ||
          (previous.disposition !== null && previous.disposition !== disposition)
        ) {
          throw new RuntimeWriteAbort("conflict");
        }
      }
      const armedAt = previous === undefined ? databaseNow : dbTimestamp(previous.armed_at);
      const payloadDigest = outboxPayloadDigest(item, armedAt);
      if (previous === undefined) {
        await client.query(
          `INSERT INTO cleanup_outbox(
             tenant_id,attempt_id,idempotency_key,registry_id,provider_key,provider_sandbox_id,
             state,armed,armed_at,identity_digest,disposition,payload,payload_digest,
             created_at,updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,$11::jsonb,$12,$8,$8)`,
          [
            tenant,
            attemptId,
            item.idempotencyKey,
            item.payload.registryId,
            item.payload.providerKey,
            item.payload.providerSandboxId,
            item.state,
            armedAt,
            identityDigest,
            disposition ?? null,
            JSON.stringify(item.payload),
            payloadDigest,
          ],
        );
      } else {
        await client.query(
          `UPDATE cleanup_outbox
              SET state=$4,disposition=$5,payload=$6::jsonb,payload_digest=$7,updated_at=$8
            WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3`,
          [
            tenant,
            attemptId,
            item.idempotencyKey,
            item.state,
            disposition ?? null,
            JSON.stringify(item.payload),
            payloadDigest,
            databaseNow,
          ],
        );
      }
      return {
        kind: "sandbox_cleanup",
        idempotencyKey: item.idempotencyKey,
        payloadDigest,
        state: item.state,
        armed: true,
        armedAt,
        identity: {
          registryId: item.payload.registryId,
          providerKey: item.payload.providerKey,
          providerSandboxId: item.payload.providerSandboxId,
        },
        identityDigest,
        ...(disposition === undefined ? {} : { disposition }),
      };
    }
    const payloadDigest = outboxPayloadDigest(item);
    if (item.kind === "sandbox_lifecycle_unknown") {
      await client.query(
        `INSERT INTO sandbox_lifecycle_unknown(
           tenant_id,attempt_id,idempotency_key,request_id,provider_key,provider_sandbox_id,
           actual_ttl_seconds,stage,event_payload,payload_digest,occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [
          tenant,
          attemptId,
          item.idempotencyKey,
          item.payload.requestId,
          item.payload.uncertainEvent.providerKey,
          item.payload.sandboxId ?? null,
          item.payload.actualTtlSeconds,
          item.payload.stage,
          JSON.stringify(item.payload.uncertainEvent),
          payloadDigest,
          databaseNow,
        ],
      );
      return {
        kind: item.kind,
        idempotencyKey: item.idempotencyKey,
        payloadDigest,
        state: item.state,
      };
    }
    await client.query(
      `INSERT INTO runtime_alert_outbox(
         tenant_id,attempt_id,idempotency_key,code,payload,payload_digest,occurred_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [
        tenant,
        attemptId,
        item.idempotencyKey,
        item.payload.code,
        JSON.stringify(item.payload),
        payloadDigest,
        databaseNow,
      ],
    );
    return {
      kind: item.kind,
      idempotencyKey: item.idempotencyKey,
      payloadDigest,
      state: item.state,
    };
  }

  private async lockFenceState(
    client: PoolClient,
    scope: ExecutionScope,
  ): Promise<QueryResultRow | undefined> {
    await lockThreadExecutionHead(client, scope.tenantId, scope.threadId);
    await client.query(
      `SELECT 1 FROM thread_follow_up_queue
        WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 FOR UPDATE`,
      [scope.tenantId, scope.threadId, scope.runId],
    );
    const result = await client.query(
      `SELECT attempt.tenant_id,attempt.attempt_id,attempt.run_id,attempt.thread_id,attempt.workspace_id,
              attempt.root_run_id,attempt.base_revision_id,
              attempt.current_revision_id AS attempt_current_revision_id,
              attempt.status AS attempt_status,attempt.stage AS attempt_stage,
              attempt.version AS attempt_version,
              attempt.next_event_sequence,attempt.projection_version,
              attempt.model_execution_started,
              claim.worker_id,claim.claim_token,claim.claim_epoch,claim.expires_at AS claim_expires_at,
              claim.workspace_lease_epoch AS claim_workspace_lease_epoch,
              claim.released_at AS claim_released_at,
              fence.lease_epoch AS fence_lease_epoch,
              lease.root_run_id AS lease_root_run_id,lease.epoch AS lease_row_epoch,
              lease.expires_at AS lease_expires_at,
              r.status AS run_status,r.origin AS run_origin,
              w.current_revision_number,w.current_revision_id,w.lease_epoch,
              head.active_run_id AS head_active_run_id,
              head.active_turn_id AS head_active_turn_id,
              head.writer_owner AS head_writer_owner,head.writer_token AS head_writer_token,
              head.writer_epoch AS head_writer_epoch,
              head.writer_expires_at AS head_writer_expires_at,
              queue.state AS queue_state,queue.claim_owner AS queue_claim_owner,
              queue.claim_token AS queue_claim_token,queue.claim_epoch AS queue_claim_epoch,
              queue.claim_expires_at AS queue_claim_expires_at
         FROM execution_attempts attempt
         JOIN run_claims claim
           ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
         JOIN runs r ON r.tenant_id=attempt.tenant_id AND r.id=attempt.run_id
         JOIN workspaces w ON w.tenant_id=attempt.tenant_id AND w.id=attempt.workspace_id
         JOIN execution_workspace_fences fence
           ON fence.tenant_id=attempt.tenant_id
          AND fence.attempt_id=attempt.attempt_id
          AND fence.lease_epoch=claim.workspace_lease_epoch
          JOIN workspace_write_leases lease
           ON lease.tenant_id=attempt.tenant_id
          AND lease.workspace_id=attempt.workspace_id
           AND lease.root_run_id=attempt.root_run_id
           AND lease.epoch=claim.workspace_lease_epoch
          LEFT JOIN thread_execution_heads head
            ON head.tenant_id=attempt.tenant_id AND head.thread_id=attempt.thread_id
          LEFT JOIN thread_follow_up_queue queue
            ON queue.tenant_id=attempt.tenant_id AND queue.thread_id=attempt.thread_id
           AND queue.run_id=attempt.run_id
        WHERE attempt.tenant_id=$1 AND attempt.run_id=$2
          AND attempt.status IN ('claimed','running','finalizing')
        ORDER BY attempt.created_at DESC LIMIT 1
        FOR UPDATE OF attempt,claim,r,w,lease`,
      [scope.tenantId, scope.runId],
    );
    return result.rows[0];
  }

  private async validateLockedFence(
    client: PoolClient,
    row: QueryResultRow | undefined,
    fence: ExecutionFence,
  ): Promise<"active" | "cancelled" | "fence_lost" | "scope_mismatch"> {
    if (row === undefined) return "fence_lost";
    if (!scopeMatches(row, fence.scope)) return "scope_mismatch";
    if (!fenceMatches(row, fence) || row.claim_released_at !== null) return "fence_lost";
    if (row.run_status === "cancelled") return "cancelled";
    if (row.run_status !== "running") return "fence_lost";
    const now = await client.query<{ database_now: Date }>(
      "SELECT clock_timestamp() AS database_now",
    );
    const databaseNow = Date.parse(dbTimestamp(now.rows[0]?.database_now));
    return Date.parse(dbTimestamp(row.claim_expires_at)) <= databaseNow ||
      Date.parse(dbTimestamp(row.lease_expires_at)) <= databaseNow ||
      (row.queue_state !== null &&
        (Date.parse(dbTimestamp(row.head_writer_expires_at)) <= databaseNow ||
          Date.parse(dbTimestamp(row.queue_claim_expires_at)) <= databaseNow))
      ? "fence_lost"
      : "active";
  }

  private async loadState(
    client: PoolClient,
    scope: ExecutionScope,
    attemptId: string,
  ): Promise<
    | {
        readonly run: Run;
        readonly workspace: Workspace;
        readonly attempt: ExecutionAttemptSnapshot;
      }
    | undefined
  > {
    const aggregate = await client.query(
      `SELECT ${aggregateColumns}, input.root_run_id,input.base_revision_id
         FROM runs r ${aggregateJoins}
        WHERE r.tenant_id=$1 AND r.id=$2`,
      [scope.tenantId, scope.runId],
    );
    const aggregateRow = aggregate.rows[0];
    if (aggregateRow === undefined || !scopeMatches(aggregateRow, scope)) return undefined;
    const attempt = await client.query(
      `SELECT attempt_id,status AS attempt_status,stage AS attempt_stage,
              version AS attempt_version,next_event_sequence,projection_version,
              model_execution_started,current_revision_id AS attempt_current_revision_id
         FROM execution_attempts
        WHERE tenant_id=$1 AND attempt_id=$2`,
      [scope.tenantId, attemptId],
    );
    const attemptRow = attempt.rows[0];
    if (attemptRow === undefined) return undefined;
    return { ...mapAggregate(aggregateRow), attempt: mapAttempt(attemptRow) };
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function settleWorkspaceArtifactIntents(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly runId: string;
    readonly threadId: string;
    readonly workspaceId: string;
    readonly rootRunId: string;
    readonly revisionId: string;
    readonly databaseNow: ReturnType<typeof isoTimestamp>;
    readonly historyFilesystemEnabled: boolean;
    readonly runOrigin: "normal" | "playground" | "evaluation" | "api";
    readonly historyDirectoryTimeZone: string;
  },
): Promise<void> {
  const intents = await client.query<{
    readonly idempotency_key: string;
    readonly command_digest: string;
    readonly artifact_id: string;
    readonly resource_id: string;
    readonly resource_version_id: string;
    readonly blob_reference_id: string;
    readonly blob_operation_id: string;
    readonly replaces_artifact_id: string | null;
    readonly name: string;
    readonly purpose: "deliverable" | "diagnostic" | "trace";
    readonly deliverable_key: string | null;
    readonly source_relative_path: string;
    readonly resource_name: string;
    readonly content_sha256: string;
    readonly size: string;
    readonly blob_lifecycle_id: string;
    readonly blob_incarnation_id: string;
    readonly physical_object_key: string;
  }>(
    `SELECT intent.idempotency_key,intent.command_digest,intent.artifact_id,
            intent.resource_id,intent.resource_version_id,intent.blob_reference_id,
            intent.blob_operation_id,intent.replaces_artifact_id,intent.name,
            intent.purpose,intent.deliverable_key,intent.source_relative_path,
            intent.resource_name,file.content_sha256,file.size::text,
            file.blob_lifecycle_id::text,file.blob_incarnation_id::text,
            file.physical_object_key
       FROM workspace_artifact_publication_intents intent
       JOIN workspace_revision_files file
         ON file.tenant_id=intent.tenant_id AND file.workspace_id=intent.workspace_id
        AND file.revision_id=$7 AND file.relative_path=intent.source_relative_path
      WHERE intent.tenant_id=$1 AND intent.attempt_id=$2 AND intent.run_id=$3
        AND intent.thread_id=$4 AND intent.workspace_id=$5 AND intent.root_run_id=$6
      ORDER BY intent.created_at,intent.idempotency_key`,
    [
      input.tenantId,
      input.attemptId,
      input.runId,
      input.threadId,
      input.workspaceId,
      input.rootRunId,
      input.revisionId,
    ],
  );
  for (const intent of intents.rows) {
    const size = Number(intent.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new RuntimeWriteAbort("conflict");
    const mediaType = workspaceArtifactMediaType(intent.source_relative_path);
    await client.query(
      `INSERT INTO blob_commits(tenant_id,operation_id,status,version,snapshot,created_at,updated_at)
       VALUES($1,$2,'completed',0,$3::jsonb,$4,$4)`,
      [
        input.tenantId,
        intent.blob_operation_id,
        JSON.stringify({
          schemaVersion: 1,
          kind: "workspace_artifact_binding",
          workspaceRevisionId: input.revisionId,
          sourceRelativePath: intent.source_relative_path,
          digest: intent.content_sha256,
        }),
        input.databaseNow,
      ],
    );
    await client.query(
      `INSERT INTO blob_references(
         tenant_id,reference_id,operation_id,state,purpose,sha256,size,media_type,
         staging_upload_id,lifecycle_id,incarnation_id,physical_object_key,created_at,updated_at
       ) VALUES($1,$2,$3,'stable','workspace',$4,$5,$10,$2,$6::uuid,$7::uuid,$8,$9,$9)`,
      [
        input.tenantId,
        intent.blob_reference_id,
        intent.blob_operation_id,
        intent.content_sha256,
        size,
        intent.blob_lifecycle_id,
        intent.blob_incarnation_id,
        intent.physical_object_key,
        input.databaseNow,
        mediaType,
      ],
    );
    // latest FK 是 deferred；先写入带最终 head 的 Resource，再补不可变 Version。
    await client.query(
      `INSERT INTO resources(
         tenant_id,id,name,normalized_name,origin,visibility,latest_version_number,
         latest_version_id,created_at,updated_at
       ) VALUES($1,$2,$3,lower($3),'artifact',$5,1,$4,$6,$6)`,
      [
        input.tenantId,
        intent.resource_id,
        intent.resource_name,
        intent.resource_version_id,
        ["normal", "api"].includes(input.runOrigin) && intent.purpose === "deliverable"
          ? "searchable"
          : "pending_explicit_commit",
        input.databaseNow,
      ],
    );
    await client.query(
      `INSERT INTO resource_versions(
         tenant_id,resource_id,id,version_number,parent_version_id,blob_reference_id,
         blob_purpose,blob_lifecycle_id,blob_incarnation_id,physical_object_key,
         digest,media_type,size,source_workspace_id,source_workspace_revision_id,
         source_relative_path,created_at
       ) VALUES(
         $1,$2,$3,1,NULL,$4,'workspace',$5::uuid,$6::uuid,$7,$8,
         $14,$9,$10,$11,$12,$13
       )`,
      [
        input.tenantId,
        intent.resource_id,
        intent.resource_version_id,
        intent.blob_reference_id,
        intent.blob_lifecycle_id,
        intent.blob_incarnation_id,
        intent.physical_object_key,
        intent.content_sha256,
        size,
        input.workspaceId,
        input.revisionId,
        intent.source_relative_path,
        input.databaseNow,
        mediaType,
      ],
    );
    await client.query(
      `INSERT INTO artifact_publications(
         tenant_id,id,thread_id,run_id,attempt_id,workspace_id,root_run_id,
         resource_id,resource_version_id,replaces_artifact_id,name,purpose,
         deliverable_key,status,blob_reference_id,blob_purpose,blob_lifecycle_id,
         blob_incarnation_id,physical_object_key,digest,media_type,size,
         source_workspace_id,workspace_revision_id,source_relative_path,created_at,updated_at
       ) VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'publishing',$14,'workspace',
         $15::uuid,$16::uuid,$17,$18,$24,$19,$20,$21,$22,$23,$23
       )`,
      [
        input.tenantId,
        intent.artifact_id,
        input.threadId,
        input.runId,
        input.attemptId,
        input.workspaceId,
        input.rootRunId,
        intent.resource_id,
        intent.resource_version_id,
        intent.replaces_artifact_id,
        intent.name,
        intent.purpose,
        intent.deliverable_key,
        intent.blob_reference_id,
        intent.blob_lifecycle_id,
        intent.blob_incarnation_id,
        intent.physical_object_key,
        intent.content_sha256,
        size,
        input.workspaceId,
        input.revisionId,
        intent.source_relative_path,
        input.databaseNow,
        mediaType,
      ],
    );
    await client.query(
      `INSERT INTO artifact_publication_commands(
         tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
         idempotency_key,command_digest,artifact_id,created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.tenantId,
        input.attemptId,
        input.runId,
        input.threadId,
        input.workspaceId,
        input.rootRunId,
        intent.idempotency_key,
        intent.command_digest,
        intent.artifact_id,
        input.databaseNow,
      ],
    );
    await client.query(
      `INSERT INTO artifact_publication_settlements(tenant_id,artifact_id,target,settled_at)
       VALUES($1,$2,'published',$3)`,
      [input.tenantId, intent.artifact_id, input.databaseNow],
    );
    await enqueueWebhookEvent({
      client,
      tenantId: input.tenantId,
      payload: artifactWebhookPayload({
        tenantId: input.tenantId,
        artifactId: intent.artifact_id,
        runId: input.runId,
        occurredAt: input.databaseNow,
      }),
    });
    if (
      ["normal", "api"].includes(input.runOrigin) &&
      shouldIndexArtifactInHistory({
        historyFilesystemEnabled: input.historyFilesystemEnabled,
        purpose: intent.purpose,
      })
    ) {
      await insertHistoryAgentDeliverable(client, {
        tenantId: input.tenantId,
        threadId: input.threadId,
        artifactId: intent.artifact_id,
        resourceId: intent.resource_id,
        resourceVersionId: intent.resource_version_id,
        resourceName: intent.resource_name,
        publishedAt: input.databaseNow,
        timeZone: input.historyDirectoryTimeZone,
      });
    }
  }
}

async function inspectExpiredAttemptRecovery(
  client: PoolClient,
  scope: ExecutionScope,
): Promise<"recovered" | "not_found" | "scope_mismatch"> {
  const result = await client.query(
    `SELECT tenant_id,run_id,thread_id,workspace_id,root_run_id,base_revision_id,status
       FROM execution_attempts
      WHERE tenant_id=$1 AND run_id=$2
      ORDER BY created_at DESC,attempt_id DESC LIMIT 1
      FOR UPDATE`,
    [scope.tenantId, scope.runId],
  );
  const row = result.rows[0];
  if (row === undefined || row.status !== "recovery_required") return "not_found";
  return scopeMatches(row, scope) ? "recovered" : "scope_mismatch";
}

/**
 * 过期 Attempt 已经失去调用 Provider 的资格；恢复事务只登记一次 terminate effect，立即隔离
 * 可变 Session 并释放旧 lease。真正的远端关闭仍由 Scheduler 的 durable consumer 执行。
 */
async function prepareExpiredThreadSandboxTermination(
  client: PoolClient,
  input: {
    readonly scope: ExecutionScope;
    readonly attemptId: string;
    readonly databaseNow: string;
  },
): Promise<void> {
  const active = await client.query<{
    readonly session_id: string;
    readonly generation: string;
    readonly provider_sandbox_id: string;
    readonly state: string;
  }>(
    `SELECT session.session_id,session.generation::text,session.provider_sandbox_id,session.state
       FROM thread_sandbox_leases sandbox_lease
       JOIN thread_sandbox_sessions session
         ON session.tenant_id=sandbox_lease.tenant_id AND session.session_id=sandbox_lease.session_id
      WHERE sandbox_lease.tenant_id=$1 AND sandbox_lease.run_id=$2
        AND sandbox_lease.attempt_id=$3 AND sandbox_lease.released_at IS NULL
      ORDER BY sandbox_lease.lease_epoch DESC LIMIT 1
      FOR UPDATE OF sandbox_lease,session`,
    [input.scope.tenantId, input.scope.runId, input.attemptId],
  );
  const session = active.rows[0];
  if (session === undefined) return;
  if (session.state !== "terminated") {
    const effectId = `sandbox-effect-${randomUUID()}`;
    const operationId = `${input.attemptId}/sandbox/expired-recovery-terminate`;
    const effect = await client.query<{ readonly effect_id: string }>(
      `INSERT INTO sandbox_lifecycle_effects(
         tenant_id,effect_id,operation_id,request_digest,session_id,generation,effect_kind,state,
         run_id,attempt_id,provider_sandbox_id,expected_session_state,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'terminate','pending',$7,$8,$9,$10,$11,$11)
       ON CONFLICT (tenant_id,operation_id) DO UPDATE
         SET updated_at=sandbox_lifecycle_effects.updated_at
       RETURNING effect_id`,
      [
        input.scope.tenantId,
        effectId,
        operationId,
        digestCanonical({ operationId, reason: "expired_attempt_recovery" }),
        session.session_id,
        Number(session.generation),
        input.scope.runId,
        input.attemptId,
        session.provider_sandbox_id,
        session.state,
        input.databaseNow,
      ],
    );
    const durableEffectId = effect.rows[0]?.effect_id;
    if (durableEffectId === undefined) throw new Error("过期 Sandbox terminate effect 缺失");
    await client.query(
      `UPDATE thread_sandbox_sessions
          SET state='unknown',current_effect_id=$4,paused_at=NULL,retention_expires_at=NULL,
              updated_at=$5
        WHERE tenant_id=$1 AND session_id=$2 AND generation=$3 AND state<>'terminated'`,
      [
        input.scope.tenantId,
        session.session_id,
        Number(session.generation),
        durableEffectId,
        input.databaseNow,
      ],
    );
  }
  await client.query(
    `UPDATE thread_sandbox_leases SET released_at=$4,updated_at=$4
      WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND released_at IS NULL`,
    [input.scope.tenantId, session.session_id, input.scope.runId, input.databaseNow],
  );
}

async function releasePreparedWorkspaceCandidates(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly reason: "terminal" | "expired_recovery" | "manual_recovery";
  },
): Promise<void> {
  await client.query(
    `UPDATE blob_references reference SET state='released',updated_at=clock_timestamp()
       FROM workspace_revision_candidate_files file
       JOIN workspace_revision_candidates candidate
         ON candidate.tenant_id=file.tenant_id AND candidate.workspace_id=file.workspace_id
        AND candidate.attempt_id=file.attempt_id AND candidate.operation_key=file.operation_key
      WHERE candidate.tenant_id=$1 AND candidate.attempt_id=$2
        AND candidate.status IN ('building','prepared') AND file.source='uploaded'
        AND reference.tenant_id=file.tenant_id AND reference.reference_id=file.blob_reference_id
        AND reference.state='stable'`,
    [input.tenantId, input.attemptId],
  );
  await client.query(
    `UPDATE workspace_revision_candidates
        SET status='released',release_reason=$3,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND attempt_id=$2 AND status IN ('building','prepared')`,
    [input.tenantId, input.attemptId, input.reason],
  );
}

function attemptTransitionAllowed(current: string, next: string | undefined): boolean {
  if (next === undefined || next === current) return true;
  const allowed: Readonly<Record<string, readonly string[]>> = {
    claimed: ["running", "cancelled", "failed", "recovery_required", "abandoned"],
    running: ["running", "waiting", "finalizing", "failed", "cancelled", "recovery_required"],
    waiting: [],
    finalizing: ["finalizing", "waiting", "succeeded", "failed", "cancelled", "recovery_required"],
    succeeded: [],
    failed: [],
    cancelled: [],
    recovery_required: ["abandoned", "failed"],
    abandoned: [],
  };
  return allowed[current]?.includes(next) ?? false;
}

function cleanupTransitionAllowed(previous: string, next: string): boolean {
  if (previous === "pending") return next === "pending" || next === "started";
  if (previous === "started") {
    return next === "started" || next === "completed" || next === "unknown";
  }
  return previous === next;
}

function storedPermitMatches(
  permitRow: QueryResultRow,
  stateRow: QueryResultRow | undefined,
  input: {
    readonly fence: ExecutionFence;
    readonly expectedAttemptVersion: number;
    readonly permit: ExternalEffectPermit;
  },
): boolean {
  if (stateRow === undefined) return false;
  const permit = input.permit;
  return (
    scopeMatches(stateRow, permit.scope) &&
    scopeMatches(stateRow, input.fence.scope) &&
    permitRow.permit_id === permit.permitId &&
    permitRow.attempt_id === stateRow.attempt_id &&
    permitRow.effect === permit.effect &&
    permitRow.call_id === permit.callId &&
    permitRow.tool_name === permit.toolName &&
    (permitRow.tool_version_id ?? undefined) === permit.toolVersionId &&
    permitRow.args_digest === permit.argsDigest &&
    Number(permitRow.attempt_version) === input.expectedAttemptVersion &&
    permit.attemptVersion === input.expectedAttemptVersion &&
    Number(stateRow.attempt_version) === input.expectedAttemptVersion &&
    permitRow.run_claim_token === input.fence.runClaim.token &&
    permit.runClaimToken === input.fence.runClaim.token &&
    Number(permitRow.run_claim_epoch) === input.fence.runClaim.epoch &&
    permit.runClaimEpoch === input.fence.runClaim.epoch &&
    permitRow.workspace_root_run_id === input.fence.workspaceLease.rootRunId &&
    permit.workspaceRootRunId === input.fence.workspaceLease.rootRunId &&
    Number(permitRow.workspace_lease_epoch) === input.fence.workspaceLease.epoch &&
    permit.workspaceLeaseEpoch === input.fence.workspaceLease.epoch &&
    dbTimestamp(permitRow.issued_at) === permit.issuedAt &&
    dbTimestamp(permitRow.expires_at) === permit.expiresAt
  );
}
