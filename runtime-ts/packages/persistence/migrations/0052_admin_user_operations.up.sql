-- ADR-20260821004057：后台用户治理与对话统计只经受限投影和审计状态变更暴露。
DO $$
DECLARE
  control_role text := NULLIF(current_setting('app.admin_control_role', true), '');
BEGIN
  IF control_role IS NULL OR control_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.admin_control_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
END $$;

ALTER TABLE user_accounts
  ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','disabled'));

CREATE TABLE admin_user_account_audits (
  audit_id text PRIMARY KEY CHECK (audit_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'),
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  target_user_id text NOT NULL REFERENCES user_accounts(user_id) ON DELETE RESTRICT,
  previous_status text NOT NULL CHECK (previous_status IN ('active','disabled')),
  status text NOT NULL CHECK (status IN ('active','disabled') AND status <> previous_status),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admin_user_account_audits_created_idx
  ON admin_user_account_audits(created_at DESC,audit_id DESC);

ALTER TABLE admin_user_account_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_user_account_audits FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  migrator_role text := current_user;
  control_role text := current_setting('app.admin_control_role');
BEGIN
  EXECUTE format(
    'CREATE POLICY admin_user_account_audits_migrator_policy ON admin_user_account_audits FOR ALL TO %I USING (true) WITH CHECK (true)',
    migrator_role
  );
  EXECUTE format(
    'CREATE POLICY admin_user_account_audits_control_policy ON admin_user_account_audits FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=actor_user_id AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY user_accounts_admin_control_update_policy ON user_accounts FOR UPDATE TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY user_sessions_admin_control_delete_policy ON user_sessions FOR DELETE TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
END $$;

-- 目录只向管理员会话返回账号资料；密码材料和 Session 摘要不会进入投影。
CREATE VIEW admin_user_directory WITH (security_barrier=true) AS
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

CREATE OR REPLACE VIEW admin_runtime_statistics WITH (security_barrier=true) AS
SELECT
  clock_timestamp() AS generated_at,
  (SELECT count(*)::bigint FROM runs) AS runs_total,
  (SELECT count(*)::bigint FROM runs WHERE status='queued') AS runs_queued,
  (SELECT count(*)::bigint FROM runs WHERE status='running') AS runs_running,
  (SELECT count(*)::bigint FROM runs WHERE status='succeeded' AND updated_at>=clock_timestamp()-interval '24 hours') AS runs_succeeded_24h,
  (SELECT count(*)::bigint FROM runs WHERE status='failed' AND updated_at>=clock_timestamp()-interval '24 hours') AS runs_failed_24h,
  (SELECT count(*)::bigint FROM runs WHERE status='cancelled' AND updated_at>=clock_timestamp()-interval '24 hours') AS runs_cancelled_24h,
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
  (SELECT count(DISTINCT created_by_user_id)::bigint FROM threads WHERE updated_at>=clock_timestamp()-interval '7 days') AS users_active_7d,
  (SELECT count(*)::bigint FROM user_accounts WHERE status='disabled') AS users_disabled,
  (SELECT count(*)::bigint FROM threads) AS conversations_total,
  (SELECT count(*)::bigint FROM threads WHERE created_at>=clock_timestamp()-interval '24 hours') AS conversations_created_24h,
  (SELECT count(*)::bigint FROM threads WHERE updated_at>=clock_timestamp()-interval '24 hours') AS conversations_active_24h,
  (SELECT count(*)::bigint FROM threads WHERE status='archived') AS conversations_archived;
