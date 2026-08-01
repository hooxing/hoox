-- ADR-0064 / 阶段 2：Thread Context 是跨 Run 的仅追加事实流，不替代 Attempt rollout。
ALTER TABLE execution_attempts
  ADD CONSTRAINT execution_attempts_context_scope_unique
  UNIQUE (tenant_id,attempt_id,run_id,thread_id);

CREATE TABLE thread_context_streams (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence BETWEEN 1 AND 9007199254740991),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT
);

INSERT INTO thread_context_streams(tenant_id,thread_id)
SELECT tenant_id,id FROM threads;

CREATE TABLE thread_context_entries (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  entry_id text NOT NULL CHECK (octet_length(entry_id) BETWEEN 1 AND 512),
  run_id text,
  attempt_id text,
  kind text NOT NULL CHECK (kind IN (
    'run_started','user_message','assistant_message','tool_call','tool_result',
    'workspace_committed','workspace_unchanged','run_terminal'
  )),
  tool_call_id text,
  tool_name text,
  normalized_tool_call_id text GENERATED ALWAYS AS (coalesce(tool_call_id,'')) STORED,
  tool_call_sequence bigint,
  tool_call_predecessor_kind text GENERATED ALWAYS AS (
    CASE WHEN kind='tool_result' THEN 'tool_call' ELSE NULL END
  ) STORED,
  body_inline jsonb,
  body_reference_id text,
  body_operation_id text,
  body_state text,
  body_purpose text,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  body_size bigint NOT NULL CHECK (body_size BETWEEN 0 AND 9007199254740991),
  body_lifecycle_id uuid,
  body_incarnation_id uuid,
  body_physical_object_key text,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id,sequence),
  UNIQUE (tenant_id,thread_id,entry_id),
  UNIQUE (tenant_id,thread_id,sequence,kind,normalized_tool_call_id),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES thread_context_streams(tenant_id,thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,thread_id) REFERENCES runs(tenant_id,id,thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id,run_id,thread_id)
    REFERENCES execution_attempts(tenant_id,attempt_id,run_id,thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id,thread_id,tool_call_sequence,tool_call_predecessor_kind,normalized_tool_call_id
  ) REFERENCES thread_context_entries(
    tenant_id,thread_id,sequence,kind,normalized_tool_call_id
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id,body_reference_id,body_operation_id,body_state,body_purpose,body_sha256,body_size,
    body_lifecycle_id,body_incarnation_id,body_physical_object_key
  ) REFERENCES blob_references(
    tenant_id,reference_id,operation_id,state,purpose,sha256,size,
    lifecycle_id,incarnation_id,physical_object_key
  ) ON DELETE RESTRICT,
  CONSTRAINT thread_context_entry_call_shape_check CHECK (
    (kind IN ('tool_call','tool_result')
      AND tool_call_id IS NOT NULL AND octet_length(tool_call_id) BETWEEN 1 AND 200
      AND tool_name IS NOT NULL AND octet_length(tool_name) BETWEEN 1 AND 200)
    OR (kind NOT IN ('tool_call','tool_result') AND tool_call_id IS NULL AND tool_name IS NULL)
  ),
  CONSTRAINT thread_context_entry_pair_shape_check CHECK (
    (kind='tool_result' AND tool_call_sequence IS NOT NULL)
    OR (kind<>'tool_result' AND tool_call_sequence IS NULL)
  ),
  CONSTRAINT thread_context_entry_body_shape_check CHECK (
    (body_inline IS NOT NULL AND jsonb_typeof(body_inline)='object'
      AND octet_length(body_inline::text) <= 2097152
      AND body_reference_id IS NULL AND body_operation_id IS NULL
      AND body_state IS NULL AND body_purpose IS NULL AND body_lifecycle_id IS NULL
      AND body_incarnation_id IS NULL AND body_physical_object_key IS NULL)
    OR
    (body_inline IS NULL AND body_reference_id IS NOT NULL
      AND body_operation_id IS NOT NULL AND body_state='stable' AND body_purpose='trace'
      AND body_lifecycle_id IS NOT NULL
      AND body_incarnation_id IS NOT NULL AND body_physical_object_key IS NOT NULL)
  )
);

CREATE INDEX thread_context_entries_run_idx
  ON thread_context_entries(tenant_id,run_id,sequence);

CREATE TABLE thread_context_append_commands (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  first_sequence bigint NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence >= first_sequence),
  entry_count integer NOT NULL CHECK (entry_count > 0 AND entry_count <= 512),
  appended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id,idempotency_key),
  FOREIGN KEY (tenant_id,thread_id,first_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,last_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT
);

ALTER TABLE thread_context_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_streams FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_streams_tenant_policy ON thread_context_streams
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_context_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_entries_tenant_policy ON thread_context_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_context_append_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_append_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_append_commands_tenant_policy ON thread_context_append_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
