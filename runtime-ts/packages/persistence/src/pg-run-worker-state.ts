import { randomUUID } from "node:crypto";
import { isoTimestamp, type Run, type Workspace, workspaceRevisionId } from "@cube-runtime/domain";
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
} from "@cube-runtime/run-contracts";
import {
  assertControlledRolloutProjection,
  outboxPayloadDigest,
  rolloutProjectionDigest,
  runtimeMutationDigest,
  sandboxCleanupIdentityDigest,
  workspaceChangeDigest,
} from "@cube-runtime/run-contracts/mutation-protocol";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { TransactionCommitUnknownError, withTenantTransaction } from "./postgres.js";
import { mapRun, mapTenant, mapThread, mapWorkspace } from "./row-mappers.js";

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
}

export interface InitializeRunExecutionInput {
  readonly scope: ExecutionScope;
  readonly input: string;
  readonly answer?: string;
  readonly rolloutProjection: ControlledRolloutProjection;
}

const aggregateColumns = `
  t.id AS tenant_id, t.kind AS tenant_kind, t.owner_user_id, t.display_name,
  t.created_by_user_id, t.created_at AS tenant_created_at,
  tenant_actor.id AS tenant_actor_id, tenant_actor.created_at AS tenant_actor_created_at,
  th.id AS thread_id, th.created_by_user_id AS thread_created_by_user_id,
  th.title AS thread_title, th.status AS thread_status,
  th.created_at AS thread_created_at, th.updated_at AS thread_updated_at,
  thread_creator.id AS thread_creator_id,
  thread_creator.created_at AS thread_creator_created_at,
  creator_membership.id AS thread_creator_membership_id,
  creator_membership.role AS thread_creator_membership_role,
  creator_membership.status AS thread_creator_membership_status,
  creator_membership.created_at AS thread_creator_membership_created_at,
  r.id AS run_id, r.status AS run_status,
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

function isPgCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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

function fenceMatches(row: QueryResultRow, fence: ExecutionFence): boolean {
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
      serializedJson(command.rolloutProjection) === undefined)
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
      boundedIdentifier(command.workspaceChange.objectKey, 1_024))
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

  async acquire(input: {
    readonly scope: ExecutionScope;
    readonly signal: AbortSignal;
  }): Promise<SandboxAcquireResult> {
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
               provider_sandbox_id,request_id,state,actual_ttl_seconds
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$2,'ready',$9)
             ON CONFLICT (tenant_id,registry_id) DO NOTHING`,
            [
              input.scope.tenantId,
              result.session.registryId,
              attemptId,
              input.scope.runId,
              input.scope.threadId,
              input.scope.workspaceId,
              input.scope.rootRunId,
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
        await client.query(
          `UPDATE sandbox_registry SET state=$3,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND registry_id=$2`,
          [input.scope.tenantId, input.session.registryId, expectedState],
        );
        return true;
      },
      { isolationLevel: "SERIALIZABLE" },
    );
    if (!valid) throw new Error("Sandbox cleanup intent 未持久化或身份不匹配");
    const result = await this.upstream.settle(input);
    await withTenantTransaction(this.pool, { tenantId: input.scope.tenantId }, async (client) => {
      await client.query(
        `UPDATE sandbox_registry SET state=$3,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND registry_id=$2`,
        [
          input.scope.tenantId,
          input.session.registryId,
          result.outcome === "unknown"
            ? "unknown"
            : input.disposition === "pause"
              ? "paused"
              : "closed",
        ],
      );
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
          const aggregate = await client.query(
            `SELECT ${aggregateColumns}, input.root_run_id, input.base_revision_id,
                    input.input_text, input.answer_text,
                    input.initial_projection, input.initial_projection_digest
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
          const claimEpochResult = await client.query<{ next_epoch: string }>(
            `SELECT (COALESCE(max(claim_epoch),0)+1)::text AS next_epoch
               FROM run_claims WHERE tenant_id=$1 AND run_id=$2`,
            [input.scope.tenantId, input.scope.runId],
          );
          const claimEpoch = Number(claimEpochResult.rows[0]?.next_epoch ?? "1");
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
          const fence: ExecutionFence = {
            scope: input.scope,
            runClaim: { token: claimToken, epoch: claimEpoch, expiresAt },
            workspaceLease: { rootRunId: input.scope.rootRunId, epoch: leaseEpoch, expiresAt },
          };
          return {
            outcome: "claimed",
            snapshot: {
              run: state.run,
              workspace: state.workspace,
              attempt: state.attempt,
              input: String(row.input_text),
              ...(row.answer_text === null ? {} : { answer: String(row.answer_text) }),
              rolloutProjection: projection,
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
      return await withTenantTransaction(
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
                      $3::timestamptz + interval '1 millisecond'
                    ) AS expires_at`,
            [leaseDurationMs, row.claim_expires_at, row.lease_expires_at],
          );
          const nowRow = nowResult.rows[0];
          if (nowRow === undefined) throw new Error("数据库时钟查询没有返回行");
          const databaseNow = dbTimestamp(nowRow.database_now);
          if (
            Date.parse(dbTimestamp(row.claim_expires_at)) <= Date.parse(databaseNow) ||
            Date.parse(dbTimestamp(row.lease_expires_at)) <= Date.parse(databaseNow) ||
            row.claim_released_at !== null
          ) {
            return { outcome: "fence_lost" } as const;
          }
          const expiresAt = dbTimestamp(nowRow.expires_at);
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
          } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
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
      !/^[0-9a-f]{64}$/.test(input.call.argsDigest)
    ) {
      return { outcome: "conflict" };
    }
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          const row = await this.lockFenceState(client, input.fence.scope);
          const fenceOutcome = await this.validateLockedFence(client, row, input.fence);
          if (fenceOutcome !== "active") return { outcome: fenceOutcome } as const;
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
            `INSERT INTO external_effect_permits(
               tenant_id,permit_id,attempt_id,effect,call_id,tool_name,args_digest,
               attempt_version,run_claim_token,run_claim_epoch,workspace_root_run_id,
               workspace_lease_epoch,expires_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               clock_timestamp() + ($13::bigint * interval '1 millisecond'))
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
              issuedAt: dbTimestamp(permitRow.issued_at),
              expiresAt: dbTimestamp(permitRow.expires_at),
            },
          } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      if (isPgCode(error, "23505") || isPgCode(error, "23503") || isPgCode(error, "23514")) {
        return { outcome: "conflict" };
      }
      return { outcome: "unavailable" };
    }
  }

  async consumeExternalEffectPermit(input: {
    readonly fence: ExecutionFence;
    readonly expectedAttemptVersion: number;
    readonly permit: ExternalEffectPermit;
  }): ReturnType<ExecutionPersistencePort["consumeExternalEffectPermit"]> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          const row = await this.lockFenceState(client, input.fence.scope);
          const fenceOutcome = await this.validateLockedFence(client, row, input.fence);
          if (fenceOutcome !== "active") return { outcome: fenceOutcome } as const;
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
          if (permitRow.consumed_at !== null) return { outcome: "already_consumed" } as const;
          if (!storedPermitMatches(permitRow, row, input)) return { outcome: "conflict" } as const;
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
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async mutate(command: RuntimeMutation): Promise<RuntimeMutationResult> {
    if (!mutationStorageShapeValid(command)) return { outcome: "protocol_invalid" };
    const { commandDigest: suppliedDigest, ...unsigned } = command;
    if (runtimeMutationDigest(unsigned) !== suppliedDigest) {
      return { outcome: "idempotency_conflict" };
    }
    let result: RuntimeMutationResult;
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
      return { outcome: "unavailable" };
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
              Date.parse(dbTimestamp(row.lease_expires_at)) > Date.parse(databaseNow))
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
          await client.query(
            `UPDATE execution_attempts
                SET status=$3, version=version+1, updated_at=$4, finished_at=$4
              WHERE tenant_id=$1 AND attempt_id=$2`,
            [input.scope.tenantId, row.attempt_id, attemptStatus, databaseNow],
          );
          if (attemptStatus === "failed") {
            await client.query(
              `UPDATE runs SET status='failed', version=version+1, updated_at=$3
                WHERE tenant_id=$1 AND id=$2 AND status='running'`,
              [input.scope.tenantId, input.scope.runId, databaseNow],
            );
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
    if (!fenceMatches(row, command.fence)) return { outcome: "fence_lost" };
    const fenceOutcome = await this.validateLockedFence(client, row, command.fence);
    if (fenceOutcome !== "active") {
      return { outcome: fenceOutcome === "cancelled" ? "fence_lost" : fenceOutcome };
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
      const revisionNumber = Number(row.current_revision_number) + 1;
      await client.query(
        `INSERT INTO workspace_revisions(
           tenant_id,workspace_id,id,thread_id,revision_number,parent_revision_id,
           created_by_run_id,lease_epoch,object_key,digest,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          change.tenantId,
          change.workspaceId,
          change.revisionId,
          change.threadId,
          revisionNumber,
          change.parentRevisionId ?? null,
          change.rootRunId,
          command.fence.workspaceLease.epoch,
          change.objectKey,
          change.digest,
          databaseNow,
        ],
      );
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

    for (const event of command.events) {
      await client.query(
        `INSERT INTO run_events(
           tenant_id,attempt_id,sequence,schema_version,kind,payload,occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          command.fence.scope.tenantId,
          row.attempt_id,
          event.sequence,
          event.schemaVersion,
          event.kind,
          JSON.stringify(event.payload),
          databaseNow,
        ],
      );
    }

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

    if (command.nextRunStatus !== undefined) {
      const updated = await client.query(
        `UPDATE runs SET status=$3,version=version+1,updated_at=$4
          WHERE tenant_id=$1 AND id=$2 AND status='running'`,
        [
          command.fence.scope.tenantId,
          command.fence.scope.runId,
          command.nextRunStatus,
          databaseNow,
        ],
      );
      if (updated.rowCount !== 1) throw new RuntimeWriteAbort("conflict");
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
    }

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
          WHERE tenant_id=$1 AND attempt_id=$2 AND registry_id=$3 AND provider_sandbox_id=$4`,
        [tenant, attemptId, item.payload.registryId, item.payload.providerSandboxId],
      );
      if (registry.rowCount !== 1) throw new RuntimeWriteAbort("conflict");
      const existing = await client.query<{
        registry_id: string;
        provider_sandbox_id: string;
        state: "pending" | "started" | "completed" | "unknown";
        armed: boolean;
        armed_at: Date;
        identity_digest: string;
        disposition: "pause" | "close" | null;
      }>(
        `SELECT registry_id,provider_sandbox_id,state,armed,armed_at,identity_digest,disposition
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
             tenant_id,attempt_id,idempotency_key,registry_id,provider_sandbox_id,
             state,armed,armed_at,identity_digest,disposition,payload,payload_digest,
             created_at,updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10::jsonb,$11,$7,$7)`,
          [
            tenant,
            attemptId,
            item.idempotencyKey,
            item.payload.registryId,
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
           tenant_id,attempt_id,idempotency_key,request_id,provider_sandbox_id,
           actual_ttl_seconds,stage,event_payload,payload_digest,occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [
          tenant,
          attemptId,
          item.idempotencyKey,
          item.payload.requestId,
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
    const result = await client.query(
      `SELECT attempt.tenant_id,attempt.attempt_id,attempt.run_id,attempt.thread_id,attempt.workspace_id,
              attempt.root_run_id,attempt.base_revision_id,
              attempt.current_revision_id AS attempt_current_revision_id,
              attempt.status AS attempt_status,attempt.stage AS attempt_stage,
              attempt.version AS attempt_version,
              attempt.next_event_sequence,attempt.projection_version,
              attempt.model_execution_started,
              claim.claim_token,claim.claim_epoch,claim.expires_at AS claim_expires_at,
              claim.workspace_lease_epoch AS claim_workspace_lease_epoch,
              claim.released_at AS claim_released_at,
              fence.lease_epoch AS fence_lease_epoch,
              lease.root_run_id AS lease_root_run_id,lease.epoch AS lease_row_epoch,
              lease.expires_at AS lease_expires_at,
              r.status AS run_status,w.current_revision_number,w.current_revision_id,w.lease_epoch
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
      Date.parse(dbTimestamp(row.lease_expires_at)) <= databaseNow
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
