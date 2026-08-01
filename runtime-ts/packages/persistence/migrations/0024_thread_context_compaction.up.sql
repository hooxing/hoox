-- ADR-0068 / 阶段 4：持久 compaction checkpoint + normalized replacement history。
ALTER TABLE thread_context_entries
  DROP CONSTRAINT thread_context_entries_kind_check,
  ADD CONSTRAINT thread_context_entries_kind_check CHECK (kind IN (
    'run_started','user_message','assistant_message','tool_call','tool_result',
    'workspace_committed','workspace_unchanged','run_terminal','compaction_checkpoint'
  ));

ALTER TABLE thread_context_streams
  ADD COLUMN current_window_number bigint NOT NULL DEFAULT 0 CHECK (
    current_window_number BETWEEN 0 AND 9007199254740991
  ),
  ADD COLUMN current_checkpoint_id text,
  ADD COLUMN current_compatibility_digest text CHECK (
    current_compatibility_digest IS NULL OR current_compatibility_digest ~ '^[0-9a-f]{64}$'
  );

CREATE TABLE thread_context_compaction_checkpoints (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  checkpoint_id text NOT NULL CHECK (checkpoint_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  operation_id text NOT NULL CHECK (octet_length(operation_id) BETWEEN 1 AND 512),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  window_number bigint NOT NULL CHECK (window_number BETWEEN 1 AND 9007199254740991),
  previous_checkpoint_id text,
  source_from_sequence bigint NOT NULL CHECK (source_from_sequence BETWEEN 1 AND 9007199254740991),
  source_prefix_through_sequence bigint NOT NULL CHECK (
    source_prefix_through_sequence BETWEEN source_from_sequence AND 9007199254740991
  ),
  through_sequence bigint NOT NULL CHECK (
    through_sequence BETWEEN source_prefix_through_sequence AND 9007199254740991
  ),
  checkpoint_fact_sequence bigint NOT NULL CHECK (
    checkpoint_fact_sequence BETWEEN 1 AND 9007199254740991
    AND checkpoint_fact_sequence > through_sequence
  ),
  compatibility_digest text NOT NULL CHECK (compatibility_digest ~ '^[0-9a-f]{64}$'),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  source_history_digest text NOT NULL CHECK (source_history_digest ~ '^[0-9a-f]{64}$'),
  replacement_history_digest text NOT NULL CHECK (replacement_history_digest ~ '^[0-9a-f]{64}$'),
  tokenizer_identity text NOT NULL CHECK (octet_length(tokenizer_identity) BETWEEN 1 AND 200),
  tokens_before bigint NOT NULL CHECK (tokens_before BETWEEN 1 AND 9007199254740991),
  tokens_after bigint NOT NULL CHECK (tokens_after BETWEEN 1 AND 9007199254740991),
  compaction_path text NOT NULL CHECK (compaction_path IN ('local','remote')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id,checkpoint_id),
  UNIQUE (tenant_id,thread_id,operation_id),
  UNIQUE (tenant_id,thread_id,window_number),
  UNIQUE (tenant_id,thread_id,checkpoint_fact_sequence),
  FOREIGN KEY (tenant_id,thread_id)
    REFERENCES thread_context_streams(tenant_id,thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,checkpoint_fact_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,previous_checkpoint_id)
    REFERENCES thread_context_compaction_checkpoints(tenant_id,thread_id,checkpoint_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT thread_context_compaction_chain_shape_check CHECK (
    (window_number=1 AND previous_checkpoint_id IS NULL)
    OR (window_number>1 AND previous_checkpoint_id IS NOT NULL)
  )
);

CREATE TABLE thread_context_compaction_replacement_items (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  checkpoint_id text NOT NULL,
  item_ordinal integer NOT NULL CHECK (item_ordinal BETWEEN 0 AND 9999),
  history_sequence bigint NOT NULL CHECK (history_sequence BETWEEN 1 AND 9007199254740991),
  item_kind text NOT NULL CHECK (
    item_kind IN ('user','assistant','tool_result','runtime_notice','compaction_handoff')
  ),
  message jsonb NOT NULL CHECK (
    jsonb_typeof(message)='object' AND octet_length(message::text) <= 8388608
  ),
  message_digest text NOT NULL CHECK (message_digest ~ '^[0-9a-f]{64}$'),
  tool_call_ids text[] NOT NULL DEFAULT '{}',
  tool_call_id text,
  tool_name text,
  predecessor_ordinal integer,
  predecessor_kind text GENERATED ALWAYS AS (
    CASE WHEN item_kind='tool_result' THEN 'assistant' ELSE NULL END
  ) STORED,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  PRIMARY KEY (tenant_id,thread_id,checkpoint_id,item_ordinal),
  UNIQUE (tenant_id,thread_id,checkpoint_id,item_ordinal,item_kind),
  FOREIGN KEY (tenant_id,thread_id,checkpoint_id)
    REFERENCES thread_context_compaction_checkpoints(tenant_id,thread_id,checkpoint_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,checkpoint_id,predecessor_ordinal,predecessor_kind)
    REFERENCES thread_context_compaction_replacement_items(
      tenant_id,thread_id,checkpoint_id,item_ordinal,item_kind
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT thread_context_compaction_item_tool_shape_check CHECK (
    (item_kind='assistant' AND tool_call_id IS NULL AND tool_name IS NULL
      AND predecessor_ordinal IS NULL)
    OR (item_kind='tool_result' AND cardinality(tool_call_ids)=0
      AND tool_call_id IS NOT NULL AND tool_name IS NOT NULL
      AND predecessor_ordinal IS NOT NULL)
    OR (item_kind NOT IN ('assistant','tool_result') AND cardinality(tool_call_ids)=0
      AND tool_call_id IS NULL AND tool_name IS NULL AND predecessor_ordinal IS NULL)
  )
);

ALTER TABLE thread_context_streams
  ADD CONSTRAINT thread_context_stream_current_checkpoint_fk FOREIGN KEY (
    tenant_id,thread_id,current_checkpoint_id
  ) REFERENCES thread_context_compaction_checkpoints(tenant_id,thread_id,checkpoint_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT thread_context_stream_checkpoint_shape_check CHECK (
    (current_window_number=0 AND current_checkpoint_id IS NULL
      AND current_compatibility_digest IS NULL)
    OR (current_window_number>0 AND current_checkpoint_id IS NOT NULL
      AND current_compatibility_digest IS NOT NULL)
  );

CREATE INDEX thread_context_compaction_compatible_idx
  ON thread_context_compaction_checkpoints(
    tenant_id,thread_id,compatibility_digest,through_sequence DESC,window_number DESC
  );

ALTER TABLE thread_context_compaction_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_compaction_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_compaction_checkpoints_tenant_policy
  ON thread_context_compaction_checkpoints
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_context_compaction_replacement_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_compaction_replacement_items FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_compaction_replacement_items_tenant_policy
  ON thread_context_compaction_replacement_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
