DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM runtime_agent_threads WHERE kind = 'subagent') THEN
    RAISE EXCEPTION '存在 SubAgent 运行事实，不能无损回退 0034';
  END IF;
END $$;

ALTER TABLE external_effect_permits
  DROP CONSTRAINT external_effect_permits_effect_check,
  ADD CONSTRAINT external_effect_permits_effect_check CHECK (
    effect IN ('model_start', 'model_continue', 'tool_execution')
  );

ALTER TABLE runtime_rollout_streams
  DROP CONSTRAINT runtime_rollout_streams_agent_thread_fk,
  DROP CONSTRAINT runtime_rollout_streams_agent_kind_check,
  ADD CONSTRAINT runtime_rollout_streams_agent_kind_check CHECK (agent_kind = 'root'),
  ADD CONSTRAINT runtime_rollout_streams_tenant_id_attempt_id_key UNIQUE (tenant_id, attempt_id);

DROP TABLE runtime_agent_commands;
DROP TABLE runtime_agent_mailbox_messages;
DROP TABLE runtime_agent_turns;
DROP TABLE runtime_agent_threads;
