ALTER TABLE threads ADD COLUMN is_playground boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN origin text NOT NULL DEFAULT 'normal'
  CHECK (origin IN ('normal','playground','evaluation','api'));
ALTER TABLE runs ADD CONSTRAINT runs_tenant_id_origin_unique UNIQUE (tenant_id,id,origin);

-- 此视图不借用所有者权限；开关只标识专用事务，不能代替角色和本人空间校验。
CREATE VIEW playground_acceptance_scope WITH (security_invoker=true,security_barrier=true) AS
SELECT t.id AS tenant_id,m.user_id FROM tenants t
JOIN memberships m ON m.tenant_id=t.id AND m.user_id=t.owner_user_id
JOIN platform_control_operators actor ON actor.user_id=m.user_id
WHERE current_setting('app.playground_acceptance',true)='true'
  AND t.id=NULLIF(current_setting('app.tenant_id',true),'') AND t.kind='personal'
  AND m.user_id=NULLIF(current_setting('app.user_id',true),'') AND m.status='active'
  AND actor.status='active' AND actor.role IN ('operator','admin');

-- 普通请求即使属于管理员也看不到 Playground；无用户身份的执行事务继续消费队列。
ALTER POLICY threads_read_policy ON threads USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND (NOT is_playground OR NULLIF(current_setting('app.user_id',true),'') IS NULL));
DROP POLICY threads_insert_policy ON threads;
CREATE POLICY threads_insert_policy ON threads FOR INSERT
  WITH CHECK (NOT is_playground AND tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND EXISTS (
    SELECT 1 FROM agent_definitions d WHERE d.id=agent_definition_id AND d.status='published'
      AND (d.availability_mode='all_tenants' OR EXISTS (
        SELECT 1 FROM agent_definition_tenants scope WHERE scope.definition_id=d.id
          AND scope.tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND scope.available))
  ));
DROP POLICY runs_isolation_policy ON runs;
CREATE POLICY runs_read ON runs FOR SELECT USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND (origin<>'playground' OR NULLIF(current_setting('app.user_id',true),'') IS NULL));
CREATE POLICY runs_insert ON runs FOR INSERT WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND origin<>'playground' AND EXISTS (
  SELECT 1 FROM threads t WHERE t.tenant_id=runs.tenant_id AND t.id=runs.thread_id AND NOT t.is_playground));
CREATE POLICY runs_update ON runs FOR UPDATE USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));

-- 普通 steer 先固化候选快照，直到转队列才有 Run 行，不能在此分支依赖 runs。
DROP POLICY run_agent_snapshots_insert ON run_agent_snapshots;
CREATE POLICY run_agent_snapshots_insert ON run_agent_snapshots FOR INSERT
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND EXISTS (
    SELECT 1 FROM threads t
    JOIN agent_definitions d ON d.id=t.agent_definition_id
    JOIN agent_revisions r ON r.definition_id=d.id AND r.id=d.current_revision_id
    WHERE NOT t.is_playground AND t.tenant_id=run_agent_snapshots.tenant_id AND t.id=run_agent_snapshots.thread_id
      AND d.id=run_agent_snapshots.definition_id AND d.status='published'
      AND (d.availability_mode='all_tenants' OR EXISTS (
        SELECT 1 FROM agent_definition_tenants scope
         WHERE scope.definition_id=d.id AND scope.tenant_id=t.tenant_id AND scope.available
      ))
      AND r.id=run_agent_snapshots.revision_id AND r.status='published'
      AND r.content_digest=run_agent_snapshots.revision_digest AND r.content=run_agent_snapshots.content
  ));

CREATE TABLE run_playground_mocks (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  origin text NOT NULL DEFAULT 'playground' CHECK (origin='playground'),
  mock_results jsonb NOT NULL CHECK (jsonb_typeof(mock_results)='object' AND octet_length(mock_results::text) BETWEEN 2 AND 65536),
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id,run_id), UNIQUE(tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,run_id,origin) REFERENCES runs(tenant_id,id,origin) ON DELETE CASCADE
);
ALTER TABLE run_playground_mocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_playground_mocks FORCE ROW LEVEL SECURITY;

DO $$
DECLARE runtime_role text := current_setting('app.runtime_role');
        migrator_role text := current_user;
BEGIN
  EXECUTE format('GRANT SELECT ON playground_acceptance_scope TO %I', runtime_role);
  EXECUTE format('GRANT SELECT,INSERT ON run_playground_mocks TO %I', runtime_role);
  EXECUTE format($policy$CREATE POLICY playground_read ON threads FOR SELECT TO %I USING (is_playground AND tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND EXISTS (SELECT 1 FROM playground_acceptance_scope))$policy$, runtime_role);
  EXECUTE format($policy$CREATE POLICY playground_insert ON threads FOR INSERT TO %I WITH CHECK (is_playground AND created_by_user_id=NULLIF(current_setting('app.user_id',true),'') AND tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND EXISTS (SELECT 1 FROM playground_acceptance_scope))$policy$, runtime_role);
  EXECUTE format($policy$CREATE POLICY playground_read ON runs FOR SELECT TO %I USING (origin='playground' AND tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND EXISTS (SELECT 1 FROM playground_acceptance_scope))$policy$, runtime_role);
  EXECUTE format($policy$CREATE POLICY playground_insert ON runs FOR INSERT TO %I WITH CHECK (origin='playground' AND tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND EXISTS (SELECT 1 FROM playground_acceptance_scope) AND EXISTS (SELECT 1 FROM threads t WHERE t.tenant_id=runs.tenant_id AND t.id=runs.thread_id AND t.is_playground AND t.created_by_user_id=NULLIF(current_setting('app.user_id',true),'')))$policy$, runtime_role);
  EXECUTE format($policy$CREATE POLICY playground_read ON agent_definitions FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM playground_acceptance_scope))$policy$, runtime_role);
  EXECUTE format($policy$CREATE POLICY playground_read ON agent_revisions FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM playground_acceptance_scope))$policy$, runtime_role);
  EXECUTE format($policy$CREATE POLICY playground_insert ON run_agent_snapshots FOR INSERT TO %I WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND EXISTS (SELECT 1 FROM playground_acceptance_scope) AND EXISTS (
    SELECT 1 FROM runs r JOIN threads t ON t.tenant_id=r.tenant_id AND t.id=r.thread_id
    JOIN agent_revisions v ON v.definition_id=t.agent_definition_id AND v.id=run_agent_snapshots.revision_id
    WHERE r.tenant_id=run_agent_snapshots.tenant_id AND r.thread_id=run_agent_snapshots.thread_id AND r.id=run_agent_snapshots.run_id
      AND r.origin='playground' AND t.is_playground AND t.agent_definition_id=run_agent_snapshots.definition_id
      AND v.status IN ('draft','published') AND v.content_digest=run_agent_snapshots.revision_digest AND v.content=run_agent_snapshots.content))$policy$, runtime_role);
  EXECUTE format($policy$CREATE POLICY playground_read ON run_playground_mocks FOR SELECT TO %I USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND (NULLIF(current_setting('app.user_id',true),'') IS NULL OR EXISTS (SELECT 1 FROM playground_acceptance_scope)))$policy$, runtime_role);
  EXECUTE format($policy$CREATE POLICY playground_insert ON run_playground_mocks FOR INSERT TO %I WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND EXISTS (SELECT 1 FROM playground_acceptance_scope))$policy$, runtime_role);
  EXECUTE format($policy$CREATE POLICY playground_directory_read ON run_agent_snapshots FOR SELECT TO %I USING (EXISTS (
    SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'') AND actor.status='active'))$policy$, migrator_role);
END $$;

CREATE OR REPLACE VIEW admin_run_directory WITH (security_barrier=true) AS
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
  FROM thread_continuity_metric_observations metric
  WHERE metric.tenant_id=run.tenant_id AND metric.run_id=run.id
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

-- 后台诊断目录保留测试流量，业务计数和 Token 汇总不纳入 Playground。队列和资源健康仍反映实际负载。
CREATE OR REPLACE VIEW admin_runtime_statistics WITH (security_barrier=true) AS
WITH business_runs AS NOT MATERIALIZED (SELECT * FROM runs WHERE origin<>'playground'),
business_threads AS NOT MATERIALIZED (SELECT * FROM threads t WHERE NOT t.is_playground),
business_metrics AS NOT MATERIALIZED (
  SELECT metric.* FROM thread_continuity_metric_observations metric
   WHERE NOT EXISTS (SELECT 1 FROM runs pg WHERE pg.tenant_id=metric.tenant_id AND pg.id=metric.run_id AND pg.origin='playground')
)
SELECT
  clock_timestamp() AS generated_at,
  (SELECT count(*)::bigint FROM business_runs) AS runs_total,
  (SELECT count(*)::bigint FROM business_runs WHERE status='queued') AS runs_queued,
  (SELECT count(*)::bigint FROM business_runs WHERE status='running') AS runs_running,
  (SELECT count(*)::bigint FROM business_runs WHERE status='succeeded' AND updated_at>=clock_timestamp()-interval '24 hours') AS runs_succeeded_24h,
  (SELECT count(*)::bigint FROM business_runs WHERE status='failed' AND updated_at>=clock_timestamp()-interval '24 hours') AS runs_failed_24h,
  (SELECT count(*)::bigint FROM business_runs WHERE status='cancelled' AND updated_at>=clock_timestamp()-interval '24 hours') AS runs_cancelled_24h,
  (SELECT count(*)::bigint FROM run_dispatch_outbox WHERE state='ready') AS dispatch_pending,
  (SELECT count(*)::bigint FROM run_dispatch_outbox WHERE state='claimed') AS dispatch_claimed,
  (SELECT count(*)::bigint FROM sandbox_registry WHERE state='ready') AS sandboxes_active,
  (SELECT count(*)::bigint FROM sandbox_registry WHERE state='paused') AS sandboxes_paused,
  (SELECT count(*)::bigint FROM cleanup_outbox WHERE state IN ('pending','started','unknown')) AS sandbox_cleanup_pending,
  (SELECT count(*)::bigint FROM memory_ingestion_outbox WHERE state IN ('pending','claimed','submitted')) AS memory_pending,
  (SELECT count(*)::bigint FROM memory_ingestion_outbox WHERE state='failed') AS memory_failed,
  (SELECT count(*)::bigint FROM scheduled_tasks WHERE status='active') AS automations_active,
  (SELECT count(*)::bigint FROM scheduled_task_occurrences WHERE state='failed' AND updated_at>=clock_timestamp()-interval '24 hours') AS automation_failed_occurrences_24h,
  (SELECT count(*)::bigint FROM skill_versions WHERE status='available') AS skills_published,
  (SELECT count(*)::bigint FROM tenant_skill_installations WHERE status IN ('enabled','disabled')) AS skills_installed,
  (SELECT count(*)::bigint FROM user_accounts) AS users_total,
  (SELECT count(*)::bigint FROM user_accounts WHERE created_at>=clock_timestamp()-interval '24 hours') AS users_registered_24h,
  (SELECT count(DISTINCT created_by_user_id)::bigint FROM business_threads WHERE updated_at>=clock_timestamp()-interval '7 days') AS users_active_7d,
  (SELECT count(*)::bigint FROM user_accounts WHERE status='disabled') AS users_disabled,
  (SELECT count(*)::bigint FROM business_threads) AS conversations_total,
  (SELECT count(*)::bigint FROM business_threads WHERE created_at>=clock_timestamp()-interval '24 hours') AS conversations_created_24h,
  (SELECT count(*)::bigint FROM business_threads WHERE updated_at>=clock_timestamp()-interval '24 hours') AS conversations_active_24h,
  (SELECT count(*)::bigint FROM business_threads WHERE status='archived') AS conversations_archived,
  (SELECT COALESCE(sum(value),0)::text FROM business_metrics
    WHERE metric_name='model_input_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_input_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM business_metrics
    WHERE metric_name='model_output_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_output_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM business_metrics
    WHERE metric_name='model_cache_read_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_cache_read_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM business_metrics
    WHERE metric_name='model_generation_duration_ms' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_generation_duration_ms_24h
WHERE EXISTS (
  SELECT 1 FROM platform_control_operators actor
   WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
     AND actor.status='active'
);

CREATE OR REPLACE VIEW admin_user_directory WITH (security_barrier=true) AS
SELECT
  account.user_id,
  account.email,
  account.display_name,
  account.status,
  account.created_at,
  GREATEST(conversation.last_active_at,session.last_active_at) AS last_active_at,
  COALESCE(session.active_sessions,0)::bigint AS active_sessions,
  COALESCE(conversation.conversation_count,0)::bigint AS conversation_count,
  COALESCE(conversation.run_count,0)::bigint AS run_count
FROM user_accounts account
LEFT JOIN LATERAL (
  SELECT
    max(thread.updated_at) AS last_active_at,
    count(DISTINCT (thread.tenant_id,thread.id))::bigint AS conversation_count,
    count(DISTINCT (run.tenant_id,run.id))::bigint AS run_count
  FROM threads thread
  LEFT JOIN runs run ON run.tenant_id=thread.tenant_id AND run.thread_id=thread.id
  WHERE thread.created_by_user_id=account.user_id
    AND NOT thread.is_playground
) conversation ON true
LEFT JOIN LATERAL (
  SELECT
    max(candidate.created_at) AS last_active_at,
    count(*) FILTER (WHERE candidate.expires_at>clock_timestamp())::bigint AS active_sessions
  FROM user_sessions candidate
  WHERE candidate.user_id=account.user_id
) session ON true
WHERE EXISTS (
  SELECT 1 FROM platform_control_operators actor
   WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
     AND actor.status='active' AND actor.role='admin'
);

-- 轨迹投影只允许暴露 Mock 执行标记，不投影 Mock 结果正文。
CREATE OR REPLACE VIEW admin_run_event_outline WITH (security_barrier=true) AS
SELECT
  attempt.tenant_id,
  attempt.run_id,
  event.attempt_id,
  event.sequence,
  event.kind,
  event.occurred_at,
  CASE event.kind
    WHEN 'attempt_state_changed' THEN jsonb_strip_nulls(jsonb_build_object(
      'status',event.payload->'status',
      'stage',event.payload->'stage',
      'code',event.payload->'code'
    ))
    WHEN 'run_waiting' THEN jsonb_build_object(
      'question','',
      'checkpointId',event.payload->'checkpointId'
    )
    WHEN 'sandbox_recovery_decided' THEN jsonb_strip_nulls(jsonb_build_object(
      'decision',event.payload->'decision',
      'checkpointId',event.payload->'checkpointId',
      'registryId',event.payload->'registryId',
      'generation',event.payload->'generation',
      'reason',event.payload->'reason'
    ))
    WHEN 'artifact_correction_requested' THEN jsonb_build_object(
      'round',event.payload->'round',
      'maxRounds',event.payload->'maxRounds',
      'code',event.payload->'code',
      'feedback',''
    )
    WHEN 'agent_event' THEN CASE event.payload->>'type'
      WHEN 'thinking.delta' THEN jsonb_build_object('type','thinking.delta','delta','')
      WHEN 'message.delta' THEN jsonb_build_object('type','message.delta','delta','')
      WHEN 'message.completed' THEN jsonb_build_object(
        'type','message.completed','stopReason',event.payload->'stopReason'
      )
      WHEN 'tool.started' THEN jsonb_strip_nulls(jsonb_build_object(
        'type','tool.started',
        'callId',event.payload->'callId',
        'name',event.payload->'name',
        'parentCallId',event.payload->'parentCallId',
        'presentation',CASE WHEN jsonb_typeof(event.payload->'presentation')='object'
          THEN jsonb_build_object('action',event.payload->'presentation'->'action') END
      ))
      WHEN 'tool.updated' THEN jsonb_build_object(
        'type','tool.updated','callId',event.payload->'callId','name',event.payload->'name'
      )
      WHEN 'tool.completed' THEN jsonb_strip_nulls(jsonb_build_object(
        'type','tool.completed',
        'callId',event.payload->'callId',
        'name',event.payload->'name',
        'isError',event.payload->'isError',
        'executionMode',CASE WHEN event.payload->>'executionMode'='playground_mock' THEN 'playground_mock' END,
        'failure',CASE WHEN jsonb_typeof(event.payload->'failure')='object'
          THEN jsonb_build_object('code',event.payload->'failure'->'code','message','') END
      ))
      WHEN 'todo.updated' THEN jsonb_build_object(
        'type','todo.updated',
        'snapshot',jsonb_build_object(
          'schemaVersion',event.payload->'snapshot'->'schemaVersion',
          'version',event.payload->'snapshot'->'version',
          'todos','[]'::jsonb
        )
      )
      WHEN 'queue.updated' THEN jsonb_build_object(
        'type','queue.updated',
        'steering',(
          SELECT COALESCE(jsonb_agg(to_jsonb(''::text)),'[]'::jsonb)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(event.payload->'steering')='array'
              THEN event.payload->'steering' ELSE '[]'::jsonb END)
        ),
        'followUp',(
          SELECT COALESCE(jsonb_agg(to_jsonb(''::text)),'[]'::jsonb)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(event.payload->'followUp')='array'
              THEN event.payload->'followUp' ELSE '[]'::jsonb END)
        )
      )
      WHEN 'runtime.notice' THEN jsonb_build_object(
        'type','runtime.notice',
        'level',event.payload->'level',
        'code',event.payload->'code',
        'message','',
        'source',event.payload->'source'
      )
      WHEN 'error' THEN jsonb_strip_nulls(jsonb_build_object(
        'type','error',
        'code',event.payload->'code',
        'message','',
        'action',event.payload->'action'
      ))
      WHEN 'finalization.started' THEN jsonb_build_object(
        'type','finalization.started','callId',event.payload->'callId'
      )
      WHEN 'finalization.cancelled' THEN jsonb_build_object(
        'type','finalization.cancelled',
        'callId',event.payload->'callId',
        'reason',event.payload->'reason'
      )
      WHEN 'final_answer.committed' THEN jsonb_build_object(
        'type','final_answer.committed','callId',event.payload->'callId'
      )
      WHEN 'compaction.forbidden' THEN jsonb_build_object(
        'type','compaction.forbidden','source',event.payload->'source'
      )
      ELSE jsonb_build_object('type',event.payload->'type')
    END
    ELSE '{}'::jsonb
  END AS payload
FROM run_events event
JOIN execution_attempts attempt
  ON attempt.tenant_id=event.tenant_id AND attempt.attempt_id=event.attempt_id
WHERE EXISTS (
  SELECT 1 FROM platform_control_operators actor
   WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
     AND actor.status='active'
);

-- Webhook Outbox 保留来源快照，避免领取与发送许可边界依赖可变 Run 可见性。
ALTER TABLE webhook_outbox
  ADD COLUMN source_run_id text,
  ADD COLUMN source_run_origin text NOT NULL DEFAULT 'unknown'
    CHECK (source_run_origin IN ('normal','playground','evaluation','api','unknown'));

-- 历史 Outbox 以既有事件中的 Run ID 与持久化来源回填；找不到事实的旧事件保持 unknown 并失败关闭。
UPDATE webhook_outbox outbox
   SET source_run_id=source_run.id,
       source_run_origin=source_run.origin
  FROM runs source_run
 WHERE source_run.tenant_id=outbox.tenant_id
   AND source_run.id=outbox.payload->'data'->>'runId';

ALTER TABLE webhook_outbox
  ADD CONSTRAINT webhook_outbox_source_run_shape
    CHECK ((source_run_origin='unknown')=(source_run_id IS NULL)),
  ADD CONSTRAINT webhook_outbox_source_run_fk
    FOREIGN KEY (tenant_id,source_run_id,source_run_origin)
    REFERENCES runs(tenant_id,id,origin) ON DELETE RESTRICT;
