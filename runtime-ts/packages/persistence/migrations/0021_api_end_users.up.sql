ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes)>0 AND scopes <@ ARRAY['threads:read','runs:read','threads:create','runs:create','tool-results:submit','webhooks:manage','end-users:represent']::text[]
);

CREATE TABLE api_end_users (
  integration_tenant_id text NOT NULL,
  created_by_api_key_id text NOT NULL,
  created_by_integration_user_id text NOT NULL,
  external_id text COLLATE "C" NOT NULL CHECK (external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  user_id text NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE RESTRICT,
  personal_tenant_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (integration_tenant_id,external_id),
  FOREIGN KEY (integration_tenant_id,created_by_api_key_id) REFERENCES api_keys(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (personal_tenant_id,user_id) REFERENCES tenants(id,owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (personal_tenant_id,user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT
);
ALTER TABLE api_end_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_end_users FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  runtime_role text := current_setting('app.runtime_role');
  control_role text := current_setting('app.admin_control_role');
BEGIN
  EXECUTE format('CREATE POLICY end_users_runtime ON api_end_users TO %I
    USING (integration_tenant_id=NULLIF(current_setting(''app.end_user_integration_tenant'',true),''''))
    WITH CHECK (integration_tenant_id=NULLIF(current_setting(''app.end_user_integration_tenant'',true),'''')
      AND user_id=NULLIF(current_setting(''app.user_id'',true),'''')
      AND personal_tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''') AND status=''active'')',runtime_role);
  EXECUTE format('CREATE POLICY end_users_migrator ON api_end_users TO %I USING (true) WITH CHECK (true)',current_user);
  EXECUTE format('CREATE POLICY end_users_control ON api_end_users TO %I
    USING (EXISTS (SELECT 1 FROM platform_control_operators actor
      WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))
    WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators actor
      WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))',control_role);
END $$;

ALTER TABLE admin_user_account_audits
  DROP CONSTRAINT admin_user_account_audits_target_user_id_fkey;
ALTER TABLE admin_user_account_audits
  ADD CONSTRAINT admin_user_account_audits_target_user_id_fkey
  FOREIGN KEY (target_user_id) REFERENCES app_users(id) ON DELETE RESTRICT;

CREATE OR REPLACE VIEW admin_user_directory WITH (security_barrier=true) AS
SELECT
  account.user_id,account.email,account.display_name,account.status,account.created_at,
  GREATEST(conversation.last_active_at,session.last_active_at) AS last_active_at,
  COALESCE(session.active_sessions,0)::bigint AS active_sessions,
  COALESCE(conversation.conversation_count,0)::bigint AS conversation_count,
  COALESCE(conversation.run_count,0)::bigint AS run_count,
  NULL::text AS source
FROM user_accounts account
LEFT JOIN LATERAL (
  SELECT max(thread.updated_at) AS last_active_at,
    count(DISTINCT (thread.tenant_id,thread.id))::bigint AS conversation_count,
    count(DISTINCT (run.tenant_id,run.id))::bigint AS run_count
  FROM threads thread LEFT JOIN runs run ON run.tenant_id=thread.tenant_id AND run.thread_id=thread.id
  WHERE thread.created_by_user_id=account.user_id AND NOT thread.is_playground
) conversation ON true
LEFT JOIN LATERAL (
  SELECT max(candidate.created_at) AS last_active_at,
    count(*) FILTER (WHERE candidate.expires_at>clock_timestamp())::bigint AS active_sessions
  FROM user_sessions candidate WHERE candidate.user_id=account.user_id
) session ON true
WHERE EXISTS (SELECT 1 FROM platform_control_operators actor
  WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'') AND actor.status='active' AND actor.role='admin')
UNION ALL
SELECT mapped.user_id,''::text,mapped.external_id COLLATE "default",mapped.status,mapped.created_at,
  conversation.last_active_at,0::bigint,conversation.conversation_count,conversation.run_count,'api_mapping'::text
FROM api_end_users mapped
LEFT JOIN LATERAL (
  SELECT max(thread.updated_at) AS last_active_at,
    count(DISTINCT (thread.tenant_id,thread.id))::bigint AS conversation_count,
    count(DISTINCT (run.tenant_id,run.id))::bigint AS run_count
  FROM threads thread LEFT JOIN runs run ON run.tenant_id=thread.tenant_id AND run.thread_id=thread.id
  WHERE thread.created_by_user_id=mapped.user_id AND NOT thread.is_playground
) conversation ON true
WHERE EXISTS (SELECT 1 FROM platform_control_operators actor
  WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'') AND actor.status='active' AND actor.role='admin');
