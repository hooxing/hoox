DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM installation_state WHERE initialized_at IS NOT NULL) THEN
    RAISE EXCEPTION '已初始化的管理员安装状态禁止回退';
  END IF;
END $$;
DROP POLICY platform_control_operators_initialize_policy ON platform_control_operators;
DROP POLICY platform_control_operators_runtime_read_policy ON platform_control_operators;
DROP TABLE installation_state;
