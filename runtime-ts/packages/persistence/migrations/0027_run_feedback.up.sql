ALTER TABLE run_agent_snapshots ADD CONSTRAINT run_agent_snapshots_feedback_key UNIQUE (tenant_id,run_id,revision_id);
CREATE TABLE run_feedback (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  revision_id text NOT NULL,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  rating text NOT NULL CHECK (rating IN ('up','down')),
  comment text CHECK (char_length(comment)<=2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id,user_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,run_id,revision_id) REFERENCES run_agent_snapshots(tenant_id,run_id,revision_id) ON DELETE RESTRICT
);
ALTER TABLE run_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_feedback FORCE ROW LEVEL SECURITY;
DO $$
DECLARE runtime_role text := current_setting('app.runtime_role');
BEGIN
  EXECUTE format($policy$CREATE POLICY run_feedback_own ON run_feedback TO %I
    USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
      AND user_id=NULLIF(current_setting('app.user_id',true),'')
      AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=run_feedback.tenant_id AND m.user_id=run_feedback.user_id AND m.status='active')
      AND EXISTS (SELECT 1 FROM runs r JOIN threads t ON t.tenant_id=r.tenant_id AND t.id=r.thread_id
                   WHERE r.tenant_id=run_feedback.tenant_id AND r.id=run_feedback.run_id AND r.origin IN ('normal','api') AND NOT t.is_playground))
    WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
      AND user_id=NULLIF(current_setting('app.user_id',true),'')
      AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=run_feedback.tenant_id AND m.user_id=run_feedback.user_id AND m.status='active')
      AND EXISTS (SELECT 1 FROM runs r JOIN threads t ON t.tenant_id=r.tenant_id AND t.id=r.thread_id
                   WHERE r.tenant_id=run_feedback.tenant_id AND r.id=run_feedback.run_id AND r.origin IN ('normal','api') AND NOT t.is_playground))$policy$,runtime_role);
  EXECUTE format('CREATE POLICY run_feedback_admin_projection ON run_feedback FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active''))',current_user);
END $$;

CREATE OR REPLACE VIEW admin_agent_metrics_hourly WITH (security_barrier=true) AS
WITH run_facts AS (
  SELECT r.tenant_id,r.id AS run_id,r.created_at,r.status,r.origin,
         t.agent_definition_id,s.revision_id AS agent_revision_id,
         CASE WHEN latest.status IN ('recovery_required','abandoned') THEN 1 ELSE 0 END AS result_unknown,
         CASE WHEN r.status='succeeded' THEN 1 ELSE 0 END AS succeeded,
         CASE WHEN r.status='failed' THEN 1 ELSE 0 END AS failed,
         CASE WHEN (r.status IN ('succeeded','failed','cancelled') OR latest.status IN ('recovery_required','abandoned'))
                    AND latest.finished_at IS NOT NULL
              THEN latest.finished_at-r.created_at END AS duration,
         COALESCE(usage.input_tokens,0) AS input_tokens,
         COALESCE(usage.output_tokens,0) AS output_tokens,
         COALESCE(usage.cache_read_tokens,0) AS cache_read_tokens,
         COALESCE(usage.generation_duration_ms,0) AS generation_duration_ms,
         COALESCE(usage.model_calls,0) AS model_calls,
         COALESCE(events.tool_calls,0) AS tool_calls,
         COALESCE(events.failed_tool_calls,0) AS failed_tool_calls,
         COALESCE(feedback.up_count,0) AS feedback_up_count,COALESCE(feedback.down_count,0) AS feedback_down_count,
         pricing.currency,pricing.input_per_million,pricing.output_per_million,pricing.cache_read_per_million
    FROM runs r
    JOIN threads t ON t.tenant_id=r.tenant_id AND t.id=r.thread_id
    LEFT JOIN run_agent_snapshots s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
    LEFT JOIN LATERAL (
      SELECT a.attempt_id,a.status,a.finished_at FROM execution_attempts a
       WHERE a.tenant_id=r.tenant_id AND a.run_id=r.id
       ORDER BY a.created_at DESC,a.attempt_id DESC LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT sum(value) FILTER (WHERE metric_name='model_input_tokens') AS input_tokens,
             sum(value) FILTER (WHERE metric_name='model_output_tokens') AS output_tokens,
             sum(value) FILTER (WHERE metric_name='model_cache_read_tokens') AS cache_read_tokens,
             sum(value) FILTER (WHERE metric_name='model_generation_duration_ms') AS generation_duration_ms,
             sum(value) FILTER (WHERE metric_name='model_generation_count') AS model_calls
        FROM thread_continuity_metric_observations m
       WHERE m.tenant_id=r.tenant_id AND m.run_id=r.id
         AND m.metric_name IN ('model_input_tokens','model_output_tokens','model_cache_read_tokens','model_generation_duration_ms','model_generation_count')
    ) usage ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE e.payload->>'type'='tool.started') AS tool_calls,
             count(*) FILTER (WHERE e.payload->>'type'='tool.completed' AND e.payload->'isError'='true'::jsonb) AS failed_tool_calls
        FROM run_events e
       WHERE e.tenant_id=r.tenant_id AND e.attempt_id=latest.attempt_id
    ) events ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE rating='up') AS up_count,count(*) FILTER (WHERE rating='down') AS down_count
        FROM run_feedback feedback WHERE feedback.tenant_id=r.tenant_id AND feedback.run_id=r.id
    ) feedback ON true
    LEFT JOIN run_model_pricing_snapshots pricing ON pricing.tenant_id=r.tenant_id AND pricing.run_id=r.id
   WHERE r.created_at >= NULLIF(current_setting('app.agent_metrics_from',true),'')::timestamptz
     AND r.created_at < NULLIF(current_setting('app.agent_metrics_to',true),'')::timestamptz
     AND (NULLIF(current_setting('app.agent_metrics_agent_id',true),'') IS NULL
          OR t.agent_definition_id=NULLIF(current_setting('app.agent_metrics_agent_id',true),''))
     AND (NULLIF(current_setting('app.agent_metrics_revision_id',true),'') IS NULL
          OR s.revision_id=NULLIF(current_setting('app.agent_metrics_revision_id',true),''))
     AND (NULLIF(current_setting('app.agent_metrics_tenant_id',true),'') IS NULL
          OR r.tenant_id=NULLIF(current_setting('app.agent_metrics_tenant_id',true),''))
     AND CASE WHEN NULLIF(current_setting('app.agent_metrics_origin',true),'') IS NULL
              THEN r.origin NOT IN ('playground','evaluation')
              ELSE r.origin=NULLIF(current_setting('app.agent_metrics_origin',true),'') END
), grouped AS (
  SELECT date_trunc('hour',created_at) AS window_start,agent_definition_id,agent_revision_id,tenant_id,origin,currency,
         count(*)::bigint AS run_count,
         sum(feedback_up_count)::bigint AS feedback_up_count,sum(feedback_down_count)::bigint AS feedback_down_count,
         sum(succeeded)::bigint AS succeeded_count,sum(failed)::bigint AS failed_count,sum(result_unknown)::bigint AS result_unknown_count,
         count(*) FILTER (WHERE status='cancelled')::bigint AS cancelled_count,
         count(*) FILTER (WHERE status IN ('succeeded','failed','cancelled') OR result_unknown=1)::bigint AS resolved_count,
         sum(tool_calls)::bigint AS tool_calls,sum(failed_tool_calls)::bigint AS failed_tool_calls,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM duration)*1000) AS latency_p50_ms,
         percentile_cont(0.90) WITHIN GROUP (ORDER BY extract(epoch FROM duration)*1000) AS latency_p90_ms,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM duration)*1000) AS latency_p99_ms,
         avg(NULLIF(generation_duration_ms,0)) AS average_generation_ms,
         avg(model_calls) AS average_model_rounds,
         sum(input_tokens)::numeric AS input_tokens,sum(output_tokens)::numeric AS output_tokens,sum(cache_read_tokens)::numeric AS cache_read_tokens,
         CASE WHEN bool_or(
           (model_calls>0 AND currency IS NULL)
           OR (model_calls>0 AND input_per_million IS NULL AND output_per_million IS NULL AND cache_read_per_million IS NULL)
           OR (input_tokens>0 AND input_per_million IS NULL)
           OR (output_tokens>0 AND output_per_million IS NULL)
           OR (cache_read_tokens>0 AND cache_read_per_million IS NULL)
         )
              THEN NULL ELSE sum(COALESCE(input_tokens*input_per_million,0)+COALESCE(output_tokens*output_per_million,0)+COALESCE(cache_read_tokens*cache_read_per_million,0))/1000000 END AS cost
    FROM run_facts
   GROUP BY 1,2,3,4,5,6
)
SELECT window_start,agent_definition_id,agent_revision_id,tenant_id,origin,currency,run_count,succeeded_count,failed_count,result_unknown_count,cancelled_count,
       succeeded_count::numeric/NULLIF(resolved_count,0) AS success_rate,
       failed_count::numeric/NULLIF(resolved_count,0) AS failure_rate,
       result_unknown_count::numeric/NULLIF(resolved_count,0) AS result_unknown_rate,
       failed_tool_calls::numeric/NULLIF(tool_calls,0) AS tool_failure_rate,
       latency_p50_ms,latency_p90_ms,latency_p99_ms,average_generation_ms,average_model_rounds,tool_calls,failed_tool_calls,
       input_tokens,output_tokens,cache_read_tokens,cost,feedback_up_count,feedback_down_count,
       feedback_up_count::numeric/NULLIF(feedback_up_count+feedback_down_count,0) AS feedback_up_rate,
       feedback_down_count::numeric/NULLIF(feedback_up_count+feedback_down_count,0) AS feedback_down_rate
  FROM grouped
 WHERE EXISTS (SELECT 1 FROM platform_control_operators actor
                WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'') AND actor.status='active');

CREATE VIEW admin_run_feedback_content WITH (security_barrier=true) AS
SELECT feedback.* FROM run_feedback feedback
WHERE EXISTS (
  SELECT 1 FROM admin_run_content_access_audits access
  JOIN platform_control_operators actor ON actor.user_id=access.actor_user_id
  WHERE access.audit_id=NULLIF(current_setting('app.run_content_audit_id',true),'')
    AND access.actor_user_id=NULLIF(current_setting('app.user_id',true),'')
    AND access.access_transaction=pg_current_xact_id_if_assigned()
    AND access.tenant_id=feedback.tenant_id AND access.run_id=feedback.run_id
    AND actor.status='active' AND actor.role='admin'
);

DO $$
BEGIN
  EXECUTE format('GRANT SELECT,INSERT,DELETE,UPDATE(rating,comment,updated_at) ON run_feedback TO %I',current_setting('app.runtime_role'));
  EXECUTE format('GRANT SELECT ON admin_run_feedback_content TO %I',current_setting('app.admin_control_role'));
END $$;
