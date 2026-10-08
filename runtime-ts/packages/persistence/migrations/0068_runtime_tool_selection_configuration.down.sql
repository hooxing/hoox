-- 历史字段（包括空数组）与 Revision 摘要不可抹去；持锁检查后才允许恢复旧约束。
LOCK TABLE admin_control_config_revisions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM admin_control_config_revisions
    WHERE object_kind='runtime_settings' AND configuration ? 'enabledTools'
  ) THEN
    RAISE EXCEPTION 'DOWN_MIGRATION_BLOCKED:runtime_tool_selection_configuration_exists';
  END IF;
END;
$$;

ALTER TABLE admin_control_config_revisions DROP CONSTRAINT admin_control_configuration_shape;
ALTER TABLE admin_control_config_revisions
  ADD CONSTRAINT admin_control_configuration_shape CHECK (
    (
      object_kind='model_provider'
      AND configuration->>'providerKey'=object_key
      AND configuration->>'protocol'='openai-compatible'
      AND configuration->>'baseUrl' ~ '^https://'
      AND jsonb_typeof(configuration->'models')='array'
      AND jsonb_array_length(configuration->'models') BETWEEN 1 AND 100
      AND jsonb_typeof(configuration->'defaultModelId')='string'
      AND (
        (
          configuration ?& ARRAY[
            'providerKey','displayName','protocol','baseUrl','secretRef','defaultModelId','models'
          ]
          AND configuration-ARRAY[
            'providerKey','displayName','protocol','baseUrl','secretRef','defaultModelId','models'
          ]='{}'::jsonb
          AND configuration->>'secretRef'='deployment:model'
        ) OR (
          configuration ?& ARRAY[
            'providerKey','displayName','protocol','baseUrl','defaultModelId','models','credential'
          ]
          AND configuration-ARRAY[
            'providerKey','displayName','protocol','baseUrl','defaultModelId','models','credential'
          ]='{}'::jsonb
          AND jsonb_typeof(configuration->'credential')='object'
          AND configuration->'credential' ?& ARRAY['version','nonce','ciphertext','authTag']
          AND (configuration->'credential')-ARRAY['version','nonce','ciphertext','authTag']='{}'::jsonb
          AND configuration->'credential'->>'version'='1'
          AND configuration->'credential'->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
          AND configuration->'credential'->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
          AND configuration->'credential'->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
        )
      )
      AND jsonb_path_exists(
        configuration,
        '$.models[*] ? (@.enabled == true && @.id == $.defaultModelId)'
      )
      AND jsonb_array_length(jsonb_path_query_array(
        configuration,
        '$.models[*] ? (
          @.id.type() == "string" && @.name.type() == "string" &&
          @.enabled.type() == "boolean" && @.reasoning.type() == "boolean" &&
          @.input.type() == "array" && exists(@.input[*] ? (@ == "text")) &&
          @.contextWindow.type() == "number" && @.contextWindow >= 1 &&
          @.maxTokens.type() == "number" && @.maxTokens >= 1 &&
          @.maxTokens <= @.contextWindow
        )'
      ))=jsonb_array_length(configuration->'models')
    ) OR (
      object_kind='memory_provider'
      AND configuration ?& ARRAY[
        'providerKey','displayName','providerKind','baseUrl','apiSecretRef','scopeSecretRef',
        'requestTimeoutMs','enabled'
      ]
      AND configuration-ARRAY[
        'providerKey','displayName','providerKind','baseUrl','apiSecretRef','scopeSecretRef',
        'requestTimeoutMs','enabled','credential'
      ]='{}'::jsonb
      AND configuration->>'providerKey'=object_key
      AND configuration->>'providerKind'='mem0'
      AND (
        (configuration->>'apiSecretRef'='deployment:memory-api' AND NOT configuration ? 'credential')
        OR (configuration->>'apiSecretRef'='managed:memory-api'
          AND configuration ? 'credential'
          AND jsonb_typeof(configuration->'credential')='object'
          AND configuration->'credential' ?& ARRAY['version','nonce','ciphertext','authTag']
          AND (configuration->'credential')-ARRAY['version','nonce','ciphertext','authTag']='{}'::jsonb
          AND configuration->'credential'->>'version'='1'
          AND configuration->'credential'->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
          AND configuration->'credential'->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
          AND configuration->'credential'->>'authTag' ~ '^[A-Za-z0-9_-]{22}$')
      )
      AND configuration->>'scopeSecretRef' IN ('deployment:memory-scope','platform:memory-scope')
      AND configuration->>'baseUrl' ~ '^https://'
      AND jsonb_typeof(configuration->'enabled')='boolean'
      AND (configuration->>'requestTimeoutMs')::bigint BETWEEN 100 AND 120000
    ) OR (
      object_kind='runtime_settings'
      AND object_key='global'
      AND configuration ?& ARRAY[
        'workerMaxConcurrentRuns','userMaxConcurrentRunsPerTenant',
        'compactionSoftLimitPercent','compactionTargetPercent','compactionRecentUserTokens',
        'compactionMaxOutputTokens','compactionTimeoutMs'
      ]
      AND configuration-ARRAY[
        'toolCallingMode','workerMaxConcurrentRuns','userMaxConcurrentRunsPerTenant',
        'compactionSoftLimitPercent','compactionTargetPercent','compactionRecentUserTokens',
        'compactionMaxOutputTokens','compactionTimeoutMs'
      ]='{}'::jsonb
      AND (
        NOT (configuration ? 'toolCallingMode')
        OR (jsonb_typeof(configuration->'toolCallingMode')='string'
          AND configuration->>'toolCallingMode' IN ('native','ptc'))
      )
      AND (configuration->>'workerMaxConcurrentRuns')::bigint BETWEEN 1 AND 100
      AND (configuration->>'userMaxConcurrentRunsPerTenant')::bigint BETWEEN 1 AND 100
      AND (configuration->>'compactionSoftLimitPercent')::bigint BETWEEN 50 AND 95
      AND (configuration->>'compactionTargetPercent')::bigint BETWEEN 20 AND 90
      AND (configuration->>'compactionTargetPercent')::bigint
          < (configuration->>'compactionSoftLimitPercent')::bigint
      AND (configuration->>'compactionRecentUserTokens')::bigint BETWEEN 1 AND 1000000
      AND (configuration->>'compactionMaxOutputTokens')::bigint BETWEEN 128 AND 1000000
      AND (configuration->>'compactionTimeoutMs')::bigint BETWEEN 1000 AND 600000
    )
  );

DROP FUNCTION runtime_tool_selection_is_valid(jsonb);
