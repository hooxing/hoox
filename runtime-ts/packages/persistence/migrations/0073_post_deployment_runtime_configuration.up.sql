-- 扩展可选后台设置，历史修订保持原值；Provider 密钥仍由既有版本持有。
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
        'titleGeneration','compactionEnabled','enabledTools','toolCallingMode','workerMaxConcurrentRuns','userMaxConcurrentRunsPerTenant',
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
      AND (NOT (configuration ? 'compactionEnabled') OR jsonb_typeof(configuration->'compactionEnabled')='boolean')
      AND (NOT (configuration ? 'titleGeneration') OR COALESCE(
        CASE WHEN jsonb_typeof(configuration->'titleGeneration')='object' THEN
          CASE WHEN configuration->'titleGeneration'->'enabled'='false'::jsonb THEN
            (configuration->'titleGeneration')-ARRAY['enabled']='{}'::jsonb
          WHEN configuration->'titleGeneration'->'enabled'='true'::jsonb THEN
            configuration->'titleGeneration' ?& ARRAY['enabled','providerKey','providerRevision','modelId']
            AND (configuration->'titleGeneration')-ARRAY['enabled','providerKey','providerRevision','modelId']='{}'::jsonb
            AND jsonb_typeof(configuration->'titleGeneration'->'providerKey')='string'
            AND configuration->'titleGeneration'->>'providerKey' ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
            AND jsonb_typeof(configuration->'titleGeneration'->'providerRevision')='number'
            AND configuration->'titleGeneration'->>'providerRevision' ~ '^[1-9][0-9]*$'
            AND (configuration->'titleGeneration'->>'providerRevision')::numeric <= 9007199254740991
            AND jsonb_typeof(configuration->'titleGeneration'->'modelId')='string'
            AND length(configuration->'titleGeneration'->>'modelId') BETWEEN 1 AND 512
          ELSE FALSE END
        ELSE FALSE END, FALSE))
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

-- 以 Migrator 权限只投影当前标题引用，避免 Runtime 策略递归读取配置修订表。
CREATE VIEW runtime_title_model_reference WITH (security_barrier=true) AS
SELECT revision.configuration->'titleGeneration'->>'providerKey' AS provider_key,
       (revision.configuration->'titleGeneration'->>'providerRevision')::bigint AS provider_revision
FROM admin_control_active_configs active
JOIN admin_control_config_revisions revision USING(object_kind,object_key,revision)
WHERE active.object_kind='runtime_settings' AND active.object_key='global'
  AND revision.configuration->'titleGeneration'->'enabled'='true'::jsonb;
REVOKE ALL ON runtime_title_model_reference FROM PUBLIC;
DO $$
DECLARE
  runtime_role text := current_setting('app.runtime_role');
BEGIN
  EXECUTE format('GRANT SELECT ON runtime_title_model_reference TO %I',runtime_role);
  EXECUTE format('CREATE POLICY runtime_title_model_revisions_read_policy ON admin_control_config_revisions FOR SELECT TO %I USING (
    object_kind=''model_provider'' AND EXISTS (
      SELECT 1 FROM runtime_title_model_reference reference
      WHERE reference.provider_key=admin_control_config_revisions.object_key
        AND reference.provider_revision=admin_control_config_revisions.revision
    )
  )',runtime_role);
END $$;
