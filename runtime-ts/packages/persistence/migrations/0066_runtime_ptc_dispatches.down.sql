-- 非空 journal 不可无损撤回；迁移事务回滚会恢复 FORCE RLS，不允许静默删除已记录调用。
ALTER TABLE runtime_ptc_dispatches NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM runtime_ptc_dispatches) THEN
    RAISE EXCEPTION '不可丢弃已持久化的 PTC 内层调用日志';
  END IF;
END $$;
DROP TABLE runtime_ptc_dispatches;
