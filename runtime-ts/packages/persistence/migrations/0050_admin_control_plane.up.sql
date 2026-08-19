-- ADR-20260819165254：独立后台控制面、不可变配置 revision 与 Run 固定快照。
DO $$
DECLARE
  control_role text := NULLIF(current_setting('app.admin_control_role', true), '');
  runtime_role text := NULLIF(current_setting('app.runtime_role', true), '');
BEGIN
  IF control_role IS NULL OR control_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.admin_control_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
  IF runtime_role IS NULL OR runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.runtime_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
  IF control_role = runtime_role THEN
    RAISE EXCEPTION 'Admin Control 与 Runtime 必须使用不同角色';
  END IF;
END $$;

CREATE TABLE platform_control_operators (
  user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('viewer','operator','admin')),
  status text NOT NULL CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE admin_control_config_revisions (
  object_kind text NOT NULL CHECK (object_kind IN ('model_provider','memory_provider','runtime_settings')),
  object_key text NOT NULL CHECK (object_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  configuration jsonb NOT NULL CHECK (
    jsonb_typeof(configuration)='object' AND octet_length(configuration::text) BETWEEN 2 AND 65536
  ),
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT admin_control_configuration_shape CHECK (
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
  ),
  PRIMARY KEY (object_kind,object_key,revision),
  UNIQUE (object_kind,object_key,configuration_digest)
);

CREATE TABLE admin_control_provider_probes (
  object_kind text NOT NULL CHECK (object_kind IN ('model_provider','memory_provider')),
  object_key text NOT NULL,
  revision bigint NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  status text NOT NULL CHECK (status IN ('healthy','failed')),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 2000),
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (object_kind,object_key,revision,sequence),
  FOREIGN KEY (object_kind,object_key,revision)
    REFERENCES admin_control_config_revisions(object_kind,object_key,revision) ON DELETE RESTRICT
);

CREATE TABLE admin_control_active_configs (
  object_kind text PRIMARY KEY CHECK (object_kind IN ('model_provider','memory_provider','runtime_settings')),
  object_key text NOT NULL,
  revision bigint NOT NULL,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  activated_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 2000),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (object_kind,object_key,revision)
    REFERENCES admin_control_config_revisions(object_kind,object_key,revision) ON DELETE RESTRICT
);

CREATE TABLE admin_control_activation_events (
  generation bigint PRIMARY KEY CHECK (generation BETWEEN 1 AND 9007199254740991),
  object_kind text NOT NULL,
  object_key text NOT NULL,
  revision bigint NOT NULL,
  replaced_object_key text,
  replaced_revision bigint,
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (object_kind,object_key,revision)
    REFERENCES admin_control_config_revisions(object_kind,object_key,revision) ON DELETE RESTRICT,
  CONSTRAINT admin_control_activation_replaced_shape CHECK (
    (replaced_object_key IS NULL)=(replaced_revision IS NULL)
  )
);

CREATE TABLE admin_control_commands (
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id,idempotency_key)
);

CREATE TABLE admin_control_audits (
  audit_id text PRIMARY KEY CHECK (audit_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'),
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  object_kind text NOT NULL CHECK (object_kind IN ('model_provider','memory_provider','runtime_settings')),
  object_key text NOT NULL CHECK (object_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  action text NOT NULL CHECK (action IN ('create_draft','probe','publish','rollback')),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 2000),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admin_control_audits_created_idx ON admin_control_audits(created_at DESC,audit_id DESC);

CREATE TABLE admin_control_generation (
  singleton text PRIMARY KEY CHECK (singleton='global'),
  generation bigint NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO admin_control_generation(singleton,generation) VALUES ('global',0);

CREATE TABLE run_runtime_config_snapshots (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  model_object_kind text NOT NULL DEFAULT 'model_provider' CHECK (model_object_kind='model_provider'),
  model_object_key text NOT NULL,
  model_revision bigint NOT NULL,
  memory_object_kind text CHECK (memory_object_kind IS NULL OR memory_object_kind='memory_provider'),
  memory_object_key text,
  memory_revision bigint,
  runtime_settings_object_kind text CHECK (
    runtime_settings_object_kind IS NULL OR runtime_settings_object_kind='runtime_settings'
  ),
  runtime_settings_object_key text,
  runtime_settings_revision bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (model_object_kind,model_object_key,model_revision)
    REFERENCES admin_control_config_revisions(object_kind,object_key,revision) ON DELETE RESTRICT,
  FOREIGN KEY (memory_object_kind,memory_object_key,memory_revision)
    REFERENCES admin_control_config_revisions(object_kind,object_key,revision) ON DELETE RESTRICT,
  FOREIGN KEY (runtime_settings_object_kind,runtime_settings_object_key,runtime_settings_revision)
    REFERENCES admin_control_config_revisions(object_kind,object_key,revision) ON DELETE RESTRICT,
  CONSTRAINT run_runtime_config_memory_shape CHECK (
    (memory_object_kind IS NULL)=(memory_object_key IS NULL)
    AND (memory_object_key IS NULL)=(memory_revision IS NULL)
  ),
  CONSTRAINT run_runtime_config_settings_shape CHECK (
    (runtime_settings_object_kind IS NULL)=(runtime_settings_object_key IS NULL)
    AND (runtime_settings_object_key IS NULL)=(runtime_settings_revision IS NULL)
  )
);

ALTER TABLE platform_control_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_control_operators FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_control_config_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_control_config_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_control_provider_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_control_provider_probes FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_control_active_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_control_active_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_control_activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_control_activation_events FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_control_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_control_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_control_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_control_audits FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_control_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_control_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE run_runtime_config_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_runtime_config_snapshots FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  migrator_role text := current_user;
  control_role text := current_setting('app.admin_control_role');
  runtime_role text := current_setting('app.runtime_role');
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'platform_control_operators','admin_control_config_revisions','admin_control_provider_probes',
    'admin_control_active_configs','admin_control_activation_events','admin_control_commands',
    'admin_control_audits','admin_control_generation','run_runtime_config_snapshots'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)',
      table_name || '_migrator_policy', table_name, migrator_role
    );
  END LOOP;

  EXECUTE format(
    'CREATE POLICY platform_control_operators_self_policy ON platform_control_operators FOR SELECT TO %I USING (user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'')',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY admin_control_revisions_read_policy ON admin_control_config_revisions FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active''))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY admin_control_revisions_insert_policy ON admin_control_config_revisions FOR INSERT TO %I WITH CHECK (created_by=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=created_by AND actor.status=''active'' AND actor.role IN (''operator'',''admin'')))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY admin_control_probes_policy ON admin_control_provider_probes FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=actor_user_id AND actor.status=''active'' AND actor.role IN (''operator'',''admin'')))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY admin_control_active_policy ON admin_control_active_configs FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'')) WITH CHECK (activated_by=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=activated_by AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY admin_control_activation_events_policy ON admin_control_activation_events FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=actor_user_id AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY admin_control_commands_policy ON admin_control_commands FOR ALL TO %I USING (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),''''))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY admin_control_audits_policy ON admin_control_audits FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),''''))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY admin_control_generation_policy ON admin_control_generation FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'')) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );

  EXECUTE format(
    'CREATE POLICY runtime_control_revisions_read_policy ON admin_control_config_revisions FOR SELECT TO %I USING (
       EXISTS (
         SELECT 1 FROM admin_control_active_configs active
          WHERE active.object_kind=admin_control_config_revisions.object_kind
            AND active.object_key=admin_control_config_revisions.object_key
            AND active.revision=admin_control_config_revisions.revision
       ) OR EXISTS (
         SELECT 1 FROM run_runtime_config_snapshots snapshot
          WHERE snapshot.tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')
            AND (
              (admin_control_config_revisions.object_kind=''model_provider''
               AND snapshot.model_object_key=admin_control_config_revisions.object_key
               AND snapshot.model_revision=admin_control_config_revisions.revision)
              OR (admin_control_config_revisions.object_kind=''memory_provider''
                  AND snapshot.memory_object_key=admin_control_config_revisions.object_key
                  AND snapshot.memory_revision=admin_control_config_revisions.revision)
              OR (admin_control_config_revisions.object_kind=''runtime_settings''
                  AND snapshot.runtime_settings_object_key=admin_control_config_revisions.object_key
                  AND snapshot.runtime_settings_revision=admin_control_config_revisions.revision)
            )
       )
     )',
    runtime_role
  );
  EXECUTE format(
    'CREATE POLICY runtime_control_active_read_policy ON admin_control_active_configs FOR SELECT TO %I USING (true)',
    runtime_role
  );
  EXECUTE format(
    'CREATE POLICY runtime_control_generation_read_policy ON admin_control_generation FOR SELECT TO %I USING (true)',
    runtime_role
  );
  EXECUTE format(
    'CREATE POLICY run_runtime_config_snapshots_runtime_policy ON run_runtime_config_snapshots FOR ALL TO %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),''''))',
    runtime_role
  );
END $$;

-- View 由 Migrator 拥有且只返回计数；Admin Control 不取得底层 Tenant 行的 SELECT。
CREATE VIEW admin_runtime_statistics WITH (security_barrier=true) AS
SELECT
  clock_timestamp() AS generated_at,
  (SELECT count(*)::bigint FROM runs) AS runs_total,
  (SELECT count(*)::bigint FROM runs WHERE status='queued') AS runs_queued,
  (SELECT count(*)::bigint FROM runs WHERE status='running') AS runs_running,
  (SELECT count(*)::bigint FROM runs WHERE status='succeeded' AND updated_at>=clock_timestamp()-interval '24 hours') AS runs_succeeded_24h,
  (SELECT count(*)::bigint FROM runs WHERE status='failed' AND updated_at>=clock_timestamp()-interval '24 hours') AS runs_failed_24h,
  (SELECT count(*)::bigint FROM runs WHERE status='cancelled' AND updated_at>=clock_timestamp()-interval '24 hours') AS runs_cancelled_24h,
  (SELECT count(*)::bigint FROM run_dispatch_outbox WHERE state='ready') AS dispatch_pending,
  (SELECT count(*)::bigint FROM run_dispatch_outbox WHERE state='claimed') AS dispatch_claimed,
  (SELECT count(*)::bigint FROM sandbox_registry WHERE state='ready') AS sandboxes_active,
  (SELECT count(*)::bigint FROM sandbox_registry WHERE state='paused') AS sandboxes_paused,
  (SELECT count(*)::bigint FROM cleanup_outbox WHERE state IN ('pending','started','unknown')) AS sandbox_cleanup_pending,
  (SELECT count(*)::bigint FROM memory_ingestion_outbox WHERE state IN ('pending','claimed','submitted')) AS memory_pending,
  (SELECT count(*)::bigint FROM memory_ingestion_outbox WHERE state='failed') AS memory_failed,
  (SELECT count(*)::bigint FROM scheduled_tasks WHERE status='active') AS automations_active,
  (SELECT count(*)::bigint FROM scheduled_task_occurrences WHERE state='failed' AND updated_at>=clock_timestamp()-interval '24 hours') AS automation_failed_occurrences_24h,
  (SELECT count(*)::bigint FROM skill_versions WHERE status='available') AS skills_published,
  (SELECT count(*)::bigint FROM tenant_skill_installations WHERE status IN ('enabled','disabled')) AS skills_installed;
