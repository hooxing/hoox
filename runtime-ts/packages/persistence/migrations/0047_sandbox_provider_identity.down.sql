DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sandbox_registry WHERE provider_key <> 'cube')
    OR EXISTS (SELECT 1 FROM cleanup_outbox WHERE provider_key <> 'cube')
    OR EXISTS (SELECT 1 FROM sandbox_lifecycle_unknown WHERE provider_key <> 'cube')
    OR EXISTS (SELECT 1 FROM waiting_recovery_checkpoints WHERE provider_key <> 'cube')
    OR EXISTS (SELECT 1 FROM thread_sandbox_sessions WHERE provider_key <> 'cube')
    OR EXISTS (SELECT 1 FROM sandbox_lifecycle_effects WHERE provider_key <> 'cube') THEN
    RAISE EXCEPTION '非 Cube Sandbox Provider 已产生事实，拒绝破坏性回退';
  END IF;
END $$;

ALTER TABLE cleanup_outbox DROP CONSTRAINT cleanup_outbox_provider_registry_fkey;
ALTER TABLE waiting_recovery_checkpoints DROP CONSTRAINT waiting_recovery_provider_registry_fkey;
ALTER TABLE sandbox_registry
  DROP CONSTRAINT sandbox_registry_provider_identity_key,
  DROP CONSTRAINT sandbox_registry_cleanup_identity_key;
ALTER TABLE thread_sandbox_sessions
  DROP CONSTRAINT thread_sandbox_sessions_provider_identity_key;

ALTER TABLE sandbox_registry
  ADD UNIQUE (tenant_id,provider_sandbox_id),
  ADD UNIQUE (tenant_id,attempt_id,registry_id,provider_sandbox_id);
ALTER TABLE cleanup_outbox
  ADD FOREIGN KEY (tenant_id,attempt_id,registry_id,provider_sandbox_id)
  REFERENCES sandbox_registry(tenant_id,attempt_id,registry_id,provider_sandbox_id)
  ON DELETE RESTRICT;
ALTER TABLE waiting_recovery_checkpoints
  ADD FOREIGN KEY (tenant_id,attempt_id,registry_id,provider_sandbox_id)
  REFERENCES sandbox_registry(tenant_id,attempt_id,registry_id,provider_sandbox_id)
  ON DELETE RESTRICT;
ALTER TABLE thread_sandbox_sessions ADD UNIQUE (provider_sandbox_id);

ALTER TABLE sandbox_lifecycle_effects DROP COLUMN provider_key;
ALTER TABLE thread_sandbox_sessions DROP COLUMN provider_key;
ALTER TABLE waiting_recovery_checkpoints DROP COLUMN provider_key;
ALTER TABLE sandbox_lifecycle_unknown DROP COLUMN provider_key;
ALTER TABLE cleanup_outbox DROP COLUMN provider_key;
ALTER TABLE sandbox_registry DROP COLUMN provider_key;
