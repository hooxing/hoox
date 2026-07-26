-- ADR-0018：Thread、初始 Workspace 与幂等事实必须原子创建，不能由 API 组合多个 Repository 写入。
CREATE TABLE api_thread_idempotency_records (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  thread_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, idempotency_key),
  UNIQUE (tenant_id, thread_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE api_thread_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_thread_idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY api_thread_idempotency_records_tenant_policy ON api_thread_idempotency_records
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
