-- ADR-20260820090402：Provider 拥有 Pi 风格模型目录，平台控制启用集合与默认模型。
ALTER TABLE admin_control_config_revisions
  DROP CONSTRAINT admin_control_configuration_shape;

ALTER TABLE admin_control_config_revisions
  ADD CONSTRAINT admin_control_configuration_shape CHECK (
    (
      object_kind='model_provider'
      AND configuration ?& ARRAY[
        'providerKey','displayName','protocol','baseUrl','secretRef','defaultModelId','models'
      ]
      AND configuration-ARRAY[
        'providerKey','displayName','protocol','baseUrl','secretRef','defaultModelId','models'
      ]='{}'::jsonb
      AND configuration->>'protocol'='openai-compatible'
      AND configuration->>'secretRef'='deployment:model'
      AND configuration->>'providerKey'=object_key
      AND jsonb_typeof(configuration->'providerKey')='string'
      AND jsonb_typeof(configuration->'displayName')='string'
      AND jsonb_typeof(configuration->'baseUrl')='string'
      AND configuration->>'baseUrl' ~ '^https://'
      AND jsonb_typeof(configuration->'defaultModelId')='string'
      AND configuration->>'defaultModelId' ~ '^.{1,255}$'
      AND jsonb_typeof(configuration->'models')='array'
      AND jsonb_array_length(configuration->'models') BETWEEN 1 AND 100
      AND jsonb_array_length(jsonb_path_query_array(
        configuration,
        '$.models[*] ? (
          @.id.type() == "string" && @.id like_regex "^.{1,255}$" &&
          @.name.type() == "string" && @.name like_regex "^.{1,120}$" &&
          @.enabled.type() == "boolean" && @.reasoning.type() == "boolean" &&
          @.input.type() == "array" && @.input.size() >= 1 && @.input.size() <= 2 &&
          exists(@.input[*] ? (@ == "text")) &&
          !(exists(@.input[*] ? (@ != "text" && @ != "image"))) &&
          (@.input.size() == 1 || @.input[0] != @.input[1]) &&
          @.contextWindow.type() == "number" &&
          @.contextWindow == @.contextWindow.floor() &&
          @.contextWindow >= 1 && @.contextWindow <= 10000000 &&
          @.maxTokens.type() == "number" && @.maxTokens == @.maxTokens.floor() &&
          @.maxTokens >= 1 && @.maxTokens <= @.contextWindow
        )'
      ))=jsonb_array_length(configuration->'models')
      AND NOT jsonb_path_exists(
        configuration,
        '$.models[*].keyvalue() ? (
          @.key != "id" && @.key != "name" && @.key != "enabled" &&
          @.key != "reasoning" && @.key != "input" &&
          @.key != "contextWindow" && @.key != "maxTokens"
        )'
      )
      AND jsonb_path_exists(
        configuration,
        '$.models[*] ? (@.enabled == true && @.id == $.defaultModelId)'
      )
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
