import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_USER_MAX_CONCURRENT_RUNS_PER_TENANT } from "@hoox/admin-control";
import { isoTimestamp, type Run, rehydrateRun } from "@hoox/domain";
import { rolloutProjectionDigest } from "@hoox/run-contracts/mutation-protocol";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import type { EnqueueOutboxPort, IdempotentRunEnqueueResult } from "./ports.js";
import { TransactionCommitUnknownError, withTenantTransaction } from "./postgres.js";
import { createRunSkillSnapshot, SkillSnapshotUnavailableError } from "./pg-skill-runtime.js";
import { scheduleWorkerTenant, wakeWorkerTenant } from "./pg-worker-tenant-assignment.js";
import {
  enqueueThreadTitleGeneration,
  isThreadTitleGenerationEnabled,
} from "./pg-thread-title-generation.js";
import {
  enqueueThreadFollowUp,
  LegacyRunDrainRequiredError,
  legacyInitialProjection,
} from "./pg-thread-run-queue.js";

const maxInputBytes = 1_048_576;
const legacyInitialProjectionDigest = rolloutProjectionDigest(legacyInitialProjection);
const maxOutboxLeaseMilliseconds = 300_000;
const maxOutboxRetryMilliseconds = 86_400_000;

function timestamp(value: unknown) {
  if (value instanceof Date) return isoTimestamp(value.toISOString());
  if (typeof value === "string") return isoTimestamp(new Date(value).toISOString());
  throw new TypeError("数据库未返回 Run 时间");
}

function inputDigest(value: string): string {
  if (
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maxInputBytes ||
    Buffer.byteLength(value, "utf8") < 1
  ) {
    throw new TypeError("Run 输入 UTF-8 字节数无效");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dispatcherIdentity(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > 200) {
    throw new TypeError("dispatcherId 的 UTF-8 字节长度必须在 1 到 200 之间");
  }
  return normalized;
}

function restoreRun(row: QueryResultRow, thread: Parameters<typeof rehydrateRun>[1]): Run {
  return rehydrateRun(
    {
      id: String(row.run_id),
      tenantId: String(row.tenant_id),
      threadId: String(row.thread_id),
      status: String(row.run_status),
      createdAt: timestamp(row.run_created_at),
      updatedAt: timestamp(row.run_updated_at),
    },
    thread,
  );
}

export interface PgRunDispatchCreationOptions {
  /** 故障测试可模拟 COMMIT 成功但客户端没有获得响应；实现会按幂等键读回。 */
  readonly afterCommit?: (operation: "create_run") => void | Promise<void>;
  /** 默认关闭；关闭只影响新入口，Worker 仍会 drain 已经接受的 V2 queue item。 */
  readonly serialQueueV2Enabled?: boolean;
  readonly historyTitleGenerationEnabled?: boolean;
}

/**
 * API 的唯一生产 CreateRun capability。V2 的固定锁序是 Membership→Thread→execution
 * head→Workspace；Run、receipt、queue、可选的队首激活与幂等记录在同一事务提交。
 * 开关关闭且 Thread 没有 V2 事实时保留既有“创建即绑定/dispatch”兼容路径。
 */
export class PgRunDispatchCreation implements EnqueueOutboxPort {
  constructor(
    private readonly pool: Pool,
    private readonly options: PgRunDispatchCreationOptions = {},
  ) {
    if (options.historyTitleGenerationEnabled === true && options.serialQueueV2Enabled !== true) {
      throw new TypeError("历史标题生成依赖 V2 串行队列 receipt");
    }
  }

  async createQueuedRun(
    input: Parameters<EnqueueOutboxPort["createQueuedRun"]>[0],
  ): Promise<IdempotentRunEnqueueResult<Run>> {
    if (
      input.scope.tenantId !== input.run.tenantId ||
      input.thread.id !== input.run.threadId ||
      input.thread.tenantId !== input.scope.tenantId
    ) {
      return { outcome: "not_authorized" };
    }
    const digest = inputDigest(input.inputText);
    let committed = false;
    try {
      const result = await withTenantTransaction(this.pool, input.scope, async (client) => {
        const membership = await client.query<{ readonly status: string }>(
          `SELECT status FROM memberships
            WHERE tenant_id=$1 AND user_id=$2 FOR SHARE`,
          [input.scope.tenantId, input.scope.userId],
        );
        if (membership.rows[0]?.status !== "active") return { outcome: "not_authorized" } as const;
        // 已提交记录先读回，归档后的同键重试不应再触碰已失活的父 Thread。
        const replay = await this.readIdempotency(client, input);
        if (replay !== undefined) return replay;
        // 幂等记录没有 UPDATE 权限；用事务 advisory lock 串行化首个相同键请求，
        // 避免为了行锁而扩大 api_idempotency_records 的最小 ACL。
        await this.lockIdempotencyKey(client, input);
        const existing = await this.readIdempotency(client, input);
        if (existing !== undefined) return existing;

        const thread = await client.query<{ readonly status: string }>(
          `SELECT status FROM threads WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [input.scope.tenantId, input.run.threadId],
        );
        if (thread.rows[0]?.status !== "active") return { outcome: "parent_inactive" } as const;
        if (this.options.serialQueueV2Enabled !== true) {
          const v2Thread = await client.query(
            `SELECT 1 FROM thread_follow_up_queue
              WHERE tenant_id=$1 AND thread_id=$2 LIMIT 1`,
            [input.scope.tenantId, input.run.threadId],
          );
          // 回退不能在已有 V2 顺序事实的 Thread 上重新打开并行旧入口。
          if (v2Thread.rowCount !== 0) return { outcome: "legacy_drain_required" } as const;
        }

        const run = await client.query<QueryResultRow>(
          `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
           VALUES ($1,$2,$3,'queued',clock_timestamp(),clock_timestamp())
           RETURNING id AS run_id,tenant_id,thread_id,status AS run_status,
                     created_at AS run_created_at,updated_at AS run_updated_at`,
          [input.scope.tenantId, input.run.id, input.run.threadId],
        );
        const runRow = run.rows[0];
        if (runRow === undefined) throw new TypeError("创建 Run 未返回数据");
        await createRunSkillSnapshot(client, {
          tenantId: input.scope.tenantId,
          runId: input.run.id,
          userId: input.scope.userId,
          ...(input.skillInvocation === undefined
            ? {}
            : { explicitInvocation: input.skillInvocation }),
        });
        if (this.options.serialQueueV2Enabled === true) {
          const receiptId = await enqueueThreadFollowUp(client, {
            tenantId: input.scope.tenantId,
            threadId: input.run.threadId,
            runId: input.run.id,
            clientRequestId: input.idempotency.key,
            requestDigest: input.idempotency.requestHash,
            inputText: input.inputText,
            inputDigest: digest,
          });
          if (
            await isThreadTitleGenerationEnabled(
              client,
              this.options.historyTitleGenerationEnabled ?? false,
            )
          ) {
            await enqueueThreadTitleGeneration(client, {
              tenantId: input.scope.tenantId,
              threadId: input.run.threadId,
              receiptId,
            });
          }
        } else {
          // 兼容路径仍在创建时绑定 base；V2 开启后只由激活事务执行下面两项写入。
          const workspace = await client.query<{
            readonly id: string;
            readonly current_revision_id: string | null;
          }>(
            `SELECT id,current_revision_id FROM workspaces
              WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
            [input.scope.tenantId, input.run.threadId],
          );
          const workspaceRow = workspace.rows[0];
          if (workspaceRow === undefined) return { outcome: "parent_inactive" } as const;
          await client.query(
            `INSERT INTO run_execution_inputs(
               tenant_id,run_id,thread_id,workspace_id,root_run_id,base_revision_id,
               input_text,initial_projection,initial_projection_digest
             ) VALUES ($1,$2,$3,$4,$2,$5,$6,$7::jsonb,$8)`,
            [
              input.scope.tenantId,
              input.run.id,
              input.run.threadId,
              workspaceRow.id,
              workspaceRow.current_revision_id,
              input.inputText,
              JSON.stringify(legacyInitialProjection),
              legacyInitialProjectionDigest,
            ],
          );
          await client.query(
            `INSERT INTO run_dispatch_outbox(
               tenant_id,outbox_id,run_id,thread_id,workspace_id,root_run_id,
               input_digest,state
             ) VALUES ($1,$2,$3,$4,$5,$3,$6,'ready')`,
            [
              input.scope.tenantId,
              randomUUID(),
              input.run.id,
              input.run.threadId,
              workspaceRow.id,
              digest,
            ],
          );
          await wakeWorkerTenant(client, input.scope.tenantId);
        }
        await client.query(
          `INSERT INTO api_idempotency_records(tenant_id,user_id,operation,idempotency_key,request_hash,run_id)
           VALUES ($1,$2,'run.create',$3,$4,$5)`,
          [
            input.scope.tenantId,
            input.scope.userId,
            input.idempotency.key,
            input.idempotency.requestHash,
            input.run.id,
          ],
        );
        return { outcome: "created", entity: restoreRun(runRow, input.thread) } as const;
      });
      committed = true;
      await this.options.afterCommit?.("create_run");
      return result;
    } catch (error) {
      if (error instanceof SkillSnapshotUnavailableError) {
        return { outcome: "skill_not_available" };
      }
      if (error instanceof LegacyRunDrainRequiredError) {
        return { outcome: "legacy_drain_required" };
      }
      // 已离开事务后连接断开与测试注入的响应丢失都不能重写；只按原键读回。
      if (error instanceof TransactionCommitUnknownError || committed) {
        const replay = await this.readReplay(input);
        if (replay !== undefined) return replay;
      }
      throw mapPersistenceError(error, "原子创建 Run 与投递 Outbox");
    }
  }

  async replayQueuedRun(
    input: Parameters<EnqueueOutboxPort["replayQueuedRun"]>[0],
  ): Promise<IdempotentRunEnqueueResult<Run> | { readonly outcome: "not_found" }> {
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const membership = await client.query<{ readonly status: string }>(
          `SELECT status FROM memberships
            WHERE tenant_id=$1 AND user_id=$2 FOR SHARE`,
          [input.scope.tenantId, input.scope.userId],
        );
        if (membership.rows[0]?.status !== "active") return { outcome: "not_authorized" } as const;
        const replay = await this.readIdempotency(client, input);
        return replay ?? { outcome: "not_found" };
      });
    } catch (error) {
      throw mapPersistenceError(error, "读取 Run 创建幂等记录");
    }
  }

  private async lockIdempotencyKey(
    client: PoolClient,
    input: Parameters<EnqueueOutboxPort["createQueuedRun"]>[0],
  ): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
      this.options.serialQueueV2Enabled === true
        ? `${input.scope.tenantId}\u001f${input.thread.id}\u001ffollow_up\u001f${input.idempotency.key}`
        : `${input.scope.tenantId}\u001f${input.scope.userId}\u001frun.create\u001f${input.idempotency.key}`,
    ]);
  }

  private async readIdempotency(
    client: PoolClient,
    input: Pick<
      Parameters<EnqueueOutboxPort["createQueuedRun"]>[0],
      "scope" | "thread" | "idempotency"
    >,
  ): Promise<IdempotentRunEnqueueResult<Run> | undefined> {
    const record = await client.query<QueryResultRow>(
      `SELECT request_hash,run_id FROM api_idempotency_records
        WHERE tenant_id=$1 AND user_id=$2 AND operation='run.create' AND idempotency_key=$3`,
      [input.scope.tenantId, input.scope.userId, input.idempotency.key],
    );
    const row = record.rows[0];
    if (row === undefined) {
      const receipt = await client.query<{
        readonly request_digest: string;
        readonly queued_run_id: string;
      }>(
        `SELECT request_digest,queued_run_id FROM thread_input_receipts
          WHERE tenant_id=$1 AND thread_id=$2 AND client_request_id=$3`,
        [input.scope.tenantId, input.thread.id, input.idempotency.key],
      );
      const receiptRow = receipt.rows[0];
      if (receiptRow === undefined) return undefined;
      if (receiptRow.request_digest !== input.idempotency.requestHash) {
        return { outcome: "key_conflict" };
      }
      const run = await client.query<QueryResultRow>(
        `SELECT id AS run_id,tenant_id,thread_id,status AS run_status,
                created_at AS run_created_at,updated_at AS run_updated_at
           FROM runs WHERE tenant_id=$1 AND id=$2`,
        [input.scope.tenantId, receiptRow.queued_run_id],
      );
      const runRow = run.rows[0];
      if (runRow === undefined) throw new TypeError("输入 receipt 缺少 Run");
      return { outcome: "replayed", entity: restoreRun(runRow, input.thread) };
    }
    if (row.request_hash !== input.idempotency.requestHash) return { outcome: "key_conflict" };
    const run = await client.query<QueryResultRow>(
      `SELECT id AS run_id,tenant_id,thread_id,status AS run_status,
              created_at AS run_created_at,updated_at AS run_updated_at
         FROM runs WHERE tenant_id=$1 AND id=$2`,
      [input.scope.tenantId, row.run_id],
    );
    const runRow = run.rows[0];
    if (runRow === undefined) throw new TypeError("幂等记录缺少 Run");
    return { outcome: "replayed", entity: restoreRun(runRow, input.thread) };
  }

  private async readReplay(
    input: Parameters<EnqueueOutboxPort["createQueuedRun"]>[0],
  ): Promise<IdempotentRunEnqueueResult<Run> | undefined> {
    return withTenantTransaction(this.pool, input.scope, (client) =>
      this.readIdempotency(client, input),
    );
  }
}

export interface PgClaimedRunDispatch {
  readonly outboxId: string;
  readonly generation: number;
  readonly claimToken: string;
  readonly scope: {
    readonly tenantId: string;
    readonly runId: string;
    readonly threadId: string;
    readonly workspaceId: string;
    readonly rootRunId: string;
    readonly baseRevisionId?: string;
  };
}

/** PostgreSQL Outbox 领取适配器；每次 claim/ack 都是独立短事务，绝不执行 Worker。 */
export class PgRunDispatchOutbox {
  constructor(private readonly pool: Pool) {}

  async claim(input: {
    readonly tenantId: string;
    readonly dispatcherId: string;
    readonly limit: number;
    readonly leaseMilliseconds: number;
    readonly userMaxConcurrentRunsPerTenant?: number;
  }): Promise<readonly PgClaimedRunDispatch[]> {
    const userMaxConcurrentRunsPerTenant =
      input.userMaxConcurrentRunsPerTenant ?? DEFAULT_USER_MAX_CONCURRENT_RUNS_PER_TENANT;
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError("Outbox claim limit 无效");
    }
    if (
      !Number.isSafeInteger(userMaxConcurrentRunsPerTenant) ||
      userMaxConcurrentRunsPerTenant < 1 ||
      userMaxConcurrentRunsPerTenant > 100
    ) {
      throw new TypeError("单用户在 Tenant 内并行 Run 上限无效");
    }
    if (
      !Number.isSafeInteger(input.leaseMilliseconds) ||
      input.leaseMilliseconds < 1_000 ||
      input.leaseMilliseconds > maxOutboxLeaseMilliseconds
    ) {
      throw new TypeError("Outbox lease 无效");
    }
    const dispatcherId = dispatcherIdentity(input.dispatcherId);
    const candidateLimit = Math.min(500, Math.max(100, input.limit * 10));
    return withTenantTransaction(this.pool, { tenantId: input.tenantId }, async (client) => {
      // 同一 Tenant 的占槽事务必须串行复核 Thread 与 User 计数；只锁短事务，
      // 不包住模型执行，因此不会形成 Tenant 运行并发上限。
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
        `${input.tenantId}\u001frun-dispatch-scheduling`,
      ]);
      const rows = await client.query<QueryResultRow>(
        `WITH active_user_runs AS (
           SELECT DISTINCT active.user_id,active.run_id
             FROM (
               SELECT COALESCE(snapshot.user_id,thread.created_by_user_id) AS user_id,
                      claimed.run_id
                 FROM run_dispatch_outbox claimed
                 JOIN threads thread
                   ON thread.tenant_id=claimed.tenant_id AND thread.id=claimed.thread_id
                 LEFT JOIN run_skill_snapshots snapshot
                   ON snapshot.tenant_id=claimed.tenant_id AND snapshot.run_id=claimed.run_id
                WHERE claimed.tenant_id=$1 AND claimed.state='claimed'
                  AND claimed.lease_expires_at>=clock_timestamp()
               UNION
               SELECT COALESCE(snapshot.user_id,thread.created_by_user_id) AS user_id,
                      attempt.run_id
                 FROM execution_attempts attempt
                 JOIN run_claims claim
                   ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
                 JOIN threads thread
                   ON thread.tenant_id=attempt.tenant_id AND thread.id=attempt.thread_id
                 LEFT JOIN run_skill_snapshots snapshot
                   ON snapshot.tenant_id=attempt.tenant_id AND snapshot.run_id=attempt.run_id
                WHERE attempt.tenant_id=$1
                  AND attempt.status IN ('claimed','running','finalizing')
                  AND claim.released_at IS NULL AND claim.expires_at>=clock_timestamp()
             ) active
         ), active_user_counts AS (
           SELECT user_id,count(*)::bigint AS active_run_count
             FROM active_user_runs GROUP BY user_id
         )
         SELECT outbox.outbox_id,outbox.run_id,outbox.thread_id,outbox.workspace_id,
                outbox.root_run_id,input.base_revision_id,outbox.generation,
                COALESCE(snapshot.user_id,thread.created_by_user_id) AS user_id,
                COALESCE(active.active_run_count,0)::text AS active_run_count
           FROM run_dispatch_outbox AS outbox
           JOIN run_execution_inputs AS input
             ON input.tenant_id=outbox.tenant_id AND input.run_id=outbox.run_id
           JOIN threads thread
             ON thread.tenant_id=outbox.tenant_id AND thread.id=outbox.thread_id
           LEFT JOIN run_skill_snapshots snapshot
             ON snapshot.tenant_id=outbox.tenant_id AND snapshot.run_id=outbox.run_id
           LEFT JOIN active_user_counts active
             ON active.user_id=COALESCE(snapshot.user_id,thread.created_by_user_id)
           LEFT JOIN thread_follow_up_queue queue
             ON queue.tenant_id=outbox.tenant_id AND queue.thread_id=outbox.thread_id
            AND queue.run_id=outbox.run_id
           LEFT JOIN thread_execution_heads head
             ON head.tenant_id=outbox.tenant_id AND head.thread_id=outbox.thread_id
          WHERE outbox.tenant_id=$1
            AND COALESCE(active.active_run_count,0)<$2
            AND (queue.run_id IS NULL OR (queue.state='active' AND head.active_run_id=outbox.run_id))
            AND NOT EXISTS (
              SELECT 1
                FROM run_dispatch_outbox active_dispatch
               WHERE active_dispatch.tenant_id=outbox.tenant_id
                 AND active_dispatch.thread_id=outbox.thread_id
                 AND active_dispatch.state='claimed'
                 AND active_dispatch.lease_expires_at>=clock_timestamp()
              UNION ALL
              SELECT 1
                FROM execution_attempts active_attempt
                JOIN run_claims active_claim
                  ON active_claim.tenant_id=active_attempt.tenant_id
                 AND active_claim.attempt_id=active_attempt.attempt_id
               WHERE active_attempt.tenant_id=outbox.tenant_id
                 AND active_attempt.thread_id=outbox.thread_id
                 AND active_attempt.status IN ('claimed','running','finalizing')
                 AND active_claim.released_at IS NULL
                 AND active_claim.expires_at>=clock_timestamp()
            )
            AND (
              (outbox.state='ready' AND outbox.next_attempt_at <= clock_timestamp())
              OR (outbox.state='claimed' AND outbox.lease_expires_at < clock_timestamp())
            )
          ORDER BY COALESCE(active.active_run_count,0),outbox.next_attempt_at,outbox.created_at
          LIMIT $3 FOR UPDATE OF outbox SKIP LOCKED`,
        [input.tenantId, userMaxConcurrentRunsPerTenant, candidateLimit],
      );
      const claims: PgClaimedRunDispatch[] = [];
      for (const row of rows.rows) {
        if (claims.length >= input.limit) break;
        const requestedByUserId = String(row.user_id);
        const activeThread = await client.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count
             FROM (
               SELECT active_dispatch.run_id
                 FROM run_dispatch_outbox active_dispatch
                WHERE active_dispatch.tenant_id=$1 AND active_dispatch.thread_id=$2
                  AND active_dispatch.state='claimed'
                  AND active_dispatch.lease_expires_at>=clock_timestamp()
               UNION
               SELECT active_attempt.run_id
                 FROM execution_attempts active_attempt
                 JOIN run_claims active_claim
                   ON active_claim.tenant_id=active_attempt.tenant_id
                  AND active_claim.attempt_id=active_attempt.attempt_id
                WHERE active_attempt.tenant_id=$1 AND active_attempt.thread_id=$2
                  AND active_attempt.status IN ('claimed','running','finalizing')
                  AND active_claim.released_at IS NULL
                  AND active_claim.expires_at>=clock_timestamp()
             ) active`,
          [input.tenantId, String(row.thread_id)],
        );
        const activeThreadCount = Number(activeThread.rows[0]?.count);
        if (!Number.isSafeInteger(activeThreadCount)) {
          throw new TypeError("Thread 活跃 Run 计数无效");
        }
        if (activeThreadCount >= 1) continue;
        const active = await client.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count
             FROM (
               SELECT claimed.run_id
                 FROM run_dispatch_outbox claimed
                 JOIN threads thread
                   ON thread.tenant_id=claimed.tenant_id AND thread.id=claimed.thread_id
                 LEFT JOIN run_skill_snapshots snapshot
                   ON snapshot.tenant_id=claimed.tenant_id AND snapshot.run_id=claimed.run_id
                WHERE claimed.tenant_id=$1
                  AND COALESCE(snapshot.user_id,thread.created_by_user_id)=$2
                  AND claimed.state='claimed' AND claimed.lease_expires_at>=clock_timestamp()
               UNION
               SELECT attempt.run_id
                 FROM execution_attempts attempt
                 JOIN run_claims claim
                   ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
                 JOIN threads thread
                   ON thread.tenant_id=attempt.tenant_id AND thread.id=attempt.thread_id
                 LEFT JOIN run_skill_snapshots snapshot
                   ON snapshot.tenant_id=attempt.tenant_id AND snapshot.run_id=attempt.run_id
                WHERE attempt.tenant_id=$1
                  AND COALESCE(snapshot.user_id,thread.created_by_user_id)=$2
                  AND attempt.status IN ('claimed','running','finalizing')
                  AND claim.released_at IS NULL AND claim.expires_at>=clock_timestamp()
             ) active`,
          [input.tenantId, requestedByUserId],
        );
        const activeCount = Number(active.rows[0]?.count);
        if (!Number.isSafeInteger(activeCount)) {
          throw new TypeError("用户活跃 Run 计数无效");
        }
        if (activeCount >= userMaxConcurrentRunsPerTenant) continue;
        const token = randomUUID();
        const updated = await client.query<QueryResultRow>(
          `UPDATE run_dispatch_outbox
              SET state='claimed',generation=generation+1,claim_token=$3,claimed_by=$4,
                  lease_expires_at=clock_timestamp()+($5::bigint * interval '1 millisecond'),
                  dispatch_attempts=dispatch_attempts+1,last_error_code=NULL,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND outbox_id=$2
            RETURNING generation`,
          [input.tenantId, row.outbox_id, token, dispatcherId, input.leaseMilliseconds],
        );
        const generation = Number(updated.rows[0]?.generation);
        if (!Number.isSafeInteger(generation)) throw new TypeError("Outbox claim generation 无效");
        claims.push(
          Object.freeze({
            outboxId: String(row.outbox_id),
            generation,
            claimToken: token,
            scope: Object.freeze({
              tenantId: input.tenantId,
              runId: String(row.run_id),
              threadId: String(row.thread_id),
              workspaceId: String(row.workspace_id),
              rootRunId: String(row.root_run_id),
              ...(row.base_revision_id === null
                ? {}
                : { baseRevisionId: String(row.base_revision_id) }),
            }),
          }),
        );
      }
      return Object.freeze(claims);
    });
  }

  async acknowledge(input: {
    readonly claim: PgClaimedRunDispatch;
    readonly outcome: "dispatched" | "terminal" | "waiting" | "defer";
    readonly retryAfterMilliseconds?: number;
  }): Promise<void> {
    const retryAfterMilliseconds = input.retryAfterMilliseconds;
    if (input.outcome === "defer") {
      if (
        retryAfterMilliseconds === undefined ||
        !Number.isSafeInteger(retryAfterMilliseconds) ||
        retryAfterMilliseconds < 1_000 ||
        retryAfterMilliseconds > maxOutboxRetryMilliseconds
      ) {
        throw new TypeError("Outbox defer 延迟无效");
      }
    }
    await withTenantTransaction(
      this.pool,
      { tenantId: input.claim.scope.tenantId },
      async (client) => {
        const locked = await client.query<{ readonly status: string }>(
          `SELECT runs.status FROM run_dispatch_outbox
          JOIN runs ON runs.tenant_id=run_dispatch_outbox.tenant_id
                   AND runs.id=run_dispatch_outbox.run_id
         WHERE run_dispatch_outbox.tenant_id=$1 AND run_dispatch_outbox.outbox_id=$2
           AND run_dispatch_outbox.state='claimed'
           AND run_dispatch_outbox.generation=$3 AND run_dispatch_outbox.claim_token=$4
           AND run_dispatch_outbox.lease_expires_at >= clock_timestamp()
         FOR UPDATE OF run_dispatch_outbox,runs`,
          [
            input.claim.scope.tenantId,
            input.claim.outboxId,
            input.claim.generation,
            input.claim.claimToken,
          ],
        );
        // 迟到 ack（租约已被新 generation 重领）与已删除视为安全 no-op。
        if (locked.rows[0] === undefined) return;
        const cancelled = locked.rows[0].status === "cancelled";
        const terminal = ["succeeded", "failed", "cancelled"].includes(locked.rows[0].status);
        if (
          (input.outcome === "waiting" && locked.rows[0].status !== "waiting") ||
          (input.outcome === "terminal" && !terminal) ||
          (input.outcome === "dispatched" && !["queued", "running"].includes(locked.rows[0].status))
        ) {
          throw new TypeError("Outbox ack 与 Run 状态不一致");
        }
        if (input.outcome === "defer" && !cancelled) {
          await client.query(
            `UPDATE run_dispatch_outbox
              SET state='ready',claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,
                  next_attempt_at=clock_timestamp()+($3::bigint * interval '1 millisecond'),
                  last_error_code='retryable',updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND outbox_id=$2`,
            // defer 分支已经完成严格验证；默认值仅帮助 TypeScript 穿过异步回调边界。
            [input.claim.scope.tenantId, input.claim.outboxId, retryAfterMilliseconds ?? 0],
          );
          await scheduleWorkerTenant(
            client,
            input.claim.scope.tenantId,
            retryAfterMilliseconds ?? 0,
          );
          return;
        }
        // success/terminal/waiting 或已取消的 defer 都终结本条投递；Worker 内部幂等地防止第二 Attempt。
        await client.query(
          `UPDATE run_dispatch_outbox
            SET state=$3,claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,
                last_error_code=$4,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND outbox_id=$2`,
          [
            input.claim.scope.tenantId,
            input.claim.outboxId,
            cancelled ? "cancelled" : "dispatched",
            input.outcome === "terminal"
              ? "terminal"
              : input.outcome === "waiting"
                ? "waiting"
                : null,
          ],
        );
      },
    );
  }
}
