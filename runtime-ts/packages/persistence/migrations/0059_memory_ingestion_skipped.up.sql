-- 关闭记忆的本地消费使用独立终态；Provider 成功仍必须有真实提交凭据。
ALTER TABLE memory_ingestion_outbox
  DROP CONSTRAINT memory_ingestion_outbox_state_check,
  DROP CONSTRAINT memory_ingestion_outbox_provider_shape_check,
  DROP CONSTRAINT memory_ingestion_outbox_completion_shape_check,
  ADD CONSTRAINT memory_ingestion_outbox_state_check CHECK (
    state IN ('pending', 'claimed', 'submitted', 'succeeded', 'failed', 'skipped')
  ),
  ADD CONSTRAINT memory_ingestion_outbox_provider_shape_check CHECK (
    (state = 'pending' AND provider_event_id IS NULL AND submitted_at IS NULL)
    OR (state = 'claimed')
    OR (state IN ('submitted', 'succeeded') AND provider_event_id IS NOT NULL
      AND submitted_at IS NOT NULL)
    OR (state = 'failed')
    OR (state = 'skipped' AND (
      (provider_event_id IS NULL AND submitted_at IS NULL)
      OR (provider_event_id IS NOT NULL AND submitted_at IS NOT NULL)
    ))
  ),
  ADD CONSTRAINT memory_ingestion_outbox_completion_shape_check CHECK (
    (state IN ('succeeded', 'failed', 'skipped')) = (completed_at IS NOT NULL)
  );
