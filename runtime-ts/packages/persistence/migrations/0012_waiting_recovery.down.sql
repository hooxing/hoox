DROP TABLE waiting_recovery_effect_outbox;
DROP TABLE waiting_recovery_checkpoints;

DROP INDEX run_events_waiting_recovery_checkpoint_idx;
DROP INDEX runtime_rollout_waiting_recovery_checkpoint_idx;
ALTER TABLE run_events DROP CONSTRAINT run_events_waiting_recovery_payload_check;
-- 恢复事实属于只追加链，down 仅允许尚未写入事实的部署；存在数据时明确安全失败。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM run_events WHERE kind='sandbox_recovery_decided')
     OR EXISTS (SELECT 1 FROM runtime_rollout_entries WHERE kind='sandbox_recovery') THEN
    RAISE EXCEPTION '0012 down refused: waiting recovery append-only facts exist';
  END IF;
END $$;
ALTER TABLE sandbox_registry DROP CONSTRAINT sandbox_registry_generation_check;
ALTER TABLE sandbox_registry DROP COLUMN generation;

ALTER TABLE runtime_rollout_entries DROP CONSTRAINT runtime_rollout_entries_kind_check;
ALTER TABLE runtime_rollout_entries ADD CONSTRAINT runtime_rollout_entries_kind_check CHECK (
  kind IN ('user','assistant','tool_call','tool_result','waiting','terminal')
);
ALTER TABLE run_events DROP CONSTRAINT run_events_kind_check;
ALTER TABLE run_events ADD CONSTRAINT run_events_kind_check CHECK (
  kind IN ('agent_event','attempt_state_changed','run_waiting','artifact_correction_requested')
);
