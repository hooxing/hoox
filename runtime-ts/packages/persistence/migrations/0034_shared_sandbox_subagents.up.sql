CREATE TABLE runtime_agent_threads (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  parent_agent_thread_id text,
  canonical_path text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('root', 'subagent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'failed')),
  task text NOT NULL DEFAULT '',
  enabled_tools jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(enabled_tools) = 'array'),
  fork_turns text NOT NULL DEFAULT 'none' CHECK (
    fork_turns = 'none' OR fork_turns = 'all' OR fork_turns ~ '^[1-9][0-9]{0,5}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id),
  UNIQUE (tenant_id, attempt_id, canonical_path),
  FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES execution_attempts(tenant_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, parent_agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_agent_thread_shape_check CHECK (
    octet_length(agent_thread_id) BETWEEN 1 AND 200
    AND octet_length(canonical_path) BETWEEN 1 AND 200
    AND octet_length(task) <= 32768
    AND ((kind = 'root' AND parent_agent_thread_id IS NULL) OR (kind = 'subagent' AND parent_agent_thread_id IS NOT NULL))
  )
);

INSERT INTO runtime_agent_threads(
  tenant_id, thread_id, run_id, attempt_id, agent_thread_id, canonical_path, kind, status
)
SELECT tenant_id, thread_id, run_id, attempt_id, agent_thread_id, '/root', 'root', 'open'
  FROM runtime_rollout_streams
ON CONFLICT DO NOTHING;

CREATE TABLE runtime_agent_turns (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  agent_turn_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 1000000),
  trigger text NOT NULL CHECK (trigger IN ('spawn', 'follow_up')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'interrupted', 'failed')),
  prompt_text text NOT NULL CHECK (octet_length(prompt_text) BETWEEN 1 AND 32768),
  final_answer text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id, agent_turn_id),
  UNIQUE (tenant_id, attempt_id, agent_thread_id, ordinal),
  FOREIGN KEY (tenant_id, attempt_id, agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_agent_turn_terminal_shape_check CHECK (
    (status IN ('queued', 'running') AND completed_at IS NULL)
    OR (status IN ('completed', 'interrupted', 'failed') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT runtime_agent_turn_result_shape_check CHECK (
    (final_answer IS NULL OR octet_length(final_answer) <= 65536)
    AND (error_code IS NULL OR octet_length(error_code) BETWEEN 1 AND 200)
  )
);
CREATE UNIQUE INDEX runtime_agent_turns_one_active_idx
  ON runtime_agent_turns(tenant_id, attempt_id, agent_thread_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE runtime_agent_mailbox_messages (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  recipient_agent_thread_id text NOT NULL,
  sender_agent_thread_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('message', 'final_answer', 'error')),
  payload text NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 65536),
  command_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, sequence),
  UNIQUE (tenant_id, attempt_id, command_id),
  FOREIGN KEY (tenant_id, attempt_id, recipient_agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, sender_agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT
);

CREATE TABLE runtime_agent_commands (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  caller_agent_thread_id text NOT NULL,
  command_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('spawn', 'send_message', 'follow_up', 'interrupt')),
  args_digest text NOT NULL CHECK (args_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, caller_agent_thread_id, command_id),
  FOREIGN KEY (tenant_id, attempt_id, caller_agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT
);

ALTER TABLE runtime_rollout_streams
  DROP CONSTRAINT runtime_rollout_streams_agent_kind_check,
  DROP CONSTRAINT runtime_rollout_streams_tenant_id_attempt_id_key,
  ADD CONSTRAINT runtime_rollout_streams_agent_kind_check CHECK (agent_kind IN ('root', 'subagent')),
  ADD CONSTRAINT runtime_rollout_streams_agent_thread_fk
    FOREIGN KEY (tenant_id, attempt_id, agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT;

ALTER TABLE external_effect_permits
  DROP CONSTRAINT external_effect_permits_effect_check,
  ADD CONSTRAINT external_effect_permits_effect_check CHECK (
    effect IN ('model_start', 'model_continue', 'agent_model_start', 'tool_execution')
  );

ALTER TABLE runtime_agent_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_agent_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_agent_threads_tenant_policy ON runtime_agent_threads
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime_agent_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_agent_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_agent_turns_tenant_policy ON runtime_agent_turns
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime_agent_mailbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_agent_mailbox_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_agent_mailbox_messages_tenant_policy ON runtime_agent_mailbox_messages
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime_agent_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_agent_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_agent_commands_tenant_policy ON runtime_agent_commands
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
