-- ADR-0016：API 创建 Run 与调度投递之间的持久化边界。禁止通过函数或触发器隐藏状态转换。
CREATE TABLE api_idempotency_records (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  operation text NOT NULL CHECK (operation = 'run.create'),
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  run_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, operation, idempotency_key),
  UNIQUE (tenant_id, run_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE run_dispatch_outbox (
  tenant_id text NOT NULL,
  outbox_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('ready', 'claimed', 'dispatched', 'cancelled')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 9007199254740991),
  claim_token text,
  claimed_by text CHECK (claimed_by IS NULL OR octet_length(claimed_by) BETWEEN 1 AND 200),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, outbox_id),
  UNIQUE (tenant_id, run_id),
  UNIQUE (tenant_id, run_id, thread_id, workspace_id, root_run_id),
  FOREIGN KEY (tenant_id, run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES run_execution_inputs(tenant_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT,
  CONSTRAINT run_dispatch_outbox_claim_shape CHECK (
    (state = 'claimed' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'claimed' AND claim_token IS NULL AND claimed_by IS NULL AND lease_expires_at IS NULL)
  )
);
CREATE INDEX run_dispatch_outbox_claim_idx
  ON run_dispatch_outbox (state, next_attempt_at, lease_expires_at)
  WHERE state IN ('ready', 'claimed');

ALTER TABLE api_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY api_idempotency_records_tenant_policy ON api_idempotency_records
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE run_dispatch_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_dispatch_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY run_dispatch_outbox_tenant_policy ON run_dispatch_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- JS trim 与 PostgreSQL 的 Unicode 空白语义不完全相同；数据库最少拒绝 ASCII/POSIX 空白，
-- 其余 Unicode 边界仍由 API/端口的 JavaScript trim 精确收敛，避免受限 SQL 直写 tab/newline。
ALTER TABLE run_execution_inputs
  ADD CONSTRAINT run_execution_inputs_nonblank_input_check CHECK (input_text ~ '[^[:space:]]');
