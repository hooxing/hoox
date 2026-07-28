-- 迁移角色也受 FORCE RLS 限制；先在本事务内取消 FORCE，否则跨租户安全检查会假空。
-- 拒绝时整个迁移事务回滚，FORCE RLS 也一并恢复。
ALTER TABLE waiting_recovery_checkpoints NO FORCE ROW LEVEL SECURITY;
ALTER TABLE waiting_recovery_effect_outbox NO FORCE ROW LEVEL SECURITY;
ALTER TABLE run_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_entries NO FORCE ROW LEVEL SECURITY;

-- 任何 checkpoint/outbox 都代表已持久化恢复状态；即使尚无公开事实也禁止破坏性回退。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM waiting_recovery_checkpoints)
     OR EXISTS (SELECT 1 FROM waiting_recovery_effect_outbox)
     OR EXISTS (SELECT 1 FROM run_events WHERE kind='sandbox_recovery_decided')
     OR EXISTS (SELECT 1 FROM runtime_rollout_entries WHERE kind='sandbox_recovery') THEN
    RAISE EXCEPTION '0012 down refused: waiting recovery state or append-only facts exist';
  END IF;
END $$;

-- 空库继续回退时 waiting 表随即删除；共享事实表必须恢复 FORCE RLS。
ALTER TABLE run_events FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_entries FORCE ROW LEVEL SECURITY;

DROP TABLE waiting_recovery_effect_outbox;
DROP TABLE waiting_recovery_checkpoints;

DROP INDEX run_events_waiting_recovery_checkpoint_idx;
DROP INDEX runtime_rollout_waiting_recovery_checkpoint_idx;
ALTER TABLE run_events DROP CONSTRAINT run_events_waiting_recovery_payload_check;
ALTER TABLE run_claims DROP CONSTRAINT run_claims_attempt_generation_unique;
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
