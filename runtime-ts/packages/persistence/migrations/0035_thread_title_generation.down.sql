DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM thread_history_directories WHERE naming_state = 'pending'
  ) THEN
    RAISE EXCEPTION 'thread title generation down requires no pending history directories';
  END IF;
END
$$;

DROP TABLE IF EXISTS thread_title_generation_outbox;

ALTER TABLE thread_history_directories
  DROP CONSTRAINT thread_history_directories_naming_state_check,
  ADD CONSTRAINT thread_history_directories_naming_state_check
    CHECK (naming_state IN ('ready', 'fallback'));
