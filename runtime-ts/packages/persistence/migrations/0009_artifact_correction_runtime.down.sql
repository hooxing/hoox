-- 回退会移除仅由 0009 引入的修正事件与继续许可；migrateDown 本身只允许显式开发/测试破坏性操作。
ALTER TABLE external_effect_permits NO FORCE ROW LEVEL SECURITY;
ALTER TABLE run_events NO FORCE ROW LEVEL SECURITY;
DELETE FROM external_effect_permits WHERE effect = 'model_continue';
DELETE FROM run_events WHERE kind = 'artifact_correction_requested';
DROP INDEX run_events_artifact_correction_round_idx;
ALTER TABLE run_events DROP CONSTRAINT run_events_artifact_correction_payload_check;

ALTER TABLE external_effect_permits
  DROP CONSTRAINT external_effect_permits_effect_check,
  ADD CONSTRAINT external_effect_permits_effect_check CHECK (
    effect IN ('model_start', 'tool_execution')
  );

ALTER TABLE run_events
  DROP CONSTRAINT run_events_kind_check,
  ADD CONSTRAINT run_events_kind_check CHECK (
    kind IN ('agent_event', 'attempt_state_changed', 'run_waiting')
  );

ALTER TABLE external_effect_permits FORCE ROW LEVEL SECURITY;
ALTER TABLE run_events FORCE ROW LEVEL SECURITY;
