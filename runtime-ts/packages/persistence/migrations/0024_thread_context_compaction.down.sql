DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM thread_context_compaction_checkpoints LIMIT 1)
     OR EXISTS (SELECT 1 FROM thread_context_compaction_replacement_items LIMIT 1) THEN
    RAISE EXCEPTION 'Thread compaction checkpoint 非空，拒绝破坏性回滚';
  END IF;
END $$;

ALTER TABLE thread_context_streams
  DROP CONSTRAINT thread_context_stream_current_checkpoint_fk,
  DROP CONSTRAINT thread_context_stream_checkpoint_shape_check,
  DROP COLUMN current_compatibility_digest,
  DROP COLUMN current_checkpoint_id,
  DROP COLUMN current_window_number;

DROP TABLE thread_context_compaction_replacement_items;
DROP TABLE thread_context_compaction_checkpoints;

ALTER TABLE thread_context_entries
  DROP CONSTRAINT thread_context_entries_kind_check,
  ADD CONSTRAINT thread_context_entries_kind_check CHECK (kind IN (
    'run_started','user_message','assistant_message','tool_call','tool_result',
    'workspace_committed','workspace_unchanged','run_terminal'
  ));
