DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sandbox_lifecycle_effects)
     OR EXISTS (SELECT 1 FROM thread_sandbox_leases)
     OR EXISTS (SELECT 1 FROM thread_sandbox_sessions) THEN
    RAISE EXCEPTION '阶段 5 Sandbox Session 已产生事实，拒绝破坏性回退';
  END IF;
END $$;

ALTER TABLE thread_sandbox_sessions DROP CONSTRAINT thread_sandbox_sessions_current_effect_fk;
DROP TABLE sandbox_lifecycle_effects;
DROP TABLE thread_sandbox_leases;
DROP TABLE thread_sandbox_sessions;
