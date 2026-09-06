-- 不把跳过事实伪装成 Provider 成功或失败；存在新终态时拒绝回退。
ALTER TABLE memory_ingestion_outbox NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM memory_ingestion_outbox WHERE state = 'skipped') THEN
    RAISE EXCEPTION 'memory ingestion skipped down requires no skipped rows';
  END IF;
END
$$;

ALTER TABLE memory_ingestion_outbox
  DROP CONSTRAINT memory_ingestion_outbox_state_check,
  DROP CONSTRAINT memory_ingestion_outbox_provider_shape_check,
  DROP CONSTRAINT memory_ingestion_outbox_completion_shape_check,
  ADD CONSTRAINT memory_ingestion_outbox_state_check CHECK (
    state IN ('pending', 'claimed', 'submitted', 'succeeded', 'failed')
  ),
  ADD CONSTRAINT memory_ingestion_outbox_provider_shape_check CHECK (
    (state = 'pending' AND provider_event_id IS NULL AND submitted_at IS NULL)
    OR (state = 'claimed')
    OR (state IN ('submitted', 'succeeded') AND provider_event_id IS NOT NULL
      AND submitted_at IS NOT NULL)
    OR (state = 'failed')
  ),
  ADD CONSTRAINT memory_ingestion_outbox_completion_shape_check CHECK (
    (state IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)
  );
ALTER TABLE memory_ingestion_outbox FORCE ROW LEVEL SECURITY;
