DROP VIEW IF EXISTS admin_agent_metrics_hourly;
ALTER TABLE thread_continuity_metric_observations NO FORCE ROW LEVEL SECURITY;
DELETE FROM thread_continuity_metric_observations WHERE metric_name='model_generation_count';
ALTER TABLE thread_continuity_metric_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_continuity_metric_observations
  DROP CONSTRAINT thread_continuity_metric_observations_metric_name_check;
ALTER TABLE thread_continuity_metric_observations
  ADD CONSTRAINT thread_continuity_metric_observations_metric_name_check CHECK (metric_name IN (
    'thread_input_total','steer_apply_latency_ms','steer_to_follow_up_total',
    'follow_up_queue_depth','follow_up_wait_ms','thread_writer_conflict_total',
    'context_rebuild_latency_ms','context_visible_tokens','context_tokens_before_compaction',
    'context_tokens_after_compaction','compaction_latency_ms','compaction_total',
    'context_recovery_digest_mismatch_total','context_window_number',
    'sandbox_handoff_total','sandbox_resume_total','sandbox_resume_latency_ms',
    'sandbox_create_latency_ms','workspace_materialize_latency_ms','sandbox_paused_seconds',
    'sandbox_snapshot_bytes','sandbox_cold_rebuild_total','sandbox_unknown_total',
    'sandbox_revision_mismatch_total','sandbox_idle_running_seconds',
    'model_input_tokens','model_output_tokens','model_cache_read_tokens',
    'model_generation_duration_ms'
  ));
DROP POLICY IF EXISTS runs_agent_metrics_read ON runs;
DROP POLICY IF EXISTS threads_agent_metrics_read ON threads;
DROP POLICY IF EXISTS model_metrics_agent_metrics_read ON thread_continuity_metric_observations;
DROP POLICY IF EXISTS run_agent_snapshots_agent_metrics_read ON run_agent_snapshots;
DROP POLICY IF EXISTS pricing_snapshots_agent_metrics_read ON run_model_pricing_snapshots;
DROP TABLE IF EXISTS run_model_pricing_snapshots;
DROP INDEX IF EXISTS run_metrics_observation_run_idx;
DROP INDEX IF EXISTS runs_metrics_created_idx;
