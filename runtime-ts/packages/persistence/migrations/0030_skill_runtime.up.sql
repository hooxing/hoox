ALTER TABLE blob_lifecycles
  DROP CONSTRAINT blob_lifecycles_purpose_check,
  ADD CONSTRAINT blob_lifecycles_purpose_check CHECK (
    purpose IN ('workspace', 'resource', 'artifact', 'trace', 'preview', 'skill')
  );

ALTER TABLE blob_references
  DROP CONSTRAINT blob_references_purpose_check,
  ADD CONSTRAINT blob_references_purpose_check CHECK (
    purpose IN ('workspace', 'resource', 'artifact', 'trace', 'preview', 'skill')
  );

CREATE TABLE run_skill_snapshots (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  explicit_invocation_name text CHECK (
    explicit_invocation_name IS NULL
    OR explicit_invocation_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  explicit_args text CHECK (
    explicit_args IS NULL OR octet_length(explicit_args) <= 16384
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  CONSTRAINT run_skill_snapshots_explicit_shape_check CHECK (
    (explicit_invocation_name IS NULL AND explicit_args IS NULL)
    OR (explicit_invocation_name IS NOT NULL AND explicit_args IS NOT NULL)
  )
);

CREATE TABLE run_skill_snapshot_items (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 64),
  invocation_name text NOT NULL CHECK (
    invocation_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  canonical_key text NOT NULL CHECK (canonical_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  skill_id text NOT NULL,
  skill_version text NOT NULL,
  description text NOT NULL CHECK (
    octet_length(description) BETWEEN 1 AND 2048
    AND description !~ '[[:cntrl:]]'
  ),
  entrypoint_digest text NOT NULL CHECK (entrypoint_digest ~ '^[0-9a-f]{64}$'),
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, run_id, ordinal),
  UNIQUE (tenant_id, run_id, invocation_name),
  UNIQUE (tenant_id, run_id, invocation_name, skill_version),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES run_skill_snapshots(tenant_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (skill_id, skill_version)
    REFERENCES skill_versions(skill_id, version) ON DELETE RESTRICT
);

CREATE TABLE skill_invocations (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  invocation_id text NOT NULL CHECK (length(invocation_id) BETWEEN 1 AND 400),
  call_id text,
  source text NOT NULL CHECK (source IN ('explicit', 'tool')),
  invocation_name text NOT NULL,
  skill_version text NOT NULL,
  args_digest text NOT NULL CHECK (args_digest ~ '^[0-9a-f]{64}$'),
  instruction_digest text CHECK (instruction_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('loading', 'loaded', 'failed')),
  failure_code text CHECK (failure_code IN (
    'SKILL_NOT_INSTALLED', 'SKILL_REVOKED', 'SKILL_INCOMPATIBLE',
    'SKILL_CONTENT_UNAVAILABLE', 'SKILL_ARGUMENTS_INVALID',
    'SKILL_CONTEXT_LIMIT', 'SKILL_PROTOCOL'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id, attempt_id, invocation_id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, run_id, attempt_id, call_id),
  FOREIGN KEY (tenant_id, run_id, invocation_name, skill_version)
    REFERENCES run_skill_snapshot_items(tenant_id, run_id, invocation_name, skill_version)
    ON DELETE RESTRICT,
  CONSTRAINT skill_invocations_source_shape_check CHECK (
    (source = 'explicit' AND call_id IS NULL)
    OR (source = 'tool' AND call_id IS NOT NULL)
  ),
  CONSTRAINT skill_invocations_status_shape_check CHECK (
    (status = 'loading' AND instruction_digest IS NULL AND failure_code IS NULL)
    OR (status = 'loaded' AND instruction_digest IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed' AND failure_code IS NOT NULL)
  )
);

CREATE INDEX skill_invocations_loaded_packages_idx
  ON skill_invocations(tenant_id, run_id, attempt_id, invocation_name)
  WHERE status = 'loaded';

CREATE POLICY skills_runtime_snapshot_read_policy ON skills
  FOR SELECT USING (NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL);
CREATE POLICY skill_versions_runtime_snapshot_read_policy ON skill_versions
  FOR SELECT USING (NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL);
CREATE POLICY skill_version_files_runtime_snapshot_read_policy ON skill_version_files
  FOR SELECT USING (NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL);

ALTER TABLE run_skill_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_skill_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY run_skill_snapshots_tenant_policy ON run_skill_snapshots
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE run_skill_snapshot_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_skill_snapshot_items FORCE ROW LEVEL SECURITY;
CREATE POLICY run_skill_snapshot_items_tenant_policy ON run_skill_snapshot_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE skill_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_invocations_tenant_policy ON skill_invocations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
