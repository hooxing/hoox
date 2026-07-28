import { randomUUID } from "node:crypto";
import type { RecoveryMetricsPort } from "@cube-runtime/run-contracts";
import type { Pool } from "pg";
import { mapPersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";

/** 生产恢复指标写入 PG，避免 cleanup 失败只存在于进程日志或被静默丢弃。 */
export class PgRecoveryMetrics implements RecoveryMetricsPort {
  constructor(private readonly pool: Pool) {}

  async recordOrphanCleanup(
    input: Parameters<RecoveryMetricsPort["recordOrphanCleanup"]>[0],
  ): Promise<void> {
    try {
      await withTenantTransaction(this.pool, input.scope, async (client) => {
        await client.query(
          `INSERT INTO runtime_recovery_metrics(
             tenant_id, metric_id, run_id, thread_id, workspace_id, root_run_id,
             registry_id, reason, cleanup_outcome
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            input.scope.tenantId,
            randomUUID(),
            input.scope.runId,
            input.scope.threadId,
            input.scope.workspaceId,
            input.scope.rootRunId,
            input.registryId,
            input.reason,
            input.cleanupOutcome,
          ],
        );
      });
    } catch (error) {
      throw mapPersistenceError(error, "记录 Sandbox 恢复指标");
    }
  }
}
