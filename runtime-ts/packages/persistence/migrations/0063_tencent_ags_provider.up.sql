-- 腾讯云 AGS 独立持久身份，保留既有 Provider 外键与唯一性边界。
ALTER TABLE sandbox_registry
  DROP CONSTRAINT sandbox_registry_provider_key_check,
  ADD CONSTRAINT sandbox_registry_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
ALTER TABLE cleanup_outbox
  DROP CONSTRAINT cleanup_outbox_provider_key_check,
  ADD CONSTRAINT cleanup_outbox_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
ALTER TABLE sandbox_lifecycle_unknown
  DROP CONSTRAINT sandbox_lifecycle_unknown_provider_key_check,
  ADD CONSTRAINT sandbox_lifecycle_unknown_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
ALTER TABLE waiting_recovery_checkpoints
  DROP CONSTRAINT waiting_recovery_checkpoints_provider_key_check,
  ADD CONSTRAINT waiting_recovery_checkpoints_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
ALTER TABLE thread_sandbox_sessions
  DROP CONSTRAINT thread_sandbox_sessions_provider_key_check,
  ADD CONSTRAINT thread_sandbox_sessions_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
ALTER TABLE sandbox_lifecycle_effects
  DROP CONSTRAINT sandbox_lifecycle_effects_provider_key_check,
  ADD CONSTRAINT sandbox_lifecycle_effects_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
