-- ADR-20260910005916：配置版本不可变，远端实例在创建前固定版本，停用新建不影响旧实例清理。
CREATE TABLE sandbox_provider_profiles (
  provider_key text NOT NULL CHECK (provider_key IN ('cube','e2b','tencent-ags')),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration)='object' AND octet_length(configuration::text) <= 16384),
  credential jsonb CHECK (credential IS NULL OR (
    jsonb_typeof(credential)='object' AND credential->>'version'='1'
    AND credential ?& ARRAY['nonce','ciphertext','authTag']
    AND octet_length(credential::text) <= 32768
  )),
  created_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_key,revision),
  CHECK (configuration->>'providerKey'=provider_key),
  CHECK (configuration ?& ARRAY['providerKey','displayName','endpoint','credentialConfigured','policy']),
  CHECK (configuration-ARRAY['providerKey','displayName','endpoint','credentialConfigured','policy']='{}'::jsonb)
);

CREATE TABLE sandbox_routing_revisions (
  revision bigint PRIMARY KEY CHECK (revision BETWEEN 1 AND 9007199254740991),
  mode text NOT NULL CHECK (mode IN ('single','weighted')),
  created_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE sandbox_routing_targets (
  routing_revision bigint NOT NULL REFERENCES sandbox_routing_revisions(revision),
  provider_key text NOT NULL,
  profile_revision bigint NOT NULL,
  weight integer NOT NULL CHECK (weight BETWEEN 1 AND 1000),
  PRIMARY KEY (routing_revision,provider_key),
  UNIQUE (routing_revision,provider_key,profile_revision),
  FOREIGN KEY (provider_key,profile_revision) REFERENCES sandbox_provider_profiles(provider_key,revision)
);

CREATE TABLE sandbox_control_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
  routing_revision bigint REFERENCES sandbox_routing_revisions(revision)
);
INSERT INTO sandbox_control_head(singleton) VALUES(true);

CREATE TABLE sandbox_profile_probes (
  probe_id text PRIMARY KEY,
  provider_key text NOT NULL,
  profile_revision bigint NOT NULL,
  healthy boolean NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 0 AND 3600000),
  actor_user_id text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_key,profile_revision) REFERENCES sandbox_provider_profiles(provider_key,revision)
);

CREATE TABLE sandbox_control_audits (
  audit_id text PRIMARY KEY,
  generation bigint NOT NULL,
  actor_user_id text NOT NULL REFERENCES app_users(id),
  action text NOT NULL CHECK (action IN ('save_profile','publish_routing','probe')),
  provider_key text CHECK (provider_key IN ('cube','e2b','tencent-ags')),
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE sandbox_configuration_bindings (
  tenant_id text NOT NULL REFERENCES tenants(id),
  registry_id text NOT NULL,
  routing_revision bigint NOT NULL REFERENCES sandbox_routing_revisions(revision),
  provider_key text NOT NULL,
  profile_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,registry_id),
  FOREIGN KEY (provider_key,profile_revision) REFERENCES sandbox_provider_profiles(provider_key,revision),
  FOREIGN KEY (routing_revision,provider_key,profile_revision) REFERENCES sandbox_routing_targets(routing_revision,provider_key,profile_revision)
);

DO $$
DECLARE
  migrator_role text := current_user;
  control_role text := current_setting('app.admin_control_role');
  runtime_role text := current_setting('app.runtime_role');
  table_name text;
  actor_check text := 'EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'')';
  admin_check text := 'EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')';
BEGIN
  FOREACH table_name IN ARRAY ARRAY['sandbox_provider_profiles','sandbox_routing_revisions','sandbox_routing_targets','sandbox_control_head','sandbox_profile_probes','sandbox_control_audits','sandbox_configuration_bindings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY migrator_all ON %I FOR ALL TO %I USING(true) WITH CHECK(true)',table_name,migrator_role);
    IF table_name <> 'sandbox_configuration_bindings' THEN
      EXECUTE format('GRANT SELECT,INSERT ON %I TO %I',table_name,control_role);
      EXECUTE format('CREATE POLICY control_read ON %I FOR SELECT TO %I USING (%s)',table_name,control_role,actor_check);
      EXECUTE format('CREATE POLICY control_insert ON %I FOR INSERT TO %I WITH CHECK (%s)',table_name,control_role,admin_check);
    END IF;
  END LOOP;
  EXECUTE format('GRANT UPDATE(generation,routing_revision) ON sandbox_control_head TO %I',control_role);
  EXECUTE format('CREATE POLICY control_update ON sandbox_control_head FOR UPDATE TO %I USING (%s) WITH CHECK (%s)',control_role,admin_check,admin_check);
  EXECUTE format('GRANT SELECT ON sandbox_control_head,sandbox_routing_revisions,sandbox_routing_targets,sandbox_provider_profiles TO %I',runtime_role);
  FOREACH table_name IN ARRAY ARRAY['sandbox_control_head','sandbox_routing_revisions','sandbox_routing_targets'] LOOP
    EXECUTE format('CREATE POLICY runtime_read ON %I FOR SELECT TO %I USING (true)',table_name,runtime_role);
  END LOOP;
  EXECUTE format('CREATE POLICY runtime_profile_read ON sandbox_provider_profiles FOR SELECT TO %I USING (
    EXISTS(SELECT 1 FROM sandbox_control_head head JOIN sandbox_routing_targets target ON target.routing_revision=head.routing_revision
      WHERE target.provider_key=sandbox_provider_profiles.provider_key AND target.profile_revision=sandbox_provider_profiles.revision)
    OR EXISTS(SELECT 1 FROM sandbox_configuration_bindings binding WHERE binding.provider_key=sandbox_provider_profiles.provider_key AND binding.profile_revision=sandbox_provider_profiles.revision)
  )',runtime_role);
  EXECUTE format('GRANT SELECT,INSERT ON sandbox_configuration_bindings TO %I',runtime_role);
  EXECUTE format('CREATE POLICY runtime_binding_read ON sandbox_configuration_bindings FOR SELECT TO %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),''''))',runtime_role);
  EXECUTE format('CREATE POLICY runtime_binding_insert ON sandbox_configuration_bindings FOR INSERT TO %I WITH CHECK (
    tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''') AND EXISTS (
      SELECT 1 FROM sandbox_control_head head JOIN sandbox_routing_targets target ON target.routing_revision=head.routing_revision
      WHERE target.routing_revision=sandbox_configuration_bindings.routing_revision AND target.provider_key=sandbox_configuration_bindings.provider_key AND target.profile_revision=sandbox_configuration_bindings.profile_revision)
  )',runtime_role);
END $$;
