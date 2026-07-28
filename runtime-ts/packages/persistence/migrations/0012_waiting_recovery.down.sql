DROP TABLE waiting_recovery_effect_outbox;
DROP TABLE waiting_recovery_checkpoints;

DROP INDEX run_events_waiting_recovery_checkpoint_idx;
DROP INDEX runtime_rollout_waiting_recovery_checkpoint_idx;
ALTER TABLE run_events DROP CONSTRAINT run_events_waiting_recovery_payload_check;
-- down 仅在显式 allow-destructive 下执行；若后续 Rollout 已引用恢复事实，FK 会安全阻止降级。
DELETE FROM run_events WHERE kind='sandbox_recovery_decided';
DELETE FROM runtime_rollout_entries WHERE kind='sandbox_recovery';

ALTER TABLE runtime_rollout_entries DROP CONSTRAINT runtime_rollout_entries_kind_check;
ALTER TABLE runtime_rollout_entries ADD CONSTRAINT runtime_rollout_entries_kind_check CHECK (
  kind IN ('user','assistant','tool_call','tool_result','waiting','terminal')
);
ALTER TABLE run_events DROP CONSTRAINT run_events_kind_check;
ALTER TABLE run_events ADD CONSTRAINT run_events_kind_check CHECK (
  kind IN ('agent_event','attempt_state_changed','run_waiting','artifact_correction_requested')
);
