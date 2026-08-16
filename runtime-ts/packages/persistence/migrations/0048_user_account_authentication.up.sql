-- 本地产品账号在解析 Tenant 之前按邮箱或随机会话摘要定位；两张表仍以细粒度 RLS
-- 限制为当前认证候选或已经建立的用户上下文，禁止 Runtime 无条件扫描凭据事实。
ALTER TABLE tenants
  ADD CONSTRAINT tenants_personal_owner_identity_key UNIQUE (id, owner_user_id);

CREATE TABLE user_accounts (
  user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  personal_tenant_id text NOT NULL UNIQUE,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  normalized_email text NOT NULL UNIQUE CHECK (
    length(normalized_email) BETWEEN 3 AND 254 AND normalized_email = lower(normalized_email)
  ),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 32),
  password_algorithm text NOT NULL CHECK (password_algorithm = 'scrypt-v1'),
  password_salt bytea NOT NULL CHECK (octet_length(password_salt) = 16),
  password_hash bytea NOT NULL CHECK (octet_length(password_hash) = 32),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (personal_tenant_id, user_id)
    REFERENCES tenants(id, owner_user_id) ON DELETE RESTRICT
);

CREATE TABLE user_sessions (
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES user_accounts(user_id) ON DELETE CASCADE,
  personal_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  FOREIGN KEY (personal_tenant_id, user_id)
    REFERENCES tenants(id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX user_sessions_user_expiry_idx ON user_sessions(user_id, expires_at DESC);
CREATE INDEX user_sessions_expiry_idx ON user_sessions(expires_at);

ALTER TABLE user_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY user_accounts_authentication_policy ON user_accounts
  USING (
    normalized_email = NULLIF(current_setting('app.auth_email', true), '')
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')
    AND personal_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
  );

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_authentication_policy ON user_sessions
  USING (
    token_digest = NULLIF(current_setting('app.auth_session_digest', true), '')
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')
    AND personal_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
  );
