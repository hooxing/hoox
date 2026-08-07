CREATE TABLE runtime_subagent_conversations (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  agent_thread_id text NOT NULL,
  canonical_path text NOT NULL,
  task text NOT NULL,
  enabled_tools jsonb NOT NULL CHECK (jsonb_typeof(enabled_tools) = 'array'),
  tool_manifest_digest text NOT NULL CHECK (tool_manifest_digest ~ '^[0-9a-f]{64}$'),
  fork_turns text NOT NULL CHECK (
    fork_turns = 'none' OR fork_turns = 'all' OR fork_turns ~ '^[1-9][0-9]{0,5}$'
  ),
  turn_ordinal integer NOT NULL CHECK (turn_ordinal BETWEEN 1 AND 1000000),
  history jsonb,
  history_digest text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id, agent_thread_id),
  UNIQUE (tenant_id, thread_id, canonical_path),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT runtime_subagent_conversation_shape_check CHECK (
    octet_length(agent_thread_id) BETWEEN 1 AND 200
    AND octet_length(canonical_path) BETWEEN 1 AND 200
    AND octet_length(task) BETWEEN 1 AND 32768
    AND (
      (history IS NULL AND history_digest IS NULL)
      OR (
        jsonb_typeof(history) = 'object'
        AND history_digest ~ '^[0-9a-f]{64}$'
        AND octet_length(history::text) <= 33554432
      )
    )
  )
);

ALTER TABLE runtime_subagent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_subagent_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_subagent_conversations_tenant_policy ON runtime_subagent_conversations
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
