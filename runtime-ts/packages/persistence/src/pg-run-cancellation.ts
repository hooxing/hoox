import type { ExecutionScope } from "@aisay/run-contracts";
import type { Pool } from "pg";
import { withTenantTransaction } from "./postgres.js";

/** 为生产 Worker 提供租户隔离的 Run 取消状态读取。 */
export class PgRunCancellationReader {
  constructor(private readonly pool: Pool) {}

  async isCancelled(scope: ExecutionScope): Promise<boolean> {
    return withTenantTransaction(
      this.pool,
      { tenantId: scope.tenantId },
      async (client) => {
        const result = await client.query<{ readonly status: string }>(
          `SELECT status FROM runs
             WHERE tenant_id=$1 AND id=$2 AND thread_id=$3`,
          [scope.tenantId, scope.runId, scope.threadId],
        );
        return result.rows[0]?.status === "cancelled";
      },
      { readOnly: true },
    );
  }
}
