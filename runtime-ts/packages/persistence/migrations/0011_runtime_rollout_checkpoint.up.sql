-- ADR-0030：Pi Session 文件不是事实源；Runtime 以仅追加事实、checkpoint 投影和幂等回执恢复。
ALTER TABLE blob_references ADD CONSTRAINT blob_references_rollout_target_unique
  UNIQUE (tenant_id, reference_id, state, purpose, sha256, size);

CREATE TABLE runtime_rollout_streams (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  agent_thread_id text NOT NULL,
  agent_kind text NOT NULL DEFAULT 'root' CHECK (agent_kind = 'root'),
  model_id text NOT NULL CHECK (octet_length(model_id) BETWEEN 1 AND 255),
  model_compatibility_hash text NOT NULL CHECK (model_compatibility_hash ~ '^[0-9a-f]{64}$'),
  prompt_policy_hash text NOT NULL CHECK (prompt_policy_hash ~ '^[0-9a-f]{64}$'),
  tool_schema_hash text NOT NULL CHECK (tool_schema_hash ~ '^[0-9a-f]{64}$'),
  skill_manifest_hash text NOT NULL CHECK (skill_manifest_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id),
  UNIQUE (tenant_id, attempt_id, agent_thread_id),
  -- 首版一个 Attempt 只能存在一个 root stream；Agent Thread 维度仍保留在事实主键中。
  UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(
      tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id
    ) ON DELETE RESTRICT,
  CONSTRAINT runtime_rollout_stream_identifiers_check CHECK (
    octet_length(thread_id) BETWEEN 1 AND 200
    AND octet_length(run_id) BETWEEN 1 AND 200
    AND octet_length(attempt_id) BETWEEN 1 AND 200
    AND octet_length(workspace_id) BETWEEN 1 AND 200
    AND octet_length(root_run_id) BETWEEN 1 AND 200
    AND octet_length(agent_thread_id) BETWEEN 1 AND 200
  )
);

CREATE TABLE runtime_rollout_entries (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 0 AND 9007199254740991),
  kind text NOT NULL CHECK (kind IN (
    'user', 'assistant', 'tool_call', 'tool_result', 'waiting', 'terminal'
  )),
  tool_call_id text,
  normalized_tool_call_id text GENERATED ALWAYS AS (coalesce(tool_call_id, '')) STORED,
  previous_sequence bigint,
  previous_kind text,
  previous_tool_call_id text,
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_digest text NOT NULL CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  is_truncated boolean NOT NULL DEFAULT false,
  blob_reference_id text,
  blob_state text,
  blob_purpose text,
  blob_sha256 text,
  blob_size bigint,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, sequence),
  UNIQUE (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    sequence, kind, normalized_tool_call_id
  ),
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id)
    REFERENCES runtime_rollout_streams(
      tenant_id, thread_id, run_id, attempt_id, agent_thread_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    previous_sequence, previous_kind, previous_tool_call_id
  ) REFERENCES runtime_rollout_entries(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    sequence, kind, normalized_tool_call_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, blob_reference_id, blob_state, blob_purpose, blob_sha256, blob_size)
    REFERENCES blob_references(tenant_id, reference_id, state, purpose, sha256, size)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_rollout_entry_call_shape_check CHECK (
    (kind IN ('tool_call', 'tool_result')
      AND tool_call_id IS NOT NULL AND octet_length(tool_call_id) BETWEEN 1 AND 200)
    OR (kind NOT IN ('tool_call', 'tool_result') AND tool_call_id IS NULL)
  ),
  -- 自引用前驱同时保证无间隙单调序号、tool_call 后只能紧跟同 ID 的 tool_result。
  CONSTRAINT runtime_rollout_entry_predecessor_shape_check CHECK (
    (sequence = 0
      AND previous_sequence IS NULL AND previous_kind IS NULL AND previous_tool_call_id IS NULL
      AND kind <> 'tool_result')
    OR
    (sequence > 0
      AND previous_sequence = sequence - 1
      AND previous_kind IS NOT NULL AND previous_tool_call_id IS NOT NULL
      AND previous_kind <> 'terminal'
      AND (
        (kind = 'tool_result'
          AND previous_kind = 'tool_call' AND previous_tool_call_id = tool_call_id)
        OR (kind <> 'tool_result' AND previous_kind <> 'tool_call')
      ))
  ),
  CONSTRAINT runtime_rollout_entry_body_size_check CHECK (octet_length(body::text) <= 16384),
  CONSTRAINT runtime_rollout_entry_blob_shape_check CHECK (
    (blob_reference_id IS NULL AND blob_state IS NULL AND blob_purpose IS NULL
      AND blob_sha256 IS NULL AND blob_size IS NULL AND NOT is_truncated)
    OR
    (kind = 'tool_result' AND blob_reference_id IS NOT NULL
      AND blob_state = 'stable' AND blob_purpose = 'trace'
      AND blob_sha256 ~ '^[0-9a-f]{64}$'
      AND blob_size BETWEEN 0 AND 9007199254740991)
  )
);
CREATE INDEX runtime_rollout_entries_tail_idx ON runtime_rollout_entries(
  tenant_id, attempt_id, agent_thread_id, sequence DESC
);

CREATE TABLE runtime_rollout_append_commands (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  first_sequence bigint NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence >= first_sequence),
  appended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id, idempotency_key),
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, first_sequence)
    REFERENCES runtime_rollout_entries(
      tenant_id, thread_id, run_id, attempt_id, agent_thread_id, sequence
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, last_sequence)
    REFERENCES runtime_rollout_entries(
      tenant_id, thread_id, run_id, attempt_id, agent_thread_id, sequence
    ) ON DELETE RESTRICT
);

-- Replacement history 规范化为共享的仅追加前缀，checkpoint 只能引用其中一个长度。
-- 因而后续 checkpoint 无法清空、改写或分叉已经提交的 replacement。
CREATE TABLE runtime_rollout_replacements (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  replacement_sequence bigint NOT NULL CHECK (
    replacement_sequence BETWEEN 0 AND 9007199254740991
  ),
  previous_replacement_sequence bigint,
  previous_replacement_digest text,
  replacement jsonb NOT NULL CHECK (jsonb_typeof(replacement) = 'object'),
  replacement_digest text NOT NULL CHECK (replacement_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id, replacement_sequence
  ),
  UNIQUE (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    replacement_sequence, replacement_digest
  ),
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id)
    REFERENCES runtime_rollout_streams(
      tenant_id, thread_id, run_id, attempt_id, agent_thread_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    previous_replacement_sequence, previous_replacement_digest
  ) REFERENCES runtime_rollout_replacements(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    replacement_sequence, replacement_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT runtime_rollout_replacement_predecessor_check CHECK (
    (replacement_sequence = 0
      AND previous_replacement_sequence IS NULL AND previous_replacement_digest IS NULL)
    OR
    (replacement_sequence > 0
      AND previous_replacement_sequence = replacement_sequence - 1
      AND previous_replacement_digest ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT runtime_rollout_replacement_size_check CHECK (
    octet_length(replacement::text) <= 16384
  )
);

CREATE TABLE runtime_rollout_checkpoints (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  checkpoint_id text NOT NULL CHECK (octet_length(checkpoint_id) BETWEEN 1 AND 200),
  checkpoint_sequence bigint NOT NULL CHECK (checkpoint_sequence BETWEEN 0 AND 9007199254740991),
  previous_checkpoint_sequence bigint,
  previous_through_sequence bigint,
  previous_window_start_sequence bigint,
  previous_replacement_history_length bigint,
  window_start_sequence bigint NOT NULL CHECK (window_start_sequence >= 0),
  window_start_kind text NOT NULL CHECK (window_start_kind <> 'tool_result'),
  window_start_tool_call_id text NOT NULL,
  through_sequence bigint NOT NULL CHECK (through_sequence >= window_start_sequence),
  through_kind text NOT NULL CHECK (through_kind <> 'tool_call'),
  through_tool_call_id text NOT NULL,
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  projection_digest text NOT NULL CHECK (projection_digest ~ '^[0-9a-f]{64}$'),
  replacement_history_length bigint NOT NULL CHECK (
    replacement_history_length BETWEEN 0 AND 9007199254740991
  ),
  replacement_history_last_sequence bigint GENERATED ALWAYS AS (
    CASE WHEN replacement_history_length = 0 THEN NULL ELSE replacement_history_length - 1 END
  ) STORED,
  replacement_history_tail_digest text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id, checkpoint_id),
  UNIQUE (tenant_id, attempt_id, agent_thread_id, through_sequence),
  UNIQUE (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    checkpoint_sequence, through_sequence, window_start_sequence, replacement_history_length
  ),
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    window_start_sequence, window_start_kind, window_start_tool_call_id
  ) REFERENCES runtime_rollout_entries(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    sequence, kind, normalized_tool_call_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    through_sequence, through_kind, through_tool_call_id
  ) REFERENCES runtime_rollout_entries(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    sequence, kind, normalized_tool_call_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    previous_checkpoint_sequence, previous_through_sequence,
    previous_window_start_sequence, previous_replacement_history_length
  ) REFERENCES runtime_rollout_checkpoints(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    checkpoint_sequence, through_sequence, window_start_sequence, replacement_history_length
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    replacement_history_last_sequence, replacement_history_tail_digest
  ) REFERENCES runtime_rollout_replacements(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    replacement_sequence, replacement_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT runtime_rollout_checkpoint_predecessor_check CHECK (
    (checkpoint_sequence = 0
      AND previous_checkpoint_sequence IS NULL AND previous_through_sequence IS NULL
      AND previous_window_start_sequence IS NULL
      AND previous_replacement_history_length IS NULL)
    OR
    (checkpoint_sequence > 0
      AND previous_checkpoint_sequence = checkpoint_sequence - 1
      AND previous_through_sequence IS NOT NULL
      AND previous_window_start_sequence IS NOT NULL
      AND previous_replacement_history_length IS NOT NULL
      AND through_sequence > previous_through_sequence
      AND window_start_sequence >= previous_window_start_sequence
      AND replacement_history_length >= previous_replacement_history_length)
  ),
  CONSTRAINT runtime_rollout_checkpoint_replacement_shape_check CHECK (
    (replacement_history_length = 0 AND replacement_history_tail_digest IS NULL)
    OR
    (replacement_history_length > 0 AND replacement_history_tail_digest ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT runtime_rollout_checkpoint_size_check CHECK (
    octet_length(projection::text) <= 65536
  )
);
CREATE INDEX runtime_rollout_checkpoints_latest_idx ON runtime_rollout_checkpoints(
  tenant_id, attempt_id, agent_thread_id, through_sequence DESC
);

CREATE TABLE runtime_rollout_checkpoint_commands (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  checkpoint_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id, idempotency_key),
  UNIQUE (tenant_id, attempt_id, agent_thread_id, checkpoint_id),
  FOREIGN KEY (tenant_id, attempt_id, agent_thread_id, checkpoint_id)
    REFERENCES runtime_rollout_checkpoints(
      tenant_id, attempt_id, agent_thread_id, checkpoint_id
    ) ON DELETE RESTRICT
);

ALTER TABLE runtime_rollout_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_streams FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_streams_tenant_policy ON runtime_rollout_streams
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_rollout_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_entries_tenant_policy ON runtime_rollout_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_rollout_append_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_append_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_append_commands_tenant_policy ON runtime_rollout_append_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_rollout_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_replacements FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_replacements_tenant_policy ON runtime_rollout_replacements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_rollout_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_checkpoints_tenant_policy ON runtime_rollout_checkpoints
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_rollout_checkpoint_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_checkpoint_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_checkpoint_commands_tenant_policy ON runtime_rollout_checkpoint_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
