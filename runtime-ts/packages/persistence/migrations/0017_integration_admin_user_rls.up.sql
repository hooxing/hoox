DO $$
DECLARE
  control_role name := current_setting('app.admin_control_role');
  runtime_role name := current_setting('app.runtime_role');
BEGIN
  EXECUTE format('ALTER POLICY app_users_tenant_policy ON app_users TO %I',runtime_role);
  EXECUTE format('CREATE POLICY integration_admin_users_manage ON app_users TO %I USING (id=NULLIF(current_setting(''app.user_id'',true),'''') OR EXISTS (SELECT 1 FROM api_keys k WHERE k.integration_user_id=app_users.id)) WITH CHECK (id=NULLIF(current_setting(''app.user_id'',true),''''))',control_role);
END
$$;
