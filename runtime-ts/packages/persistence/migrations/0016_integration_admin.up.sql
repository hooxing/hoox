CREATE TABLE integration_admin_audits (
  id uuid PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES app_users(id),
  tenant_id text NOT NULL REFERENCES tenants(id),
  action text NOT NULL CHECK (action IN (
    'api_key.list','api_key.create','api_key.rotate','api_key.revoke',
    'webhook.list','webhook.create','webhook.rotate','webhook.disable','webhook.delete'
  )),
  object_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE integration_admin_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_admin_audits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON integration_admin_audits FROM PUBLIC;

DO $$
DECLARE
  control_role name := NULLIF(current_setting('app.admin_control_role',true),'');
  migrator_role name := current_user;
  admin_guard text := 'EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.integration_admin_user_id'',true),'''') AND actor.role=''admin'' AND actor.status=''active'')';
  tenant_guard text := 'tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')';
BEGIN
  IF control_role IS NULL OR migrator_role IS NULL THEN
    RAISE EXCEPTION '集成管理数据库角色未配置';
  END IF;
  EXECUTE format('CREATE POLICY integration_admin_actor ON platform_control_operators FOR SELECT TO %I USING (user_id=NULLIF(current_setting(''app.integration_admin_user_id'',true),''''))',control_role);
  EXECUTE format('CREATE POLICY integration_admin_guard ON api_keys AS RESTRICTIVE TO %I USING (%s AND %s) WITH CHECK (%s AND %s)',control_role,admin_guard,tenant_guard,admin_guard,tenant_guard);
  EXECUTE format('CREATE POLICY integration_admin_key_update ON api_keys AS RESTRICTIVE FOR UPDATE TO %I USING (revoked_at IS NULL) WITH CHECK (true)',control_role);
  EXECUTE format('CREATE POLICY integration_admin_guard ON memberships AS RESTRICTIVE TO %I USING (%s AND %s AND (user_id=NULLIF(current_setting(''app.user_id'',true),'''') OR EXISTS (SELECT 1 FROM api_keys k WHERE k.tenant_id=memberships.tenant_id AND k.integration_user_id=memberships.user_id))) WITH CHECK (%s AND %s AND role=''member'' AND status IN (''active'',''revoked'') AND EXISTS (SELECT 1 FROM app_users u WHERE u.id=memberships.user_id AND u.kind=''integration''))',control_role,admin_guard,tenant_guard,admin_guard,tenant_guard);
  EXECUTE format('CREATE POLICY integration_admin_membership_update ON memberships AS RESTRICTIVE FOR UPDATE TO %I USING (status=''active'') WITH CHECK (status=''revoked'')',control_role);
  EXECUTE format('CREATE POLICY integration_admin_guard ON app_users AS RESTRICTIVE TO %I USING (%s AND kind=''integration'') WITH CHECK (%s AND kind=''integration'' AND id=NULLIF(current_setting(''app.user_id'',true),''''))',control_role,admin_guard,admin_guard);
  EXECUTE format('CREATE POLICY integration_admin_guard ON tenants AS RESTRICTIVE TO %I USING (%s AND id=NULLIF(current_setting(''app.tenant_id'',true),''''))',control_role,admin_guard);
  EXECUTE format('CREATE POLICY integration_admin_manage ON tenant_webhooks TO %I USING (%s AND %s) WITH CHECK (%s AND %s)',control_role,admin_guard,tenant_guard,admin_guard,tenant_guard);
  EXECUTE format('CREATE POLICY integration_admin_audits_admin ON integration_admin_audits TO %I USING (%s AND %s) WITH CHECK (%s AND %s AND actor_user_id=NULLIF(current_setting(''app.integration_admin_user_id'',true),''''))',control_role,admin_guard,tenant_guard,admin_guard,tenant_guard);
  EXECUTE format('CREATE POLICY integration_admin_audits_migrator ON integration_admin_audits TO %I USING (true) WITH CHECK (true)',migrator_role);
END
$$;
