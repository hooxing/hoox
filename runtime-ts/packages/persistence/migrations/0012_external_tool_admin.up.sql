CREATE TABLE external_tool_registration_drafts (
  draft_id text PRIMARY KEY CHECK (draft_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source text NOT NULL CHECK (source IN ('mcp','http')),
  display_name text NOT NULL CHECK (octet_length(display_name) BETWEEN 1 AND 200),
  endpoint text NOT NULL CHECK (endpoint ~ '^https://[^/@]+(/|$)' AND octet_length(endpoint)<=2048),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=32768),
  credential_ref text CHECK (credential_ref IS NULL OR octet_length(credential_ref) BETWEEN 1 AND 128),
  credential_configured boolean NOT NULL DEFAULT false,
  created_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE external_tool_draft_credentials (
  draft_id text PRIMARY KEY REFERENCES external_tool_registration_drafts(draft_id) ON DELETE RESTRICT,
  cipher_version smallint NOT NULL CHECK(cipher_version=1),
  nonce text NOT NULL CHECK(nonce ~ '^[A-Za-z0-9_-]{16}$'),
  ciphertext text NOT NULL CHECK(octet_length(ciphertext)<=10924),
  auth_tag text NOT NULL CHECK(auth_tag ~ '^[A-Za-z0-9_-]{22}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE external_tool_publish_batches (
  batch_id text PRIMARY KEY CHECK (batch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  display_name text NOT NULL CHECK (octet_length(display_name) BETWEEN 1 AND 200),
  source text NOT NULL CHECK (source IN ('mcp','http')),
  created_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE external_tool_publish_batch_versions (
  batch_id text NOT NULL REFERENCES external_tool_publish_batches(batch_id) ON DELETE RESTRICT,
  tool_version_id text NOT NULL UNIQUE REFERENCES external_tool_versions(tool_version_id) ON DELETE RESTRICT,
  PRIMARY KEY(batch_id,tool_version_id)
);
CREATE TABLE external_tool_admin_commands (
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK(octet_length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_user_id,idempotency_key)
);
CREATE TABLE external_tool_admin_audits (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('draft_saved','probe','published','revoked')),
  object_id text NOT NULL CHECK(octet_length(object_id) BETWEEN 1 AND 128),
  outcome text NOT NULL CHECK(outcome IN ('succeeded','failed')),
  reason text NOT NULL CHECK(octet_length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$
DECLARE control_role text := current_setting('app.admin_control_role'); table_name text;
BEGIN
  IF control_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN RAISE EXCEPTION 'app.admin_control_role 无效'; END IF;
  FOREACH table_name IN ARRAY ARRAY['external_tool_registration_drafts','external_tool_draft_credentials','external_tool_publish_batches','external_tool_publish_batch_versions','external_tool_admin_commands','external_tool_admin_audits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)',table_name||'_migrator_policy',table_name,current_user);
    IF table_name IN ('external_tool_admin_commands','external_tool_admin_audits') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))',table_name||'_admin_policy',table_name,control_role);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))',table_name||'_admin_policy',table_name,control_role);
    END IF;
  END LOOP;
END $$;
-- 受限选择视图只暴露可供 Agent 白名单选择的已发布工具元信息；视图所有者执行底表读取。
CREATE VIEW external_tool_selectable_versions WITH (security_barrier=true) AS
SELECT v.tool_version_id, v.source, v.model_tool_name, v.description, b.display_name AS batch_name
FROM external_tool_versions v
JOIN external_tool_publish_batch_versions bv USING(tool_version_id)
JOIN external_tool_publish_batches b USING(batch_id)
WHERE NOT EXISTS (SELECT 1 FROM external_tool_revocations r WHERE r.tool_version_id=v.tool_version_id)
  AND EXISTS (SELECT 1 FROM platform_control_operators actor
              WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
                AND actor.status='active' AND actor.role IN ('operator','admin'));
DO $$ DECLARE control_role text := current_setting('app.admin_control_role'); BEGIN
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON external_tool_registration_drafts TO %I',control_role);
  EXECUTE format('GRANT INSERT ON external_tool_draft_credentials TO %I',control_role);
  EXECUTE format('GRANT SELECT,INSERT ON external_tool_publish_batches,external_tool_publish_batch_versions,external_tool_admin_commands,external_tool_admin_audits TO %I',control_role);
  EXECUTE format('GRANT USAGE ON SEQUENCE external_tool_admin_audits_audit_id_seq TO %I',control_role);
  EXECUTE format('GRANT SELECT ON external_tool_selectable_versions TO %I',control_role);
END $$;
