CREATE TABLE installation_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  administrator_user_id text REFERENCES app_users(id) ON DELETE RESTRICT,
  initialized_at timestamptz,
  CHECK ((administrator_user_id IS NULL) = (initialized_at IS NULL))
);
-- 已存在的管理面授权会关闭首次初始化，禁用管理员也不能重新开放安装入口。
INSERT INTO installation_state(singleton,administrator_user_id,initialized_at)
SELECT true,user_id,clock_timestamp() FROM platform_control_operators
WHERE role='admin' ORDER BY created_at LIMIT 1;
INSERT INTO installation_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE installation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE installation_state FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  runtime_role text := current_setting('app.runtime_role');
  migrator_role text := current_user;
BEGIN
  EXECUTE format('CREATE POLICY installation_state_migrator_policy ON installation_state TO %I USING (true) WITH CHECK (true)',migrator_role);
  EXECUTE format('CREATE POLICY installation_state_read_policy ON installation_state FOR SELECT TO %I USING (true)',runtime_role);
  EXECUTE format('CREATE POLICY installation_state_initialize_policy ON installation_state FOR UPDATE TO %I USING (administrator_user_id IS NULL) WITH CHECK (administrator_user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND initialized_at IS NOT NULL)',runtime_role);
  EXECUTE format('CREATE POLICY platform_control_operators_runtime_read_policy ON platform_control_operators FOR SELECT TO %I USING (user_id=NULLIF(current_setting(''app.user_id'',true),''''))',runtime_role);
  EXECUTE format('CREATE POLICY platform_control_operators_initialize_policy ON platform_control_operators FOR INSERT TO %I WITH CHECK (role=''admin'' AND status=''active'' AND user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS(SELECT 1 FROM installation_state WHERE administrator_user_id=user_id))',runtime_role);
END $$;
