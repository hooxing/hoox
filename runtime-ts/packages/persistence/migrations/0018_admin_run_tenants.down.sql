DROP VIEW admin_integration_tenant_directory;
DROP POLICY run_execution_inputs_admin_projection_read ON run_execution_inputs;
DROP POLICY tenants_admin_integration_directory_read ON tenants;
DROP POLICY user_accounts_admin_integration_directory_read ON user_accounts;
DROP VIEW admin_run_directory;
CREATE VIEW admin_run_directory WITH (security_barrier=true) AS
SELECT
  run.tenant_id, run.id AS run_id, run.thread_id, run.status, run.created_at, run.updated_at,
  snapshot.definition_id AS agent_definition_id, snapshot.revision_id AS agent_revision_id,
  run.origin,
  COALESCE(attempts.attempt_count,0)::bigint AS attempt_count,
  COALESCE(attempts.items,'[]'::jsonb) AS attempts,
  latest.attempt_id AS latest_attempt_id, latest.status AS latest_attempt_status,
  latest.created_at AS latest_attempt_started_at, latest.finished_at AS latest_attempt_finished_at,
  COALESCE(usage.model_calls,0)::bigint AS model_calls,
  COALESCE(usage.input_tokens,0)::text AS input_tokens,
  COALESCE(usage.output_tokens,0)::text AS output_tokens,
  COALESCE(usage.cache_read_tokens,0)::text AS cache_read_tokens,
  COALESCE(usage.generation_duration_ms,0)::text AS generation_duration_ms,
  COALESCE(events.event_count,0)::bigint AS event_count,
  COALESCE(events.tool_calls,0)::bigint AS tool_calls,
  COALESCE(events.failed_tool_calls,0)::bigint AS failed_tool_calls,
  COALESCE(events.error_count,0)::bigint AS error_count
FROM runs run
LEFT JOIN run_agent_snapshots snapshot ON snapshot.tenant_id=run.tenant_id AND snapshot.run_id=run.id
LEFT JOIN LATERAL (
  SELECT count(*)::bigint AS attempt_count,
    jsonb_agg(jsonb_build_object('attemptId',attempt.attempt_id,'status',attempt.status,
      'stage',attempt.stage,'createdAt',attempt.created_at,'finishedAt',attempt.finished_at)
      ORDER BY attempt.created_at,attempt.attempt_id) AS items
  FROM execution_attempts attempt WHERE attempt.tenant_id=run.tenant_id AND attempt.run_id=run.id
) attempts ON true
LEFT JOIN LATERAL (
  SELECT attempt.attempt_id,attempt.status,attempt.created_at,attempt.finished_at
  FROM execution_attempts attempt WHERE attempt.tenant_id=run.tenant_id AND attempt.run_id=run.id
  ORDER BY attempt.created_at DESC,attempt.attempt_id DESC LIMIT 1
) latest ON true
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE metric.metric_name='model_output_tokens') AS model_calls,
    sum(metric.value) FILTER (WHERE metric.metric_name='model_input_tokens') AS input_tokens,
    sum(metric.value) FILTER (WHERE metric.metric_name='model_output_tokens') AS output_tokens,
    sum(metric.value) FILTER (WHERE metric.metric_name='model_cache_read_tokens') AS cache_read_tokens,
    sum(metric.value) FILTER (WHERE metric.metric_name='model_generation_duration_ms') AS generation_duration_ms
  FROM thread_continuity_metric_observations metric WHERE metric.tenant_id=run.tenant_id AND metric.run_id=run.id
    AND metric.metric_name IN ('model_input_tokens','model_output_tokens','model_cache_read_tokens','model_generation_duration_ms')
) usage ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS event_count,
    count(*) FILTER (WHERE event.kind='agent_event' AND event.payload->>'type'='tool.started') AS tool_calls,
    count(*) FILTER (WHERE event.kind='agent_event' AND event.payload->>'type'='tool.completed' AND event.payload->'isError'='true'::jsonb) AS failed_tool_calls,
    count(*) FILTER (WHERE (event.kind='agent_event' AND event.payload->>'type' IN ('error','runtime.notice'))
      OR (event.kind='attempt_state_changed' AND (event.payload ? 'code' OR event.payload->>'status' IN ('failed','cancelled','abandoned','recovery_required')))
      OR event.kind='artifact_correction_requested') AS error_count
  FROM run_events event WHERE event.tenant_id=run.tenant_id AND event.attempt_id=latest.attempt_id
) events ON true
WHERE EXISTS (SELECT 1 FROM platform_control_operators actor
  WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'') AND actor.status='active');
