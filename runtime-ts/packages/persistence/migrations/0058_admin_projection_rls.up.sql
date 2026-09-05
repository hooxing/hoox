-- 聚合视图仍由无 BYPASSRLS 的 Migrator 持有；不增加控制角色的底表权限。
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'runs','threads','run_dispatch_outbox','sandbox_registry','cleanup_outbox',
    'memory_ingestion_outbox','scheduled_tasks','scheduled_task_occurrences',
    'tenant_skill_installations','user_accounts','thread_continuity_metric_observations','user_sessions'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' %s))',
      table_name || '_admin_projection_read', table_name, current_user,
      CASE WHEN table_name='user_sessions' THEN 'AND actor.role=''admin''' ELSE '' END
    );
  END LOOP;
END $$;
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
  (SELECT count(*)::bigint FROM threads WHERE status='archived') AS conversations_archived,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_input_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_input_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_output_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_output_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_cache_read_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_cache_read_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_generation_duration_ms' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_generation_duration_ms_24h
WHERE EXISTS (
  SELECT 1 FROM platform_control_operators actor
   WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
     AND actor.status='active'
);
