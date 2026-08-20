DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM admin_control_config_revisions WHERE object_kind='model_provider'
  ) THEN
    RAISE EXCEPTION '已有模型目录配置事实，禁止降级为单模型结构';
  END IF;
END $$;

ALTER TABLE admin_control_config_revisions
  DROP CONSTRAINT admin_control_configuration_shape;

ALTER TABLE admin_control_config_revisions
  ADD CONSTRAINT admin_control_configuration_shape CHECK (
    (
      object_kind='model_provider'
      AND configuration ?& ARRAY[
        'providerKey','displayName','protocol','baseUrl','secretRef','modelId',
        'supportsImages','contextWindow','maxOutputTokens'
      ]
      AND configuration-ARRAY[
        'providerKey','displayName','protocol','baseUrl','secretRef','modelId',
        'supportsImages','contextWindow','maxOutputTokens'
      ]='{}'::jsonb
      AND configuration->>'protocol'='openai-compatible'
      AND configuration->>'secretRef'='deployment:model'
      AND configuration->>'providerKey'=object_key
      AND jsonb_typeof(configuration->'providerKey')='string'
      AND jsonb_typeof(configuration->'displayName')='string'
      AND jsonb_typeof(configuration->'baseUrl')='string'
      AND configuration->>'baseUrl' ~ '^https://'
      AND jsonb_typeof(configuration->'modelId')='string'
      AND jsonb_typeof(configuration->'supportsImages')='boolean'
      AND jsonb_typeof(configuration->'contextWindow')='number'
      AND jsonb_typeof(configuration->'maxOutputTokens')='number'
      AND configuration->>'contextWindow' ~ '^[1-9][0-9]{0,7}$'
      AND configuration->>'maxOutputTokens' ~ '^[1-9][0-9]{0,7}$'
      AND (configuration->>'contextWindow')::bigint BETWEEN 1 AND 10000000
      AND (configuration->>'maxOutputTokens')::bigint
          BETWEEN 1 AND (configuration->>'contextWindow')::bigint
    ) OR (
      object_kind='memory_provider'
      AND configuration ?& ARRAY[
        'providerKey','displayName','providerKind','baseUrl','apiSecretRef','scopeSecretRef',
        'requestTimeoutMs','enabled'
      ]
      AND configuration-ARRAY[
        'providerKey','displayName','providerKind','baseUrl','apiSecretRef','scopeSecretRef',
        'requestTimeoutMs','enabled'
      ]='{}'::jsonb
      AND configuration->>'providerKind'='mem0'
      AND configuration->>'apiSecretRef'='deployment:memory-api'
      AND configuration->>'scopeSecretRef'='deployment:memory-scope'
      AND configuration->>'providerKey'=object_key
      AND jsonb_typeof(configuration->'providerKey')='string'
      AND jsonb_typeof(configuration->'displayName')='string'
      AND jsonb_typeof(configuration->'baseUrl')='string'
      AND configuration->>'baseUrl' ~ '^https://'
      AND jsonb_typeof(configuration->'requestTimeoutMs')='number'
      AND jsonb_typeof(configuration->'enabled')='boolean'
      AND configuration->>'requestTimeoutMs' ~ '^[1-9][0-9]{2,5}$'
      AND (configuration->>'requestTimeoutMs')::bigint BETWEEN 100 AND 120000
    ) OR (
      object_kind='runtime_settings'
      AND object_key='global'
      AND configuration ?& ARRAY[
        'compactionSoftLimitPercent','compactionTargetPercent','compactionRecentUserTokens',
        'compactionMaxOutputTokens','compactionTimeoutMs'
      ]
      AND configuration-ARRAY[
        'compactionSoftLimitPercent','compactionTargetPercent','compactionRecentUserTokens',
        'compactionMaxOutputTokens','compactionTimeoutMs'
      ]='{}'::jsonb
      AND jsonb_typeof(configuration->'compactionSoftLimitPercent')='number'
      AND jsonb_typeof(configuration->'compactionTargetPercent')='number'
      AND jsonb_typeof(configuration->'compactionRecentUserTokens')='number'
      AND jsonb_typeof(configuration->'compactionMaxOutputTokens')='number'
      AND jsonb_typeof(configuration->'compactionTimeoutMs')='number'
      AND configuration->>'compactionSoftLimitPercent' ~ '^[0-9]+$'
      AND configuration->>'compactionTargetPercent' ~ '^[0-9]+$'
      AND configuration->>'compactionRecentUserTokens' ~ '^[0-9]+$'
      AND configuration->>'compactionMaxOutputTokens' ~ '^[0-9]+$'
      AND configuration->>'compactionTimeoutMs' ~ '^[0-9]+$'
      AND (configuration->>'compactionSoftLimitPercent')::bigint BETWEEN 50 AND 95
      AND (configuration->>'compactionTargetPercent')::bigint BETWEEN 20 AND 90
      AND (configuration->>'compactionTargetPercent')::bigint
          < (configuration->>'compactionSoftLimitPercent')::bigint
      AND (configuration->>'compactionRecentUserTokens')::bigint BETWEEN 1 AND 1000000
      AND (configuration->>'compactionMaxOutputTokens')::bigint BETWEEN 128 AND 1000000
      AND (configuration->>'compactionTimeoutMs')::bigint BETWEEN 1000 AND 600000
    )
  );
