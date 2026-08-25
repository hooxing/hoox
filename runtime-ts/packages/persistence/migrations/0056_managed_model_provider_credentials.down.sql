DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM admin_control_config_revisions
     WHERE object_kind='model_provider' AND configuration ? 'credential'
  ) THEN
    RAISE EXCEPTION 'DOWN_MIGRATION_BLOCKED:managed_model_provider_credentials_exist';
  END IF;
END $$;

-- 只有不存在托管密钥 Revision 时才允许回退；恢复 0051 的约束由向下迁移门禁阻止误删数据。
ALTER TABLE admin_control_config_revisions
  DROP CONSTRAINT admin_control_configuration_shape;

ALTER TABLE admin_control_config_revisions
  ADD CONSTRAINT admin_control_configuration_shape CHECK (
    object_kind<>'model_provider' OR (
      configuration ?& ARRAY[
        'providerKey','displayName','protocol','baseUrl','secretRef','defaultModelId','models'
      ]
      AND configuration-ARRAY[
        'providerKey','displayName','protocol','baseUrl','secretRef','defaultModelId','models'
      ]='{}'::jsonb
      AND configuration->>'providerKey'=object_key
      AND configuration->>'protocol'='openai-compatible'
      AND configuration->>'secretRef'='deployment:model'
      AND configuration->>'baseUrl' ~ '^https://'
      AND jsonb_typeof(configuration->'models')='array'
      AND jsonb_array_length(configuration->'models') BETWEEN 1 AND 100
    ) OR object_kind IN ('memory_provider','runtime_settings')
  );
