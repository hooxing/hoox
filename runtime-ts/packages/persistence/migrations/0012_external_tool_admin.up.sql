-- 外部工具管理面：MCP 注册草稿、草稿凭据密文、原子发布批次、幂等命令与操作审计。
-- 所有表只授予 Admin Control，且 RLS 仅放行有效 admin；Runtime 与其他角色零 ACL。
CREATE TABLE external_tool_registration_drafts (
  draft_id text PRIMARY KEY CHECK (draft_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source text NOT NULL CHECK (source = 'mcp'),
  display_name text NOT NULL CHECK (octet_length(display_name) BETWEEN 1 AND 200),
  server_name text NOT NULL CHECK (server_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  endpoint text NOT NULL CHECK (endpoint ~ '^https://[^/@]+(/|$)' AND octet_length(endpoint)<=2048),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 120000),
  max_response_bytes integer NOT NULL CHECK (max_response_bytes BETWEEN 1 AND 1048576),
  side_effect text NOT NULL CHECK (side_effect IN ('read_only','write','destructive')),
  idempotent boolean NOT NULL,
  credential_configured boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  created_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- 草稿凭据只用于发布前探测与发布时按版本重新加密；更换凭据为删除后重新插入，不保留可回读旧值。
CREATE TABLE external_tool_draft_credentials (
  draft_id text PRIMARY KEY REFERENCES external_tool_registration_drafts(draft_id) ON DELETE RESTRICT,
  cipher_version smallint NOT NULL CHECK (cipher_version=1),
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16}$'),
  ciphertext text NOT NULL CHECK (octet_length(ciphertext)<=10924),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^[A-Za-z0-9_-]{22}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE external_tool_publish_batches (
  batch_id text PRIMARY KEY CHECK (batch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  draft_id text NOT NULL REFERENCES external_tool_registration_drafts(draft_id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence >= 1),
  draft_generation bigint NOT NULL CHECK (draft_generation >= 0),
  display_name text NOT NULL CHECK (octet_length(display_name) BETWEEN 1 AND 200),
  source text NOT NULL CHECK (source IN ('mcp','http')),
  server_name text NOT NULL CHECK (server_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  endpoint text NOT NULL CHECK (endpoint ~ '^https://[^/@]+(/|$)' AND octet_length(endpoint)<=2048),
  created_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (draft_id, sequence)
);
CREATE TABLE external_tool_publish_batch_versions (
  batch_id text NOT NULL REFERENCES external_tool_publish_batches(batch_id) ON DELETE RESTRICT,
  tool_version_id text NOT NULL UNIQUE REFERENCES external_tool_versions(tool_version_id) ON DELETE RESTRICT,
  PRIMARY KEY (batch_id, tool_version_id)
);
CREATE TABLE external_tool_admin_commands (
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id, idempotency_key)
);
CREATE TABLE external_tool_admin_audits (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('draft_saved','credential_changed','probed','published','revoked')),
  object_id text NOT NULL CHECK (octet_length(object_id) BETWEEN 1 AND 128),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','rejected','failed')),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX external_tool_admin_audits_object_idx ON external_tool_admin_audits(object_id, audit_id DESC);
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
-- 受限选择视图只暴露可供 Agent 白名单选择的已发布工具元信息；视图所有者执行底表读取，
-- 只对有效 operator/admin 返回行。批次内任一版本撤销都使整批不可选。
CREATE VIEW external_tool_selectable_versions WITH (security_barrier=true) AS
SELECT v.tool_version_id, v.source, v.model_tool_name, v.description, b.display_name AS batch_name
FROM external_tool_versions v
JOIN external_tool_publish_batch_versions bv USING (tool_version_id)
JOIN external_tool_publish_batches b USING (batch_id)
WHERE NOT EXISTS (
        SELECT 1 FROM external_tool_publish_batch_versions sibling
          JOIN external_tool_revocations r ON r.tool_version_id=sibling.tool_version_id
         WHERE sibling.batch_id=b.batch_id)
  AND EXISTS (SELECT 1 FROM platform_control_operators actor
              WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
                AND actor.status='active' AND actor.role IN ('operator','admin'));
DO $$ DECLARE control_role text := current_setting('app.admin_control_role'); BEGIN
  EXECUTE format('GRANT SELECT,INSERT ON external_tool_registration_drafts TO %I',control_role);
  EXECUTE format('GRANT UPDATE(display_name,server_name,endpoint,timeout_ms,max_response_bytes,side_effect,idempotent,credential_configured,generation,updated_by,updated_at) ON external_tool_registration_drafts TO %I',control_role);
  EXECUTE format('GRANT SELECT,INSERT,DELETE ON external_tool_draft_credentials TO %I',control_role);
  EXECUTE format('GRANT SELECT,INSERT ON external_tool_publish_batches,external_tool_publish_batch_versions,external_tool_admin_commands,external_tool_admin_audits TO %I',control_role);
  EXECUTE format('GRANT USAGE ON SEQUENCE external_tool_admin_audits_audit_id_seq TO %I',control_role);
  EXECUTE format('GRANT SELECT ON external_tool_selectable_versions TO %I',control_role);
END $$;
