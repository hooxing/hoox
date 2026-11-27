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
      await client.query("SELECT set_config('app.pinned_model_run_id',$1,true)", [input.runId]);
      await client.query(
        `INSERT INTO run_model_pricing_snapshots(
           tenant_id,run_id,model_id,currency,input_per_million,output_per_million,cache_read_per_million
         )
         SELECT $1,$2,selected.model_id,model_price.pricing->>'currency',
                CASE WHEN model_price.pricing->>'inputPerMillion' ~ '^[0-9]+([.][0-9]+)?$' THEN (model_price.pricing->>'inputPerMillion')::numeric END,
                CASE WHEN model_price.pricing->>'outputPerMillion' ~ '^[0-9]+([.][0-9]+)?$' THEN (model_price.pricing->>'outputPerMillion')::numeric END,
                CASE WHEN model_price.pricing->>'cacheReadPerMillion' ~ '^[0-9]+([.][0-9]+)?$' THEN (model_price.pricing->>'cacheReadPerMillion')::numeric END
           FROM (
             SELECT agent.content #>> '{model,providerKey}' AS provider_key,
                    (agent.content #>> '{model,providerRevision}')::bigint AS provider_revision,
                    agent.content #>> '{model,modelId}' AS model_id
               FROM run_agent_snapshots agent
              WHERE agent.tenant_id=$1 AND agent.run_id=$2
                AND agent.content #>> '{model,mode}'='pinned'
             UNION ALL
             SELECT snapshot.model_object_key,snapshot.model_revision,
                    revision.configuration->>'defaultModelId'
               FROM run_runtime_config_snapshots snapshot
               JOIN admin_control_config_revisions revision
                 ON revision.object_kind='model_provider'
                AND revision.object_key=snapshot.model_object_key
                AND revision.revision=snapshot.model_revision
              WHERE snapshot.tenant_id=$1 AND snapshot.run_id=$2
                AND NOT EXISTS (
                  SELECT 1 FROM run_agent_snapshots agent
                   WHERE agent.tenant_id=$1 AND agent.run_id=$2
                     AND agent.content #>> '{model,mode}'='pinned'
                )
           ) selected
           JOIN admin_control_config_revisions revision
             ON revision.object_kind='model_provider'
            AND revision.object_key=selected.provider_key
            AND revision.revision=selected.provider_revision
           LEFT JOIN LATERAL (
             SELECT model->'pricing' AS pricing FROM jsonb_array_elements(revision.configuration->'models') model
              WHERE model->>'id'=selected.model_id LIMIT 1
           ) model_price ON true
         ON CONFLICT(tenant_id,run_id) DO NOTHING`,
        [input.tenantId, input.runId],
      );
      // 同次调用的用量与轮次数在同一事务落库，避免比率和均值读到半组样本。
      await client.query(
        `INSERT INTO thread_continuity_metric_observations(
           tenant_id,observation_id,thread_id,run_id,metric_name,value,unit
         ) VALUES
           ($1,$2 || ':input',$3,$4,'model_input_tokens',$5,'tokens'),
           ($1,$2 || ':output',$3,$4,'model_output_tokens',$6,'tokens'),
           ($1,$2 || ':cache-read',$3,$4,'model_cache_read_tokens',$7,'tokens'),
           ($1,$2 || ':duration',$3,$4,'model_generation_duration_ms',$8,'milliseconds'),
           ($1,$2 || ':count',$3,$4,'model_generation_count',1,'count')
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
             FROM threads thread
             JOIN memberships membership
               ON membership.tenant_id=thread.tenant_id AND membership.user_id=$3
              AND membership.status='active'
             LEFT JOIN thread_execution_heads head
               ON head.tenant_id=thread.tenant_id AND head.thread_id=thread.id
             LEFT JOIN thread_context_streams stream
               ON stream.tenant_id=thread.tenant_id AND stream.thread_id=thread.id
            WHERE thread.tenant_id=$1 AND thread.id=$2`,
          [input.scope.tenantId, input.threadId, input.scope.userId],
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
