-- ADR-0171：Sandbox Provider 是持久身份的一部分；所有恢复、清理与 Thread Session 路由必须按 provider_key 失败关闭。
ALTER TABLE sandbox_registry
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));
ALTER TABLE cleanup_outbox
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));
ALTER TABLE sandbox_lifecycle_unknown
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));
ALTER TABLE waiting_recovery_checkpoints
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));
ALTER TABLE thread_sandbox_sessions
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));
ALTER TABLE sandbox_lifecycle_effects
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));

DO $$
DECLARE current_name text;
BEGIN
  SELECT conname INTO current_name FROM pg_constraint
   WHERE conrelid='cleanup_outbox'::regclass AND contype='f'
     AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (tenant_id, attempt_id, registry_id, provider_sandbox_id)%';
  IF current_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE cleanup_outbox DROP CONSTRAINT %I', current_name);
  END IF;

  SELECT conname INTO current_name FROM pg_constraint
   WHERE conrelid='waiting_recovery_checkpoints'::regclass AND contype='f'
     AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (tenant_id, attempt_id, registry_id, provider_sandbox_id)%';
  IF current_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE waiting_recovery_checkpoints DROP CONSTRAINT %I', current_name);
  END IF;

  FOR current_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='sandbox_registry'::regclass AND contype='u'
       AND pg_get_constraintdef(oid) IN (
         'UNIQUE (tenant_id, provider_sandbox_id)',
         'UNIQUE (tenant_id, attempt_id, registry_id, provider_sandbox_id)'
       )
  LOOP
    EXECUTE format('ALTER TABLE sandbox_registry DROP CONSTRAINT %I', current_name);
  END LOOP;

  SELECT conname INTO current_name FROM pg_constraint
   WHERE conrelid='thread_sandbox_sessions'::regclass AND contype='u'
     AND pg_get_constraintdef(oid)='UNIQUE (provider_sandbox_id)';
  IF current_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE thread_sandbox_sessions DROP CONSTRAINT %I', current_name);
  END IF;
END $$;

ALTER TABLE sandbox_registry
  ADD CONSTRAINT sandbox_registry_provider_identity_key
  UNIQUE (tenant_id,provider_key,provider_sandbox_id),
  ADD CONSTRAINT sandbox_registry_cleanup_identity_key
  UNIQUE (tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id);
ALTER TABLE cleanup_outbox
  ADD CONSTRAINT cleanup_outbox_provider_registry_fkey
  FOREIGN KEY (tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id)
  REFERENCES sandbox_registry(tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id)
  ON DELETE RESTRICT;
ALTER TABLE waiting_recovery_checkpoints
  ADD CONSTRAINT waiting_recovery_provider_registry_fkey
  FOREIGN KEY (tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id)
  REFERENCES sandbox_registry(tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id)
  ON DELETE RESTRICT;
ALTER TABLE thread_sandbox_sessions
  ADD CONSTRAINT thread_sandbox_sessions_provider_identity_key
  UNIQUE (provider_key,provider_sandbox_id);
