-- 内层调用独立于 Rollout/Thread 历史；只保存开始事实和固定受控回执，不保存程序输出。
CREATE TABLE runtime_ptc_dispatches (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  base_revision_id text,
  run_claim_token text NOT NULL CHECK (run_claim_token ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  run_claim_epoch bigint NOT NULL CHECK (run_claim_epoch BETWEEN 0 AND 9007199254740991),
  workspace_lease_epoch bigint NOT NULL CHECK (workspace_lease_epoch BETWEEN 0 AND 9007199254740991),
  tool_call_id text NOT NULL CHECK (tool_call_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  parent_tool_call_id text NOT NULL CHECK (parent_tool_call_id <> tool_call_id),
  parent_sequence bigint NOT NULL,
  parent_kind text NOT NULL DEFAULT 'tool_call' CHECK (parent_kind = 'tool_call'),
  tool_name text NOT NULL CHECK (tool_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  start_idempotency_key text NOT NULL CHECK (octet_length(start_idempotency_key) BETWEEN 1 AND 512),
  start_digest text NOT NULL CHECK (start_digest ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result_idempotency_key text CHECK (octet_length(result_idempotency_key) BETWEEN 1 AND 512),
  result_digest text CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  result_body jsonb,
  is_truncated boolean,
  blob_reference_id text,
  blob_state text,
  blob_purpose text,
  blob_sha256 text,
  blob_size bigint,
  completed_at timestamptz,
  -- Provider 的调用 ID 可跨 Run/Attempt 复用；调用身份与幂等键只能在完整 stream scope 内唯一。
  PRIMARY KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, tool_call_id),
  UNIQUE (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, start_idempotency_key),
  UNIQUE (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, result_idempotency_key),
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id)
    REFERENCES runtime_rollout_streams(tenant_id, thread_id, run_id, attempt_id, agent_thread_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
               parent_sequence, parent_kind, parent_tool_call_id)
    REFERENCES runtime_rollout_entries(tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
                                      sequence, kind, normalized_tool_call_id)
    ON DELETE RESTRICT,
  -- 引用必须在同租户再次满足 stable/trace 身份；不能把 staged 或 resource Blob 冒充回执。
  FOREIGN KEY (tenant_id, blob_reference_id, blob_state, blob_purpose, blob_sha256, blob_size)
    REFERENCES blob_references(tenant_id, reference_id, state, purpose, sha256, size)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_ptc_dispatch_result_shape_check CHECK (
    (result_idempotency_key IS NULL AND result_digest IS NULL AND result_body IS NULL
     AND is_truncated IS NULL AND blob_reference_id IS NULL AND blob_state IS NULL
     AND blob_purpose IS NULL AND blob_sha256 IS NULL AND blob_size IS NULL AND completed_at IS NULL)
    OR
    (result_idempotency_key IS NOT NULL AND result_digest IS NOT NULL AND result_body IS NOT NULL
     AND is_truncated IS NOT NULL AND blob_reference_id IS NOT NULL
     AND blob_state IS NOT NULL AND blob_purpose IS NOT NULL AND blob_sha256 IS NOT NULL
     AND blob_size IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at
     AND blob_state='stable' AND blob_purpose='trace' AND blob_sha256 ~ '^[0-9a-f]{64}$'
     AND blob_size BETWEEN 0 AND 9007199254740991
     AND jsonb_typeof(result_body)='object' AND octet_length(result_body::text)<=16384
     AND result_body-ARRAY['schemaVersion','toolName','receiptSha256','receiptBytes','receipt','traceBlob','truncation','observation']='{}'::jsonb
     AND (result_body->>'schemaVersion'='2' AND result_body->>'toolName'=tool_name
          AND result_body->>'receiptSha256'=blob_sha256
          AND result_body->'receiptBytes'=to_jsonb(blob_size)
          AND result_body->'traceBlob'=jsonb_build_object('referenceId',blob_reference_id)
          AND jsonb_typeof(result_body->'observation')='string'
          AND result_body->'truncation'->'isTruncated'=to_jsonb(is_truncated)
          AND result_body->'truncation'->'modelVisibleBytes'=to_jsonb(octet_length(result_body->>'observation'))
          AND (result_body->'truncation')-ARRAY['isTruncated','reason','modelVisibleBytes']='{}'::jsonb
          AND result_body->'receipt'=jsonb_build_object(
            'schemaVersion',1,'trust','sandbox_untrusted','toolName',tool_name,
            'outcome',result_body->'receipt'->>'outcome',
            'message',CASE result_body->'receipt'->>'outcome'
              WHEN 'succeeded' THEN '工具调用已完成。' WHEN 'failed' THEN '工具调用未完成。' END)
          AND result_body->'receipt'->>'outcome' IN ('succeeded','failed')) IS TRUE)
  )
);
CREATE INDEX runtime_ptc_dispatches_parent_idx ON runtime_ptc_dispatches(
  tenant_id, thread_id, run_id, attempt_id, agent_thread_id, parent_tool_call_id, started_at, tool_call_id
);
ALTER TABLE runtime_ptc_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_ptc_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_ptc_dispatches_tenant_policy ON runtime_ptc_dispatches
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
