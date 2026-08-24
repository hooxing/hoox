CREATE INDEX model_usage_metrics_admin_query_idx
  ON thread_continuity_metric_observations(metric_name,observed_at DESC)
  WHERE metric_name IN (
    'model_input_tokens','model_output_tokens','model_cache_read_tokens',
    'model_generation_duration_ms'
  );
