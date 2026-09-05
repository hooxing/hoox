DROP POLICY runs_admin_projection_read ON runs;
DROP POLICY threads_admin_projection_read ON threads;
DROP POLICY run_dispatch_outbox_admin_projection_read ON run_dispatch_outbox;
DROP POLICY sandbox_registry_admin_projection_read ON sandbox_registry;
DROP POLICY cleanup_outbox_admin_projection_read ON cleanup_outbox;
DROP POLICY memory_ingestion_outbox_admin_projection_read ON memory_ingestion_outbox;
DROP POLICY scheduled_tasks_admin_projection_read ON scheduled_tasks;
DROP POLICY scheduled_task_occurrences_admin_projection_read ON scheduled_task_occurrences;
DROP POLICY tenant_skill_installations_admin_projection_read ON tenant_skill_installations;
DROP POLICY user_accounts_admin_projection_read ON user_accounts;
DROP POLICY thread_continuity_metric_observations_admin_projection_read ON thread_continuity_metric_observations;
DROP POLICY user_sessions_admin_projection_read ON user_sessions;

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
    WHERE metric_name='model_generation_duration_ms' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_generation_duration_ms_24h;
