DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM thread_context_entries LIMIT 1) THEN
    RAISE EXCEPTION 'thread_context_entries 非空，拒绝破坏性回滚';
  END IF;
END $$;

DROP TABLE thread_context_history_audits;
