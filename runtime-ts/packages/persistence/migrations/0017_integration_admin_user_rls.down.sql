DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM integration_admin_audits) THEN
    RAISE EXCEPTION '集成管理审计存在，拒绝回退身份隔离策略';
  END IF;
END
$$;
DROP POLICY integration_admin_users_manage ON app_users;
ALTER POLICY app_users_tenant_policy ON app_users TO PUBLIC;
