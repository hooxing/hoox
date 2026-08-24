-- ADR-20260824115000：Better Auth 与 Hoox 共用数据库，但凭据表只向 Runtime 身份边界开放。
DO $$
DECLARE
  runtime_role text := NULLIF(current_setting('app.runtime_role', true), '');
  control_role text := NULLIF(current_setting('app.admin_control_role', true), '');
BEGIN
  IF runtime_role IS NULL OR runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.runtime_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
  IF control_role IS NULL OR control_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.admin_control_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
END $$;

ALTER TABLE user_accounts
  ADD COLUMN better_auth_user_id text UNIQUE,
  ALTER COLUMN password_algorithm DROP NOT NULL,
  ALTER COLUMN password_salt DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD CONSTRAINT user_accounts_password_shape CHECK (
    (password_algorithm IS NULL AND password_salt IS NULL AND password_hash IS NULL)
    OR (password_algorithm='scrypt-v1' AND octet_length(password_salt)=16 AND octet_length(password_hash)=32)
  );

DROP POLICY user_accounts_authentication_policy ON user_accounts;
CREATE POLICY user_accounts_authentication_policy ON user_accounts
  USING (
    normalized_email = NULLIF(current_setting('app.auth_email', true), '')
    OR better_auth_user_id = NULLIF(current_setting('app.auth_better_auth_user_id', true), '')
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')
    AND personal_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
  );

CREATE TABLE better_auth_users (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  phone_number text UNIQUE,
  phone_number_verified boolean,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE better_auth_sessions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES better_auth_users(id) ON DELETE CASCADE
);
CREATE INDEX better_auth_sessions_user_id_idx ON better_auth_sessions(user_id);
CREATE TABLE better_auth_accounts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  issuer text NOT NULL,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES better_auth_users(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL,
  UNIQUE (issuer,account_id)
);
CREATE INDEX better_auth_accounts_user_id_idx ON better_auth_accounts(user_id);
CREATE TABLE better_auth_verifications (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX better_auth_verifications_identifier_idx ON better_auth_verifications(identifier);
CREATE TABLE better_auth_rate_limits (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  last_request bigint NOT NULL
);

CREATE TABLE identity_auth_configuration (
  singleton text PRIMARY KEY CHECK (singleton='global'),
  version_token bigint NOT NULL CHECK (version_token BETWEEN 1 AND 9007199254740991),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration)='object'),
  secrets_ciphertext bytea NOT NULL CHECK (octet_length(secrets_ciphertext) BETWEEN 1 AND 65536),
  secrets_nonce bytea NOT NULL CHECK (octet_length(secrets_nonce)=12),
  secrets_tag bytea NOT NULL CHECK (octet_length(secrets_tag)=16),
  updated_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE identity_auth_audits (
  audit_id text PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  previous_version_token bigint NOT NULL CHECK (previous_version_token BETWEEN 0 AND 9007199254740991),
  version_token bigint NOT NULL CHECK (version_token=previous_version_token+1),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX identity_auth_audits_created_idx ON identity_auth_audits(created_at DESC,audit_id DESC);
CREATE TABLE identity_auth_commands (
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_user_id,idempotency_key)
);

ALTER TABLE better_auth_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE better_auth_users FORCE ROW LEVEL SECURITY;
ALTER TABLE better_auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE better_auth_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE better_auth_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE better_auth_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE better_auth_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE better_auth_verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE better_auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE better_auth_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_configuration FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_audits FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_commands FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  migrator_role text := current_user;
  runtime_role text := current_setting('app.runtime_role');
  control_role text := current_setting('app.admin_control_role');
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['better_auth_users','better_auth_sessions','better_auth_accounts','better_auth_verifications','better_auth_rate_limits'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', table_name||'_migrator_policy', table_name, migrator_role);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', table_name||'_runtime_policy', table_name, runtime_role);
  END LOOP;
  EXECUTE format('CREATE POLICY identity_auth_configuration_migrator_policy ON identity_auth_configuration FOR ALL TO %I USING (true) WITH CHECK (true)', migrator_role);
  EXECUTE format('CREATE POLICY identity_auth_configuration_runtime_policy ON identity_auth_configuration FOR SELECT TO %I USING (true)', runtime_role);
  EXECUTE format('CREATE POLICY identity_auth_configuration_control_policy ON identity_auth_configuration FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')) WITH CHECK (updated_by=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=updated_by AND actor.status=''active'' AND actor.role=''admin''))', control_role);
  EXECUTE format('CREATE POLICY identity_auth_audits_migrator_policy ON identity_auth_audits FOR ALL TO %I USING (true) WITH CHECK (true)', migrator_role);
  EXECUTE format('CREATE POLICY identity_auth_audits_control_policy ON identity_auth_audits FOR ALL TO %I USING (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),''''))', control_role);
  EXECUTE format('CREATE POLICY identity_auth_commands_migrator_policy ON identity_auth_commands FOR ALL TO %I USING (true) WITH CHECK (true)', migrator_role);
  EXECUTE format('CREATE POLICY identity_auth_commands_control_policy ON identity_auth_commands FOR ALL TO %I USING (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),''''))', control_role);
  EXECUTE format('CREATE POLICY better_auth_sessions_control_delete_policy ON better_auth_sessions FOR DELETE TO %I USING (EXISTS (SELECT 1 FROM user_accounts target JOIN platform_control_operators actor ON actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'' WHERE target.better_auth_user_id=better_auth_sessions.user_id))', control_role);
END $$;
