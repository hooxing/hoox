DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM thread_sandbox_sessions
     WHERE resource_filesystem_mounted = false
       AND state IN ('running', 'pausing', 'paused', 'resuming')
  ) THEN
    RAISE EXCEPTION '存在未挂载 ResourceFS 的可复用 Thread Sandbox，拒绝回退能力字段';
  END IF;
END $$;

ALTER TABLE thread_sandbox_sessions DROP COLUMN resource_filesystem_mounted;
