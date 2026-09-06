DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM run_compaction_settings_snapshots) THEN
    RAISE EXCEPTION 'Run 上下文压缩快照非空，拒绝破坏性回滚';
  END IF;
END $$;

DROP TABLE run_compaction_settings_snapshots;
