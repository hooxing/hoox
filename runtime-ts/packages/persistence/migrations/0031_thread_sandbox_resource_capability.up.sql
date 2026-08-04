-- 旧版本的 Thread Sandbox 创建时始终挂载 ResourceFS，因此已有行安全回填为 true；
-- 新创建 Session 必须由 lifecycle 显式记录实际能力。
ALTER TABLE thread_sandbox_sessions
  ADD COLUMN resource_filesystem_mounted boolean NOT NULL DEFAULT true;

ALTER TABLE thread_sandbox_sessions
  ALTER COLUMN resource_filesystem_mounted SET DEFAULT false;
