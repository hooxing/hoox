import { createHash, randomUUID } from "node:crypto";
import { isoTimestamp, rehydrateRun, type Run } from "@cube-runtime/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import type { EnqueueOutboxPort, IdempotentCreateResult } from "./ports.js";
import { TransactionCommitUnknownError, withTenantTransaction } from "./postgres.js";

const maxInputBytes = 1_048_576;
const emptyProjectionDigest = createHash("sha256").update("{}").digest("hex");

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
}

/**
 * API 的唯一生产 CreateRun capability。Membership→Thread→Workspace 为固定锁序；
 * Run、不可变输入、Outbox 与幂等记录在同一事务提交，绝不由 API 拼接多次写入。
 */
export class PgRunDispatchCreation implements EnqueueOutboxPort {
  constructor(
    private readonly pool: Pool,
    private readonly options: PgRunDispatchCreationOptions = {},
  ) {}

  async createQueuedRun(
    input: Parameters<EnqueueOutboxPort["createQueuedRun"]>[0],
  ): Promise<IdempotentCreateResult<Run>> {
    if (
      input.scope.tenantId !== input.run.tenantId ||
      input.thread.id !== input.run.threadId ||
      input.thread.tenantId !== input.scope.tenantId
    ) {
      return { outcome: "not_authorized" };
    }
    const digest = inputDigest(input.inputText);
    try {
      const result = await withTenantTransaction(this.pool, input.scope, async (client) => {
        const membership = await client.query<{ readonly status: string }>(
          `SELECT status FROM memberships
            WHERE tenant_id=$1 AND user_id=$2 FOR SHARE`,
          [input.scope.tenantId, input.scope.userId],
        );
        if (membership.rows[0]?.status !== "active") return { outcome: "not_authorized" } as const;
        // Membership 锁是创建命令的串行化起点；在其后检查幂等键，避免并发首请求双写。
        const existing = await this.lockIdempotency(client, input);
        if (existing !== undefined) return existing;

        const thread = await client.query<{ readonly status: string }>(
          `SELECT status FROM threads WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [input.scope.tenantId, input.run.threadId],
        );
        if (thread.rows[0]?.status !== "active") return { outcome: "parent_inactive" } as const;

        // 读取并锁定原始 head，后续 Worker 只能依据已持久化的 base_revision_id 执行。
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

        const run = await client.query<QueryResultRow>(
          `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
           VALUES ($1,$2,$3,'queued',clock_timestamp(),clock_timestamp())
           RETURNING id AS run_id,tenant_id,thread_id,status AS run_status,
                     created_at AS run_created_at,updated_at AS run_updated_at`,
          [input.scope.tenantId, input.run.id, input.run.threadId],
        );
        const runRow = run.rows[0];
        if (runRow === undefined) throw new TypeError("创建 Run 未返回数据");
        await client.query(
          `INSERT INTO run_execution_inputs(
             tenant_id,run_id,thread_id,workspace_id,root_run_id,base_revision_id,
             input_text,initial_projection,initial_projection_digest
           ) VALUES ($1,$2,$3,$4,$2,$5,$6,'{}'::jsonb,$7)`,
          [
            input.scope.tenantId,
            input.run.id,
            input.run.threadId,
            workspaceRow.id,
            workspaceRow.current_revision_id,
            input.inputText,
            emptyProjectionDigest,
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
      await this.options.afterCommit?.("create_run");
      return result;
    } catch (error) {
      if (error instanceof TransactionCommitUnknownError) {
        const replay = await this.readReplay(input);
        if (replay !== undefined) return replay;
      }
      throw mapPersistenceError(error, "原子创建 Run 与投递 Outbox");
    }
  }

  private async lockIdempotency(
    client: PoolClient,
    input: Parameters<EnqueueOutboxPort["createQueuedRun"]>[0],
  ): Promise<IdempotentCreateResult<Run> | undefined> {
    const record = await client.query<QueryResultRow>(
      `SELECT request_hash,run_id FROM api_idempotency_records
        WHERE tenant_id=$1 AND user_id=$2 AND operation='run.create' AND idempotency_key=$3
        FOR UPDATE`,
      [input.scope.tenantId, input.scope.userId, input.idempotency.key],
    );
    const row = record.rows[0];
    if (row === undefined) return undefined;
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
  ): Promise<IdempotentCreateResult<Run> | undefined> {
    return withTenantTransaction(this.pool, input.scope, (client) =>
      this.lockIdempotency(client, input),
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
  }): Promise<readonly PgClaimedRunDispatch[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError("Outbox claim limit 无效");
    }
    if (!Number.isSafeInteger(input.leaseMilliseconds) || input.leaseMilliseconds < 1_000) {
      throw new TypeError("Outbox lease 无效");
    }
    return withTenantTransaction(this.pool, { tenantId: input.tenantId }, async (client) => {
      const rows = await client.query<QueryResultRow>(
        `SELECT outbox.outbox_id,outbox.run_id,outbox.thread_id,outbox.workspace_id,
                outbox.root_run_id,input.base_revision_id,outbox.generation
           FROM run_dispatch_outbox AS outbox
           JOIN run_execution_inputs AS input
             ON input.tenant_id=outbox.tenant_id AND input.run_id=outbox.run_id
          WHERE outbox.tenant_id=$1
            AND (
              (state='ready' AND next_attempt_at <= clock_timestamp())
              OR (state='claimed' AND lease_expires_at < clock_timestamp())
            )
          ORDER BY outbox.next_attempt_at,outbox.created_at
          LIMIT $2 FOR UPDATE OF outbox SKIP LOCKED`,
        [input.tenantId, input.limit],
      );
      const claims: PgClaimedRunDispatch[] = [];
      for (const row of rows.rows) {
        const token = randomUUID();
        const updated = await client.query<QueryResultRow>(
          `UPDATE run_dispatch_outbox
              SET state='claimed',generation=generation+1,claim_token=$3,claimed_by=$4,
                  lease_expires_at=clock_timestamp()+($5::bigint * interval '1 millisecond'),
                  dispatch_attempts=dispatch_attempts+1,last_error_code=NULL,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND outbox_id=$2
            RETURNING generation`,
          [input.tenantId, row.outbox_id, token, input.dispatcherId, input.leaseMilliseconds],
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
    if (
      input.outcome === "defer" &&
      (!Number.isSafeInteger(input.retryAfterMilliseconds) || input.retryAfterMilliseconds! < 1_000)
    ) {
      throw new TypeError("Outbox defer 延迟无效");
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
            [input.claim.scope.tenantId, input.claim.outboxId, input.retryAfterMilliseconds],
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
