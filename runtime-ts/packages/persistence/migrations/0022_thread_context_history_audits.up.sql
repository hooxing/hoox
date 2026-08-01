-- shadow/read 每次重建都落摘要审计；正文仍只存在 Context entries / Stable Blob。
CREATE TABLE thread_context_history_audits (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow','read')),
  through_sequence bigint NOT NULL CHECK (through_sequence BETWEEN 0 AND 9007199254740991),
  compatibility_digest text NOT NULL CHECK (compatibility_digest ~ '^[0-9a-f]{64}$'),
  history_digest text NOT NULL CHECK (history_digest ~ '^[0-9a-f]{64}$'),
  projection_schema_version integer NOT NULL DEFAULT 1 CHECK (projection_schema_version=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id,attempt_id,mode,through_sequence,compatibility_digest,history_digest
  ),
  FOREIGN KEY (tenant_id,attempt_id,run_id,thread_id)
    REFERENCES execution_attempts(tenant_id,attempt_id,run_id,thread_id) ON DELETE RESTRICT
);

ALTER TABLE thread_context_history_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_history_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_history_audits_tenant_policy ON thread_context_history_audits
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
