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
-- 认证时 Tenant 尚未知；哈希策略只服务于 SELECT 与 last_used_at 更新。
CREATE POLICY api_keys_tenant_policy ON api_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY api_keys_hash_lookup_policy ON api_keys FOR SELECT
  USING (key_hash = decode(NULLIF(current_setting('app.api_key_hash', true), ''), 'hex'));
CREATE POLICY api_keys_hash_usage_policy ON api_keys FOR UPDATE
  USING (key_hash = decode(NULLIF(current_setting('app.api_key_hash', true), ''), 'hex'))
  WITH CHECK (key_hash = decode(NULLIF(current_setting('app.api_key_hash', true), ''), 'hex'));

DO $$
DECLARE
  runtime_role name := NULLIF(current_setting('app.runtime_role', true), '');
BEGIN
  IF runtime_role IS NULL THEN
    RAISE EXCEPTION 'Runtime 数据库角色未配置';
  END IF;

  -- Runtime 只能将集成身份的 active Membership 转为 revoked；已 revoked 行不再可更新。
  -- PostgreSQL 对 SELECT ... FOR SHARE/UPDATE 同样施加 UPDATE 策略的 USING，因此 USING
  -- 只限定 active 行：人类成员的授权加锁与 lock_marker 自更新必须继续命中。状态迁移约束
  -- 放在 WITH CHECK：新行要么仍为 active，要么是集成身份的 revoked。列级 ACL 只开放
  -- status 与 lock_marker，user_id 不可改，因此人类成员不能被吊销；revoked 行不满足 USING，
  -- Runtime 既不能重新激活它，也不能再锁定或更新它。
  EXECUTE format(
    'CREATE POLICY api_key_integration_membership_revoke ON memberships AS RESTRICTIVE FOR UPDATE TO %I
       USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')
         AND status = ''active'')
       WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')
         AND (status = ''active''
           OR (status = ''revoked''
             AND EXISTS (SELECT 1 FROM app_users WHERE app_users.id = memberships.user_id AND app_users.kind = ''integration''))))',
    runtime_role
  );
  -- revoked_at IS NULL 排除已吊销行；列级 ACL 再限制可更新列。
  EXECUTE format(
    'CREATE POLICY api_key_revocation_guard ON api_keys AS RESTRICTIVE FOR UPDATE TO %I
       USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''') AND revoked_at IS NULL)
       WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), ''''))',
    runtime_role
  );
END
$$;
