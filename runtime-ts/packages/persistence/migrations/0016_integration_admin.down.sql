DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM integration_admin_audits) THEN
    RAISE EXCEPTION '集成管理审计存在，拒绝破坏性回退';
  END IF;
END
$$;
DROP TABLE integration_admin_audits;
DROP POLICY integration_admin_actor ON platform_control_operators;
DROP POLICY integration_admin_guard ON api_keys;
DROP POLICY integration_admin_key_update ON api_keys;
DROP POLICY integration_admin_guard ON memberships;
DROP POLICY integration_admin_membership_update ON memberships;
DROP POLICY integration_admin_guard ON app_users;
DROP POLICY integration_admin_guard ON tenants;
DROP POLICY integration_admin_manage ON tenant_webhooks;
