-- CHECK 使用内联 JSON 运算，保持严格名单和去重语义；CASE 拒绝非数组与 NULL。
-- 先解除旧约束依赖，再删除辅助函数，使整批迁移提交时满足禁止 routine 的安全边界。
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
        'enabledTools','toolCallingMode','workerMaxConcurrentRuns','userMaxConcurrentRunsPerTenant',
        'compactionSoftLimitPercent','compactionTargetPercent','compactionRecentUserTokens',
        'compactionMaxOutputTokens','compactionTimeoutMs'
      ]='{}'::jsonb
      AND (
        NOT (configuration ? 'toolCallingMode')
        OR (jsonb_typeof(configuration->'toolCallingMode')='string'
          AND configuration->>'toolCallingMode' IN ('native','ptc'))
      )
      AND (
        NOT (configuration ? 'enabledTools')
        OR CASE WHEN jsonb_typeof(configuration->'enabledTools')='array' THEN (
          (configuration->'enabledTools')-ARRAY[
            'exec_command','read','edit','write','skill','todo_write','deliver_file',
            'automation_update','spawn_agent','send_message','followup_task','wait_agent',
            'interrupt_agent','list_agents'
          ]='[]'::jsonb
          AND jsonb_array_length(configuration->'enabledTools')=(
            ((configuration->'enabledTools') ? 'exec_command')::integer +
            ((configuration->'enabledTools') ? 'read')::integer +
            ((configuration->'enabledTools') ? 'edit')::integer +
            ((configuration->'enabledTools') ? 'write')::integer +
            ((configuration->'enabledTools') ? 'skill')::integer +
            ((configuration->'enabledTools') ? 'todo_write')::integer +
            ((configuration->'enabledTools') ? 'deliver_file')::integer +
            ((configuration->'enabledTools') ? 'automation_update')::integer +
            ((configuration->'enabledTools') ? 'spawn_agent')::integer +
            ((configuration->'enabledTools') ? 'send_message')::integer +
            ((configuration->'enabledTools') ? 'followup_task')::integer +
            ((configuration->'enabledTools') ? 'wait_agent')::integer +
            ((configuration->'enabledTools') ? 'interrupt_agent')::integer +
            ((configuration->'enabledTools') ? 'list_agents')::integer
          )
        ) ELSE FALSE END
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
