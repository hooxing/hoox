CREATE TABLE artifact_deliverable_commands (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, idempotency_key),
  UNIQUE (tenant_id, run_id),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(
      tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id
    ) ON DELETE RESTRICT
);

CREATE TABLE artifact_deliverable_declarations (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  deliverable_key text NOT NULL CHECK (octet_length(deliverable_key) BETWEEN 1 AND 128),
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  requirement text NOT NULL CHECK (requirement IN ('required', 'optional')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id, deliverable_key),
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE artifact_publications (
  tenant_id text NOT NULL,
  id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  resource_id text NOT NULL,
  resource_version_id text NOT NULL,
  replaces_artifact_id text,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  purpose text NOT NULL CHECK (purpose IN ('deliverable', 'diagnostic', 'trace')),
  deliverable_key text,
  normalized_deliverable_key text GENERATED ALWAYS AS (coalesce(deliverable_key, '')) STORED,
  status text NOT NULL DEFAULT 'publishing' CHECK (status = 'publishing'),
  replacement_required_status text GENERATED ALWAYS AS (
    CASE WHEN replaces_artifact_id IS NULL THEN NULL ELSE 'failed' END
  ) STORED,
  blob_reference_id text NOT NULL,
  blob_purpose text NOT NULL CHECK (blob_purpose = 'resource'),
  blob_lifecycle_id uuid NOT NULL,
  blob_incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL CHECK (octet_length(media_type) BETWEEN 1 AND 255),
  size bigint NOT NULL CHECK (size BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, run_id),
  UNIQUE (tenant_id, id, run_id, purpose, normalized_deliverable_key),
  UNIQUE (tenant_id, id, attempt_id, run_id, thread_id, workspace_id, root_run_id),
  FOREIGN KEY (tenant_id, run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(
      tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id, resource_version_id)
    REFERENCES resource_versions(tenant_id, resource_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, replaces_artifact_id, run_id, purpose, normalized_deliverable_key
  ) REFERENCES artifact_publications(
    tenant_id, id, run_id, purpose, normalized_deliverable_key
  ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, run_id, deliverable_key)
    REFERENCES artifact_deliverable_declarations(tenant_id, run_id, deliverable_key) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, blob_reference_id, blob_purpose, digest, size,
    blob_lifecycle_id, blob_incarnation_id, physical_object_key
  ) REFERENCES blob_references(
    tenant_id, reference_id, purpose, sha256, size,
    lifecycle_id, incarnation_id, physical_object_key
  ) ON DELETE RESTRICT,
  CONSTRAINT artifact_deliverable_shape_check CHECK (
    (purpose = 'deliverable' AND deliverable_key IS NOT NULL)
    OR (purpose <> 'deliverable' AND deliverable_key IS NULL)
  )
);
CREATE INDEX artifact_publications_run_idx
  ON artifact_publications(tenant_id, run_id, created_at, id);

-- 终态采用仅追加事实，而不是可变 status；唯一行同时保证只允许一次 publishing→终态。
CREATE TABLE artifact_publication_settlements (
  tenant_id text NOT NULL,
  artifact_id text NOT NULL,
  target text NOT NULL CHECK (target IN ('published', 'failed')),
  settled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, artifact_id),
  UNIQUE (tenant_id, artifact_id, target),
  FOREIGN KEY (tenant_id, artifact_id) REFERENCES artifact_publications(tenant_id, id)
    ON DELETE RESTRICT
);

ALTER TABLE artifact_publications ADD CONSTRAINT artifact_replacement_failed_fk
  FOREIGN KEY (tenant_id, replaces_artifact_id, replacement_required_status)
  REFERENCES artifact_publication_settlements(tenant_id, artifact_id, target)
  ON DELETE RESTRICT;

CREATE TABLE artifact_publication_commands (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  artifact_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, idempotency_key),
  UNIQUE (tenant_id, artifact_id),
  FOREIGN KEY (
    tenant_id, artifact_id, attempt_id, run_id, thread_id, workspace_id, root_run_id
  ) REFERENCES artifact_publications(
    tenant_id, id, attempt_id, run_id, thread_id, workspace_id, root_run_id
  ) ON DELETE RESTRICT
);

ALTER TABLE artifact_deliverable_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_deliverable_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_deliverable_commands_tenant_policy ON artifact_deliverable_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE artifact_deliverable_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_deliverable_declarations FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_deliverable_declarations_tenant_policy ON artifact_deliverable_declarations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE artifact_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_publications_tenant_policy ON artifact_publications
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE artifact_publication_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_publication_settlements_tenant_policy ON artifact_publication_settlements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE artifact_publication_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_publication_commands_tenant_policy ON artifact_publication_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
