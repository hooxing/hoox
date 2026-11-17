-- 只公开聚合布尔值，兼容迁移后由运维 SQL 授权的管理员，不暴露其他用户身份。
CREATE VIEW installation_status WITH (security_barrier=true) AS
SELECT administrator_user_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM platform_control_operators WHERE role='admin')
    OR EXISTS(SELECT 1 FROM platform_skill_operators WHERE role='admin') AS initialized
FROM installation_state WHERE singleton=true;
DO $$ BEGIN
  EXECUTE format('GRANT SELECT ON installation_status TO %I',current_setting('app.runtime_role'));
END $$;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY platform_skill_operators_runtime_read_policy ON platform_skill_operators FOR SELECT TO %I USING (user_id=NULLIF(current_setting(''app.user_id'',true),''''))',current_setting('app.runtime_role'));
  EXECUTE format('CREATE POLICY platform_skill_operators_initialize_policy ON platform_skill_operators FOR INSERT TO %I WITH CHECK (role=''admin'' AND status=''active'' AND user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS(SELECT 1 FROM installation_state WHERE administrator_user_id=user_id))',current_setting('app.runtime_role'));
END $$;
