DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM thread_context_entries LIMIT 1) THEN
    RAISE EXCEPTION 'thread_context_entries 非空，拒绝破坏性回滚';
  END IF;
END $$;

DROP TABLE thread_context_append_commands;
DROP TABLE thread_context_entries;
DROP TABLE thread_context_streams;
ALTER TABLE execution_attempts DROP CONSTRAINT execution_attempts_context_scope_unique;
