import type { ModelUsageMetricsPort, ThreadContinuityMetricsPort } from "@hoox/run-contracts";
import type { Pool } from "pg";
import type { ThreadContinuityReadPort, ThreadContinuityStatusView } from "./ports.js";
import { withTenantTransaction } from "./postgres.js";

export class PgThreadContinuityMetrics
  implements ThreadContinuityMetricsPort, ModelUsageMetricsPort
{
  constructor(private readonly pool: Pool) {}

  async record(input: Parameters<ThreadContinuityMetricsPort["record"]>[0]): Promise<void> {
    if (
      !Number.isFinite(input.value) ||
      input.value < 0 ||
      Buffer.byteLength(input.observationId, "utf8") < 8 ||
      Buffer.byteLength(input.observationId, "utf8") > 512 ||
      (input.outcome !== undefined && Buffer.byteLength(input.outcome, "utf8") > 64) ||
      (input.reason !== undefined && Buffer.byteLength(input.reason, "utf8") > 64)
    ) {
      throw new TypeError("Thread continuity metric 无效");
    }
    await withTenantTransaction(this.pool, { tenantId: input.tenantId }, async (client) => {
      await client.query(
        `INSERT INTO thread_continuity_metric_observations(
           tenant_id,observation_id,thread_id,run_id,metric_name,value,unit,path,outcome,reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id,observation_id) DO NOTHING`,
        [
          input.tenantId,
          input.observationId,
          input.threadId,
          input.runId ?? null,
          input.metricName,
          input.value,
          input.unit,
          input.path ?? null,
          input.outcome ?? null,
          input.reason ?? null,
        ],
      );
    });
  }

  async recordModelUsage(
    input: Parameters<ModelUsageMetricsPort["recordModelUsage"]>[0],
  ): Promise<void> {
    const tokenValues = [input.inputTokens, input.outputTokens, input.cacheReadTokens];
    if (
      tokenValues.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      !Number.isFinite(input.generationDurationMs) ||
      input.generationDurationMs < 0 ||
      Buffer.byteLength(input.observationId, "utf8") < 8 ||
      Buffer.byteLength(input.observationId, "utf8") > 440
    ) {
      throw new TypeError("模型用量观测无效");
    }
    await withTenantTransaction(this.pool, { tenantId: input.tenantId }, async (client) => {
      // 四项事实在同一事务内落库，缓存率和吞吐量不会读取到半组样本。
      await client.query(
        `INSERT INTO thread_continuity_metric_observations(
           tenant_id,observation_id,thread_id,run_id,metric_name,value,unit
         ) VALUES
           ($1,$2 || ':input',$3,$4,'model_input_tokens',$5,'tokens'),
           ($1,$2 || ':output',$3,$4,'model_output_tokens',$6,'tokens'),
           ($1,$2 || ':cache-read',$3,$4,'model_cache_read_tokens',$7,'tokens'),
           ($1,$2 || ':duration',$3,$4,'model_generation_duration_ms',$8,'milliseconds')
         ON CONFLICT (tenant_id,observation_id) DO NOTHING`,
        [
          input.tenantId,
          input.observationId,
          input.threadId,
          input.runId,
          input.inputTokens,
          input.outputTokens,
          input.cacheReadTokens,
          input.generationDurationMs,
        ],
      );
    });
  }
}

export class PgThreadContinuityReadRepository implements ThreadContinuityReadPort {
  constructor(private readonly pool: Pool) {}

  async getStatus(
    input: Parameters<ThreadContinuityReadPort["getStatus"]>[0],
  ): ReturnType<ThreadContinuityReadPort["getStatus"]> {
    return withTenantTransaction(
      this.pool,
      input.scope,
      async (client) => {
        const authorized = await client.query(
          `SELECT 1 FROM threads thread JOIN memberships membership
             ON membership.tenant_id=thread.tenant_id AND membership.user_id=$2
            AND membership.status='active'
            WHERE thread.tenant_id=$1 AND thread.id=$3`,
          [input.scope.tenantId, input.scope.userId, input.threadId],
        );
        if (authorized.rowCount !== 1) return { outcome: "not_found" } as const;
        const result = await client.query<{
          readonly context_sequence: string | null;
          readonly window_number: string | null;
          readonly queue_depth: string;
          readonly sandbox_state: NonNullable<ThreadContinuityStatusView["sandboxState"]> | null;
        }>(
          `SELECT head.context_through_sequence::text AS context_sequence,
                  stream.current_window_number::text AS window_number,
                  (SELECT count(*)::text FROM thread_follow_up_queue queue
                    WHERE queue.tenant_id=$1 AND queue.thread_id=$2
                      AND queue.state IN ('queued','active')) AS queue_depth,
                  (SELECT session.state FROM thread_sandbox_sessions session
                    WHERE session.tenant_id=$1 AND session.thread_id=$2
                    ORDER BY session.generation DESC LIMIT 1) AS sandbox_state
             FROM thread_execution_heads head
             JOIN thread_context_streams stream
               ON stream.tenant_id=head.tenant_id AND stream.thread_id=head.thread_id
            WHERE head.tenant_id=$1 AND head.thread_id=$2`,
          [input.scope.tenantId, input.threadId],
        );
        const row = result.rows[0];
        if (row === undefined) return { outcome: "not_found" } as const;
        return {
          outcome: "found",
          status: {
            queueDepth: Number(row.queue_depth),
            contextSequence: row.context_sequence === null ? 0 : Number(row.context_sequence),
            compactionWindow: row.window_number === null ? 0 : Number(row.window_number),
            ...(row.sandbox_state === null ? {} : { sandboxState: row.sandbox_state }),
          },
        } as const;
      },
      { readOnly: true, isolationLevel: "REPEATABLE READ" },
    );
  }
}
