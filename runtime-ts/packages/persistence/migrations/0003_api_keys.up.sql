ALTER TABLE app_users
  ADD COLUMN kind text NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'integration'));

CREATE TABLE api_keys (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  integration_user_id text NOT NULL,
  key_hash bytea NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
  key_prefix text NOT NULL CHECK (left(key_prefix, 8) = 'hoox_sk_'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR length(note) <= 500),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['threads:read','runs:read','threads:create','runs:create','tool-results:submit','webhooks:manage']::text[]),
  created_by_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
-- 认证时 Tenant 尚未知；只开放按事务哈希命中的 SELECT 与最近使用列级 UPDATE。
CREATE POLICY api_keys_tenant_policy ON api_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY api_keys_hash_lookup_policy ON api_keys FOR SELECT
  USING (key_hash = decode(NULLIF(current_setting('app.api_key_hash', true), ''), 'hex'));
CREATE POLICY api_keys_hash_usage_policy ON api_keys FOR UPDATE
  USING (key_hash = decode(NULLIF(current_setting('app.api_key_hash', true), ''), 'hex'))
  WITH CHECK (key_hash = decode(NULLIF(current_setting('app.api_key_hash', true), ''), 'hex'));
