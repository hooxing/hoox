-- ADR-0055：模型网络诊断正文只引用 trace Blob，索引不含 Header/正文，且不纳入普通资源检索。
CREATE TABLE model_wire_trace_records (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  turn bigint NOT NULL CHECK (turn BETWEEN 0 AND 9007199254740991),
  part text NOT NULL CHECK (part IN ('request', 'response')),
  capture_status text NOT NULL CHECK (capture_status IN ('complete', 'truncated', 'aborted', 'failed')),
  persistence_status text NOT NULL CHECK (persistence_status IN (
    'stored', 'unknown', 'conflict', 'unavailable', 'not_captured'
  )),
  sha256 text,
  size bigint,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  blob_reference_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, attempt_id, turn, part),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id)
    REFERENCES execution_attempts(tenant_id, attempt_id, run_id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, blob_reference_id)
    REFERENCES blob_references(tenant_id, reference_id) ON DELETE RESTRICT,
  CONSTRAINT model_wire_trace_identity_check CHECK (
    octet_length(thread_id) BETWEEN 1 AND 200 AND octet_length(run_id) BETWEEN 1 AND 200
    AND octet_length(attempt_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT model_wire_trace_body_check CHECK (
    (persistence_status = 'stored' AND sha256 ~ '^[0-9a-f]{64}$' AND size >= 0
      AND blob_reference_id IS NOT NULL)
    OR
    (persistence_status <> 'stored' AND blob_reference_id IS NULL)
  )
);
CREATE INDEX model_wire_trace_records_run_idx ON model_wire_trace_records(
  tenant_id, run_id, attempt_id, turn, part
);
CREATE INDEX model_wire_trace_records_expiry_idx ON model_wire_trace_records(expires_at);

ALTER TABLE model_wire_trace_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_wire_trace_records FORCE ROW LEVEL SECURITY;
CREATE POLICY model_wire_trace_records_tenant_policy ON model_wire_trace_records
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
