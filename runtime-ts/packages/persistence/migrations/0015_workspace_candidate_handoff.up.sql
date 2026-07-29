-- Workspace 发布先把每个新 stable 引用绑定到 Attempt candidate；最终 RuntimeMutation 再在
-- 同一 SERIALIZABLE 事务中把引用交给 revision。released 引用只保留审计身份，不再参与 GC 可达性。
ALTER TABLE blob_references DROP CONSTRAINT blob_references_state_check;
ALTER TABLE blob_references
  ADD CONSTRAINT blob_references_state_check CHECK (state IN ('staged', 'stable', 'released'));
ALTER TABLE blob_references DROP CONSTRAINT blob_reference_target_shape_check;
ALTER TABLE blob_references
  ADD CONSTRAINT blob_reference_target_shape_check CHECK (
    (state = 'staged' AND lifecycle_id IS NULL AND incarnation_id IS NULL AND physical_object_key IS NULL)
    OR
    (state IN ('stable', 'released') AND lifecycle_id IS NOT NULL
      AND incarnation_id IS NOT NULL AND physical_object_key IS NOT NULL)
  );

CREATE TABLE workspace_revision_candidates (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  root_run_id text NOT NULL,
  parent_revision_id text,
  parent_revision_key text GENERATED ALWAYS AS (COALESCE(parent_revision_id, '')) STORED,
  revision_id text NOT NULL,
  operation_key text NOT NULL CHECK (
    octet_length(operation_key) BETWEEN 1 AND 256
  ),
  operation_digest text NOT NULL CHECK (operation_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest text CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('building', 'prepared', 'committed', 'released')),
  release_reason text CHECK (release_reason IN (
    'publish_failed', 'superseded', 'terminal', 'expired_recovery', 'manual_recovery'
  )),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, attempt_id, operation_key),
  UNIQUE (
    tenant_id, workspace_id, attempt_id, run_id, thread_id, root_run_id,
    parent_revision_key, revision_id, operation_key, operation_digest
  ),
  UNIQUE (tenant_id, workspace_id, revision_id),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(
      tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, parent_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_revision_candidate_state_shape CHECK (
    (status = 'building' AND manifest_digest IS NULL AND release_reason IS NULL)
    OR (status IN ('prepared', 'committed') AND manifest_digest IS NOT NULL AND release_reason IS NULL)
    OR (status = 'released' AND release_reason IS NOT NULL)
  )
);

CREATE TABLE workspace_revision_candidate_files (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  root_run_id text NOT NULL,
  parent_revision_id text,
  parent_revision_key text GENERATED ALWAYS AS (COALESCE(parent_revision_id, '')) STORED,
  revision_id text NOT NULL,
  operation_key text NOT NULL,
  operation_digest text NOT NULL CHECK (operation_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest text CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  relative_path text NOT NULL CHECK (
    length(relative_path) BETWEEN 1 AND 4096
    AND relative_path !~ '(^/|\\|(^|/)\.\.?(/|$)|[[:cntrl:]])'
  ),
  source text NOT NULL CHECK (source IN ('base', 'uploaded')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0 AND size <= 9007199254740991),
  blob_lifecycle_id uuid NOT NULL,
  blob_incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  blob_reference_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, attempt_id, operation_key, relative_path),
  FOREIGN KEY (
    tenant_id, workspace_id, attempt_id, run_id, thread_id, root_run_id,
    parent_revision_key, revision_id, operation_key, operation_digest
  ) REFERENCES workspace_revision_candidates(
    tenant_id, workspace_id, attempt_id, run_id, thread_id, root_run_id,
    parent_revision_key, revision_id, operation_key, operation_digest
  ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, blob_lifecycle_id, blob_incarnation_id, physical_object_key)
    REFERENCES blob_incarnations(tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, blob_reference_id)
    REFERENCES blob_references(tenant_id, reference_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_revision_candidate_file_source_shape CHECK (
    (source = 'base' AND blob_reference_id IS NULL)
    OR (source = 'uploaded' AND blob_reference_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX workspace_revision_candidate_files_reference_unique
  ON workspace_revision_candidate_files (tenant_id, blob_reference_id)
  WHERE blob_reference_id IS NOT NULL;
CREATE INDEX workspace_revision_candidates_recovery_idx
  ON workspace_revision_candidates (tenant_id, attempt_id, status, expires_at)
  WHERE status IN ('building', 'prepared');

ALTER TABLE workspace_revision_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_revision_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_revision_candidates_isolation_policy ON workspace_revision_candidates
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE workspace_revision_candidate_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_revision_candidate_files FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_revision_candidate_files_isolation_policy
  ON workspace_revision_candidate_files
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE ALL ON workspace_revision_candidates, workspace_revision_candidate_files FROM PUBLIC;
