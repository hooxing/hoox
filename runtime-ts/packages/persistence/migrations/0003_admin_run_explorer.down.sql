-- 回退会删除正文访问审计；只允许在 development/test 的破坏性回退中执行。
DROP VIEW admin_run_event_content;
DROP VIEW admin_run_event_outline;
DROP VIEW admin_run_directory;
DROP POLICY run_events_admin_projection_read ON run_events;
DROP POLICY execution_attempts_admin_projection_read ON execution_attempts;
DROP INDEX model_usage_metrics_admin_run_idx;
DROP INDEX runs_admin_created_idx;
DROP TABLE admin_run_content_access_audits;
