CREATE TABLE blob_lifecycles (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  lifecycle_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('workspace', 'resource', 'artifact', 'trace', 'preview')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0 AND size <= 9007199254740991),
  state text NOT NULL CHECK (state IN ('active', 'pre_delete', 'deleting', 'deleted')),
  current_incarnation_id uuid,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 9007199254740991),
  current_claim_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, lifecycle_id),
  UNIQUE (tenant_id, purpose, sha256, size),
  UNIQUE (tenant_id, lifecycle_id, purpose, sha256, size),
  CONSTRAINT blob_lifecycle_claim_shape_check CHECK (
    (state IN ('active', 'deleted') AND current_claim_id IS NULL AND lease_expires_at IS NULL)
    OR
    (state IN ('pre_delete', 'deleting') AND current_claim_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE TABLE blob_incarnations (
  tenant_id text NOT NULL,
  lifecycle_id uuid NOT NULL,
  purpose text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL,
  incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL CHECK (
    length(physical_object_key) BETWEEN 1 AND 1024
    AND physical_object_key !~ '[[:cntrl:]\\]'
    AND physical_object_key !~ '(^/|//|/$)'
  ),
  state text NOT NULL CHECK (state IN ('allocated', 'active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  PRIMARY KEY (tenant_id, lifecycle_id, incarnation_id),
  UNIQUE (incarnation_id),
  UNIQUE (physical_object_key),
  UNIQUE (tenant_id, lifecycle_id, incarnation_id, physical_object_key),
  FOREIGN KEY (tenant_id, lifecycle_id, purpose, sha256, size)
    REFERENCES blob_lifecycles(tenant_id, lifecycle_id, purpose, sha256, size) ON DELETE RESTRICT,
  CONSTRAINT blob_incarnation_retired_shape_check CHECK (
    (state = 'retired' AND retired_at IS NOT NULL)
    OR (state <> 'retired' AND retired_at IS NULL)
  )
);

ALTER TABLE blob_lifecycles ADD CONSTRAINT blob_lifecycle_current_incarnation_fk
  FOREIGN KEY (tenant_id, lifecycle_id, current_incarnation_id)
  REFERENCES blob_incarnations(tenant_id, lifecycle_id, incarnation_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX blob_incarnations_one_live_idx
  ON blob_incarnations (tenant_id, lifecycle_id)
  WHERE state IN ('allocated', 'active');

CREATE TABLE blob_allocations (
  tenant_id text NOT NULL,
  allocation_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  reference_id text NOT NULL CHECK (length(reference_id) BETWEEN 1 AND 200),
  lifecycle_id uuid NOT NULL,
  incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0 AND generation <= 9007199254740991),
  mode text NOT NULL CHECK (mode IN ('active_reuse', 'new_after_deleted')),
  staging_upload_id text NOT NULL,
  staging_media_type text NOT NULL CHECK (length(staging_media_type) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, allocation_id),
  UNIQUE (tenant_id, operation_id),
  UNIQUE (tenant_id, allocation_id, lifecycle_id, incarnation_id, physical_object_key),
  FOREIGN KEY (tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    REFERENCES blob_incarnations(tenant_id, lifecycle_id, incarnation_id, physical_object_key) ON DELETE RESTRICT
);

CREATE TABLE blob_commits (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  status text NOT NULL CHECK (status IN (
    'upload_pending', 'staged', 'reference_commit_pending', 'reference_commit_unknown',
    'reference_committed', 'allocation_reserved', 'promotion_started', 'stable_object_ready',
    'stable_mark_gc_blocked', 'stable_mark_unknown', 'stable', 'cleanup_pending',
    'completed', 'abandoned'
  )),
  version bigint NOT NULL CHECK (version >= 0 AND version <= 9007199254740991),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, operation_id)
);

CREATE TABLE promotion_authorizations (
  tenant_id text NOT NULL,
  authorization_id uuid NOT NULL,
  operation_id text NOT NULL,
  reference_id text NOT NULL,
  allocation_id uuid NOT NULL,
  lifecycle_id uuid NOT NULL,
  incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  staging_upload_id text NOT NULL,
  staging_object_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('started', 'succeeded', 'consumed_not_copied')),
  current_execution_id uuid,
  execution_generation bigint NOT NULL DEFAULT 0 CHECK (
    execution_generation >= 0 AND execution_generation <= 9007199254740991
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, authorization_id),
  UNIQUE (authorization_id),
  UNIQUE (tenant_id, operation_id, authorization_id),
  UNIQUE (tenant_id, authorization_id, lifecycle_id, incarnation_id, physical_object_key),
  FOREIGN KEY (tenant_id, operation_id) REFERENCES blob_commits(tenant_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, allocation_id, lifecycle_id, incarnation_id, physical_object_key)
    REFERENCES blob_allocations(tenant_id, allocation_id, lifecycle_id, incarnation_id, physical_object_key) ON DELETE RESTRICT
);

CREATE TABLE promotion_executions (
  tenant_id text NOT NULL,
  execution_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  operation_id text NOT NULL,
  attempt_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0 AND generation <= 9007199254740991),
  phase text NOT NULL CHECK (phase IN ('claimed', 'executing', 'unknown', 'succeeded', 'not_copied')),
  proof_status text NOT NULL CHECK (
    proof_status IN ('pre_intent', 'copy_issued', 'not_copied', 'consumed_not_copied', 'succeeded')
  ),
  lifecycle_id uuid NOT NULL,
  incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, execution_id),
  UNIQUE (execution_id),
  UNIQUE (tenant_id, authorization_id, generation),
  UNIQUE (tenant_id, authorization_id, attempt_id),
  UNIQUE (tenant_id, authorization_id, execution_id, generation),
  FOREIGN KEY (tenant_id, operation_id, authorization_id)
    REFERENCES promotion_authorizations(tenant_id, operation_id, authorization_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, authorization_id, lifecycle_id, incarnation_id, physical_object_key)
    REFERENCES promotion_authorizations(tenant_id, authorization_id, lifecycle_id, incarnation_id, physical_object_key) ON DELETE RESTRICT
);

ALTER TABLE promotion_authorizations ADD CONSTRAINT promotion_authorization_current_execution_fk
  FOREIGN KEY (tenant_id, authorization_id, current_execution_id, execution_generation)
  REFERENCES promotion_executions(tenant_id, authorization_id, execution_id, generation)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE promotion_authorizations ADD CONSTRAINT promotion_authorization_execution_shape_check
  CHECK (
    (current_execution_id IS NULL AND execution_generation = 0)
    OR (current_execution_id IS NOT NULL AND execution_generation > 0)
  );

CREATE TABLE blob_gc_claims (
  tenant_id text NOT NULL,
  claim_id uuid NOT NULL,
  lifecycle_id uuid NOT NULL,
  incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0 AND generation <= 9007199254740991),
  phase text NOT NULL CHECK (phase IN ('pre_delete', 'deleting', 'completed', 'released')),
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, claim_id),
  UNIQUE (tenant_id, lifecycle_id, generation),
  UNIQUE (tenant_id, claim_id, generation, incarnation_id, physical_object_key),
  FOREIGN KEY (tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    REFERENCES blob_incarnations(tenant_id, lifecycle_id, incarnation_id, physical_object_key) ON DELETE RESTRICT
);

CREATE TABLE retired_blob_tombstones (
  tenant_id text NOT NULL,
  tombstone_id uuid NOT NULL,
  lifecycle_id uuid NOT NULL,
  purpose text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL,
  incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 9007199254740991),
  scrub_lease_expires_at timestamptz,
  next_scrub_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_scrubbed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, tombstone_id),
  UNIQUE (tombstone_id),
  UNIQUE (tenant_id, lifecycle_id, incarnation_id),
  FOREIGN KEY (tenant_id, lifecycle_id, purpose, sha256, size)
    REFERENCES blob_lifecycles(tenant_id, lifecycle_id, purpose, sha256, size) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    REFERENCES blob_incarnations(tenant_id, lifecycle_id, incarnation_id, physical_object_key) ON DELETE RESTRICT
);

CREATE INDEX retired_blob_tombstones_scrub_idx
  ON retired_blob_tombstones (tenant_id, next_scrub_at, scrub_lease_expires_at);

CREATE TABLE blob_references (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  reference_id text NOT NULL,
  operation_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('staged', 'stable')),
  purpose text NOT NULL CHECK (purpose IN ('workspace', 'resource', 'artifact', 'trace', 'preview')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0 AND size <= 9007199254740991),
  media_type text NOT NULL,
  staging_upload_id text NOT NULL,
  lifecycle_id uuid,
  incarnation_id uuid,
  physical_object_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, reference_id),
  UNIQUE (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, operation_id) REFERENCES blob_commits(tenant_id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    REFERENCES blob_incarnations(tenant_id, lifecycle_id, incarnation_id, physical_object_key) ON DELETE RESTRICT,
  CONSTRAINT blob_reference_target_shape_check CHECK (
    (state = 'staged' AND lifecycle_id IS NULL AND incarnation_id IS NULL AND physical_object_key IS NULL)
    OR
    (state = 'stable' AND lifecycle_id IS NOT NULL AND incarnation_id IS NOT NULL AND physical_object_key IS NOT NULL)
  )
);

CREATE INDEX blob_references_reachability_idx
  ON blob_references (tenant_id, lifecycle_id, incarnation_id)
  WHERE state = 'stable';

ALTER TABLE blob_lifecycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE blob_lifecycles FORCE ROW LEVEL SECURITY;
CREATE POLICY blob_lifecycles_isolation_policy ON blob_lifecycles
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE blob_incarnations ENABLE ROW LEVEL SECURITY;
ALTER TABLE blob_incarnations FORCE ROW LEVEL SECURITY;
CREATE POLICY blob_incarnations_isolation_policy ON blob_incarnations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE blob_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE blob_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY blob_allocations_isolation_policy ON blob_allocations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE blob_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE blob_commits FORCE ROW LEVEL SECURITY;
CREATE POLICY blob_commits_isolation_policy ON blob_commits
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE promotion_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY promotion_authorizations_isolation_policy ON promotion_authorizations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE promotion_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY promotion_executions_isolation_policy ON promotion_executions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE blob_gc_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE blob_gc_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY blob_gc_claims_isolation_policy ON blob_gc_claims
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE retired_blob_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE retired_blob_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY retired_blob_tombstones_isolation_policy ON retired_blob_tombstones
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE blob_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE blob_references FORCE ROW LEVEL SECURITY;
CREATE POLICY blob_references_isolation_policy ON blob_references
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
