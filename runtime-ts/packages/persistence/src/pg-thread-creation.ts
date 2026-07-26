import { rehydrateThread, type Thread } from "@cube-runtime/domain";
import type { QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import type { IdempotentCreateResult, ThreadCreationPort } from "./ports.js";
import { type Pool, type PoolClient, withTenantTransaction } from "./postgres.js";

function storedTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new TypeError("数据库未返回 Thread 时间");
}

/**
 * API 的唯一 Thread 创建能力：Thread、空 Workspace、幂等记录与成员资格重验共用一个事务。
 * 该实现不复用普通 Repository，避免看似成功但只写入一半父实体。
 */
export class PgThreadCreation implements ThreadCreationPort {
  constructor(private readonly pool: Pool) {}

  async createThread(
    input: Parameters<ThreadCreationPort["createThread"]>[0],
  ): Promise<IdempotentCreateResult<Thread>> {
    if (
      input.scope.tenantId !== input.thread.tenantId ||
      input.scope.userId !== input.thread.createdByUserId ||
      input.workspace.tenantId !== input.scope.tenantId ||
      input.workspace.threadId !== input.thread.id
    ) {
      return { outcome: "not_authorized" };
    }
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const membership = await client.query<{ readonly status: string }>(
          `SELECT status FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE`,
          [input.scope.tenantId, input.scope.userId],
        );
        if (membership.rows[0]?.status !== "active") return { outcome: "not_authorized" } as const;
        const replay = await this.readReplay(client, input);
        if (replay !== undefined) return replay;
        // 幂等表刻意没有 UPDATE 权限；advisory lock 让首个同键请求串行，不扩大最小 ACL。
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
          `${input.scope.tenantId}\u001f${input.scope.userId}\u001fthread.create\u001f${input.idempotency.key}`,
        ]);
        const afterLockReplay = await this.readReplay(client, input);
        if (afterLockReplay !== undefined) return afterLockReplay;
        const createdThread = await client.query(
          `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.scope.tenantId,
            input.thread.id,
            input.scope.userId,
            input.thread.title,
            input.thread.status,
            input.thread.createdAt,
            input.thread.updatedAt,
          ],
        );
        if (createdThread.rowCount !== 1) throw new TypeError("创建 Thread 未写入");
        const createdWorkspace = await client.query(
          `INSERT INTO workspaces(
             tenant_id,id,thread_id,current_revision_number,current_revision_id,lease_epoch,created_at,updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            input.scope.tenantId,
            input.workspace.id,
            input.thread.id,
            input.workspace.currentRevisionNumber,
            input.workspace.currentRevisionId ?? null,
            input.workspace.leaseEpoch,
            input.workspace.createdAt,
            input.workspace.updatedAt,
          ],
        );
        if (createdWorkspace.rowCount !== 1) throw new TypeError("创建初始 Workspace 未写入");
        await client.query(
          `INSERT INTO api_thread_idempotency_records(tenant_id,user_id,idempotency_key,request_hash,thread_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            input.scope.tenantId,
            input.scope.userId,
            input.idempotency.key,
            input.idempotency.requestHash,
            input.thread.id,
          ],
        );
        return { outcome: "created", entity: input.thread } as const;
      });
    } catch (error) {
      throw mapPersistenceError(error, "原子创建 Thread 与 Workspace");
    }
  }

  private async readReplay(
    client: PoolClient,
    input: Parameters<ThreadCreationPort["createThread"]>[0],
  ): Promise<IdempotentCreateResult<Thread> | undefined> {
    const record = await client.query<{
      readonly request_hash: string;
      readonly thread_id: string;
    }>(
      `SELECT request_hash,thread_id FROM api_thread_idempotency_records
        WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3`,
      [input.scope.tenantId, input.scope.userId, input.idempotency.key],
    );
    const existing = record.rows[0];
    if (existing === undefined) return undefined;
    if (existing.request_hash !== input.idempotency.requestHash) return { outcome: "key_conflict" };
    const thread = await client.query<QueryResultRow>(
      `SELECT id,created_by_user_id,title,status,created_at,updated_at
         FROM threads WHERE tenant_id=$1 AND id=$2`,
      [input.scope.tenantId, existing.thread_id],
    );
    const row = thread.rows[0];
    if (row === undefined || row.created_by_user_id !== input.scope.userId) {
      throw new TypeError("Thread 幂等记录缺少实体");
    }
    return {
      outcome: "replayed",
      entity: rehydrateThread(
        {
          id: String(row.id),
          tenantId: input.scope.tenantId,
          createdByUserId: String(row.created_by_user_id),
          title: String(row.title),
          status: String(row.status),
          createdAt: storedTimestamp(row.created_at),
          updatedAt: storedTimestamp(row.updated_at),
        },
        input.tenant,
        input.user,
        input.membership,
      ),
    };
  }
}
