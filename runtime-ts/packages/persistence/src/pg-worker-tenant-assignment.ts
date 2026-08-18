import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import { withTenantTransaction, withTransaction } from "./postgres.js";

const maximumLeaseMilliseconds = 300_000;

function workerIdentity(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > 200) {
    throw new TypeError("workerId 的 UTF-8 字节长度必须在 1 到 200 之间");
  }
  return normalized;
}

function leaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > maximumLeaseMilliseconds) {
    throw new TypeError("Worker Tenant assignment lease 无效");
  }
  return value;
}

/**
 * 必须在已经设置 app.tenant_id 的业务事务内调用。唤醒与 durable dispatch 同事务提交，
 * 避免任务已经可见但全局控制面没有候选的丢唤醒窗口。
 */
export async function scheduleWorkerTenantAt(
  client: PoolClient,
  tenantId: string,
  nextAttemptAt: Date,
): Promise<void> {
  if (!Number.isFinite(nextAttemptAt.getTime())) throw new TypeError("Worker Tenant 调度时间无效");
  await client.query(
    `INSERT INTO worker_tenant_assignments(tenant_id,state,next_attempt_at)
     VALUES ($1,'ready',GREATEST($2::timestamptz,clock_timestamp()))
     ON CONFLICT (tenant_id) DO UPDATE
       SET state=CASE
             WHEN worker_tenant_assignments.state='claimed' THEN 'claimed'
             ELSE 'ready'
           END,
           next_attempt_at=LEAST(
             worker_tenant_assignments.next_attempt_at,
             EXCLUDED.next_attempt_at
           ),
           updated_at=clock_timestamp()`,
    [tenantId, nextAttemptAt],
  );
}

export async function scheduleWorkerTenant(
  client: PoolClient,
  tenantId: string,
  delayMilliseconds = 0,
): Promise<void> {
  if (
    !Number.isSafeInteger(delayMilliseconds) ||
    delayMilliseconds < 0 ||
    delayMilliseconds > 86_400_000
  ) {
    throw new TypeError("Worker Tenant 调度延迟无效");
  }
  await scheduleWorkerTenantAt(client, tenantId, new Date(Date.now() + delayMilliseconds));
}

export async function wakeWorkerTenant(client: PoolClient, tenantId: string): Promise<void> {
  await scheduleWorkerTenant(client, tenantId, 0);
}

export interface PgClaimedWorkerTenantAssignment {
  readonly tenantId: string;
  readonly generation: number;
  readonly claimToken: string;
  readonly workerId: string;
}

/**
 * 全局表只保存 Tenant ID 和短租约栅栏。领取成功后，具体 dispatch、Run 与 Workspace
 * 仍由各 Repository 在 withTenantTransaction 中读取，控制面不能读取任何用户业务载荷。
 */
export class PgWorkerTenantAssignments {
  constructor(
    private readonly pools: Readonly<{
      /** 受 Tenant RLS 约束，只能 wake/settle 当前 Tenant。 */
      readonly runtime: Pool;
      /** 仅有 assignment 全局 SELECT 与 claim 栅栏 UPDATE 权限。 */
      readonly coordinator: Pool;
    }>,
  ) {}

  async wake(tenantId: string): Promise<void> {
    try {
      await withTenantTransaction(this.pools.runtime, { tenantId }, (client) =>
        wakeWorkerTenant(client, tenantId),
      );
    } catch (error) {
      throw mapPersistenceError(error, "唤醒 Worker Tenant 调度");
    }
  }

  async claim(input: {
    readonly workerId: string;
    readonly leaseMilliseconds: number;
  }): Promise<PgClaimedWorkerTenantAssignment | undefined> {
    const workerId = workerIdentity(input.workerId);
    const leaseMilliseconds = leaseDuration(input.leaseMilliseconds);
    try {
      return await withTransaction(this.pools.coordinator, async (client) => {
        const selected = await client.query<QueryResultRow>(
          `SELECT tenant_id,generation
             FROM worker_tenant_assignments
            WHERE (state='ready' AND next_attempt_at<=clock_timestamp())
               OR (state='claimed' AND lease_expires_at<clock_timestamp())
            ORDER BY
              CASE WHEN state='ready' THEN next_attempt_at ELSE lease_expires_at END,
              updated_at,tenant_id
            LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        const row = selected.rows[0];
        if (row === undefined) return undefined;
        const claimToken = randomUUID();
        const claimed = await client.query<QueryResultRow>(
          `UPDATE worker_tenant_assignments
              SET state='claimed',generation=generation+1,claim_token=$2,claimed_by=$3,
                  lease_expires_at=clock_timestamp()+($4::bigint * interval '1 millisecond'),
                  updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND generation=$5
            RETURNING generation`,
          [row.tenant_id, claimToken, workerId, leaseMilliseconds, row.generation],
        );
        const generation = Number(claimed.rows[0]?.generation);
        if (!Number.isSafeInteger(generation)) {
          throw new TypeError("Worker Tenant assignment generation 无效");
        }
        return Object.freeze({
          tenantId: String(row.tenant_id),
          generation,
          claimToken,
          workerId,
        });
      });
    } catch (error) {
      throw mapPersistenceError(error, "动态领取 Worker Tenant");
    }
  }

  async settle(assignment: PgClaimedWorkerTenantAssignment): Promise<boolean> {
    try {
      return await withTenantTransaction(
        this.pools.runtime,
        { tenantId: assignment.tenantId },
        async (client) => {
          const locked = await client.query(
            `SELECT 1 FROM worker_tenant_assignments
              WHERE tenant_id=$1 AND state='claimed' AND generation=$2
                AND claim_token=$3 AND claimed_by=$4
                AND lease_expires_at>=clock_timestamp()
              FOR UPDATE`,
            [
              assignment.tenantId,
              assignment.generation,
              assignment.claimToken,
              assignment.workerId,
            ],
          );
          // 租约过期后可能已被新 Worker 接管；迟到 settle 不能覆盖新 generation。
          if (locked.rowCount !== 1) return false;
          const pending = await client.query<{ readonly next_attempt_at: Date | string | null }>(
            `SELECT min(candidate.next_attempt_at) AS next_attempt_at
               FROM (
                 SELECT CASE
                          WHEN outbox.state='ready' THEN greatest(
                            outbox.next_attempt_at,statement_timestamp()
                          )
                          ELSE greatest(
                            outbox.lease_expires_at + interval '1 millisecond',
                            statement_timestamp()
                          )
                        END AS next_attempt_at
                   FROM run_dispatch_outbox outbox
                   LEFT JOIN thread_follow_up_queue queue
                     ON queue.tenant_id=outbox.tenant_id AND queue.thread_id=outbox.thread_id
                    AND queue.run_id=outbox.run_id
                   LEFT JOIN thread_execution_heads head
                     ON head.tenant_id=outbox.tenant_id AND head.thread_id=outbox.thread_id
                  WHERE outbox.tenant_id=$1
                    AND (queue.run_id IS NULL OR (
                      queue.state='active' AND head.active_run_id=outbox.run_id
                    ))
                    AND outbox.state IN ('ready','claimed')
                 UNION ALL
                 SELECT CASE
                          WHEN memory.state IN ('pending','submitted') THEN greatest(
                            memory.next_attempt_at,statement_timestamp()
                          )
                          ELSE greatest(
                            memory.claim_expires_at + interval '1 millisecond',
                            statement_timestamp()
                          )
                        END AS next_attempt_at
                   FROM memory_ingestion_outbox memory
                  WHERE memory.tenant_id=$1
                    AND memory.state IN ('pending','claimed','submitted')
                 UNION ALL
                 SELECT greatest(task.next_run_at,statement_timestamp()) AS next_attempt_at
                   FROM scheduled_tasks task
                  WHERE task.tenant_id=$1 AND task.status='active' AND task.next_run_at IS NOT NULL
                 UNION ALL
                 SELECT CASE
                          WHEN occurrence.state='failed' THEN greatest(
                            occurrence.next_attempt_at,statement_timestamp()
                          )
                          ELSE greatest(
                            occurrence.updated_at+interval '5 minutes',statement_timestamp()
                          )
                        END AS next_attempt_at
                   FROM scheduled_task_occurrences occurrence
                  WHERE occurrence.tenant_id=$1 AND occurrence.state IN ('dispatching','failed')
               ) candidate`,
            [assignment.tenantId],
          );
          const nextAttemptAt = pending.rows[0]?.next_attempt_at ?? null;
          const settled = await client.query(
            `UPDATE worker_tenant_assignments
                SET state=$5,claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,
                    next_attempt_at=COALESCE($6::timestamptz,clock_timestamp()),
                    updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND state='claimed' AND generation=$2
                AND claim_token=$3 AND claimed_by=$4`,
            [
              assignment.tenantId,
              assignment.generation,
              assignment.claimToken,
              assignment.workerId,
              nextAttemptAt === null ? "idle" : "ready",
              nextAttemptAt,
            ],
          );
          return settled.rowCount === 1;
        },
      );
    } catch (error) {
      throw mapPersistenceError(error, "收敛 Worker Tenant 调度租约");
    }
  }
}
