-- 外部工具版本与凭据由 Admin Control 写入；Worker Runtime 不获任何表权限。
CREATE TABLE external_tool_versions (
  tool_version_id text PRIMARY KEY CHECK (tool_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source text NOT NULL CHECK (source IN ('mcp','http')),
  model_tool_name text NOT NULL CHECK (model_tool_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND ((source='http' AND left(model_tool_name,6)='http__') OR (source='mcp' AND left(model_tool_name,5)='mcp__'))),
  description text NOT NULL CHECK (octet_length(description) <= 2048),
  input_schema jsonb NOT NULL CHECK (jsonb_typeof(input_schema)='object' AND octet_length(input_schema::text)<=32768),
  input_schema_digest text NOT NULL CHECK (input_schema_digest ~ '^[0-9a-f]{64}$'),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 120000),
  max_response_bytes integer NOT NULL CHECK (max_response_bytes BETWEEN 1 AND 1048576),
  side_effect text NOT NULL CHECK (side_effect IN ('read_only','write','destructive')),
  idempotent boolean NOT NULL,
  credential_ref text CHECK (credential_ref IS NULL OR octet_length(credential_ref) BETWEEN 1 AND 128),
  credential_configured boolean NOT NULL DEFAULT false,
  published_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE external_tool_credentials (
  tool_version_id text PRIMARY KEY REFERENCES external_tool_versions(tool_version_id) ON DELETE RESTRICT,
  cipher_version smallint NOT NULL CHECK(cipher_version=1),
  nonce text NOT NULL CHECK(octet_length(nonce)<=32),
  ciphertext text NOT NULL CHECK(octet_length(ciphertext)<=10924),
  auth_tag text NOT NULL CHECK(octet_length(auth_tag)<=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE external_tool_revocations (
  tool_version_id text PRIMARY KEY REFERENCES external_tool_versions(tool_version_id) ON DELETE RESTRICT,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK(octet_length(reason) BETWEEN 1 AND 1000),
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT
);
DO $$
DECLARE control_role text := current_setting('app.admin_control_role');
  table_name text;
BEGIN
  IF control_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN RAISE EXCEPTION 'app.admin_control_role 无效'; END IF;
  FOREACH table_name IN ARRAY ARRAY['external_tool_versions','external_tool_credentials','external_tool_revocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', table_name || '_migrator_policy', table_name, current_user);
    IF table_name = 'external_tool_credentials' THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO %I WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))', table_name || '_admin_policy', table_name, control_role);
    ELSIF table_name = 'external_tool_versions' THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')) WITH CHECK (published_by=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=published_by AND actor.status=''active'' AND actor.role=''admin''))', table_name || '_admin_policy', table_name, control_role);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=actor_user_id AND actor.status=''active'' AND actor.role=''admin''))', table_name || '_admin_policy', table_name, control_role);
    END IF;
  END LOOP;
END $$;
DO $$ DECLARE control_role text := current_setting('app.admin_control_role'); BEGIN
  EXECUTE format('GRANT SELECT, INSERT ON external_tool_versions, external_tool_revocations TO %I', control_role);
  EXECUTE format('GRANT INSERT ON external_tool_credentials TO %I', control_role);
  EXECUTE format('GRANT SELECT ON external_tool_versions, external_tool_revocations, external_tool_credentials TO %I', current_user);
END $$;
