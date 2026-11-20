-- 后台 Run 浏览器：结构视图、受审计正文视图与正文访问审计。
-- 视图由无 BYPASSRLS 的 Migrator 持有；Admin Control 只取得视图 SELECT 与审计表权限，
-- 不取得 runs、execution_attempts、run_events 或指标底表的任何权限。
DO $$
DECLARE
  control_role text := NULLIF(current_setting('app.admin_control_role', true), '');
BEGIN
  IF control_role IS NULL OR control_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.admin_control_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
END $$;

-- 正文访问审计不引用业务行：Run 数据的保留与清理不得被审计记录阻塞，审计也不得随之消失。
CREATE TABLE admin_run_content_access_audits (
  audit_id text PRIMARY KEY CHECK (audit_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'),
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL CHECK (octet_length(tenant_id) BETWEEN 1 AND 256),
  run_id text NOT NULL CHECK (octet_length(run_id) BETWEEN 1 AND 256),
  attempt_id text NOT NULL CHECK (octet_length(attempt_id) BETWEEN 1 AND 256),
  -- 正文视图只放行与本事务写入的审计匹配的读取，旧审计号不能在后续事务中复用。
  access_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admin_run_content_access_audits_run_idx
  ON admin_run_content_access_audits(tenant_id,run_id,created_at DESC);
CREATE INDEX admin_run_content_access_audits_created_idx
  ON admin_run_content_access_audits(created_at DESC,audit_id DESC);

ALTER TABLE admin_run_content_access_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_run_content_access_audits FORCE ROW LEVEL SECURITY;

-- Run 列表按创建时间跨 Tenant 倒序分页；按 Run 汇总模型用量。
CREATE INDEX runs_admin_created_idx ON runs(created_at DESC,tenant_id DESC,id DESC);
CREATE INDEX model_usage_metrics_admin_run_idx
  ON thread_continuity_metric_observations(tenant_id,run_id)
  WHERE run_id IS NOT NULL AND metric_name IN (
    'model_input_tokens','model_output_tokens','model_cache_read_tokens',
    'model_generation_duration_ms'
  );

DO $$
DECLARE
  migrator_role text := current_user;
  control_role text := current_setting('app.admin_control_role');
BEGIN
  EXECUTE format(
    'CREATE POLICY admin_run_content_access_audits_migrator_policy ON admin_run_content_access_audits FOR ALL TO %I USING (true) WITH CHECK (true)',
    migrator_role
  );
  -- 只有有效 admin 能写入或查看正文访问审计；写入必须以本人身份并绑定当前事务。
  EXECUTE format(
    'CREATE POLICY admin_run_content_access_audits_control_read_policy ON admin_run_content_access_audits FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY admin_run_content_access_audits_control_insert_policy ON admin_run_content_access_audits FOR INSERT TO %I WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND access_transaction=pg_current_xact_id() AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=actor_user_id AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
  -- 与既有 *_admin_projection_read 相同：Migrator 持有的视图只在有效控制面会话中看到底表行。
  EXECUTE format(
    'CREATE POLICY execution_attempts_admin_projection_read ON execution_attempts FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active''))',
    migrator_role
  );
  EXECUTE format(
    'CREATE POLICY run_events_admin_projection_read ON run_events FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active''))',
    migrator_role
  );
END $$;

-- Run 结构目录：只含状态、时间、Attempt 与计数，不含 Thread 标题、输入或模型正文。
-- AgentDefinition、Revision 与来源列在对应事实落库前固定为 NULL，按它们筛选不会命中任何 Run。
CREATE VIEW admin_run_directory WITH (security_barrier=true) AS
SELECT
  run.tenant_id,
  run.id AS run_id,
  run.thread_id,
  run.status,
  run.created_at,
  run.updated_at,
  NULL::text AS agent_definition_id,
  NULL::text AS agent_revision_id,
  NULL::text AS origin,
  COALESCE(attempts.attempt_count,0)::bigint AS attempt_count,
  COALESCE(attempts.items,'[]'::jsonb) AS attempts,
  latest.attempt_id AS latest_attempt_id,
  latest.status AS latest_attempt_status,
  latest.created_at AS latest_attempt_started_at,
  latest.finished_at AS latest_attempt_finished_at,
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
LEFT JOIN LATERAL (
  SELECT
    count(*)::bigint AS attempt_count,
    jsonb_agg(jsonb_build_object(
      'attemptId',attempt.attempt_id,
      'status',attempt.status,
      'stage',attempt.stage,
      'createdAt',attempt.created_at,
      'finishedAt',attempt.finished_at
    ) ORDER BY attempt.created_at,attempt.attempt_id) AS items
  FROM execution_attempts attempt
  WHERE attempt.tenant_id=run.tenant_id AND attempt.run_id=run.id
) attempts ON true
LEFT JOIN LATERAL (
  SELECT attempt.attempt_id,attempt.status,attempt.created_at,attempt.finished_at
  FROM execution_attempts attempt
  WHERE attempt.tenant_id=run.tenant_id AND attempt.run_id=run.id
  ORDER BY attempt.created_at DESC,attempt.attempt_id DESC
  LIMIT 1
) latest ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE metric.metric_name='model_output_tokens') AS model_calls,
    sum(metric.value) FILTER (WHERE metric.metric_name='model_input_tokens') AS input_tokens,
    sum(metric.value) FILTER (WHERE metric.metric_name='model_output_tokens') AS output_tokens,
    sum(metric.value) FILTER (WHERE metric.metric_name='model_cache_read_tokens') AS cache_read_tokens,
    sum(metric.value) FILTER (WHERE metric.metric_name='model_generation_duration_ms') AS generation_duration_ms
  FROM thread_continuity_metric_observations metric
  WHERE metric.tenant_id=run.tenant_id AND metric.run_id=run.id
    AND metric.metric_name IN (
      'model_input_tokens','model_output_tokens','model_cache_read_tokens',
      'model_generation_duration_ms'
    )
) usage ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) AS event_count,
    count(*) FILTER (
      WHERE event.kind='agent_event' AND event.payload->>'type'='tool.started'
    ) AS tool_calls,
    count(*) FILTER (
      WHERE event.kind='agent_event' AND event.payload->>'type'='tool.completed'
        AND event.payload->'isError'='true'::jsonb
    ) AS failed_tool_calls,
    count(*) FILTER (
      WHERE (event.kind='agent_event' AND event.payload->>'type' IN ('error','runtime.notice'))
        OR (event.kind='attempt_state_changed' AND (
          event.payload ? 'code'
          OR event.payload->>'status' IN ('failed','cancelled','abandoned','recovery_required')
        ))
        OR event.kind='artifact_correction_requested'
    ) AS error_count
  FROM run_events event
  WHERE event.tenant_id=run.tenant_id AND event.attempt_id=latest.attempt_id
) events ON true
WHERE EXISTS (
  SELECT 1 FROM platform_control_operators actor
   WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
     AND actor.status='active'
);

-- 事件结构视图：在数据库内把正文字段替换为空值，保留可投影为时间线的类型、标识、枚举与计数。
-- 新增事件字段默认不会出现在这里；需要暴露时必须先确认它不是用户或模型正文。
CREATE VIEW admin_run_event_outline WITH (security_barrier=true) AS
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

-- 正文视图：只有在同一事务中先以本人身份写入匹配该 Attempt 的正文访问审计、并把审计号
-- 写入事务级 app.run_content_audit_id 的有效 admin 才能读到行；其他情况一律为空。
CREATE VIEW admin_run_event_content WITH (security_barrier=true) AS
SELECT
  attempt.tenant_id,
  attempt.run_id,
  event.attempt_id,
  event.sequence,
  event.kind,
  event.occurred_at,
  event.payload
FROM run_events event
JOIN execution_attempts attempt
  ON attempt.tenant_id=event.tenant_id AND attempt.attempt_id=event.attempt_id
WHERE EXISTS (
  SELECT 1
    FROM admin_run_content_access_audits access
    JOIN platform_control_operators actor ON actor.user_id=access.actor_user_id
   WHERE access.audit_id=NULLIF(current_setting('app.run_content_audit_id',true),'')
     AND access.actor_user_id=NULLIF(current_setting('app.user_id',true),'')
     AND access.access_transaction=pg_current_xact_id_if_assigned()
     AND access.tenant_id=attempt.tenant_id
     AND access.run_id=attempt.run_id
     AND access.attempt_id=event.attempt_id
     AND actor.status='active'
     AND actor.role='admin'
);
