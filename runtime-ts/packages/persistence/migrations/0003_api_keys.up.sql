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

-- Runtime 不能直接改授权状态；该窄函数同时锁定 Key 并撤销其集成 Membership。
CREATE FUNCTION revoke_api_key(p_api_key_id text, p_revoked_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  v_tenant_id text := NULLIF(current_setting('app.tenant_id', true), '');
  v_integration_user_id text;
  v_user_kind text;
  v_membership_status text;
  v_updated integer;
BEGIN
  IF v_tenant_id IS NULL OR p_revoked_at IS NULL THEN
    RAISE EXCEPTION 'API Key 撤销上下文无效' USING ERRCODE = '42501';
  END IF;

  SELECT integration_user_id INTO v_integration_user_id
    FROM api_keys
   WHERE tenant_id = v_tenant_id AND id = p_api_key_id AND revoked_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT kind INTO v_user_kind FROM app_users WHERE id = v_integration_user_id;
  IF v_user_kind IS DISTINCT FROM 'integration' THEN
    RAISE EXCEPTION 'API Key 目标身份不是集成身份' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_membership_status FROM memberships
   WHERE tenant_id = v_tenant_id AND user_id = v_integration_user_id
   FOR UPDATE;
  IF NOT FOUND OR v_membership_status NOT IN ('active', 'revoked') THEN
    RAISE EXCEPTION '集成身份 Membership 状态无效' USING ERRCODE = '42501';
  END IF;
  IF v_membership_status = 'active' THEN
    UPDATE memberships SET status = 'revoked'
     WHERE tenant_id = v_tenant_id AND user_id = v_integration_user_id AND status = 'active';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION '集成身份 Membership 状态发生并发变化' USING ERRCODE = '40001';
    END IF;
  END IF;

  UPDATE api_keys SET revoked_at = p_revoked_at
   WHERE tenant_id = v_tenant_id AND id = p_api_key_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'API Key 撤销状态发生并发变化' USING ERRCODE = '40001';
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION revoke_api_key(text, timestamptz) FROM PUBLIC;
