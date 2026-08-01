DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM thread_context_legacy_anchors)
     OR EXISTS (SELECT 1 FROM thread_context_legacy_backfill_items)
     OR EXISTS (SELECT 1 FROM thread_continuity_profiles)
     OR EXISTS (SELECT 1 FROM thread_continuity_metric_observations) THEN
    RAISE EXCEPTION '阶段 6 continuity facts 已存在，拒绝破坏性回退';
  END IF;
END $$;

DROP TABLE thread_continuity_metric_observations;
DROP TABLE thread_continuity_profiles;
DROP TABLE thread_context_legacy_backfill_items;
DROP TABLE thread_context_legacy_anchors;
DROP TABLE tenant_thread_continuity_policies;

ALTER TABLE thread_context_entries
  DROP CONSTRAINT thread_context_entries_kind_check,
  ADD CONSTRAINT thread_context_entries_kind_check CHECK (kind IN (
    'run_started','user_message','assistant_message','tool_call','tool_result',
    'workspace_committed','workspace_unchanged','run_terminal','compaction_checkpoint'
  ));
