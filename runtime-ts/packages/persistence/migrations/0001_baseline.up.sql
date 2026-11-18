-- Hoox Runtime 基线 Schema。
-- 2026-11 将此前全部增量迁移按原顺序合并为本基线；之后的 Schema 变化只能以新的递增迁移追加。
-- 本文件在迁移 runner 的单一事务中执行，依赖 runner 预先设置的 app.runtime_role、
-- app.skill_publisher_role、app.admin_control_role 与 app.worker_coordinator_role。
-- 区段之间保持原执行顺序：后续区段可能修改、替换或删除前面区段创建的约束与对象。

-- ---------------------------------------------------------------------------
-- 区段：core
-- ---------------------------------------------------------------------------

CREATE TABLE app_users (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL
);

CREATE TABLE tenants (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('personal', 'team')),
  owner_user_id text REFERENCES app_users(id) ON DELETE RESTRICT,
  display_name text,
  created_by_user_id text REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  CONSTRAINT tenants_shape_check CHECK (
    (kind = 'personal' AND owner_user_id IS NOT NULL AND display_name IS NULL AND created_by_user_id IS NULL)
    OR
    (kind = 'team' AND owner_user_id IS NULL AND display_name IS NOT NULL AND length(btrim(display_name)) BETWEEN 1 AND 200 AND created_by_user_id IS NOT NULL)
  )
);

CREATE TABLE memberships (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE threads (
  tenant_id text NOT NULL,
  id text NOT NULL,
  created_by_user_id text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX threads_tenant_updated_idx ON threads (tenant_id, updated_at DESC);

CREATE TABLE runs (
  tenant_id text NOT NULL,
  id text NOT NULL,
  thread_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, thread_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX runs_thread_created_idx ON runs (tenant_id, thread_id, created_at DESC);
CREATE INDEX runs_status_updated_idx ON runs (tenant_id, status, updated_at);

CREATE TABLE workspaces (
  tenant_id text NOT NULL,
  id text NOT NULL,
  thread_id text NOT NULL,
  current_revision_number integer NOT NULL DEFAULT 0 CHECK (current_revision_number >= 0),
  current_revision_id text,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, thread_id),
  UNIQUE (tenant_id, id, thread_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_head_shape_check CHECK (
    (current_revision_number = 0 AND current_revision_id IS NULL)
    OR
    (current_revision_number > 0 AND current_revision_id IS NOT NULL)
  )
);

CREATE TABLE workspace_revisions (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  id text NOT NULL,
  thread_id text NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  parent_revision_id text,
  created_by_run_id text NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  object_key text NOT NULL CHECK (length(btrim(object_key)) > 0),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, revision_number),
  FOREIGN KEY (tenant_id, workspace_id, thread_id) REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by_run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, parent_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_revision_parent_shape_check CHECK (
    (revision_number = 1 AND parent_revision_id IS NULL)
    OR
    (revision_number > 1 AND parent_revision_id IS NOT NULL)
  )
);

ALTER TABLE workspaces ADD CONSTRAINT workspaces_current_revision_fk
  FOREIGN KEY (tenant_id, id, current_revision_id)
  REFERENCES workspace_revisions(tenant_id, workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX workspace_revisions_latest_idx
  ON workspace_revisions (tenant_id, workspace_id, revision_number DESC);

CREATE TABLE workspace_write_leases (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  thread_id text NOT NULL,
  root_run_id text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id),
  FOREIGN KEY (tenant_id, workspace_id, thread_id) REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, root_run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT
);

CREATE INDEX workspace_write_leases_expiry_idx ON workspace_write_leases (expires_at);

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_users FORCE ROW LEVEL SECURITY;
CREATE POLICY app_users_tenant_policy ON app_users
  USING (
    id = NULLIF(current_setting('app.user_id', true), '')
    OR EXISTS (
      SELECT 1 FROM memberships m
       WHERE m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
         AND m.user_id = app_users.id
    )
  )
  WITH CHECK (id = NULLIF(current_setting('app.user_id', true), ''));

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_isolation_policy ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_isolation_policy ON memberships
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
CREATE POLICY threads_isolation_policy ON threads
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;
CREATE POLICY runs_isolation_policy ON runs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_isolation_policy ON workspaces
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE workspace_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_revisions_isolation_policy ON workspace_revisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE workspace_write_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_write_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_write_leases_isolation_policy ON workspace_write_leases
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：blob_lifecycle
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 区段：membership_lock_privilege
-- ---------------------------------------------------------------------------

ALTER TABLE memberships
  ADD COLUMN lock_marker boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT memberships_lock_marker_constant CHECK (lock_marker = false);

-- ---------------------------------------------------------------------------
-- 区段：run_worker_state
-- ---------------------------------------------------------------------------

-- 生产事实表。所有时间由 PostgreSQL 生成，应用不得提交发生时间。
CREATE TABLE run_execution_inputs (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  base_revision_id text,
  input_text text NOT NULL CHECK (length(input_text) BETWEEN 1 AND 1048576),
  answer_text text,
  initial_projection jsonb NOT NULL CHECK (jsonb_typeof(initial_projection) = 'object'),
  initial_projection_digest text NOT NULL CHECK (initial_projection_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, run_id, thread_id, workspace_id, root_run_id),
  FOREIGN KEY (tenant_id, run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, root_run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, thread_id) REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, base_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT run_execution_root_check CHECK (root_run_id = run_id)
);

CREATE TABLE execution_attempts (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  base_revision_id text,
  current_revision_id text,
  status text NOT NULL CHECK (status IN (
    'claimed', 'running', 'waiting', 'finalizing', 'succeeded', 'failed',
    'cancelled', 'recovery_required', 'abandoned'
  )),
  stage text NOT NULL CHECK (stage IN (
    'claimed', 'cleanup_intent_persisted', 'model_execution_started', 'model_settled',
    'workspace_verified', 'finalizing', 'sandbox_settled', 'finished'
  )),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0 AND version <= 9007199254740991),
  next_event_sequence bigint NOT NULL DEFAULT 0 CHECK (
    next_event_sequence >= 0 AND next_event_sequence <= 9007199254740991
  ),
  projection_version bigint NOT NULL DEFAULT 0 CHECK (
    projection_version >= 0 AND projection_version <= 9007199254740991
  ),
  model_execution_started boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, attempt_id),
  UNIQUE (tenant_id, run_id, attempt_id),
  UNIQUE (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id),
  FOREIGN KEY (tenant_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES run_execution_inputs(tenant_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, current_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT execution_attempt_finished_shape_check CHECK (
    (status IN ('waiting', 'succeeded', 'failed', 'cancelled', 'recovery_required', 'abandoned')
      AND finished_at IS NOT NULL)
    OR
    (status IN ('claimed', 'running', 'finalizing') AND finished_at IS NULL)
  )
);

CREATE UNIQUE INDEX execution_attempts_one_active_run_idx
  ON execution_attempts (tenant_id, run_id)
  WHERE status IN ('claimed', 'running', 'finalizing');
CREATE INDEX execution_attempts_recovery_idx
  ON execution_attempts (tenant_id, status, updated_at)
  WHERE status IN ('recovery_required', 'claimed', 'running', 'finalizing');

CREATE TABLE execution_workspace_fences (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0 AND lease_epoch <= 9007199254740991),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  initial_expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, attempt_id),
  UNIQUE (tenant_id, attempt_id, lease_epoch),
  UNIQUE (tenant_id, workspace_id, root_run_id, lease_epoch),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT
);

CREATE TABLE run_claims (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) BETWEEN 1 AND 200),
  claim_token text NOT NULL CHECK (length(claim_token) BETWEEN 1 AND 200),
  claim_epoch bigint NOT NULL CHECK (claim_epoch > 0 AND claim_epoch <= 9007199254740991),
  workspace_lease_epoch bigint NOT NULL CHECK (
    workspace_lease_epoch > 0 AND workspace_lease_epoch <= 9007199254740991
  ),
  expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  PRIMARY KEY (tenant_id, attempt_id),
  UNIQUE (tenant_id, run_id, claim_epoch),
  UNIQUE (tenant_id, claim_token),
  UNIQUE (
    tenant_id, attempt_id, claim_token, claim_epoch, root_run_id, workspace_lease_epoch
  ),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_workspace_fences(tenant_id, attempt_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, attempt_id, workspace_lease_epoch)
    REFERENCES execution_workspace_fences(tenant_id, attempt_id, lease_epoch),
  CONSTRAINT run_claim_release_shape_check CHECK (
    (released_at IS NULL AND expires_at > acquired_at) OR released_at IS NOT NULL
  )
);
CREATE INDEX run_claims_expiry_idx ON run_claims (expires_at) WHERE released_at IS NULL;

CREATE TABLE rollout_projections (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0 AND version <= 9007199254740991),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, run_id, attempt_id)
    REFERENCES execution_attempts(tenant_id, run_id, attempt_id) ON DELETE RESTRICT
);

CREATE TABLE run_events (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0 AND sequence <= 9007199254740991),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  kind text NOT NULL CHECK (kind IN ('agent_event', 'attempt_state_changed', 'run_waiting')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, sequence),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT
);

CREATE TABLE sandbox_registry (
  tenant_id text NOT NULL,
  registry_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  provider_sandbox_id text NOT NULL,
  request_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('acquiring', 'ready', 'pausing', 'paused', 'closing', 'closed', 'unknown')),
  actual_ttl_seconds integer NOT NULL CHECK (actual_ttl_seconds BETWEEN 1 AND 86400),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, registry_id),
  UNIQUE (tenant_id, provider_sandbox_id),
  UNIQUE (tenant_id, attempt_id, registry_id, provider_sandbox_id),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(
      tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id
    ) ON DELETE RESTRICT
);

CREATE TABLE cleanup_outbox (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  idempotency_key text NOT NULL,
  registry_id text NOT NULL,
  provider_sandbox_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'started', 'completed', 'unknown')),
  armed boolean NOT NULL DEFAULT true CHECK (armed),
  armed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  identity_digest text NOT NULL CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
  disposition text CHECK (disposition IN ('pause', 'close')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, idempotency_key),
  FOREIGN KEY (tenant_id, attempt_id, registry_id, provider_sandbox_id)
    REFERENCES sandbox_registry(tenant_id, attempt_id, registry_id, provider_sandbox_id)
    ON DELETE RESTRICT,
  CONSTRAINT cleanup_outbox_disposition_shape_check CHECK (
    (state = 'pending' AND disposition IS NULL)
    OR (state IN ('started', 'completed', 'unknown') AND disposition IS NOT NULL)
  )
);
CREATE INDEX cleanup_outbox_dispatch_idx
  ON cleanup_outbox (tenant_id, state, updated_at) WHERE state IN ('pending', 'started', 'unknown');

CREATE TABLE sandbox_lifecycle_unknown (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_id text NOT NULL,
  provider_sandbox_id text,
  actual_ttl_seconds integer NOT NULL CHECK (actual_ttl_seconds BETWEEN 1 AND 86400),
  stage text NOT NULL CHECK (stage IN ('create_response', 'cleanup_after_create', 'cleanup_after_reconcile')),
  event_payload jsonb NOT NULL CHECK (jsonb_typeof(event_payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, idempotency_key),
  UNIQUE (tenant_id, attempt_id, request_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT
);

CREATE TABLE runtime_alert_outbox (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  idempotency_key text NOT NULL,
  code text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, idempotency_key),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT
);

CREATE TABLE effect_invocations (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  call_id text NOT NULL,
  tool_name text NOT NULL CHECK (length(btrim(tool_name)) BETWEEN 1 AND 200),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, call_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT
);

CREATE TABLE external_effect_permits (
  tenant_id text NOT NULL,
  permit_id text NOT NULL,
  attempt_id text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('model_start', 'tool_execution')),
  call_id text NOT NULL,
  tool_name text NOT NULL,
  args_digest text NOT NULL CHECK (args_digest ~ '^[0-9a-f]{64}$'),
  attempt_version bigint NOT NULL CHECK (attempt_version >= 0 AND attempt_version <= 9007199254740991),
  run_claim_token text NOT NULL,
  run_claim_epoch bigint NOT NULL,
  workspace_root_run_id text NOT NULL,
  workspace_lease_epoch bigint NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, permit_id),
  UNIQUE (tenant_id, attempt_id, effect, call_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, attempt_id, run_claim_token, run_claim_epoch,
    workspace_root_run_id, workspace_lease_epoch
  ) REFERENCES run_claims(
    tenant_id, attempt_id, claim_token, claim_epoch, root_run_id, workspace_lease_epoch
  ) ON DELETE RESTRICT,
  CONSTRAINT external_effect_permit_time_check CHECK (expires_at > issued_at),
  CONSTRAINT external_effect_permit_consume_check CHECK (
    consumed_at IS NULL OR consumed_at >= issued_at
  )
);
CREATE UNIQUE INDEX external_effect_permits_one_model_start_idx
  ON external_effect_permits (tenant_id, attempt_id)
  WHERE effect = 'model_start';

-- Runtime 端口之外仍可能存在受限 SQL 调用方，因此大小和标识边界必须由数据库再次兜底。
ALTER TABLE run_execution_inputs ADD CONSTRAINT run_execution_inputs_byte_size_check CHECK (
  octet_length(run_id) BETWEEN 1 AND 200
  AND octet_length(thread_id) BETWEEN 1 AND 200
  AND octet_length(workspace_id) BETWEEN 1 AND 200
  AND octet_length(root_run_id) BETWEEN 1 AND 200
  AND (base_revision_id IS NULL OR octet_length(base_revision_id) BETWEEN 1 AND 200)
  AND octet_length(input_text) BETWEEN 1 AND 1048576
  AND (answer_text IS NULL OR octet_length(answer_text) BETWEEN 1 AND 1048576)
  AND octet_length(initial_projection::text) <= 65536
);
ALTER TABLE execution_attempts ADD CONSTRAINT execution_attempts_identifier_size_check CHECK (
  octet_length(attempt_id) BETWEEN 1 AND 200
  AND octet_length(run_id) BETWEEN 1 AND 200
  AND octet_length(thread_id) BETWEEN 1 AND 200
  AND octet_length(workspace_id) BETWEEN 1 AND 200
  AND octet_length(root_run_id) BETWEEN 1 AND 200
);
ALTER TABLE run_claims ADD CONSTRAINT run_claims_identifier_size_check CHECK (
  octet_length(worker_id) BETWEEN 1 AND 200
  AND octet_length(claim_token) BETWEEN 1 AND 200
);
ALTER TABLE rollout_projections ADD CONSTRAINT rollout_projections_byte_size_check CHECK (
  octet_length(projection::text) <= 65536
);
ALTER TABLE run_events ADD CONSTRAINT run_events_payload_byte_size_check CHECK (
  octet_length(payload::text) <= 65536
);
ALTER TABLE sandbox_registry ADD CONSTRAINT sandbox_registry_identifier_size_check CHECK (
  octet_length(registry_id) BETWEEN 1 AND 200
  AND octet_length(provider_sandbox_id) BETWEEN 1 AND 200
  AND octet_length(request_id) BETWEEN 1 AND 200
);
ALTER TABLE cleanup_outbox ADD CONSTRAINT cleanup_outbox_byte_size_check CHECK (
  octet_length(idempotency_key) BETWEEN 1 AND 512
  AND octet_length(registry_id) BETWEEN 1 AND 200
  AND octet_length(provider_sandbox_id) BETWEEN 1 AND 200
  AND octet_length(payload::text) <= 65536
);
ALTER TABLE sandbox_lifecycle_unknown
  ADD CONSTRAINT sandbox_lifecycle_unknown_byte_size_check CHECK (
    octet_length(idempotency_key) BETWEEN 1 AND 512
    AND octet_length(request_id) BETWEEN 1 AND 200
    AND (provider_sandbox_id IS NULL OR octet_length(provider_sandbox_id) BETWEEN 1 AND 200)
    AND octet_length(event_payload::text) <= 65536
  );
ALTER TABLE runtime_alert_outbox ADD CONSTRAINT runtime_alert_outbox_byte_size_check CHECK (
  octet_length(idempotency_key) BETWEEN 1 AND 512
  AND octet_length(payload::text) <= 65536
);
ALTER TABLE effect_invocations ADD CONSTRAINT effect_invocations_identifier_size_check CHECK (
  octet_length(call_id) BETWEEN 1 AND 200
  AND octet_length(tool_name) BETWEEN 1 AND 200
);
ALTER TABLE external_effect_permits
  ADD CONSTRAINT external_effect_permits_identifier_size_check CHECK (
    octet_length(permit_id) BETWEEN 1 AND 200
    AND octet_length(call_id) BETWEEN 1 AND 200
    AND octet_length(tool_name) BETWEEN 1 AND 200
    AND octet_length(run_claim_token) BETWEEN 1 AND 200
    AND octet_length(workspace_root_run_id) BETWEEN 1 AND 200
  );
CREATE TABLE mutation_receipts (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  idempotency_key text NOT NULL,
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  previous_attempt_version bigint NOT NULL CHECK (previous_attempt_version >= 0),
  attempt_version bigint NOT NULL CHECK (attempt_version = previous_attempt_version + 1),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  database_now timestamptz NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, idempotency_key),
  UNIQUE (tenant_id, run_id, idempotency_key),
  FOREIGN KEY (tenant_id, run_id, attempt_id)
    REFERENCES execution_attempts(tenant_id, run_id, attempt_id) ON DELETE RESTRICT
);
ALTER TABLE mutation_receipts ADD CONSTRAINT mutation_receipts_byte_size_check CHECK (
  octet_length(idempotency_key) BETWEEN 1 AND 512
  AND octet_length(receipt::text) <= 65536
  AND octet_length(result_snapshot::text) <= 65536
);

-- 每张业务表都强制 Tenant RLS；Runtime 角色不是 owner 且不能 BYPASSRLS。
ALTER TABLE run_execution_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_execution_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY run_execution_inputs_tenant_policy ON run_execution_inputs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE execution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_attempts_tenant_policy ON execution_attempts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE execution_workspace_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_workspace_fences FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_workspace_fences_tenant_policy ON execution_workspace_fences
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE run_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY run_claims_tenant_policy ON run_claims
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE rollout_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE rollout_projections FORCE ROW LEVEL SECURITY;
CREATE POLICY rollout_projections_tenant_policy ON rollout_projections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY run_events_tenant_policy ON run_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE sandbox_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_registry_tenant_policy ON sandbox_registry
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE cleanup_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleanup_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY cleanup_outbox_tenant_policy ON cleanup_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE sandbox_lifecycle_unknown ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_lifecycle_unknown FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_lifecycle_unknown_tenant_policy ON sandbox_lifecycle_unknown
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_alert_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_alert_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_alert_outbox_tenant_policy ON runtime_alert_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE effect_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE effect_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY effect_invocations_tenant_policy ON effect_invocations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE external_effect_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_effect_permits FORCE ROW LEVEL SECURITY;
CREATE POLICY external_effect_permits_tenant_policy ON external_effect_permits
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE mutation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY mutation_receipts_tenant_policy ON mutation_receipts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：run_dispatch
-- ---------------------------------------------------------------------------

-- API 创建 Run 与调度投递之间的持久化边界。禁止通过函数或触发器隐藏状态转换。
CREATE TABLE api_idempotency_records (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  operation text NOT NULL CHECK (operation = 'run.create'),
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  run_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, operation, idempotency_key),
  UNIQUE (tenant_id, run_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE run_dispatch_outbox (
  tenant_id text NOT NULL,
  outbox_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('ready', 'claimed', 'dispatched', 'cancelled')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 9007199254740991),
  claim_token text,
  claimed_by text CHECK (claimed_by IS NULL OR octet_length(claimed_by) BETWEEN 1 AND 200),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, outbox_id),
  UNIQUE (tenant_id, run_id),
  UNIQUE (tenant_id, run_id, thread_id, workspace_id, root_run_id),
  FOREIGN KEY (tenant_id, run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES run_execution_inputs(tenant_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT,
  CONSTRAINT run_dispatch_outbox_claim_shape CHECK (
    (state = 'claimed' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'claimed' AND claim_token IS NULL AND claimed_by IS NULL AND lease_expires_at IS NULL)
  )
);
CREATE INDEX run_dispatch_outbox_claim_idx
  ON run_dispatch_outbox (state, next_attempt_at, lease_expires_at)
  WHERE state IN ('ready', 'claimed');

ALTER TABLE api_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY api_idempotency_records_tenant_policy ON api_idempotency_records
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE run_dispatch_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_dispatch_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY run_dispatch_outbox_tenant_policy ON run_dispatch_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- JS trim 与 PostgreSQL 的 Unicode 空白语义不完全相同；数据库最少拒绝 ASCII/POSIX 空白，
-- 其余 Unicode 边界仍由 API/端口的 JavaScript trim 精确收敛，避免受限 SQL 直写 tab/newline。
ALTER TABLE run_execution_inputs
  ADD CONSTRAINT run_execution_inputs_nonblank_input_check CHECK (input_text ~ '[^[:space:]]');

-- ---------------------------------------------------------------------------
-- 区段：sandbox_cleanup_consumer
-- ---------------------------------------------------------------------------

-- 0005 由 Run dispatch 预留；cleanup 消费事实从 0006 开始，避免并行分支竞争版本号。
ALTER TABLE cleanup_outbox
  ADD COLUMN claim_token text,
  ADD COLUMN claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  ADD COLUMN claimed_by text,
  ADD COLUMN claim_lease_expires_at timestamptz,
  ADD COLUMN retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN remote_call_started_at timestamptz;

ALTER TABLE cleanup_outbox ADD CONSTRAINT cleanup_outbox_consumer_claim_shape_check CHECK (
  (claim_token IS NULL AND claimed_by IS NULL AND claim_lease_expires_at IS NULL)
  OR (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND claim_lease_expires_at IS NOT NULL)
);
ALTER TABLE cleanup_outbox ADD CONSTRAINT cleanup_outbox_remote_call_shape_check CHECK (
  -- pause 也是不可判定的远端调用；崩溃后同样只能进入 unknown，不能被恢复为 close。
  remote_call_started_at IS NULL OR (state IN ('started', 'completed', 'unknown') AND disposition IN ('pause', 'close'))
);
ALTER TABLE cleanup_outbox ADD CONSTRAINT cleanup_outbox_consumer_value_size_check CHECK (
  (claim_token IS NULL OR octet_length(claim_token) BETWEEN 1 AND 512)
  AND (claimed_by IS NULL OR octet_length(claimed_by) BETWEEN 1 AND 200)
  AND claim_generation <= 9007199254740991
  AND attempt_count <= 2147483647
);
CREATE INDEX cleanup_outbox_consumer_claim_idx
  ON cleanup_outbox (tenant_id, retry_at, claim_lease_expires_at)
  WHERE state IN ('pending','started');

-- ---------------------------------------------------------------------------
-- 区段：thread_creation
-- ---------------------------------------------------------------------------

-- Thread、初始 Workspace 与幂等事实必须原子创建，不能由 API 组合多个 Repository 写入。
CREATE TABLE api_thread_idempotency_records (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  thread_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, idempotency_key),
  UNIQUE (tenant_id, thread_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE api_thread_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_thread_idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY api_thread_idempotency_records_tenant_policy ON api_thread_idempotency_records
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：resource_library
-- ---------------------------------------------------------------------------

ALTER TABLE workspace_revisions
  ADD CONSTRAINT workspace_revisions_resource_authorization_key
  UNIQUE (tenant_id, workspace_id, id, thread_id);

ALTER TABLE blob_references
  ADD CONSTRAINT blob_references_resource_version_key
  UNIQUE (
    tenant_id, reference_id, purpose, sha256, size,
    lifecycle_id, incarnation_id, physical_object_key
  );

CREATE TABLE resources (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 255),
  origin text NOT NULL CHECK (origin IN ('upload', 'file_source', 'promoted_workspace', 'artifact')),
  visibility text NOT NULL CHECK (visibility IN ('pending_explicit_commit', 'searchable')),
  latest_version_number integer NOT NULL DEFAULT 0 CHECK (latest_version_number >= 0),
  latest_version_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, latest_version_id, latest_version_number),
  CONSTRAINT resources_head_shape_check CHECK (
    (latest_version_number = 0 AND latest_version_id IS NULL AND visibility = 'pending_explicit_commit')
    OR
    (latest_version_number > 0 AND latest_version_id IS NOT NULL)
  )
);

CREATE TABLE resource_versions (
  tenant_id text NOT NULL,
  resource_id text NOT NULL,
  id text NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  parent_version_id text,
  blob_reference_id text NOT NULL,
  blob_purpose text NOT NULL CHECK (blob_purpose = 'resource'),
  blob_lifecycle_id uuid NOT NULL,
  blob_incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL CHECK (
    length(physical_object_key) BETWEEN 1 AND 1024
    AND physical_object_key !~ '[[:cntrl:]\\]'
    AND physical_object_key !~ '(^/|//|/$)'
  ),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
  size bigint NOT NULL CHECK (size >= 0 AND size <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, resource_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, resource_id, version_number),
  UNIQUE (tenant_id, resource_id, id, version_number),
  UNIQUE (tenant_id, blob_reference_id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id, parent_version_id)
    REFERENCES resource_versions(tenant_id, resource_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, blob_reference_id, blob_purpose, digest, size,
    blob_lifecycle_id, blob_incarnation_id, physical_object_key
  ) REFERENCES blob_references(
    tenant_id, reference_id, purpose, sha256, size,
    lifecycle_id, incarnation_id, physical_object_key
  ) ON DELETE RESTRICT,
  CONSTRAINT resource_version_parent_shape_check CHECK (
    (version_number = 1 AND parent_version_id IS NULL)
    OR
    (version_number > 1 AND parent_version_id IS NOT NULL)
  )
);

ALTER TABLE resources ADD CONSTRAINT resources_latest_version_fk
  FOREIGN KEY (tenant_id, id, latest_version_id, latest_version_number)
  REFERENCES resource_versions(tenant_id, resource_id, id, version_number)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX resources_search_idx
  ON resources (tenant_id, visibility, updated_at DESC, id DESC);

-- 第一阶段搜索是规范名称的字面前缀匹配；text_pattern_ops 让固定前缀可走索引，
-- 同时避免为尚未采用的模糊搜索提前安装 pg_trgm 扩展。
CREATE INDEX resources_name_prefix_idx
  ON resources (tenant_id, visibility, normalized_name text_pattern_ops);

CREATE TABLE resource_promotion_authorizations (
  tenant_id text NOT NULL,
  authorization_id text NOT NULL CHECK (
    authorization_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$'
  ),
  user_id text NOT NULL,
  agent_thread_id text NOT NULL CHECK (
    agent_thread_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'
  ),
  thread_id text NOT NULL,
  run_id text NOT NULL,
  workspace_id text NOT NULL,
  revision_id text NOT NULL,
  writer_lease_epoch bigint NOT NULL CHECK (
    writer_lease_epoch > 0 AND writer_lease_epoch <= 9007199254740991
  ),
  relative_path text NOT NULL CHECK (
    length(relative_path) BETWEEN 1 AND 1024
    AND relative_path !~ '[[:cntrl:]\\]'
    AND relative_path !~ '(^/|//|/$)'
  ),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
  size bigint NOT NULL CHECK (size >= 0 AND size <= 9007199254740991),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'consumed', 'revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, authorization_id),
  UNIQUE (tenant_id, authorization_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, revision_id, thread_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id, thread_id) ON DELETE RESTRICT,
  CONSTRAINT resource_promotion_authorization_state_shape_check CHECK (
    (state = 'consumed' AND consumed_at IS NOT NULL)
    OR (state <> 'consumed' AND consumed_at IS NULL)
  )
);

CREATE TABLE resource_promotion_idempotency (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  authorization_id text NOT NULL,
  resource_id text NOT NULL,
  resource_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, idempotency_key),
  FOREIGN KEY (tenant_id, authorization_id, user_id)
    REFERENCES resource_promotion_authorizations(tenant_id, authorization_id, user_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id, resource_version_id)
    REFERENCES resource_versions(tenant_id, resource_id, id) ON DELETE RESTRICT
);

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
CREATE POLICY resources_isolation_policy ON resources
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE resource_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_versions_isolation_policy ON resource_versions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE resource_promotion_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_promotion_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_promotion_authorizations_isolation_policy ON resource_promotion_authorizations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE resource_promotion_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_promotion_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_promotion_idempotency_isolation_policy ON resource_promotion_idempotency
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：artifact_correction_runtime
-- ---------------------------------------------------------------------------

ALTER TABLE run_events
  DROP CONSTRAINT run_events_kind_check,
  ADD CONSTRAINT run_events_kind_check CHECK (
    kind IN (
      'agent_event',
      'attempt_state_changed',
      'run_waiting',
      'artifact_correction_requested'
    )
  );

ALTER TABLE run_events
  ADD CONSTRAINT run_events_artifact_correction_payload_check CHECK (
    kind <> 'artifact_correction_requested'
    OR (
      jsonb_typeof(payload) = 'object'
      AND payload ?& ARRAY['round', 'maxRounds', 'code', 'feedback']
      AND payload - ARRAY['round', 'maxRounds', 'code', 'feedback'] = '{}'::jsonb
      AND jsonb_typeof(payload->'round') = 'number'
      AND payload->>'round' IN ('1', '2')
      AND jsonb_typeof(payload->'maxRounds') = 'number'
      AND payload->>'maxRounds' IN ('1', '2')
      AND (payload->>'maxRounds' = '2' OR payload->>'round' = '1')
      AND payload->>'code' = 'ARTIFACT_NOT_READY'
      AND jsonb_typeof(payload->'feedback') = 'string'
      AND octet_length(payload->>'feedback') BETWEEN 1 AND 8192
    )
  );
CREATE UNIQUE INDEX run_events_artifact_correction_round_idx
  ON run_events (tenant_id, attempt_id, (payload->>'round'))
  WHERE kind = 'artifact_correction_requested';

ALTER TABLE external_effect_permits
  DROP CONSTRAINT external_effect_permits_effect_check,
  ADD CONSTRAINT external_effect_permits_effect_check CHECK (
    effect IN ('model_start', 'model_continue', 'tool_execution')
  );

-- ---------------------------------------------------------------------------
-- 区段：artifact_delivery
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 区段：runtime_rollout_checkpoint
-- ---------------------------------------------------------------------------

-- Pi Session 文件不是事实源；Runtime 以仅追加事实、checkpoint 投影和幂等回执恢复。
ALTER TABLE blob_references ADD CONSTRAINT blob_references_rollout_target_unique
  UNIQUE (tenant_id, reference_id, state, purpose, sha256, size);

CREATE TABLE runtime_rollout_streams (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  agent_thread_id text NOT NULL,
  agent_kind text NOT NULL DEFAULT 'root' CHECK (agent_kind = 'root'),
  model_id text NOT NULL CHECK (octet_length(model_id) BETWEEN 1 AND 255),
  model_compatibility_hash text NOT NULL CHECK (model_compatibility_hash ~ '^[0-9a-f]{64}$'),
  prompt_policy_hash text NOT NULL CHECK (prompt_policy_hash ~ '^[0-9a-f]{64}$'),
  tool_schema_hash text NOT NULL CHECK (tool_schema_hash ~ '^[0-9a-f]{64}$'),
  skill_manifest_hash text NOT NULL CHECK (skill_manifest_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id),
  UNIQUE (tenant_id, attempt_id, agent_thread_id),
  -- 首版一个 Attempt 只能存在一个 root stream；Agent Thread 维度仍保留在事实主键中。
  UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(
      tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id
    ) ON DELETE RESTRICT,
  CONSTRAINT runtime_rollout_stream_identifiers_check CHECK (
    octet_length(thread_id) BETWEEN 1 AND 200
    AND octet_length(run_id) BETWEEN 1 AND 200
    AND octet_length(attempt_id) BETWEEN 1 AND 200
    AND octet_length(workspace_id) BETWEEN 1 AND 200
    AND octet_length(root_run_id) BETWEEN 1 AND 200
    AND octet_length(agent_thread_id) BETWEEN 1 AND 200
  )
);

CREATE TABLE runtime_rollout_entries (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 0 AND 9007199254740991),
  kind text NOT NULL CHECK (kind IN (
    'user', 'assistant', 'tool_call', 'tool_result', 'waiting', 'terminal'
  )),
  tool_call_id text,
  normalized_tool_call_id text GENERATED ALWAYS AS (coalesce(tool_call_id, '')) STORED,
  previous_sequence bigint,
  previous_kind text,
  previous_tool_call_id text,
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_digest text NOT NULL CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  is_truncated boolean NOT NULL DEFAULT false,
  blob_reference_id text,
  blob_state text,
  blob_purpose text,
  blob_sha256 text,
  blob_size bigint,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, sequence),
  UNIQUE (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    sequence, kind, normalized_tool_call_id
  ),
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id)
    REFERENCES runtime_rollout_streams(
      tenant_id, thread_id, run_id, attempt_id, agent_thread_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    previous_sequence, previous_kind, previous_tool_call_id
  ) REFERENCES runtime_rollout_entries(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    sequence, kind, normalized_tool_call_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, blob_reference_id, blob_state, blob_purpose, blob_sha256, blob_size)
    REFERENCES blob_references(tenant_id, reference_id, state, purpose, sha256, size)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_rollout_entry_call_shape_check CHECK (
    (kind IN ('tool_call', 'tool_result')
      AND tool_call_id IS NOT NULL AND octet_length(tool_call_id) BETWEEN 1 AND 200)
    OR (kind NOT IN ('tool_call', 'tool_result') AND tool_call_id IS NULL)
  ),
  -- 自引用前驱同时保证无间隙单调序号、tool_call 后只能紧跟同 ID 的 tool_result。
  CONSTRAINT runtime_rollout_entry_predecessor_shape_check CHECK (
    (sequence = 0
      AND previous_sequence IS NULL AND previous_kind IS NULL AND previous_tool_call_id IS NULL
      AND kind <> 'tool_result')
    OR
    (sequence > 0
      AND previous_sequence = sequence - 1
      AND previous_kind IS NOT NULL AND previous_tool_call_id IS NOT NULL
      AND previous_kind <> 'terminal'
      AND (
        (kind = 'tool_result'
          AND previous_kind = 'tool_call' AND previous_tool_call_id = tool_call_id)
        OR (kind <> 'tool_result' AND previous_kind <> 'tool_call')
      ))
  ),
  CONSTRAINT runtime_rollout_entry_body_size_check CHECK (octet_length(body::text) <= 16384),
  CONSTRAINT runtime_rollout_entry_blob_shape_check CHECK (
    (blob_reference_id IS NULL AND blob_state IS NULL AND blob_purpose IS NULL
      AND blob_sha256 IS NULL AND blob_size IS NULL AND NOT is_truncated)
    OR
    (kind = 'tool_result' AND blob_reference_id IS NOT NULL
      AND blob_state = 'stable' AND blob_purpose = 'trace'
      AND blob_sha256 ~ '^[0-9a-f]{64}$'
      AND blob_size BETWEEN 0 AND 9007199254740991)
  )
);
CREATE INDEX runtime_rollout_entries_tail_idx ON runtime_rollout_entries(
  tenant_id, attempt_id, agent_thread_id, sequence DESC
);

CREATE TABLE runtime_rollout_append_commands (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  first_sequence bigint NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence >= first_sequence),
  appended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id, idempotency_key),
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, first_sequence)
    REFERENCES runtime_rollout_entries(
      tenant_id, thread_id, run_id, attempt_id, agent_thread_id, sequence
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, last_sequence)
    REFERENCES runtime_rollout_entries(
      tenant_id, thread_id, run_id, attempt_id, agent_thread_id, sequence
    ) ON DELETE RESTRICT
);

-- Replacement history 规范化为共享的仅追加前缀，checkpoint 只能引用其中一个长度。
-- 因而后续 checkpoint 无法清空、改写或分叉已经提交的 replacement。
CREATE TABLE runtime_rollout_replacements (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  replacement_sequence bigint NOT NULL CHECK (
    replacement_sequence BETWEEN 0 AND 9007199254740991
  ),
  previous_replacement_sequence bigint,
  previous_replacement_digest text,
  replacement jsonb NOT NULL CHECK (jsonb_typeof(replacement) = 'object'),
  replacement_digest text NOT NULL CHECK (replacement_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id, replacement_sequence
  ),
  UNIQUE (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    replacement_sequence, replacement_digest
  ),
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id)
    REFERENCES runtime_rollout_streams(
      tenant_id, thread_id, run_id, attempt_id, agent_thread_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    previous_replacement_sequence, previous_replacement_digest
  ) REFERENCES runtime_rollout_replacements(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    replacement_sequence, replacement_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT runtime_rollout_replacement_predecessor_check CHECK (
    (replacement_sequence = 0
      AND previous_replacement_sequence IS NULL AND previous_replacement_digest IS NULL)
    OR
    (replacement_sequence > 0
      AND previous_replacement_sequence = replacement_sequence - 1
      AND previous_replacement_digest ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT runtime_rollout_replacement_size_check CHECK (
    octet_length(replacement::text) <= 16384
  )
);

CREATE TABLE runtime_rollout_checkpoints (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  checkpoint_id text NOT NULL CHECK (octet_length(checkpoint_id) BETWEEN 1 AND 200),
  checkpoint_sequence bigint NOT NULL CHECK (checkpoint_sequence BETWEEN 0 AND 9007199254740991),
  previous_checkpoint_sequence bigint,
  previous_through_sequence bigint,
  previous_window_start_sequence bigint,
  previous_replacement_history_length bigint,
  window_start_sequence bigint NOT NULL CHECK (window_start_sequence >= 0),
  window_start_kind text NOT NULL CHECK (window_start_kind <> 'tool_result'),
  window_start_tool_call_id text NOT NULL,
  through_sequence bigint NOT NULL CHECK (through_sequence >= window_start_sequence),
  through_kind text NOT NULL CHECK (through_kind <> 'tool_call'),
  through_tool_call_id text NOT NULL,
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  projection_digest text NOT NULL CHECK (projection_digest ~ '^[0-9a-f]{64}$'),
  replacement_history_length bigint NOT NULL CHECK (
    replacement_history_length BETWEEN 0 AND 9007199254740991
  ),
  replacement_history_last_sequence bigint GENERATED ALWAYS AS (
    CASE WHEN replacement_history_length = 0 THEN NULL ELSE replacement_history_length - 1 END
  ) STORED,
  replacement_history_tail_digest text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id, checkpoint_id),
  UNIQUE (tenant_id, attempt_id, agent_thread_id, through_sequence),
  UNIQUE (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    checkpoint_sequence, through_sequence, window_start_sequence, replacement_history_length
  ),
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    window_start_sequence, window_start_kind, window_start_tool_call_id
  ) REFERENCES runtime_rollout_entries(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    sequence, kind, normalized_tool_call_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    through_sequence, through_kind, through_tool_call_id
  ) REFERENCES runtime_rollout_entries(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    sequence, kind, normalized_tool_call_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    previous_checkpoint_sequence, previous_through_sequence,
    previous_window_start_sequence, previous_replacement_history_length
  ) REFERENCES runtime_rollout_checkpoints(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    checkpoint_sequence, through_sequence, window_start_sequence, replacement_history_length
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    replacement_history_last_sequence, replacement_history_tail_digest
  ) REFERENCES runtime_rollout_replacements(
    tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
    replacement_sequence, replacement_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT runtime_rollout_checkpoint_predecessor_check CHECK (
    (checkpoint_sequence = 0
      AND previous_checkpoint_sequence IS NULL AND previous_through_sequence IS NULL
      AND previous_window_start_sequence IS NULL
      AND previous_replacement_history_length IS NULL)
    OR
    (checkpoint_sequence > 0
      AND previous_checkpoint_sequence = checkpoint_sequence - 1
      AND previous_through_sequence IS NOT NULL
      AND previous_window_start_sequence IS NOT NULL
      AND previous_replacement_history_length IS NOT NULL
      AND through_sequence > previous_through_sequence
      AND window_start_sequence >= previous_window_start_sequence
      AND replacement_history_length >= previous_replacement_history_length)
  ),
  CONSTRAINT runtime_rollout_checkpoint_replacement_shape_check CHECK (
    (replacement_history_length = 0 AND replacement_history_tail_digest IS NULL)
    OR
    (replacement_history_length > 0 AND replacement_history_tail_digest ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT runtime_rollout_checkpoint_size_check CHECK (
    octet_length(projection::text) <= 65536
  )
);
CREATE INDEX runtime_rollout_checkpoints_latest_idx ON runtime_rollout_checkpoints(
  tenant_id, attempt_id, agent_thread_id, through_sequence DESC
);

CREATE TABLE runtime_rollout_checkpoint_commands (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  checkpoint_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id, idempotency_key),
  UNIQUE (tenant_id, attempt_id, agent_thread_id, checkpoint_id),
  FOREIGN KEY (tenant_id, attempt_id, agent_thread_id, checkpoint_id)
    REFERENCES runtime_rollout_checkpoints(
      tenant_id, attempt_id, agent_thread_id, checkpoint_id
    ) ON DELETE RESTRICT
);

ALTER TABLE runtime_rollout_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_streams FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_streams_tenant_policy ON runtime_rollout_streams
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_rollout_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_entries_tenant_policy ON runtime_rollout_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_rollout_append_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_append_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_append_commands_tenant_policy ON runtime_rollout_append_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_rollout_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_replacements FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_replacements_tenant_policy ON runtime_rollout_replacements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_rollout_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_checkpoints_tenant_policy ON runtime_rollout_checkpoints
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_rollout_checkpoint_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_rollout_checkpoint_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_rollout_checkpoint_commands_tenant_policy ON runtime_rollout_checkpoint_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：waiting_recovery
-- ---------------------------------------------------------------------------

-- waiting 恢复权、外部副作用 intent 与决定事实必须由 PostgreSQL 线性化。
ALTER TABLE run_events DROP CONSTRAINT run_events_kind_check;
ALTER TABLE run_events ADD CONSTRAINT run_events_kind_check CHECK (
  kind IN ('agent_event','attempt_state_changed','run_waiting','artifact_correction_requested','sandbox_recovery_decided')
);
CREATE UNIQUE INDEX run_events_waiting_recovery_checkpoint_idx
  ON run_events(tenant_id,attempt_id,(payload->>'checkpointId'))
  WHERE kind='sandbox_recovery_decided';
ALTER TABLE run_events ADD CONSTRAINT run_events_waiting_recovery_payload_check CHECK (
  kind <> 'sandbox_recovery_decided' OR (
    jsonb_typeof(payload)='object'
    AND octet_length(payload->>'checkpointId') BETWEEN 1 AND 200
    AND payload->>'decision' IN ('sandbox_reused','sandbox_rebuilt')
    AND (
      (payload->>'decision'='sandbox_reused' AND payload ?& ARRAY['registryId','generation'])
      OR (payload->>'decision'='sandbox_rebuilt' AND payload ? 'reason')
    )
  )
);

ALTER TABLE runtime_rollout_entries DROP CONSTRAINT runtime_rollout_entries_kind_check;
ALTER TABLE runtime_rollout_entries ADD CONSTRAINT runtime_rollout_entries_kind_check CHECK (
  kind IN ('user','assistant','tool_call','tool_result','waiting','terminal','sandbox_recovery')
);

ALTER TABLE sandbox_registry ADD COLUMN generation bigint NOT NULL DEFAULT 1;
ALTER TABLE sandbox_registry ADD CONSTRAINT sandbox_registry_generation_check CHECK (
  generation BETWEEN 1 AND 9007199254740991
);
CREATE UNIQUE INDEX runtime_rollout_waiting_recovery_checkpoint_idx
  ON runtime_rollout_entries(tenant_id,attempt_id,agent_thread_id,(body->>'checkpointId'))
  WHERE kind='sandbox_recovery';

ALTER TABLE run_claims ADD CONSTRAINT run_claims_attempt_generation_unique
  UNIQUE (tenant_id,run_id,attempt_id,claim_epoch);

CREATE TABLE waiting_recovery_checkpoints (
  tenant_id text NOT NULL,
  checkpoint_id text NOT NULL CHECK (octet_length(checkpoint_id) BETWEEN 1 AND 200),
  attempt_id text NOT NULL,
  attempt_generation bigint NOT NULL CHECK (attempt_generation BETWEEN 1 AND 9007199254740991),
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  base_revision_id text,
  workspace_head_state text NOT NULL CHECK (workspace_head_state IN ('found','empty')),
  workspace_head_revision_id text,
  registry_id text,
  provider_sandbox_id text,
  sandbox_generation bigint,
  sandbox_expected_generation bigint,
  sandbox_lifecycle text CHECK (sandbox_lifecycle IN (
    'paused','pause_unknown','connect_unknown','create_unknown','materialize_unknown'
  )),
  sandbox_paused_at timestamptz,
  sandbox_expires_at timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','effect_pending','resolved','unknown')),
  claim_owner text,
  claim_token text,
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch BETWEEN 0 AND 9007199254740991),
  claim_expires_at timestamptz,
  decision jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, checkpoint_id),
  UNIQUE (tenant_id, attempt_id, checkpoint_id),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,attempt_id,attempt_generation)
    REFERENCES run_claims(tenant_id,run_id,attempt_id,claim_epoch) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, workspace_head_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, registry_id, provider_sandbox_id)
    REFERENCES sandbox_registry(tenant_id, attempt_id, registry_id, provider_sandbox_id)
    ON DELETE RESTRICT,
  CONSTRAINT waiting_recovery_head_shape CHECK (
    (workspace_head_state='found' AND workspace_head_revision_id IS NOT NULL)
    OR (workspace_head_state='empty' AND workspace_head_revision_id IS NULL)
  ),
  CONSTRAINT waiting_recovery_sandbox_shape CHECK (
    (registry_id IS NULL AND provider_sandbox_id IS NULL AND sandbox_generation IS NULL
      AND sandbox_expected_generation IS NULL AND sandbox_lifecycle IS NULL
      AND sandbox_paused_at IS NULL AND sandbox_expires_at IS NULL)
    OR
    (registry_id IS NOT NULL AND provider_sandbox_id IS NOT NULL
      AND sandbox_generation > 0 AND sandbox_expected_generation > 0
      AND sandbox_lifecycle IS NOT NULL AND sandbox_paused_at IS NOT NULL
      AND sandbox_expires_at > sandbox_paused_at
      AND sandbox_expires_at <= sandbox_paused_at + interval '10 minutes')
  ),
  CONSTRAINT waiting_recovery_claim_shape CHECK (
    (state='pending' AND claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
    OR (state IN ('claimed','effect_pending') AND claim_owner IS NOT NULL
      AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (state IN ('resolved','unknown') AND decision IS NOT NULL)
  ),
  CONSTRAINT waiting_recovery_decision_shape CHECK (
    decision IS NULL OR (
      jsonb_typeof(decision)='object'
      AND (
        (decision->>'outcome'='external_effect_unknown'
          AND decision->>'effect' IN ('pause','connect','create','materialize')
          AND decision->'requestAutomaticRetry'='false'::jsonb)
        OR (decision->>'outcome'='workspace_head_unavailable'
          AND decision->'requestAutomaticRetry'='false'::jsonb)
        OR decision->>'outcome'='workspace_conflict'
        OR (decision->>'outcome'='resume'
          AND decision->>'workspace' IN ('unchanged','replan')
          AND decision->'sandbox'->>'kind' IN ('sandbox_reused','sandbox_rebuilt')
          AND (decision->'sandbox'->>'kind'<>'sandbox_reused'
            OR (octet_length(decision->'sandbox'->>'registryId') BETWEEN 1 AND 200
              AND jsonb_typeof(decision->'sandbox'->'generation')='number'
              AND (decision->'sandbox'->>'generation')::numeric BETWEEN 1 AND 9007199254740991
              AND (decision->'sandbox'->>'generation')::numeric=trunc((decision->'sandbox'->>'generation')::numeric)))
          AND (decision->'sandbox'->>'kind'<>'sandbox_rebuilt'
            OR decision->'sandbox'->>'reason' IN (
              'missing','ttl_expired','generation_mismatch','scope_mismatch','base_revision_mismatch'
            )))
      )
    )
  )
);

CREATE TABLE waiting_recovery_effect_outbox (
  tenant_id text NOT NULL,
  checkpoint_id text NOT NULL,
  intent_id text NOT NULL CHECK (octet_length(intent_id) BETWEEN 1 AND 200),
  claim_epoch bigint NOT NULL CHECK (claim_epoch > 0),
  effect text NOT NULL CHECK (effect IN ('connect','create','materialize')),
  state text NOT NULL CHECK (state IN ('pending','executing','completed','unknown')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, checkpoint_id, intent_id),
  UNIQUE (tenant_id, checkpoint_id, effect),
  FOREIGN KEY (tenant_id, checkpoint_id) REFERENCES waiting_recovery_checkpoints(tenant_id, checkpoint_id)
    ON DELETE RESTRICT,
  CONSTRAINT waiting_recovery_effect_payload_shape CHECK (
    (state='pending' AND payload ?& ARRAY['plan','decision']
      AND payload->>'requestDigest' ~ '^[0-9a-f]{64}$')
    OR (state='executing' AND payload ?& ARRAY[
      'plan','decision','requestDigest','executionTokenDigest','executionStartedAt'
    ] AND payload->>'requestDigest' ~ '^[0-9a-f]{64}$'
      AND payload->>'executionTokenDigest' ~ '^[0-9a-f]{64}$')
    OR (state='completed' AND payload ? 'plan' AND payload ? 'proof'
      AND payload->>'requestDigest' ~ '^[0-9a-f]{64}$'
      AND octet_length(payload->'proof'->>'registryId') BETWEEN 1 AND 200
      AND octet_length(payload->'proof'->>'providerSandboxId') BETWEEN 1 AND 200
      AND jsonb_typeof(payload->'proof'->'generation')='number'
      AND (payload->'proof'->>'generation')::numeric BETWEEN 1 AND 9007199254740991
      AND (payload->'proof'->>'generation')::numeric=trunc((payload->'proof'->>'generation')::numeric))
    OR (state='unknown' AND payload->>'unknownEffect' IN ('connect','create','materialize'))
  )
);

CREATE INDEX waiting_recovery_claim_idx ON waiting_recovery_checkpoints(tenant_id,state,claim_expires_at);
CREATE INDEX waiting_recovery_effect_dispatch_idx ON waiting_recovery_effect_outbox(tenant_id,state,updated_at)
  WHERE state IN ('pending','executing');

ALTER TABLE waiting_recovery_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiting_recovery_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY waiting_recovery_checkpoints_tenant_policy ON waiting_recovery_checkpoints
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE waiting_recovery_effect_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiting_recovery_effect_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY waiting_recovery_effect_outbox_tenant_policy ON waiting_recovery_effect_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：workspace_runtime
-- ---------------------------------------------------------------------------

CREATE TABLE runtime_recovery_metrics (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  metric_id uuid NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  registry_id text NOT NULL,
  reason text NOT NULL,
  cleanup_outcome text NOT NULL CHECK (cleanup_outcome IN ('settled', 'unknown', 'failed')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, metric_id),
  FOREIGN KEY (tenant_id, run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, thread_id)
    REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT
);

ALTER TABLE runtime_recovery_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_recovery_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_recovery_metrics_isolation_policy ON runtime_recovery_metrics
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE ALL ON runtime_recovery_metrics FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 区段：workspace_manifest_journal
-- ---------------------------------------------------------------------------

-- Workspace revision 从此以逐文件 stable Blob manifest 为唯一内容事实。旧 object_key 仅保留给
-- 迁移前的兼容读取，新的 Runtime 提交必须写 NULL，不能把单一对象键伪装成 manifest。
-- 旧 current head 不能在 migration 中用平面 object_key 猜测转换为 manifest。此处不做越过
-- FORCE RLS 的不可信“全租户检查”；运行时读取到没有 manifest 的旧 head 必须失败关闭，直到
-- 独立、受审计的 backfill 工具按 tenant 生成可验证的 incarnation 引用。

ALTER TABLE workspace_revisions ALTER COLUMN object_key DROP NOT NULL;
ALTER TABLE workspace_revisions DROP CONSTRAINT IF EXISTS workspace_revisions_object_key_check;

CREATE TABLE workspace_revision_manifests (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  revision_id text NOT NULL,
  thread_id text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  total_bytes bigint NOT NULL CHECK (total_bytes >= 0 AND total_bytes <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, revision_id),
  FOREIGN KEY (tenant_id, workspace_id, revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, workspace_id, thread_id)
    REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT
);

CREATE TABLE workspace_revision_files (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  revision_id text NOT NULL,
  relative_path text NOT NULL CHECK (
    length(relative_path) BETWEEN 1 AND 4096
    AND relative_path !~ '(^/|\\|(^|/)\\.\\.?(/|$)|[[:cntrl:]])'
  ),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0 AND size <= 9007199254740991),
  blob_lifecycle_id uuid NOT NULL,
  blob_incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, revision_id, relative_path),
  FOREIGN KEY (tenant_id, workspace_id, revision_id)
    REFERENCES workspace_revision_manifests(tenant_id, workspace_id, revision_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, blob_lifecycle_id, blob_incarnation_id, physical_object_key)
    REFERENCES blob_incarnations(tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    ON DELETE RESTRICT
);

CREATE INDEX workspace_revision_files_blob_reachability_idx
  ON workspace_revision_files (tenant_id, blob_lifecycle_id, blob_incarnation_id);

-- Journal 把完整 identity 永久绑定到 operationKey。unknown 只能从 running 单调进入，
-- complete 后绝不允许被降级，供 Worker 崩溃后从稳定事实继续。
CREATE TABLE workspace_operation_journal (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  thread_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('materialize', 'publish')),
  operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  identity jsonb NOT NULL CHECK (jsonb_typeof(identity) = 'object'),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'retryable', 'terminal', 'unknown')),
  result jsonb,
  failure_phase text,
  failure_code text,
  unknown_fact jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, thread_id, kind, operation_key),
  FOREIGN KEY (tenant_id, workspace_id, thread_id)
    REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operation_journal_result_shape CHECK (
    (status = 'completed' AND result IS NOT NULL AND failure_phase IS NULL AND failure_code IS NULL)
    OR (status = 'running' AND result IS NULL AND failure_phase IS NULL AND failure_code IS NULL AND unknown_fact IS NULL)
    OR (status IN ('retryable', 'terminal') AND result IS NULL AND failure_phase IS NOT NULL AND failure_code IS NOT NULL)
    OR (status = 'unknown' AND result IS NULL AND unknown_fact IS NOT NULL)
  )
);

ALTER TABLE workspace_revision_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_revision_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_revision_manifests_isolation_policy ON workspace_revision_manifests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE workspace_revision_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_revision_files FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_revision_files_isolation_policy ON workspace_revision_files
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE workspace_operation_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_operation_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_operation_journal_isolation_policy ON workspace_operation_journal
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE ALL ON workspace_revision_manifests, workspace_revision_files, workspace_operation_journal FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 区段：workspace_candidate_handoff
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 区段：workspace_artifact_intents
-- ---------------------------------------------------------------------------

-- 模型阶段只记录不可下载意图；RuntimeMutation 提交最终 Revision 时才建立
-- ResourceVersion、Artifact 与 settlement 的完整事实链。
ALTER TABLE blob_references
  ADD CONSTRAINT blob_references_lifecycle_identity_fk FOREIGN KEY (
    tenant_id,lifecycle_id,purpose,sha256,size
  ) REFERENCES blob_lifecycles(
    tenant_id,lifecycle_id,purpose,sha256,size
  ) ON DELETE RESTRICT;

ALTER TABLE workspace_revision_files
  ADD CONSTRAINT workspace_revision_files_artifact_source_key UNIQUE (
    tenant_id,workspace_id,revision_id,relative_path,content_sha256,size,
    blob_lifecycle_id,blob_incarnation_id,physical_object_key
  );

-- Workspace stable 对象的 purpose 是对象键身份的一部分，不能把同一物理键伪装成
-- resource purpose。ResourceVersion/Artifact 只在完整反向绑定 Revision file 时允许
-- 保存 workspace purpose；普通 Resource 来源仍保持 resource-only。
ALTER TABLE resource_versions
  DROP CONSTRAINT resource_versions_blob_purpose_check,
  ADD COLUMN source_workspace_id text,
  ADD COLUMN source_workspace_revision_id text,
  ADD COLUMN source_relative_path text,
  ADD CONSTRAINT resource_version_blob_source_shape CHECK (
    (blob_purpose='resource' AND source_workspace_id IS NULL
      AND source_workspace_revision_id IS NULL AND source_relative_path IS NULL)
    OR (blob_purpose='workspace' AND source_workspace_id IS NOT NULL
      AND source_workspace_revision_id IS NOT NULL AND source_relative_path IS NOT NULL)
  ),
  ADD CONSTRAINT resource_version_workspace_source_fk FOREIGN KEY (
    tenant_id,source_workspace_id,source_workspace_revision_id,source_relative_path,
    digest,size,blob_lifecycle_id,blob_incarnation_id,physical_object_key
  ) REFERENCES workspace_revision_files(
    tenant_id,workspace_id,revision_id,relative_path,content_sha256,size,
    blob_lifecycle_id,blob_incarnation_id,physical_object_key
  ) ON DELETE RESTRICT;

ALTER TABLE artifact_publications
  DROP CONSTRAINT artifact_publications_blob_purpose_check,
  ADD COLUMN source_workspace_id text,
  ADD COLUMN workspace_revision_id text,
  ADD COLUMN source_relative_path text,
  ADD CONSTRAINT artifact_publication_workspace_source_shape CHECK (
    (blob_purpose='resource' AND source_workspace_id IS NULL
      AND workspace_revision_id IS NULL AND source_relative_path IS NULL)
    OR (blob_purpose='workspace' AND source_workspace_id IS NOT NULL
      AND workspace_revision_id IS NOT NULL AND source_relative_path IS NOT NULL)
  ),
  ADD CONSTRAINT artifact_publication_workspace_source_fk FOREIGN KEY (
    tenant_id,source_workspace_id,workspace_revision_id,source_relative_path,digest,size,
    blob_lifecycle_id,blob_incarnation_id,physical_object_key
  ) REFERENCES workspace_revision_files(
    tenant_id,workspace_id,revision_id,relative_path,content_sha256,size,
    blob_lifecycle_id,blob_incarnation_id,physical_object_key
  ) ON DELETE RESTRICT;

-- intent 不得只保存一组可伪造的 permit/call 文本。组合候选键让后续 FK 同时证明：
-- call 已登记为 publish_artifact，且对应 tool_execution permit 已消费并匹配 args。
ALTER TABLE effect_invocations
  ADD CONSTRAINT effect_invocations_artifact_intent_key UNIQUE (
    tenant_id,attempt_id,call_id,tool_name
  );
ALTER TABLE external_effect_permits
  ADD CONSTRAINT external_effect_permits_artifact_intent_key UNIQUE (
    tenant_id,attempt_id,permit_id,effect,call_id,tool_name,args_digest,consumed_at
  );

CREATE TABLE workspace_artifact_publication_intents (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  call_id text NOT NULL CHECK (octet_length(call_id) BETWEEN 1 AND 256),
  permit_id text NOT NULL CHECK (octet_length(permit_id) BETWEEN 1 AND 256),
  effect text GENERATED ALWAYS AS ('tool_execution'::text) STORED,
  tool_name text GENERATED ALWAYS AS ('publish_artifact'::text) STORED,
  permit_consumed_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  tool_args_digest text NOT NULL CHECK (tool_args_digest ~ '^[0-9a-f]{64}$'),
  requested_artifact_id text NOT NULL,
  artifact_id text NOT NULL,
  resource_id text NOT NULL,
  resource_version_id text NOT NULL,
  blob_reference_id text NOT NULL,
  blob_operation_id text NOT NULL CHECK (
    blob_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ),
  replaces_artifact_id text,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  purpose text NOT NULL CHECK (purpose IN ('deliverable','diagnostic','trace')),
  deliverable_key text,
  normalized_deliverable_key text GENERATED ALWAYS AS (coalesce(deliverable_key,'')) STORED,
  source_relative_path text NOT NULL CHECK (
    length(source_relative_path) BETWEEN 1 AND 4096
    AND source_relative_path !~ '(^/|\\|(^|/)\.\.?(/|$)|[[:cntrl:]])'
  ),
  resource_name text NOT NULL CHECK (octet_length(resource_name) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,attempt_id,idempotency_key),
  UNIQUE (tenant_id,attempt_id,call_id),
  UNIQUE (tenant_id,attempt_id,requested_artifact_id),
  UNIQUE (tenant_id,artifact_id),
  UNIQUE (tenant_id,resource_id),
  UNIQUE (tenant_id,resource_version_id),
  UNIQUE (tenant_id,blob_reference_id),
  UNIQUE (tenant_id,blob_operation_id),
  FOREIGN KEY (tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id)
    REFERENCES execution_attempts(
      tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id,call_id,tool_name)
    REFERENCES effect_invocations(tenant_id,attempt_id,call_id,tool_name)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id,attempt_id,permit_id,effect,call_id,tool_name,
    tool_args_digest,permit_consumed_at
  ) REFERENCES external_effect_permits(
    tenant_id,attempt_id,permit_id,effect,call_id,tool_name,args_digest,consumed_at
  ) MATCH FULL ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,deliverable_key)
    REFERENCES artifact_deliverable_declarations(tenant_id,run_id,deliverable_key)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,replaces_artifact_id)
    REFERENCES artifact_publications(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT workspace_artifact_intent_deliverable_shape CHECK (
    (purpose='deliverable' AND deliverable_key IS NOT NULL)
    OR (purpose<>'deliverable' AND deliverable_key IS NULL)
  )
);

ALTER TABLE workspace_artifact_publication_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_artifact_publication_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_artifact_publication_intents_tenant_policy
  ON workspace_artifact_publication_intents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE ALL ON workspace_artifact_publication_intents FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 区段：model_wire_trace
-- ---------------------------------------------------------------------------

-- 先持久化命令意图，再推进 trace Blob；索引失败可由同命令或到期清理恢复。
CREATE TABLE model_wire_trace_cleanup_commands (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  command_id text NOT NULL CHECK (octet_length(command_id) BETWEEN 1 AND 200),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  expires_before timestamptz NOT NULL,
  batch_size integer NOT NULL CHECK (batch_size BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('pending', 'references_released', 'completed')),
  deleted_count integer CHECK (deleted_count BETWEEN 0 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, command_id),
  CONSTRAINT model_wire_trace_cleanup_command_shape_check CHECK (
    (status = 'pending' AND deleted_count IS NULL AND completed_at IS NULL)
    OR (status = 'references_released' AND deleted_count IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND deleted_count IS NOT NULL AND completed_at IS NOT NULL)
  )
);

-- 引用释放前先留下完整 stable 身份；清理 consumer 据此显式调用既有 GC，不能只让正文变得不可见。
CREATE TABLE model_wire_trace_cleanup_items (
  tenant_id text NOT NULL,
  cleanup_command_id text NOT NULL,
  blob_reference_id text NOT NULL,
  lifecycle_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose = 'trace'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size BETWEEN 0 AND 9007199254740991),
  incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'retry', 'completed')),
  outcome text CHECK (outcome IN ('deleted', 'still_referenced')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, cleanup_command_id, blob_reference_id),
  FOREIGN KEY (tenant_id, cleanup_command_id)
    REFERENCES model_wire_trace_cleanup_commands(tenant_id, command_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, lifecycle_id, purpose, sha256, size)
    REFERENCES blob_lifecycles(tenant_id, lifecycle_id, purpose, sha256, size) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    REFERENCES blob_incarnations(tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    ON DELETE RESTRICT,
  CONSTRAINT model_wire_trace_cleanup_item_shape_check CHECK (
    (state IN ('pending', 'retry') AND outcome IS NULL)
    OR (state = 'completed' AND outcome IS NOT NULL)
  )
);

-- 到期后只保留最小幂等墓碑，阻止旧命令在引用释放后重新创建永久悬空引用。
CREATE TABLE model_wire_trace_expiry_tombstones (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  model_turn bigint NOT NULL CHECK (model_turn BETWEEN 0 AND 9007199254740991),
  transport_attempt bigint NOT NULL CHECK (transport_attempt BETWEEN 0 AND 9007199254740991),
  part text NOT NULL CHECK (part IN ('request', 'response')),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  blob_operation_id text NOT NULL CHECK (blob_operation_id ~ '^trace-[0-9a-f]{64}$'),
  sha256 text,
  size bigint CHECK (size BETWEEN 0 AND 9007199254740991),
  cleanup_command_id text NOT NULL,
  expired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  staging_swept_at timestamptz,
  PRIMARY KEY (tenant_id, attempt_id, model_turn, transport_attempt, part),
  FOREIGN KEY (tenant_id, cleanup_command_id)
    REFERENCES model_wire_trace_cleanup_commands(tenant_id, command_id) ON DELETE RESTRICT,
  CONSTRAINT model_wire_trace_expiry_tombstone_body_check CHECK (
    (sha256 IS NULL AND size IS NULL) OR (sha256 ~ '^[0-9a-f]{64}$' AND size IS NOT NULL)
  )
);
CREATE INDEX model_wire_trace_tombstone_staging_sweep_idx
  ON model_wire_trace_expiry_tombstones(
    tenant_id, staging_swept_at ASC NULLS FIRST, expired_at, attempt_id, model_turn,
    transport_attempt, part
  );

-- reference_id 已经唯一；该冗余唯一键让下游 FK 同时证明 stable/state/purpose 与完整物理身份。
ALTER TABLE blob_references ADD CONSTRAINT blob_references_model_wire_identity_unique
  UNIQUE (
    tenant_id, reference_id, operation_id, state, purpose, sha256, size,
    lifecycle_id, incarnation_id, physical_object_key
  );

CREATE TABLE model_wire_trace_records (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  model_turn bigint NOT NULL CHECK (model_turn BETWEEN 0 AND 9007199254740991),
  transport_attempt bigint NOT NULL CHECK (transport_attempt BETWEEN 0 AND 9007199254740991),
  part text NOT NULL CHECK (part IN ('request', 'response')),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  blob_operation_id text NOT NULL CHECK (blob_operation_id ~ '^trace-[0-9a-f]{64}$'),
  capture_status text NOT NULL CHECK (capture_status IN ('complete', 'truncated', 'aborted', 'failed')),
  capture_error_code text CHECK (capture_error_code IN ('CAPTURE_UNAVAILABLE', 'BODY_UNREADABLE')),
  persistence_status text NOT NULL CHECK (persistence_status IN (
    'pending', 'stored', 'unknown', 'conflict', 'unavailable', 'not_captured'
  )),
  sha256 text,
  size bigint,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  blob_reference_id text,
  blob_state text,
  blob_purpose text,
  blob_lifecycle_id uuid,
  blob_incarnation_id uuid,
  physical_object_key text,
  processing_token uuid,
  processing_lease_expires_at timestamptz,
  retention_recovery_at timestamptz,
  cleanup_command_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, attempt_id, model_turn, transport_attempt, part),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(
      tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, cleanup_command_id)
    REFERENCES model_wire_trace_cleanup_commands(tenant_id, command_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, blob_reference_id, blob_operation_id, blob_state, blob_purpose, sha256, size,
    blob_lifecycle_id, blob_incarnation_id, physical_object_key
  ) REFERENCES blob_references(
    tenant_id, reference_id, operation_id, state, purpose, sha256, size,
    lifecycle_id, incarnation_id, physical_object_key
  ) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT model_wire_trace_identity_check CHECK (
    octet_length(thread_id) BETWEEN 1 AND 200 AND octet_length(run_id) BETWEEN 1 AND 200
    AND octet_length(attempt_id) BETWEEN 1 AND 200
    AND octet_length(workspace_id) BETWEEN 1 AND 200 AND octet_length(root_run_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT model_wire_trace_body_check CHECK (
    (
      persistence_status = 'not_captured' AND capture_error_code IS NOT NULL
      AND sha256 IS NULL AND size IS NULL AND blob_reference_id IS NULL
      AND blob_state IS NULL AND blob_purpose IS NULL AND blob_lifecycle_id IS NULL
      AND blob_incarnation_id IS NULL AND physical_object_key IS NULL
    )
    OR
    (
      persistence_status IN ('pending', 'unknown', 'conflict', 'unavailable')
      AND capture_error_code IS NULL AND sha256 ~ '^[0-9a-f]{64}$'
      AND size BETWEEN 0 AND 9007199254740991 AND blob_reference_id IS NULL
      AND blob_state IS NULL AND blob_purpose IS NULL AND blob_lifecycle_id IS NULL
      AND blob_incarnation_id IS NULL AND physical_object_key IS NULL
    )
    OR
    (
      persistence_status = 'stored' AND capture_error_code IS NULL
      AND sha256 ~ '^[0-9a-f]{64}$' AND size BETWEEN 0 AND 9007199254740991
      AND blob_reference_id IS NOT NULL AND blob_state = 'stable' AND blob_purpose = 'trace'
      AND blob_lifecycle_id IS NOT NULL AND blob_incarnation_id IS NOT NULL
      AND physical_object_key IS NOT NULL
    )
  ),
  CONSTRAINT model_wire_trace_processing_lease_shape_check CHECK (
    (processing_token IS NULL AND processing_lease_expires_at IS NULL)
    OR (processing_token IS NOT NULL AND processing_lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX model_wire_trace_records_run_idx ON model_wire_trace_records(
  tenant_id, run_id, attempt_id, model_turn, transport_attempt, part
);
CREATE INDEX model_wire_trace_records_expiry_idx ON model_wire_trace_records(
  tenant_id, expires_at, attempt_id, model_turn, transport_attempt, part
) WHERE cleanup_command_id IS NULL;
CREATE INDEX model_wire_trace_records_recovery_sweep_idx ON model_wire_trace_records(
  tenant_id, retention_recovery_at ASC NULLS FIRST, expires_at, attempt_id,
  model_turn, transport_attempt, part
) WHERE cleanup_command_id IS NULL;

ALTER TABLE model_wire_trace_cleanup_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_wire_trace_cleanup_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY model_wire_trace_cleanup_commands_tenant_policy
  ON model_wire_trace_cleanup_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE model_wire_trace_cleanup_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_wire_trace_cleanup_items FORCE ROW LEVEL SECURITY;
CREATE POLICY model_wire_trace_cleanup_items_tenant_policy ON model_wire_trace_cleanup_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE model_wire_trace_expiry_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_wire_trace_expiry_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY model_wire_trace_expiry_tombstones_tenant_policy
  ON model_wire_trace_expiry_tombstones
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE model_wire_trace_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_wire_trace_records FORCE ROW LEVEL SECURITY;
CREATE POLICY model_wire_trace_records_tenant_select_policy ON model_wire_trace_records FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY model_wire_trace_records_tenant_insert_policy ON model_wire_trace_records FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY model_wire_trace_records_tenant_update_policy ON model_wire_trace_records FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY model_wire_trace_records_expired_delete_policy ON model_wire_trace_records FOR DELETE
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
    AND expires_at <= clock_timestamp() AND cleanup_command_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM model_wire_trace_cleanup_commands cleanup
       WHERE cleanup.tenant_id = model_wire_trace_records.tenant_id
         AND cleanup.command_id = model_wire_trace_records.cleanup_command_id
         AND cleanup.status = 'pending'
    )
    AND EXISTS (
      SELECT 1 FROM model_wire_trace_expiry_tombstones tombstone
       WHERE tombstone.tenant_id = model_wire_trace_records.tenant_id
         AND tombstone.attempt_id = model_wire_trace_records.attempt_id
         AND tombstone.model_turn = model_wire_trace_records.model_turn
         AND tombstone.transport_attempt = model_wire_trace_records.transport_attempt
         AND tombstone.part = model_wire_trace_records.part
         AND tombstone.command_digest = model_wire_trace_records.command_digest
         AND tombstone.blob_operation_id = model_wire_trace_records.blob_operation_id
         AND tombstone.cleanup_command_id = model_wire_trace_records.cleanup_command_id
    )
  );

-- Runtime 虽持有 blob_references DELETE，但 RLS 只允许删除已到期、且由完整命令/物理身份绑定的 trace 引用。
DROP POLICY blob_references_isolation_policy ON blob_references;
CREATE POLICY blob_references_tenant_select_policy ON blob_references FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY blob_references_tenant_insert_policy ON blob_references FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY blob_references_tenant_update_policy ON blob_references FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY blob_references_expired_trace_delete_policy ON blob_references FOR DELETE
  USING (
    current_user = pg_get_userbyid(
      (SELECT relation.relowner FROM pg_class relation WHERE relation.oid = 'blob_references'::regclass)
    )
    OR (
      tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
      AND purpose = 'trace' AND state = 'stable'
      AND EXISTS (
        SELECT 1 FROM model_wire_trace_cleanup_items item
         WHERE item.tenant_id = blob_references.tenant_id
           AND item.blob_reference_id = blob_references.reference_id
           AND item.purpose = blob_references.purpose
           AND item.sha256 = blob_references.sha256
           AND item.size = blob_references.size
           AND item.lifecycle_id = blob_references.lifecycle_id
           AND item.incarnation_id = blob_references.incarnation_id
           AND item.physical_object_key = blob_references.physical_object_key
           AND (
             EXISTS (
               SELECT 1 FROM model_wire_trace_records record
                WHERE record.tenant_id = blob_references.tenant_id
                  AND record.cleanup_command_id = item.cleanup_command_id
                  AND record.blob_operation_id = blob_references.operation_id
                  AND record.sha256 = blob_references.sha256
                  AND record.size = blob_references.size
                  AND record.expires_at <= clock_timestamp()
             )
             OR EXISTS (
               SELECT 1 FROM model_wire_trace_expiry_tombstones tombstone
                WHERE tombstone.tenant_id = blob_references.tenant_id
                  AND tombstone.cleanup_command_id = item.cleanup_command_id
                  AND tombstone.blob_operation_id = blob_references.operation_id
                  AND tombstone.sha256 = blob_references.sha256
                  AND tombstone.size = blob_references.size
             )
           )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 区段：thread_execution_heads
-- ---------------------------------------------------------------------------

-- Thread execution head 是 Run 激活与 writer fencing 的唯一线性化点。
CREATE TABLE thread_execution_heads (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  active_run_id text,
  active_turn_id text,
  next_turn_ordinal bigint NOT NULL DEFAULT 1 CHECK (
    next_turn_ordinal BETWEEN 1 AND 9007199254740991
  ),
  next_queue_sequence bigint NOT NULL DEFAULT 1 CHECK (
    next_queue_sequence BETWEEN 1 AND 9007199254740991
  ),
  -- 阶段 1 尚未创建 Thread Context 流；NULL 明确表示“没有可绑定的 Context fact”。
  -- 阶段 2 的 context append 必须在锁定本行时单调推进该 cursor。
  context_through_sequence bigint CHECK (
    context_through_sequence BETWEEN 0 AND 9007199254740991
  ),
  writer_owner text,
  writer_token text,
  writer_epoch bigint NOT NULL DEFAULT 0 CHECK (
    writer_epoch BETWEEN 0 AND 9007199254740991
  ),
  writer_expires_at timestamptz,
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, active_run_id, thread_id)
    REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  CONSTRAINT thread_execution_head_writer_shape_check CHECK (
    (
      writer_owner IS NULL AND writer_token IS NULL AND writer_expires_at IS NULL
    ) OR (
      active_run_id IS NOT NULL
      AND octet_length(writer_owner) BETWEEN 1 AND 200
      AND octet_length(writer_token) BETWEEN 1 AND 200
      AND writer_expires_at IS NOT NULL
    )
  ),
  CONSTRAINT thread_execution_head_active_turn_shape_check CHECK (
    active_turn_id IS NULL OR active_run_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX thread_execution_heads_active_run_idx
  ON thread_execution_heads(tenant_id, active_run_id) WHERE active_run_id IS NOT NULL;

-- 只建立空 head，不猜测迁移时既有非终态 Run 的先后关系。V2 新入口启用前必须先通过
-- legacy drain Gate；关闭开关时既有每 Run 路径继续工作。
INSERT INTO thread_execution_heads(tenant_id, thread_id)
SELECT tenant_id, id FROM threads;

ALTER TABLE thread_execution_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_execution_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_execution_heads_tenant_policy ON thread_execution_heads
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：thread_follow_up_queue
-- ---------------------------------------------------------------------------

-- 旧 /runs 在 V2 开关开启时先保存不可变输入，再进入 Thread FIFO。
CREATE TABLE thread_input_receipts (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  receipt_id text NOT NULL CHECK (octet_length(receipt_id) BETWEEN 1 AND 200),
  client_request_id text NOT NULL CHECK (octet_length(client_request_id) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  requested_mode text NOT NULL CHECK (requested_mode = 'follow_up'),
  state text NOT NULL CHECK (state IN ('pending', 'consumed', 'cancelled', 'rejected')),
  disposition text NOT NULL CHECK (disposition IN ('queued', 'cancelled', 'rejected')),
  queued_run_id text NOT NULL,
  queue_sequence bigint NOT NULL CHECK (queue_sequence BETWEEN 1 AND 9007199254740991),
  input_text text NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  body_size_bytes bigint NOT NULL CHECK (body_size_bytes BETWEEN 1 AND 1048576),
  applied_context_sequence bigint CHECK (
    applied_context_sequence BETWEEN 0 AND 9007199254740991
  ),
  rejection_code text,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, thread_id, receipt_id),
  UNIQUE (tenant_id, thread_id, client_request_id),
  UNIQUE (tenant_id, thread_id, queued_run_id),
  UNIQUE (tenant_id, thread_id, queue_sequence),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, queued_run_id, thread_id)
    REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  CONSTRAINT thread_input_receipt_body_check CHECK (
    octet_length(input_text) = body_size_bytes AND input_text ~ '[^[:space:]]'
  ),
  CONSTRAINT thread_input_receipt_state_shape_check CHECK (
    (state = 'pending' AND disposition = 'queued' AND consumed_at IS NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL)
    OR (state = 'consumed' AND disposition = 'queued' AND consumed_at IS NOT NULL
      AND rejection_code IS NULL)
    OR (state = 'cancelled' AND disposition = 'cancelled' AND consumed_at IS NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL)
    OR (state = 'rejected' AND disposition = 'rejected' AND consumed_at IS NOT NULL
      AND rejection_code IS NOT NULL)
  )
);

CREATE TABLE thread_follow_up_queue (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  queue_sequence bigint NOT NULL CHECK (queue_sequence BETWEEN 1 AND 9007199254740991),
  turn_ordinal bigint NOT NULL CHECK (turn_ordinal BETWEEN 1 AND 9007199254740991),
  receipt_id text NOT NULL,
  run_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'active', 'finished', 'failed', 'cancelled')),
  claim_owner text,
  claim_token text,
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch BETWEEN 0 AND 9007199254740991),
  claim_expires_at timestamptz,
  consumption_receipt jsonb,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, thread_id, queue_sequence),
  UNIQUE (tenant_id, thread_id, turn_ordinal),
  UNIQUE (tenant_id, thread_id, receipt_id),
  UNIQUE (tenant_id, thread_id, run_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, run_id, thread_id)
    REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id, receipt_id)
    REFERENCES thread_input_receipts(tenant_id, thread_id, receipt_id) ON DELETE RESTRICT,
  CONSTRAINT thread_follow_up_queue_claim_shape_check CHECK (
    (
      claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL
    ) OR (
      state = 'active'
      AND octet_length(claim_owner) BETWEEN 1 AND 200
      AND octet_length(claim_token) BETWEEN 1 AND 200
      AND claim_epoch > 0
      AND claim_expires_at IS NOT NULL
    )
  ),
  CONSTRAINT thread_follow_up_queue_state_shape_check CHECK (
    (state = 'queued' AND activated_at IS NULL AND finished_at IS NULL
      AND consumption_receipt IS NULL)
    OR (state = 'active' AND activated_at IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('finished', 'failed', 'cancelled') AND finished_at IS NOT NULL
      AND consumption_receipt IS NOT NULL)
  )
);
CREATE UNIQUE INDEX thread_follow_up_queue_one_active_idx
  ON thread_follow_up_queue(tenant_id, thread_id) WHERE state = 'active';
CREATE INDEX thread_follow_up_queue_fifo_idx
  ON thread_follow_up_queue(tenant_id, thread_id, queue_sequence) WHERE state = 'queued';

-- 阶段 1 只固定激活瞬间的 cursor；不创建 Thread Context facts 或读取路径。
ALTER TABLE run_execution_inputs ADD COLUMN context_through_sequence bigint CHECK (
  context_through_sequence BETWEEN 0 AND 9007199254740991
);

ALTER TABLE thread_input_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_input_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_input_receipts_tenant_policy ON thread_input_receipts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE thread_follow_up_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_follow_up_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_follow_up_queue_tenant_policy ON thread_follow_up_queue
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：run_workspace_results
-- ---------------------------------------------------------------------------

-- 显式记录每个 V2 Run 的 Workspace base/result 关系，不复制文件树。
ALTER TABLE run_execution_inputs ADD CONSTRAINT run_execution_inputs_result_scope_unique
  UNIQUE (tenant_id, run_id, thread_id, workspace_id);

CREATE TABLE run_workspace_results (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  workspace_id text NOT NULL,
  base_revision_id text,
  result_revision_id text,
  outcome text NOT NULL CHECK (outcome IN ('committed', 'unchanged', 'failed_before_commit')),
  manifest_digest text CHECK (manifest_digest IS NULL OR manifest_digest ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, run_id, thread_id, workspace_id),
  FOREIGN KEY (tenant_id, run_id, thread_id, workspace_id)
    REFERENCES run_execution_inputs(tenant_id, run_id, thread_id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, base_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, result_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT run_workspace_result_shape_check CHECK (
    (outcome = 'committed' AND result_revision_id IS NOT NULL
      AND result_revision_id IS DISTINCT FROM base_revision_id
      AND manifest_digest IS NOT NULL AND committed_at IS NOT NULL)
    OR (outcome = 'unchanged' AND result_revision_id IS NOT DISTINCT FROM base_revision_id
      AND committed_at IS NOT NULL)
    OR (outcome = 'failed_before_commit' AND result_revision_id IS NULL
      AND manifest_digest IS NULL AND committed_at IS NULL)
  )
);

ALTER TABLE run_workspace_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_workspace_results FORCE ROW LEVEL SECURITY;
CREATE POLICY run_workspace_results_tenant_policy ON run_workspace_results
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：thread_context_stream
-- ---------------------------------------------------------------------------

-- Thread Context 是跨 Run 的仅追加事实流，不替代 Attempt rollout。
ALTER TABLE execution_attempts
  ADD CONSTRAINT execution_attempts_context_scope_unique
  UNIQUE (tenant_id,attempt_id,run_id,thread_id);

CREATE TABLE thread_context_streams (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence BETWEEN 1 AND 9007199254740991),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT
);

INSERT INTO thread_context_streams(tenant_id,thread_id)
SELECT tenant_id,id FROM threads;

CREATE TABLE thread_context_entries (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  entry_id text NOT NULL CHECK (octet_length(entry_id) BETWEEN 1 AND 512),
  run_id text,
  attempt_id text,
  kind text NOT NULL CHECK (kind IN (
    'run_started','user_message','assistant_message','tool_call','tool_result',
    'workspace_committed','workspace_unchanged','run_terminal'
  )),
  tool_call_id text,
  tool_name text,
  normalized_tool_call_id text GENERATED ALWAYS AS (coalesce(tool_call_id,'')) STORED,
  tool_call_sequence bigint,
  tool_call_predecessor_kind text GENERATED ALWAYS AS (
    CASE WHEN kind='tool_result' THEN 'tool_call' ELSE NULL END
  ) STORED,
  body_inline jsonb,
  body_reference_id text,
  body_operation_id text,
  body_state text,
  body_purpose text,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  body_size bigint NOT NULL CHECK (body_size BETWEEN 0 AND 9007199254740991),
  body_lifecycle_id uuid,
  body_incarnation_id uuid,
  body_physical_object_key text,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id,sequence),
  UNIQUE (tenant_id,thread_id,entry_id),
  UNIQUE (tenant_id,thread_id,sequence,kind,normalized_tool_call_id),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES thread_context_streams(tenant_id,thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,thread_id) REFERENCES runs(tenant_id,id,thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id,run_id,thread_id)
    REFERENCES execution_attempts(tenant_id,attempt_id,run_id,thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id,thread_id,tool_call_sequence,tool_call_predecessor_kind,normalized_tool_call_id
  ) REFERENCES thread_context_entries(
    tenant_id,thread_id,sequence,kind,normalized_tool_call_id
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    tenant_id,body_reference_id,body_operation_id,body_state,body_purpose,body_sha256,body_size,
    body_lifecycle_id,body_incarnation_id,body_physical_object_key
  ) REFERENCES blob_references(
    tenant_id,reference_id,operation_id,state,purpose,sha256,size,
    lifecycle_id,incarnation_id,physical_object_key
  ) ON DELETE RESTRICT,
  CONSTRAINT thread_context_entry_call_shape_check CHECK (
    (kind IN ('tool_call','tool_result')
      AND tool_call_id IS NOT NULL AND octet_length(tool_call_id) BETWEEN 1 AND 200
      AND tool_name IS NOT NULL AND octet_length(tool_name) BETWEEN 1 AND 200)
    OR (kind NOT IN ('tool_call','tool_result') AND tool_call_id IS NULL AND tool_name IS NULL)
  ),
  CONSTRAINT thread_context_entry_pair_shape_check CHECK (
    (kind='tool_result' AND tool_call_sequence IS NOT NULL)
    OR (kind<>'tool_result' AND tool_call_sequence IS NULL)
  ),
  CONSTRAINT thread_context_entry_body_shape_check CHECK (
    (body_inline IS NOT NULL AND jsonb_typeof(body_inline)='object'
      AND octet_length(body_inline::text) <= 2097152
      AND body_reference_id IS NULL AND body_operation_id IS NULL
      AND body_state IS NULL AND body_purpose IS NULL AND body_lifecycle_id IS NULL
      AND body_incarnation_id IS NULL AND body_physical_object_key IS NULL)
    OR
    (body_inline IS NULL AND body_reference_id IS NOT NULL
      AND body_operation_id IS NOT NULL AND body_state='stable' AND body_purpose='trace'
      AND body_lifecycle_id IS NOT NULL
      AND body_incarnation_id IS NOT NULL AND body_physical_object_key IS NOT NULL)
  )
);

CREATE INDEX thread_context_entries_run_idx
  ON thread_context_entries(tenant_id,run_id,sequence);

CREATE TABLE thread_context_append_commands (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  first_sequence bigint NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence >= first_sequence),
  entry_count integer NOT NULL CHECK (entry_count > 0 AND entry_count <= 512),
  appended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id,idempotency_key),
  FOREIGN KEY (tenant_id,thread_id,first_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,last_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT
);

ALTER TABLE thread_context_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_streams FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_streams_tenant_policy ON thread_context_streams
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_context_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_entries_tenant_policy ON thread_context_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_context_append_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_append_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_append_commands_tenant_policy ON thread_context_append_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：thread_context_history_audits
-- ---------------------------------------------------------------------------

-- shadow/read 每次重建都落摘要审计；正文仍只存在 Context entries / Stable Blob。
CREATE TABLE thread_context_history_audits (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow','read')),
  through_sequence bigint NOT NULL CHECK (through_sequence BETWEEN 0 AND 9007199254740991),
  compatibility_digest text NOT NULL CHECK (compatibility_digest ~ '^[0-9a-f]{64}$'),
  history_digest text NOT NULL CHECK (history_digest ~ '^[0-9a-f]{64}$'),
  projection_schema_version integer NOT NULL DEFAULT 1 CHECK (projection_schema_version=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id,attempt_id,mode,through_sequence,compatibility_digest,history_digest
  ),
  FOREIGN KEY (tenant_id,attempt_id,run_id,thread_id)
    REFERENCES execution_attempts(tenant_id,attempt_id,run_id,thread_id) ON DELETE RESTRICT
);

ALTER TABLE thread_context_history_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_history_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_history_audits_tenant_policy ON thread_context_history_audits
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：thread_input_routing
-- ---------------------------------------------------------------------------

-- 统一 receipt 顺序、durable steer 与 disposition 事件。
ALTER TABLE thread_execution_heads
  ADD COLUMN next_input_sequence bigint NOT NULL DEFAULT 1 CHECK (
    next_input_sequence BETWEEN 1 AND 9007199254740991
  );

UPDATE thread_execution_heads
   SET next_input_sequence=next_queue_sequence;

UPDATE thread_execution_heads head
   SET active_turn_id='turn-' || queue.turn_ordinal::text
  FROM thread_follow_up_queue queue
 WHERE queue.tenant_id=head.tenant_id AND queue.thread_id=head.thread_id
   AND queue.run_id=head.active_run_id AND queue.state='active';

ALTER TABLE thread_execution_heads
  ADD CONSTRAINT thread_execution_head_active_turn_id_check CHECK (
    active_turn_id IS NULL OR active_turn_id ~ '^turn-[1-9][0-9]{0,15}$'
  );

ALTER TABLE thread_input_receipts
  DROP CONSTRAINT thread_input_receipts_requested_mode_check,
  DROP CONSTRAINT thread_input_receipts_disposition_check,
  DROP CONSTRAINT thread_input_receipt_state_shape_check,
  DROP CONSTRAINT thread_input_receipt_body_check,
  ALTER COLUMN queued_run_id DROP NOT NULL,
  ALTER COLUMN queue_sequence DROP NOT NULL,
  ADD COLUMN input_sequence bigint,
  ADD COLUMN expected_run_id text,
  ADD COLUMN expected_turn_id text,
  ADD COLUMN fallback_to_follow_up boolean NOT NULL DEFAULT false,
  ADD COLUMN target_run_id text,
  ADD COLUMN target_turn_id text,
  ADD COLUMN fallback_run_id text;

UPDATE thread_input_receipts SET input_sequence=queue_sequence;

ALTER TABLE thread_input_receipts
  ALTER COLUMN input_sequence SET NOT NULL,
  ADD CONSTRAINT thread_input_receipts_input_sequence_key UNIQUE (
    tenant_id,thread_id,input_sequence
  ),
  ADD CONSTRAINT thread_input_receipts_requested_mode_check CHECK (
    requested_mode IN ('auto','steer','follow_up')
  ),
  ADD CONSTRAINT thread_input_receipts_disposition_check CHECK (
    disposition IN ('pending_steer','steered','queued','cancelled','rejected')
  ),
  ADD CONSTRAINT thread_input_receipts_identity_check CHECK (
    (expected_run_id IS NULL OR octet_length(expected_run_id) BETWEEN 1 AND 200)
    AND (expected_turn_id IS NULL OR octet_length(expected_turn_id) BETWEEN 1 AND 200)
    AND (target_run_id IS NULL OR octet_length(target_run_id) BETWEEN 1 AND 200)
    AND (target_turn_id IS NULL OR target_turn_id ~ '^turn-[1-9][0-9]{0,15}$')
    AND (fallback_run_id IS NULL OR octet_length(fallback_run_id) BETWEEN 1 AND 200)
  ),
  ADD CONSTRAINT thread_input_receipts_target_run_fk FOREIGN KEY (
    tenant_id,target_run_id,thread_id
  ) REFERENCES runs(tenant_id,id,thread_id) ON DELETE RESTRICT,
  ADD CONSTRAINT thread_input_receipts_body_check CHECK (
    body_size_bytes BETWEEN 1 AND 1048576
    AND octet_length(input_text)=body_size_bytes
    AND input_text ~ '[^[:space:]]'
  ),
  ADD CONSTRAINT thread_input_receipts_state_shape_check CHECK (
    (
      state='pending' AND disposition='pending_steer'
      AND target_run_id IS NOT NULL AND target_turn_id IS NOT NULL
      AND queued_run_id IS NULL AND queue_sequence IS NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL
      AND consumed_at IS NULL
    ) OR (
      state='pending' AND disposition='queued'
      AND queued_run_id IS NOT NULL AND queue_sequence IS NOT NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL
      AND consumed_at IS NULL
    ) OR (
      state='consumed' AND disposition='steered'
      AND target_run_id IS NOT NULL AND target_turn_id IS NOT NULL
      AND queued_run_id IS NULL AND queue_sequence IS NULL
      AND applied_context_sequence IS NOT NULL AND rejection_code IS NULL
      AND consumed_at IS NOT NULL
    ) OR (
      state='consumed' AND disposition='queued'
      AND queued_run_id IS NOT NULL AND queue_sequence IS NOT NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL
      AND consumed_at IS NOT NULL
    ) OR (
      state='cancelled' AND disposition='cancelled'
      AND applied_context_sequence IS NULL AND rejection_code IS NULL
      AND consumed_at IS NULL
    ) OR (
      state='rejected' AND disposition='rejected'
      AND applied_context_sequence IS NULL AND rejection_code IS NOT NULL
      AND consumed_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX thread_input_receipts_fallback_run_key
  ON thread_input_receipts(tenant_id,thread_id,fallback_run_id)
  WHERE fallback_run_id IS NOT NULL;

CREATE INDEX thread_input_receipts_pending_steer_idx
  ON thread_input_receipts(tenant_id,thread_id,target_run_id,input_sequence)
  WHERE state='pending' AND disposition='pending_steer';

CREATE TABLE thread_input_receipt_events (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  receipt_id text NOT NULL,
  event_sequence integer NOT NULL CHECK (event_sequence BETWEEN 1 AND 32),
  event_kind text NOT NULL CHECK (event_kind IN ('accepted','disposition_changed')),
  disposition text NOT NULL CHECK (
    disposition IN ('pending_steer','steered','queued','cancelled','rejected')
  ),
  target_run_id text,
  target_turn_id text,
  queued_run_id text,
  queue_sequence bigint,
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id,receipt_id,event_sequence),
  FOREIGN KEY (tenant_id,thread_id,receipt_id)
    REFERENCES thread_input_receipts(tenant_id,thread_id,receipt_id) ON DELETE RESTRICT,
  CONSTRAINT thread_input_receipt_event_shape_check CHECK (
    (disposition IN ('pending_steer','steered')
      AND target_run_id IS NOT NULL AND target_turn_id IS NOT NULL
      AND queued_run_id IS NULL AND queue_sequence IS NULL AND rejection_code IS NULL)
    OR (disposition='queued' AND queued_run_id IS NOT NULL AND queue_sequence IS NOT NULL
      AND rejection_code IS NULL)
    OR (disposition='cancelled' AND rejection_code IS NULL)
    OR (disposition='rejected' AND rejection_code IS NOT NULL)
  )
);

ALTER TABLE thread_input_receipt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_input_receipt_events FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_input_receipt_events_tenant_policy ON thread_input_receipt_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：thread_context_compaction
-- ---------------------------------------------------------------------------

-- 持久 compaction checkpoint + normalized replacement history。
ALTER TABLE thread_context_entries
  DROP CONSTRAINT thread_context_entries_kind_check,
  ADD CONSTRAINT thread_context_entries_kind_check CHECK (kind IN (
    'run_started','user_message','assistant_message','tool_call','tool_result',
    'workspace_committed','workspace_unchanged','run_terminal','compaction_checkpoint'
  ));

ALTER TABLE thread_context_streams
  ADD COLUMN current_window_number bigint NOT NULL DEFAULT 0 CHECK (
    current_window_number BETWEEN 0 AND 9007199254740991
  ),
  ADD COLUMN current_checkpoint_id text,
  ADD COLUMN current_compatibility_digest text CHECK (
    current_compatibility_digest IS NULL OR current_compatibility_digest ~ '^[0-9a-f]{64}$'
  );

CREATE TABLE thread_context_compaction_checkpoints (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  checkpoint_id text NOT NULL CHECK (checkpoint_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  operation_id text NOT NULL CHECK (octet_length(operation_id) BETWEEN 1 AND 512),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  window_number bigint NOT NULL CHECK (window_number BETWEEN 1 AND 9007199254740991),
  previous_checkpoint_id text,
  source_from_sequence bigint NOT NULL CHECK (source_from_sequence BETWEEN 1 AND 9007199254740991),
  source_prefix_through_sequence bigint NOT NULL CHECK (
    source_prefix_through_sequence BETWEEN source_from_sequence AND 9007199254740991
  ),
  through_sequence bigint NOT NULL CHECK (
    through_sequence BETWEEN source_prefix_through_sequence AND 9007199254740991
  ),
  checkpoint_fact_sequence bigint NOT NULL CHECK (
    checkpoint_fact_sequence BETWEEN 1 AND 9007199254740991
    AND checkpoint_fact_sequence > through_sequence
  ),
  compatibility_digest text NOT NULL CHECK (compatibility_digest ~ '^[0-9a-f]{64}$'),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  source_history_digest text NOT NULL CHECK (source_history_digest ~ '^[0-9a-f]{64}$'),
  replacement_history_digest text NOT NULL CHECK (replacement_history_digest ~ '^[0-9a-f]{64}$'),
  tokenizer_identity text NOT NULL CHECK (octet_length(tokenizer_identity) BETWEEN 1 AND 200),
  tokens_before bigint NOT NULL CHECK (tokens_before BETWEEN 1 AND 9007199254740991),
  tokens_after bigint NOT NULL CHECK (tokens_after BETWEEN 1 AND 9007199254740991),
  compaction_path text NOT NULL CHECK (compaction_path IN ('local','remote')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id,checkpoint_id),
  UNIQUE (tenant_id,thread_id,operation_id),
  UNIQUE (tenant_id,thread_id,window_number),
  UNIQUE (tenant_id,thread_id,checkpoint_fact_sequence),
  FOREIGN KEY (tenant_id,thread_id)
    REFERENCES thread_context_streams(tenant_id,thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,checkpoint_fact_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,previous_checkpoint_id)
    REFERENCES thread_context_compaction_checkpoints(tenant_id,thread_id,checkpoint_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT thread_context_compaction_chain_shape_check CHECK (
    (window_number=1 AND previous_checkpoint_id IS NULL)
    OR (window_number>1 AND previous_checkpoint_id IS NOT NULL)
  )
);

CREATE TABLE thread_context_compaction_replacement_items (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  checkpoint_id text NOT NULL,
  item_ordinal integer NOT NULL CHECK (item_ordinal BETWEEN 0 AND 9999),
  history_sequence bigint NOT NULL CHECK (history_sequence BETWEEN 1 AND 9007199254740991),
  item_kind text NOT NULL CHECK (
    item_kind IN ('user','assistant','tool_result','runtime_notice','compaction_handoff')
  ),
  message jsonb NOT NULL CHECK (
    jsonb_typeof(message)='object' AND octet_length(message::text) <= 8388608
  ),
  message_digest text NOT NULL CHECK (message_digest ~ '^[0-9a-f]{64}$'),
  tool_call_ids text[] NOT NULL DEFAULT '{}',
  tool_call_id text,
  tool_name text,
  predecessor_ordinal integer,
  predecessor_kind text GENERATED ALWAYS AS (
    CASE WHEN item_kind='tool_result' THEN 'assistant' ELSE NULL END
  ) STORED,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  PRIMARY KEY (tenant_id,thread_id,checkpoint_id,item_ordinal),
  UNIQUE (tenant_id,thread_id,checkpoint_id,item_ordinal,item_kind),
  FOREIGN KEY (tenant_id,thread_id,checkpoint_id)
    REFERENCES thread_context_compaction_checkpoints(tenant_id,thread_id,checkpoint_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,checkpoint_id,predecessor_ordinal,predecessor_kind)
    REFERENCES thread_context_compaction_replacement_items(
      tenant_id,thread_id,checkpoint_id,item_ordinal,item_kind
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT thread_context_compaction_item_tool_shape_check CHECK (
    (item_kind='assistant' AND tool_call_id IS NULL AND tool_name IS NULL
      AND predecessor_ordinal IS NULL)
    OR (item_kind='tool_result' AND cardinality(tool_call_ids)=0
      AND tool_call_id IS NOT NULL AND tool_name IS NOT NULL
      AND predecessor_ordinal IS NOT NULL)
    OR (item_kind NOT IN ('assistant','tool_result') AND cardinality(tool_call_ids)=0
      AND tool_call_id IS NULL AND tool_name IS NULL AND predecessor_ordinal IS NULL)
  )
);

ALTER TABLE thread_context_streams
  ADD CONSTRAINT thread_context_stream_current_checkpoint_fk FOREIGN KEY (
    tenant_id,thread_id,current_checkpoint_id
  ) REFERENCES thread_context_compaction_checkpoints(tenant_id,thread_id,checkpoint_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT thread_context_stream_checkpoint_shape_check CHECK (
    (current_window_number=0 AND current_checkpoint_id IS NULL
      AND current_compatibility_digest IS NULL)
    OR (current_window_number>0 AND current_checkpoint_id IS NOT NULL
      AND current_compatibility_digest IS NOT NULL)
  );

CREATE INDEX thread_context_compaction_compatible_idx
  ON thread_context_compaction_checkpoints(
    tenant_id,thread_id,compatibility_digest,through_sequence DESC,window_number DESC
  );

ALTER TABLE thread_context_compaction_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_compaction_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_compaction_checkpoints_tenant_policy
  ON thread_context_compaction_checkpoints
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_context_compaction_replacement_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_compaction_replacement_items FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_compaction_replacement_items_tenant_policy
  ON thread_context_compaction_replacement_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：thread_sandbox_sessions
-- ---------------------------------------------------------------------------

-- Thread/Workspace Sandbox 只是可验证缓存；Workspace Revision 与 Thread Context
-- 仍是事实源。Session、唯一 lease 与外部 lifecycle effect 分表保存，UNKNOWN 永不自动重试。
CREATE TABLE thread_sandbox_sessions (
  tenant_id text NOT NULL,
  session_id text NOT NULL CHECK (octet_length(session_id) BETWEEN 8 AND 200),
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  registry_id text NOT NULL CHECK (octet_length(registry_id) BETWEEN 8 AND 200),
  provider_sandbox_id text NOT NULL CHECK (octet_length(provider_sandbox_id) BETWEEN 1 AND 200),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  state text NOT NULL CHECK (
    state IN ('running', 'pausing', 'paused', 'resuming', 'terminated', 'unknown')
  ),
  materialized_revision_id text,
  materialization_attested boolean NOT NULL DEFAULT false,
  paused_at timestamptz,
  retention_expires_at timestamptz,
  current_effect_id text,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  terminated_at timestamptz,
  PRIMARY KEY (tenant_id, session_id),
  UNIQUE (tenant_id, registry_id),
  -- Provider 账号下的 ID 是全局 capability；一旦登记就不能跨 Tenant/generation 重放。
  UNIQUE (provider_sandbox_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, thread_id)
    REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, materialized_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT thread_sandbox_session_state_shape_check CHECK (
    (state = 'running' AND current_effect_id IS NULL
      AND paused_at IS NULL AND retention_expires_at IS NULL AND terminated_at IS NULL)
    OR (state IN ('pausing', 'resuming') AND current_effect_id IS NOT NULL
      AND terminated_at IS NULL)
    OR (state = 'paused' AND paused_at IS NOT NULL AND retention_expires_at IS NOT NULL
      AND current_effect_id IS NULL AND terminated_at IS NULL
      AND retention_expires_at > paused_at)
    OR (state = 'terminated' AND current_effect_id IS NULL AND terminated_at IS NOT NULL)
    OR (state = 'unknown' AND current_effect_id IS NOT NULL AND terminated_at IS NULL)
  )
);

-- unknown 已被隔离，允许 cold rebuild 新 generation；可复用状态同一 Thread/Workspace 仍只有一个。
CREATE UNIQUE INDEX thread_sandbox_sessions_one_reusable_idx
  ON thread_sandbox_sessions(tenant_id, thread_id, workspace_id)
  WHERE state IN ('running', 'pausing', 'paused', 'resuming');
CREATE INDEX thread_sandbox_sessions_retention_idx
  ON thread_sandbox_sessions(tenant_id, retention_expires_at)
  WHERE state = 'paused';

CREATE TABLE thread_sandbox_leases (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  lease_id text NOT NULL CHECK (octet_length(lease_id) BETWEEN 8 AND 200),
  lease_token text NOT NULL CHECK (octet_length(lease_token) BETWEEN 16 AND 200),
  lease_epoch bigint NOT NULL CHECK (lease_epoch BETWEEN 1 AND 9007199254740991),
  run_id text NOT NULL,
  attempt_id text,
  owner text NOT NULL CHECK (octet_length(owner) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, session_id, lease_id),
  UNIQUE (tenant_id, lease_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES thread_sandbox_sessions(tenant_id, session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES execution_attempts(tenant_id, attempt_id) ON DELETE RESTRICT,
  CONSTRAINT thread_sandbox_lease_time_check CHECK (expires_at > created_at),
  CONSTRAINT thread_sandbox_lease_release_check CHECK (
    released_at IS NULL OR released_at >= created_at
  )
);
CREATE UNIQUE INDEX thread_sandbox_leases_one_unreleased_idx
  ON thread_sandbox_leases(tenant_id, session_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX thread_sandbox_leases_one_run_idx
  ON thread_sandbox_leases(tenant_id, run_id) WHERE released_at IS NULL;

CREATE TABLE sandbox_lifecycle_effects (
  tenant_id text NOT NULL,
  effect_id text NOT NULL CHECK (octet_length(effect_id) BETWEEN 8 AND 200),
  operation_id text NOT NULL CHECK (octet_length(operation_id) BETWEEN 8 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  session_id text NOT NULL CHECK (octet_length(session_id) BETWEEN 8 AND 200),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  effect_kind text NOT NULL CHECK (effect_kind IN ('create', 'pause', 'resume', 'terminate')),
  state text NOT NULL CHECK (
    state IN ('pending', 'started', 'succeeded', 'failed_not_applied', 'unknown')
  ),
  run_id text,
  attempt_id text,
  provider_sandbox_id text,
  expected_session_state text CHECK (
    expected_session_state IN ('running', 'pausing', 'paused', 'resuming', 'terminated', 'unknown')
  ),
  resulting_session_state text CHECK (
    resulting_session_state IN ('running', 'paused', 'terminated')
  ),
  provider_receipt_digest text CHECK (provider_receipt_digest ~ '^[0-9a-f]{64}$'),
  claim_token text,
  claimed_by text,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (
    claim_generation BETWEEN 0 AND 9007199254740991
  ),
  claim_expires_at timestamptz,
  remote_call_started_at timestamptz,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, effect_id),
  UNIQUE (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES execution_attempts(tenant_id, attempt_id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_lifecycle_effect_claim_shape_check CHECK (
    (claim_token IS NULL AND claimed_by IS NULL AND claim_expires_at IS NULL)
    OR (state IN ('started', 'unknown') AND octet_length(claim_token) BETWEEN 16 AND 200
      AND octet_length(claimed_by) BETWEEN 1 AND 200 AND claim_expires_at IS NOT NULL)
  ),
  CONSTRAINT sandbox_lifecycle_effect_state_shape_check CHECK (
    (state = 'pending' AND remote_call_started_at IS NULL AND completed_at IS NULL)
    OR (state = 'started' AND completed_at IS NULL)
    OR (state IN ('succeeded', 'failed_not_applied', 'unknown') AND completed_at IS NOT NULL)
  )
);
CREATE INDEX sandbox_lifecycle_effects_pending_idx
  ON sandbox_lifecycle_effects(tenant_id, created_at)
  WHERE state IN ('pending', 'started', 'unknown');

ALTER TABLE thread_sandbox_sessions
  ADD CONSTRAINT thread_sandbox_sessions_current_effect_fk
  FOREIGN KEY (tenant_id, current_effect_id)
  REFERENCES sandbox_lifecycle_effects(tenant_id, effect_id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE thread_sandbox_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_sandbox_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_sandbox_sessions_tenant_policy ON thread_sandbox_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE thread_sandbox_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_sandbox_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_sandbox_leases_tenant_policy ON thread_sandbox_leases
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE sandbox_lifecycle_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_lifecycle_effects FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_lifecycle_effects_tenant_policy ON sandbox_lifecycle_effects
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：thread_continuity_rollout
-- ---------------------------------------------------------------------------

-- 旧 Thread 证据式 anchor、新 Thread 灰度档案与低基数指标。
ALTER TABLE thread_context_entries
  DROP CONSTRAINT thread_context_entries_kind_check,
  ADD CONSTRAINT thread_context_entries_kind_check CHECK (kind IN (
    'run_started','user_message','assistant_message','tool_call','tool_result',
    'workspace_committed','workspace_unchanged','run_terminal','compaction_checkpoint',
    'legacy_history_gap','legacy_v2_anchor'
  ));

CREATE TABLE tenant_thread_continuity_policies (
  tenant_id text NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version BETWEEN 1 AND 9007199254740991),
  v2_read_enabled boolean NOT NULL DEFAULT false,
  new_thread_rollout_basis_points integer NOT NULL DEFAULT 0 CHECK (
    new_thread_rollout_basis_points BETWEEN 0 AND 10000
  ),
  legacy_anchor_read_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE TABLE thread_context_legacy_anchors (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  anchor_id text NOT NULL CHECK (octet_length(anchor_id) BETWEEN 8 AND 200),
  operation_id text NOT NULL CHECK (octet_length(operation_id) BETWEEN 8 AND 512),
  max_runs integer NOT NULL CHECK (max_runs BETWEEN 1 AND 10000),
  total_terminal_runs integer NOT NULL CHECK (total_terminal_runs >= 0),
  selected_runs integer NOT NULL CHECK (selected_runs BETWEEN 0 AND max_runs),
  backfilled_entries integer NOT NULL CHECK (backfilled_entries >= 0),
  gap_items integer NOT NULL CHECK (gap_items >= 0),
  first_context_sequence bigint NOT NULL CHECK (
    first_context_sequence BETWEEN 1 AND 9007199254740991
  ),
  anchor_context_sequence bigint NOT NULL CHECK (
    anchor_context_sequence BETWEEN first_context_sequence AND 9007199254740991
  ),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  gap_reasons jsonb NOT NULL CHECK (
    jsonb_typeof(gap_reasons)='array' AND octet_length(gap_reasons::text) <= 16384
  ),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id),
  UNIQUE (tenant_id,anchor_id),
  UNIQUE (tenant_id,operation_id),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,first_context_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,anchor_context_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT
);

CREATE TABLE thread_context_legacy_backfill_items (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  anchor_id text NOT NULL,
  item_ordinal integer NOT NULL CHECK (item_ordinal BETWEEN 0 AND 50000),
  source_run_id text,
  evidence_kind text NOT NULL CHECK (evidence_kind IN (
    'user_input','workspace_result','run_terminal','assistant_tool_history',
    'earlier_run_range','existing_v2_stream'
  )),
  outcome text NOT NULL CHECK (outcome IN ('backfilled','already_present','gap')),
  context_sequence bigint,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  reason_code text CHECK (
    reason_code IS NULL OR reason_code IN (
      'source_missing','not_provable','max_depth_exceeded','cannot_prepend_existing_stream'
    )
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,anchor_id,item_ordinal),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,anchor_id)
    REFERENCES thread_context_legacy_anchors(tenant_id,anchor_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_run_id,thread_id)
    REFERENCES runs(tenant_id,id,thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,context_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT,
  CONSTRAINT thread_context_legacy_backfill_item_shape_check CHECK (
    (outcome='gap' AND context_sequence IS NULL AND reason_code IS NOT NULL)
    OR (outcome IN ('backfilled','already_present') AND context_sequence IS NOT NULL
      AND reason_code IS NULL)
  )
);

CREATE TABLE thread_continuity_profiles (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  rollout_source text NOT NULL CHECK (rollout_source IN ('new_thread','legacy_anchor','manual')),
  cohort_bucket integer NOT NULL CHECK (cohort_bucket BETWEEN 0 AND 9999),
  rollout_selected boolean NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version BETWEEN 0 AND 9007199254740991),
  anchor_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,anchor_id)
    REFERENCES thread_context_legacy_anchors(tenant_id,anchor_id) ON DELETE RESTRICT,
  CONSTRAINT thread_continuity_profile_anchor_shape_check CHECK (
    (rollout_source='legacy_anchor' AND anchor_id IS NOT NULL AND rollout_selected)
    OR (rollout_source<>'legacy_anchor' AND anchor_id IS NULL)
  )
);

CREATE TABLE thread_continuity_metric_observations (
  tenant_id text NOT NULL,
  observation_id text NOT NULL CHECK (octet_length(observation_id) BETWEEN 8 AND 512),
  thread_id text NOT NULL,
  run_id text,
  metric_name text NOT NULL CHECK (metric_name IN (
    'thread_input_total','steer_apply_latency_ms','steer_to_follow_up_total',
    'follow_up_queue_depth','follow_up_wait_ms','thread_writer_conflict_total',
    'context_rebuild_latency_ms','context_visible_tokens','context_tokens_before_compaction',
    'context_tokens_after_compaction','compaction_latency_ms','compaction_total',
    'context_recovery_digest_mismatch_total','context_window_number',
    'sandbox_handoff_total','sandbox_resume_total','sandbox_resume_latency_ms',
    'sandbox_create_latency_ms','workspace_materialize_latency_ms','sandbox_paused_seconds',
    'sandbox_snapshot_bytes','sandbox_cold_rebuild_total','sandbox_unknown_total',
    'sandbox_revision_mismatch_total','sandbox_idle_running_seconds'
  )),
  value double precision NOT NULL CHECK (value BETWEEN 0 AND 1e308),
  unit text NOT NULL CHECK (unit IN ('count','milliseconds','seconds','tokens','items','bytes')),
  path text CHECK (path IS NULL OR path IN ('local','remote','resume','cold','handoff')),
  outcome text CHECK (outcome IS NULL OR octet_length(outcome) BETWEEN 1 AND 64),
  reason text CHECK (reason IS NULL OR octet_length(reason) BETWEEN 1 AND 64),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,observation_id),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,thread_id) REFERENCES runs(tenant_id,id,thread_id) ON DELETE RESTRICT
);
CREATE INDEX thread_continuity_metrics_query_idx
  ON thread_continuity_metric_observations(tenant_id,metric_name,observed_at DESC);

ALTER TABLE tenant_thread_continuity_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_thread_continuity_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_thread_continuity_policies_tenant_policy
  ON tenant_thread_continuity_policies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_context_legacy_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_legacy_anchors FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_legacy_anchors_tenant_policy ON thread_context_legacy_anchors
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_context_legacy_backfill_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_legacy_backfill_items FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_legacy_backfill_items_tenant_policy
  ON thread_context_legacy_backfill_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_continuity_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_continuity_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_continuity_profiles_tenant_policy ON thread_continuity_profiles
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_continuity_metric_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_continuity_metric_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_continuity_metric_observations_tenant_policy
  ON thread_continuity_metric_observations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：thread_continuity_default_on
-- ---------------------------------------------------------------------------

-- 连续上下文已经成为产品默认路径；显式 Tenant policy 和环境开关仍保留紧急回退能力。
ALTER TABLE tenant_thread_continuity_policies
  ALTER COLUMN v2_read_enabled SET DEFAULT true,
  ALTER COLUMN new_thread_rollout_basis_points SET DEFAULT 10000,
  ALTER COLUMN legacy_anchor_read_enabled SET DEFAULT true;

-- Migrator 不持有 BYPASSRLS；数据修复在同一 DDL 事务和排他表锁内短暂关闭策略，提交前恢复。
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_thread_continuity_policies DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_continuity_profiles DISABLE ROW LEVEL SECURITY;

INSERT INTO tenant_thread_continuity_policies(
  tenant_id,policy_version,v2_read_enabled,new_thread_rollout_basis_points,
  legacy_anchor_read_enabled
)
SELECT id,1,true,10000,true FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- 0026 上线后、Tenant policy 尚未建立时产生的 profile 使用 policy_version=0；它们属于默认档案，
-- 不是显式灰度关闭，因此随产品默认值切换到全量。
UPDATE thread_continuity_profiles
   SET rollout_selected=true
 WHERE rollout_source='new_thread' AND policy_version=0 AND rollout_selected=false;

ALTER TABLE thread_continuity_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_continuity_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_thread_continuity_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_thread_continuity_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 区段：direct_vision_attachments
-- ---------------------------------------------------------------------------

-- 当前 user turn 的附件只持久化不可变 Resource/Version 身份；图片字节仍留在 BlobStore。
-- JSON 使用 resourceId -> versionId -> ordinal 的规范映射：对象键天然排除重复身份，ordinal 保留用户顺序。
-- 只使用 PostgreSQL 内建 immutable JSONPath，避免在首版空 routine manifest 中引入可执行数据库代码。
ALTER TABLE thread_input_receipts
  ADD COLUMN input_attachments jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT thread_input_receipts_attachments_check
    CHECK (
      jsonb_typeof(input_attachments) = 'object'
      AND jsonb_array_length(jsonb_path_query_array(input_attachments, '$.*.*')) <= 20
      AND NOT jsonb_path_exists(
        input_attachments,
        '$.* ? (@.type() != "object")'
      )
      AND NOT jsonb_path_exists(
        input_attachments,
        '$.keyvalue() ? (!(@.key like_regex "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"))'
      )
      AND NOT jsonb_path_exists(
        input_attachments,
        '$.*.keyvalue() ? (!(@.key like_regex "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"))'
      )
      AND NOT jsonb_path_exists(
        input_attachments,
        '$.keyvalue() ? (!exists(@.value.*))'
      )
      AND NOT jsonb_path_exists(
        input_attachments,
        '$.*.* ? (!(@.type() == "number" && @ >= 0 && @ < 20 && @.floor() == @))'
      )
    );

-- ---------------------------------------------------------------------------
-- 区段：skill_center_installations
-- ---------------------------------------------------------------------------

CREATE TABLE skills (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'),
  canonical_key text NOT NULL UNIQUE CHECK (canonical_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  publisher text NOT NULL CHECK (length(btrim(publisher)) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  recommended_version text,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT skills_recommended_shape_check CHECK (
    (status = 'active' AND recommended_version IS NOT NULL)
    OR status = 'revoked'
  )
);

CREATE TABLE skill_versions (
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  version text NOT NULL CHECK (version ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$'),
  description text NOT NULL CHECK (
    octet_length(description) BETWEEN 1 AND 2048
    AND description !~ '[[:cntrl:]]'
  ),
  compatibility text NOT NULL CHECK (
    octet_length(compatibility) BETWEEN 1 AND 500
    AND compatibility !~ '[[:cntrl:]]'
  ),
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  entrypoint_path text NOT NULL CHECK (entrypoint_path = 'SKILL.md'),
  entrypoint_digest text NOT NULL CHECK (entrypoint_digest ~ '^[0-9a-f]{64}$'),
  package_blob_ref text NOT NULL CHECK (length(btrim(package_blob_ref)) BETWEEN 1 AND 512),
  security_status text NOT NULL CHECK (security_status IN ('verified', 'restricted')),
  status text NOT NULL CHECK (status IN ('available', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (skill_id, version)
);

ALTER TABLE skills
  ADD CONSTRAINT skills_recommended_version_fk
  FOREIGN KEY (id, recommended_version)
  REFERENCES skill_versions(skill_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE skill_version_files (
  skill_id text NOT NULL,
  skill_version text NOT NULL,
  normalized_path text NOT NULL CHECK (
    length(normalized_path) BETWEEN 1 AND 1024
    AND normalized_path !~ '(^/|(^|/)\.\.(/|$)|\\\\)'
  ),
  media_type text NOT NULL CHECK (length(btrim(media_type)) BETWEEN 3 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 33554432),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  blob_ref text NOT NULL CHECK (length(btrim(blob_ref)) BETWEEN 1 AND 512),
  PRIMARY KEY (skill_id, skill_version, normalized_path),
  FOREIGN KEY (skill_id, skill_version)
    REFERENCES skill_versions(skill_id, version) ON DELETE RESTRICT
);

CREATE TABLE user_skill_installations (
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  skill_version text NOT NULL,
  invocation_name text NOT NULL CHECK (
    octet_length(invocation_name) BETWEEN 1 AND 128
    AND invocation_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND lower(invocation_name) NOT IN ('clear', 'help', 'new', 'settings', 'skills')
  ),
  status text NOT NULL CHECK (status IN ('enabled', 'disabled', 'uninstalled')),
  version_token bigint NOT NULL DEFAULT 0 CHECK (version_token >= 0),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, skill_id),
  FOREIGN KEY (skill_id, skill_version)
    REFERENCES skill_versions(skill_id, version) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX user_skill_installations_invocation_active_unique
  ON user_skill_installations (user_id, invocation_name)
  WHERE status IN ('enabled', 'disabled');

CREATE INDEX user_skill_installations_user_status_idx
  ON user_skill_installations (user_id, status, invocation_name);

CREATE TABLE user_skill_installation_commands (
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  operation text NOT NULL CHECK (operation IN ('install', 'configure', 'uninstall')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE TABLE user_skill_installation_audits (
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 160),
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('install', 'configure', 'uninstall')),
  before_status text CHECK (before_status IN ('enabled', 'disabled', 'uninstalled')),
  after_status text NOT NULL CHECK (after_status IN ('enabled', 'disabled', 'uninstalled')),
  skill_version text NOT NULL,
  invocation_name text NOT NULL,
  version_token bigint NOT NULL CHECK (version_token >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, event_id),
  FOREIGN KEY (skill_id, skill_version)
    REFERENCES skill_versions(skill_id, version) ON DELETE RESTRICT
);

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills FORCE ROW LEVEL SECURITY;
CREATE POLICY skills_authenticated_read_policy ON skills
  FOR SELECT USING (NULLIF(current_setting('app.user_id', true), '') IS NOT NULL);
DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY skills_publisher_write_policy ON skills FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    current_user,
    current_user
  );
END
$$;

ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_versions_authenticated_read_policy ON skill_versions
  FOR SELECT USING (NULLIF(current_setting('app.user_id', true), '') IS NOT NULL);
DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY skill_versions_publisher_write_policy ON skill_versions FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    current_user,
    current_user
  );
END
$$;

ALTER TABLE skill_version_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_version_files FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_version_files_authenticated_read_policy ON skill_version_files
  FOR SELECT USING (NULLIF(current_setting('app.user_id', true), '') IS NOT NULL);
DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY skill_version_files_publisher_write_policy ON skill_version_files FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    current_user,
    current_user
  );
END
$$;

ALTER TABLE user_skill_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_skill_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY user_skill_installations_owner_policy ON user_skill_installations
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));

ALTER TABLE user_skill_installation_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_skill_installation_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY user_skill_installation_commands_owner_policy ON user_skill_installation_commands
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));

ALTER TABLE user_skill_installation_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_skill_installation_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY user_skill_installation_audits_owner_policy ON user_skill_installation_audits
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：skill_runtime
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 区段：thread_sandbox_resource_capability
-- ---------------------------------------------------------------------------

-- 旧版本的 Thread Sandbox 创建时始终挂载 ResourceFS，因此已有行安全回填为 true；
-- 新创建 Session 必须由 lifecycle 显式记录实际能力。
ALTER TABLE thread_sandbox_sessions
  ADD COLUMN resource_filesystem_mounted boolean NOT NULL DEFAULT true;

ALTER TABLE thread_sandbox_sessions
  ALTER COLUMN resource_filesystem_mounted SET DEFAULT false;

-- ---------------------------------------------------------------------------
-- 区段：skill_admin_publishing
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  publisher_role text := NULLIF(current_setting('app.skill_publisher_role', true), '');
BEGIN
  IF publisher_role IS NULL OR publisher_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'Skill Publisher 数据库角色配置无效';
  END IF;
END
$$;

CREATE TABLE platform_skill_operators (
  user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('publisher','reviewer','admin')),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  version_token bigint NOT NULL DEFAULT 0 CHECK (version_token >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE skill_publication_submissions (
  submission_id text PRIMARY KEY CHECK (submission_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'),
  canonical_key text NOT NULL CHECK (canonical_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  display_name text NOT NULL CHECK (
    octet_length(display_name) BETWEEN 1 AND 200 AND display_name=btrim(display_name)
  ),
  publisher text NOT NULL CHECK (
    octet_length(publisher) BETWEEN 1 AND 200 AND publisher=btrim(publisher)
  ),
  skill_version text NOT NULL CHECK (skill_version ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$'),
  description text NOT NULL CHECK (
    octet_length(description) BETWEEN 1 AND 2048 AND description !~ '[[:cntrl:]]'
  ),
  compatibility text NOT NULL CHECK (
    octet_length(compatibility) BETWEEN 1 AND 500 AND compatibility !~ '[[:cntrl:]]'
  ),
  source_url text NOT NULL CHECK (octet_length(source_url) BETWEEN 1 AND 2048),
  source_revision text NOT NULL CHECK (
    octet_length(source_revision) BETWEEN 1 AND 200
    AND source_revision=btrim(source_revision)
    AND source_revision !~ '[[:cntrl:]]'
  ),
  license_spdx text NOT NULL CHECK (license_spdx ~ '^[A-Za-z0-9][A-Za-z0-9.+-]{0,99}$'),
  status text NOT NULL CHECK (
    status IN ('draft','submitted','approved','rejected','published','revoked')
  ),
  security_status text NOT NULL CHECK (security_status='restricted'),
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  entrypoint_digest text NOT NULL CHECK (entrypoint_digest ~ '^[0-9a-f]{64}$'),
  package_blob_ref text NOT NULL CHECK (octet_length(package_blob_ref) BETWEEN 1 AND 512),
  file_count integer NOT NULL CHECK (file_count BETWEEN 1 AND 256),
  total_bytes bigint NOT NULL CHECK (total_bytes BETWEEN 1 AND 33554432),
  version_token bigint NOT NULL DEFAULT 0 CHECK (version_token >= 0),
  created_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  reviewed_by text REFERENCES app_users(id) ON DELETE RESTRICT,
  rejection_reason text CHECK (
    rejection_reason IS NULL OR (
      octet_length(rejection_reason) BETWEEN 1 AND 2048
      AND rejection_reason=btrim(rejection_reason)
      AND rejection_reason !~ '[[:cntrl:]]'
    )
  ),
  published_skill_id text REFERENCES skills(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (canonical_key, skill_version),
  CONSTRAINT skill_publication_review_shape_check CHECK (
    (status IN ('draft','submitted') AND reviewed_by IS NULL AND rejection_reason IS NULL)
    OR (status='rejected' AND reviewed_by IS NOT NULL AND rejection_reason IS NOT NULL)
    OR (status IN ('approved','published','revoked') AND reviewed_by IS NOT NULL AND rejection_reason IS NULL)
  ),
  CONSTRAINT skill_publication_publish_shape_check CHECK (
    (status IN ('published','revoked') AND published_skill_id IS NOT NULL)
    OR (status NOT IN ('published','revoked') AND published_skill_id IS NULL)
  )
);

CREATE INDEX skill_publication_submissions_order_idx
  ON skill_publication_submissions(submission_id);

CREATE TABLE skill_publication_files (
  submission_id text NOT NULL REFERENCES skill_publication_submissions(submission_id) ON DELETE RESTRICT,
  normalized_path text NOT NULL CHECK (
    octet_length(normalized_path) BETWEEN 1 AND 1024
    AND normalized_path !~ '(^/|(^|/)\.\.(/|$)|\\\\)'
  ),
  media_type text NOT NULL CHECK (octet_length(media_type) BETWEEN 3 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 33554432),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  blob_ref text NOT NULL CHECK (octet_length(blob_ref) BETWEEN 1 AND 512),
  PRIMARY KEY (submission_id, normalized_path)
);

CREATE TABLE skill_publication_commands (
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  operation text NOT NULL CHECK (
    operation IN ('create','submit','approve','reject','publish','revoke')
  ),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  submission_id text NOT NULL REFERENCES skill_publication_submissions(submission_id) ON DELETE RESTRICT,
  result_version_token bigint NOT NULL CHECK (result_version_token >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id, idempotency_key)
);

CREATE TABLE skill_publication_audits (
  event_id text PRIMARY KEY CHECK (octet_length(event_id) BETWEEN 1 AND 320),
  submission_id text NOT NULL REFERENCES skill_publication_submissions(submission_id) ON DELETE RESTRICT,
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (
    operation IN ('create','submit','approve','reject','publish','revoke')
  ),
  before_status text CHECK (
    before_status IN ('draft','submitted','approved','rejected','published','revoked')
  ),
  after_status text NOT NULL CHECK (
    after_status IN ('draft','submitted','approved','rejected','published','revoked')
  ),
  reason text CHECK (
    reason IS NULL OR (
      octet_length(reason) BETWEEN 1 AND 2048
      AND reason=btrim(reason)
      AND reason !~ '[[:cntrl:]]'
    )
  ),
  version_token bigint NOT NULL CHECK (version_token >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE platform_skill_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_skill_operators FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_publication_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_publication_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_publication_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_publication_files FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_publication_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_publication_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_publication_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_publication_audits FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  migrator_role text := current_user;
  publisher_role text := current_setting('app.skill_publisher_role');
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'platform_skill_operators',
    'skill_publication_submissions',
    'skill_publication_files',
    'skill_publication_commands',
    'skill_publication_audits'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)',
      table_name || '_migrator_policy', table_name, migrator_role
    );
  END LOOP;

  EXECUTE format(
    'CREATE POLICY platform_skill_operators_publisher_read_policy ON platform_skill_operators FOR SELECT TO %I USING (user_id=NULLIF(current_setting(''app.user_id'', true), ''''))',
    publisher_role
  );
  FOREACH table_name IN ARRAY ARRAY[
    'skill_publication_submissions',
    'skill_publication_files',
    'skill_publication_commands',
    'skill_publication_audits'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting(''app.user_id'', true), '''') AND operator.status=''active'')) WITH CHECK (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting(''app.user_id'', true), '''') AND operator.status=''active''))',
      table_name || '_publisher_policy', table_name, publisher_role
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['skills','skill_versions','skill_version_files'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting(''app.user_id'', true), '''') AND operator.status=''active'' AND operator.role=''admin'')) WITH CHECK (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting(''app.user_id'', true), '''') AND operator.status=''active'' AND operator.role=''admin''))',
      table_name || '_admin_publisher_policy', table_name, publisher_role
    );
  END LOOP;

  -- 专用角色的 ACL 从空集合重建，避免历史直授把 Tenant/Run 等运行表带入发布进程。
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', current_schema(), publisher_role);
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
    current_schema(), publisher_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
    current_schema(), publisher_role
  );
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', current_schema(), publisher_role);
  EXECUTE format('GRANT SELECT ON platform_skill_operators TO %I', publisher_role);
  EXECUTE format(
    'GRANT SELECT,INSERT ON skill_publication_submissions,skill_publication_files,skill_publication_commands,skill_publication_audits TO %I',
    publisher_role
  );
  EXECUTE format(
    'GRANT UPDATE(status,version_token,reviewed_by,rejection_reason,published_skill_id,updated_at) ON skill_publication_submissions TO %I',
    publisher_role
  );
  EXECUTE format('GRANT SELECT,INSERT ON skills,skill_versions,skill_version_files TO %I', publisher_role);
  EXECUTE format(
    'GRANT UPDATE(display_name,recommended_version,status,updated_at) ON skills TO %I',
    publisher_role
  );
  EXECUTE format('GRANT UPDATE(status) ON skill_versions TO %I', publisher_role);
END
$$;

-- ---------------------------------------------------------------------------
-- 区段：optional_skill_source_metadata
-- ---------------------------------------------------------------------------

ALTER TABLE skill_publication_submissions
  DROP CONSTRAINT skill_publication_submissions_source_url_check,
  ADD CONSTRAINT skill_publication_submissions_source_url_check
    CHECK (octet_length(source_url) BETWEEN 0 AND 2048),
  DROP CONSTRAINT skill_publication_submissions_source_revision_check,
  ADD CONSTRAINT skill_publication_submissions_source_revision_check CHECK (
    octet_length(source_revision) BETWEEN 0 AND 200
    AND source_revision=btrim(source_revision)
    AND source_revision !~ '[[:cntrl:]]'
  );

-- ---------------------------------------------------------------------------
-- 区段：shared_sandbox_subagents
-- ---------------------------------------------------------------------------

CREATE TABLE runtime_agent_threads (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  parent_agent_thread_id text,
  canonical_path text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('root', 'subagent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'failed')),
  task text NOT NULL DEFAULT '',
  enabled_tools jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(enabled_tools) = 'array'),
  fork_turns text NOT NULL DEFAULT 'none' CHECK (
    fork_turns = 'none' OR fork_turns = 'all' OR fork_turns ~ '^[1-9][0-9]{0,5}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id),
  UNIQUE (tenant_id, attempt_id, canonical_path),
  FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES execution_attempts(tenant_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, parent_agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_agent_thread_shape_check CHECK (
    octet_length(agent_thread_id) BETWEEN 1 AND 200
    AND octet_length(canonical_path) BETWEEN 1 AND 200
    AND octet_length(task) <= 32768
    AND ((kind = 'root' AND parent_agent_thread_id IS NULL) OR (kind = 'subagent' AND parent_agent_thread_id IS NOT NULL))
  )
);

INSERT INTO runtime_agent_threads(
  tenant_id, thread_id, run_id, attempt_id, agent_thread_id, canonical_path, kind, status
)
SELECT tenant_id, thread_id, run_id, attempt_id, agent_thread_id, '/root', 'root', 'open'
  FROM runtime_rollout_streams
ON CONFLICT DO NOTHING;

CREATE TABLE runtime_agent_turns (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  agent_turn_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 1000000),
  trigger text NOT NULL CHECK (trigger IN ('spawn', 'follow_up')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'interrupted', 'failed')),
  prompt_text text NOT NULL CHECK (octet_length(prompt_text) BETWEEN 1 AND 32768),
  final_answer text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id, agent_turn_id),
  UNIQUE (tenant_id, attempt_id, agent_thread_id, ordinal),
  FOREIGN KEY (tenant_id, attempt_id, agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_agent_turn_terminal_shape_check CHECK (
    (status IN ('queued', 'running') AND completed_at IS NULL)
    OR (status IN ('completed', 'interrupted', 'failed') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT runtime_agent_turn_result_shape_check CHECK (
    (final_answer IS NULL OR octet_length(final_answer) <= 65536)
    AND (error_code IS NULL OR octet_length(error_code) BETWEEN 1 AND 200)
  )
);
CREATE UNIQUE INDEX runtime_agent_turns_one_active_idx
  ON runtime_agent_turns(tenant_id, attempt_id, agent_thread_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE runtime_agent_mailbox_messages (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  recipient_agent_thread_id text NOT NULL,
  sender_agent_thread_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('message', 'final_answer', 'error')),
  payload text NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 65536),
  command_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, sequence),
  UNIQUE (tenant_id, attempt_id, command_id),
  FOREIGN KEY (tenant_id, attempt_id, recipient_agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, sender_agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT
);

CREATE TABLE runtime_agent_commands (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  caller_agent_thread_id text NOT NULL,
  command_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('spawn', 'send_message', 'follow_up', 'interrupt')),
  args_digest text NOT NULL CHECK (args_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, caller_agent_thread_id, command_id),
  FOREIGN KEY (tenant_id, attempt_id, caller_agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT
);

ALTER TABLE runtime_rollout_streams
  DROP CONSTRAINT runtime_rollout_streams_agent_kind_check,
  DROP CONSTRAINT runtime_rollout_streams_tenant_id_attempt_id_key,
  ADD CONSTRAINT runtime_rollout_streams_agent_kind_check CHECK (agent_kind IN ('root', 'subagent')),
  ADD CONSTRAINT runtime_rollout_streams_agent_thread_fk
    FOREIGN KEY (tenant_id, attempt_id, agent_thread_id)
    REFERENCES runtime_agent_threads(tenant_id, attempt_id, agent_thread_id) ON DELETE RESTRICT;

ALTER TABLE external_effect_permits
  DROP CONSTRAINT external_effect_permits_effect_check,
  ADD CONSTRAINT external_effect_permits_effect_check CHECK (
    effect IN ('model_start', 'model_continue', 'agent_model_start', 'tool_execution')
  );

ALTER TABLE runtime_agent_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_agent_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_agent_threads_tenant_policy ON runtime_agent_threads
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime_agent_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_agent_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_agent_turns_tenant_policy ON runtime_agent_turns
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime_agent_mailbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_agent_mailbox_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_agent_mailbox_messages_tenant_policy ON runtime_agent_mailbox_messages
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime_agent_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_agent_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_agent_commands_tenant_policy ON runtime_agent_commands
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- 区段：thread_scoped_subagent_conversations
-- ---------------------------------------------------------------------------

CREATE TABLE runtime_subagent_conversations (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  agent_thread_id text NOT NULL,
  canonical_path text NOT NULL,
  task text NOT NULL,
  enabled_tools jsonb NOT NULL CHECK (jsonb_typeof(enabled_tools) = 'array'),
  tool_manifest_digest text NOT NULL CHECK (tool_manifest_digest ~ '^[0-9a-f]{64}$'),
  fork_turns text NOT NULL CHECK (
    fork_turns = 'none' OR fork_turns = 'all' OR fork_turns ~ '^[1-9][0-9]{0,5}$'
  ),
  turn_ordinal integer NOT NULL CHECK (turn_ordinal BETWEEN 1 AND 1000000),
  history jsonb,
  history_digest text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id, agent_thread_id),
  UNIQUE (tenant_id, thread_id, canonical_path),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT runtime_subagent_conversation_shape_check CHECK (
    octet_length(agent_thread_id) BETWEEN 1 AND 200
    AND octet_length(canonical_path) BETWEEN 1 AND 200
    AND octet_length(task) BETWEEN 1 AND 32768
    AND (
      (history IS NULL AND history_digest IS NULL)
      OR (
        jsonb_typeof(history) = 'object'
        AND history_digest ~ '^[0-9a-f]{64}$'
        AND octet_length(history::text) <= 33554432
      )
    )
  )
);

ALTER TABLE runtime_subagent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_subagent_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_subagent_conversations_tenant_policy ON runtime_subagent_conversations
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- 区段：personal_history_filesystem
-- ---------------------------------------------------------------------------

ALTER TABLE threads
  ADD COLUMN title_source text NOT NULL DEFAULT 'deterministic'
    CHECK (title_source IN ('deterministic', 'model', 'user')),
  ADD COLUMN title_generated_at timestamptz,
  ADD COLUMN title_generation_version integer NOT NULL DEFAULT 0
    CHECK (title_generation_version >= 0);

CREATE TABLE thread_history_directories (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  directory_name text NOT NULL CHECK (
    octet_length(directory_name) BETWEEN 1 AND 255
    AND directory_name !~ '[[:cntrl:]\\/]'
    AND directory_name NOT IN ('.', '..')
  ),
  directory_timestamp timestamptz NOT NULL,
  directory_time_zone text NOT NULL CHECK (octet_length(directory_time_zone) BETWEEN 1 AND 128),
  naming_state text NOT NULL CHECK (naming_state IN ('ready', 'fallback')),
  first_file_at timestamptz NOT NULL,
  last_file_at timestamptz NOT NULL,
  file_count bigint NOT NULL CHECK (file_count >= 0 AND file_count <= 9007199254740991),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0 AND version <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id),
  UNIQUE (tenant_id, directory_name),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT thread_history_directories_time_check CHECK (first_file_at <= last_file_at)
);

CREATE INDEX thread_history_directories_recent_idx
  ON thread_history_directories(tenant_id, last_file_at DESC, thread_id)
  INCLUDE (directory_name, directory_timestamp, file_count, naming_state);

CREATE TABLE thread_history_file_entries (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  resource_id text NOT NULL,
  resource_version_id text NOT NULL,
  relation_type text NOT NULL DEFAULT 'user_attachment'
    CHECK (relation_type = 'user_attachment'),
  directory_entry_name text NOT NULL CHECK (
    octet_length(directory_entry_name) BETWEEN 1 AND 255
    AND directory_entry_name !~ '[[:cntrl:]\\/]'
    AND directory_entry_name NOT IN ('.', '..')
  ),
  first_receipt_id text NOT NULL,
  first_attached_at timestamptz NOT NULL,
  last_attached_at timestamptz NOT NULL,
  attachment_count bigint NOT NULL CHECK (
    attachment_count > 0 AND attachment_count <= 9007199254740991
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id, resource_id, resource_version_id, relation_type),
  UNIQUE (tenant_id, thread_id, directory_entry_name),
  FOREIGN KEY (tenant_id, thread_id)
    REFERENCES thread_history_directories(tenant_id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id, resource_version_id)
    REFERENCES resource_versions(tenant_id, resource_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id, first_receipt_id)
    REFERENCES thread_input_receipts(tenant_id, thread_id, receipt_id) ON DELETE RESTRICT,
  CONSTRAINT thread_history_file_entries_time_check CHECK (first_attached_at <= last_attached_at)
);

CREATE INDEX thread_history_file_entries_thread_idx
  ON thread_history_file_entries(tenant_id, thread_id, first_attached_at, directory_entry_name);

ALTER TABLE thread_history_directories ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_history_directories_tenant_policy ON thread_history_directories
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_history_file_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_history_file_entries_tenant_policy ON thread_history_file_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- 现有 durable receipt 只回填 personal Tenant 中真正进入队列或 steer 的附件。
WITH expanded AS (
  SELECT receipt.tenant_id, receipt.thread_id, receipt.receipt_id,
         receipt.created_at AS attached_at,
         resource_item.key AS resource_id, version_item.key AS resource_version_id,
         resource.name,
         thread.title, thread.title_source, thread.created_at AS thread_created_at
    FROM thread_input_receipts receipt
    JOIN tenants tenant ON tenant.id=receipt.tenant_id AND tenant.kind='personal'
    JOIN threads thread ON thread.tenant_id=receipt.tenant_id AND thread.id=receipt.thread_id
    CROSS JOIN LATERAL jsonb_each(receipt.input_attachments) resource_item
    CROSS JOIN LATERAL jsonb_each(resource_item.value) version_item
    JOIN resources resource
      ON resource.tenant_id=receipt.tenant_id AND resource.id=resource_item.key
     AND resource.visibility='searchable'
    JOIN resource_versions version
      ON version.tenant_id=receipt.tenant_id
     AND version.resource_id=resource_item.key AND version.id=version_item.key
   WHERE receipt.disposition IN ('queued', 'pending_steer', 'steered')
), directory_candidates AS (
  SELECT tenant_id, thread_id, min(thread_created_at) AS thread_created_at,
         min(title) AS title, min(title_source) AS title_source,
         min(attached_at) AS first_file_at, max(attached_at) AS last_file_at
    FROM expanded
   GROUP BY tenant_id, thread_id
), directory_bases AS (
  SELECT *,
         to_char(thread_created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD_HH24-MI-SS')
         || '_' || left(
           COALESCE(NULLIF(regexp_replace(btrim(title), '[\\/[:cntrl:]]+', '_', 'g'), ''), '任务'),
           45
         ) AS base_name
    FROM directory_candidates
), numbered_directories AS (
  SELECT *, row_number() OVER (
           PARTITION BY tenant_id, base_name ORDER BY thread_created_at, thread_id
         ) AS collision_ordinal
    FROM directory_bases
)
INSERT INTO thread_history_directories(
  tenant_id,thread_id,directory_name,directory_timestamp,directory_time_zone,naming_state,
  first_file_at,last_file_at,file_count
)
SELECT tenant_id,thread_id,
       base_name || CASE WHEN collision_ordinal=1 THEN '' ELSE '-' || collision_ordinal::text END,
       thread_created_at,'Asia/Shanghai',
       CASE WHEN title_source='model' THEN 'ready' ELSE 'fallback' END,
       first_file_at,last_file_at,0
  FROM numbered_directories;

WITH expanded AS (
  SELECT receipt.tenant_id, receipt.thread_id, receipt.receipt_id,
         receipt.created_at AS attached_at,
         resource_item.key AS resource_id, version_item.key AS resource_version_id,
         resource.name
    FROM thread_input_receipts receipt
    JOIN tenants tenant ON tenant.id=receipt.tenant_id AND tenant.kind='personal'
    CROSS JOIN LATERAL jsonb_each(receipt.input_attachments) resource_item
    CROSS JOIN LATERAL jsonb_each(resource_item.value) version_item
    JOIN resources resource
      ON resource.tenant_id=receipt.tenant_id AND resource.id=resource_item.key
     AND resource.visibility='searchable'
    JOIN resource_versions version
      ON version.tenant_id=receipt.tenant_id
     AND version.resource_id=resource_item.key AND version.id=version_item.key
   WHERE receipt.disposition IN ('queued', 'pending_steer', 'steered')
), aggregated AS (
  SELECT tenant_id,thread_id,resource_id,resource_version_id,min(name) AS name,
         (array_agg(receipt_id ORDER BY attached_at,receipt_id))[1] AS first_receipt_id,
         min(attached_at) AS first_attached_at,max(attached_at) AS last_attached_at,
         count(*)::bigint AS attachment_count
    FROM expanded
   GROUP BY tenant_id,thread_id,resource_id,resource_version_id
), file_bases AS (
  SELECT *,
         to_char(first_attached_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD_HH24-MI-SS')
         || '_' || left(
           COALESCE(NULLIF(regexp_replace(btrim(name), '[\\/[:cntrl:]]+', '_', 'g'), ''), 'file'),
           45
         ) AS base_name
    FROM aggregated
), numbered_files AS (
  SELECT *, row_number() OVER (
           PARTITION BY tenant_id,thread_id,base_name
           ORDER BY first_attached_at,resource_id,resource_version_id
         ) AS collision_ordinal
    FROM file_bases
)
INSERT INTO thread_history_file_entries(
  tenant_id,thread_id,resource_id,resource_version_id,relation_type,directory_entry_name,
  first_receipt_id,first_attached_at,last_attached_at,attachment_count
)
SELECT tenant_id,thread_id,resource_id,resource_version_id,'user_attachment',
       base_name || CASE WHEN collision_ordinal=1 THEN '' ELSE '-' || collision_ordinal::text END,
       first_receipt_id,first_attached_at,last_attached_at,attachment_count
  FROM numbered_files;

UPDATE thread_history_directories directory
   SET first_file_at=summary.first_file_at,
       last_file_at=summary.last_file_at,
       file_count=summary.file_count,
       updated_at=clock_timestamp()
  FROM (
    SELECT tenant_id,thread_id,min(first_attached_at) AS first_file_at,
           max(last_attached_at) AS last_file_at,count(*)::bigint AS file_count
      FROM thread_history_file_entries GROUP BY tenant_id,thread_id
  ) summary
 WHERE directory.tenant_id=summary.tenant_id AND directory.thread_id=summary.thread_id;

-- ---------------------------------------------------------------------------
-- 区段：thread_title_generation
-- ---------------------------------------------------------------------------

ALTER TABLE thread_history_directories
  DROP CONSTRAINT thread_history_directories_naming_state_check,
  ADD CONSTRAINT thread_history_directories_naming_state_check
    CHECK (naming_state IN ('pending', 'ready', 'fallback'));

CREATE TABLE thread_title_generation_outbox (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  source_receipt_id text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  expected_title_generation_version integer NOT NULL
    CHECK (expected_title_generation_version >= 0),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'claimed', 'succeeded', 'fallback', 'superseded')),
  claim_token text,
  claim_generation bigint NOT NULL DEFAULT 0
    CHECK (claim_generation >= 0 AND claim_generation <= 9007199254740991),
  claimed_by text,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'MODEL_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'INVALID_RESPONSE', 'INVALID_TITLE'
    )
  ),
  model_key text CHECK (model_key IS NULL OR model_key ~ '^[a-f0-9]{64}$'),
  prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id, source_receipt_id)
    REFERENCES thread_input_receipts(tenant_id, thread_id, receipt_id) ON DELETE RESTRICT,
  CONSTRAINT thread_title_generation_outbox_claim_check CHECK (
    (state = 'claimed' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL
      AND claim_expires_at IS NOT NULL)
    OR
    (state <> 'claimed' AND claim_token IS NULL AND claimed_by IS NULL
      AND claim_expires_at IS NULL)
  ),
  CONSTRAINT thread_title_generation_outbox_completion_check CHECK (
    (state IN ('succeeded', 'fallback', 'superseded')) = (completed_at IS NOT NULL)
  )
);

CREATE INDEX thread_title_generation_outbox_claim_idx
  ON thread_title_generation_outbox(tenant_id, next_attempt_at, created_at, thread_id)
  WHERE state IN ('pending', 'claimed');

ALTER TABLE thread_title_generation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_title_generation_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_title_generation_outbox_tenant_policy ON thread_title_generation_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：semantic_history_filesystem_names
-- ---------------------------------------------------------------------------

-- 历史目录面向人和 Agent 共同浏览；时间保留为元数据，不再编码进路径。
-- Migrator 不持有 BYPASSRLS；数据改名在同一 DDL 事务内短暂关闭策略，提交前恢复。
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
ALTER TABLE threads DISABLE ROW LEVEL SECURITY;
ALTER TABLE resources DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries DISABLE ROW LEVEL SECURITY;

UPDATE thread_history_directories directory
   SET directory_name='semantic-migration-' || md5(directory.tenant_id || E'\x1f' || directory.thread_id)
  FROM tenants tenant
 WHERE tenant.id=directory.tenant_id AND tenant.kind='personal'
   AND directory.naming_state IN ('ready','fallback');

WITH directory_bases AS (
  SELECT directory.tenant_id,directory.thread_id,directory.directory_timestamp,
         left(
           COALESCE(
             NULLIF(
               regexp_replace(
                 regexp_replace(btrim(thread.title), '[\\/[:cntrl:]]+', '_', 'g'),
                 '[. ]+$', '', 'g'
               ),
               ''
             ),
             '任务'
           ),
           45
         ) AS base_name
    FROM thread_history_directories directory
    JOIN tenants tenant ON tenant.id=directory.tenant_id AND tenant.kind='personal'
    JOIN threads thread ON thread.tenant_id=directory.tenant_id AND thread.id=directory.thread_id
   WHERE directory.naming_state IN ('ready','fallback')
), numbered_directories AS (
  SELECT *,row_number() OVER (
           PARTITION BY tenant_id,base_name ORDER BY directory_timestamp,thread_id
         ) AS collision_ordinal
    FROM directory_bases
)
UPDATE thread_history_directories directory
   SET directory_name=numbered.base_name ||
         CASE WHEN numbered.collision_ordinal=1 THEN ''
              ELSE '-' || numbered.collision_ordinal::text END,
       version=directory.version+1,updated_at=clock_timestamp()
  FROM numbered_directories numbered
 WHERE directory.tenant_id=numbered.tenant_id AND directory.thread_id=numbered.thread_id;

UPDATE thread_history_file_entries entry
   SET directory_entry_name='semantic-migration-' ||
       md5(entry.tenant_id || E'\x1f' || entry.thread_id || E'\x1f' ||
           entry.resource_id || E'\x1f' || entry.resource_version_id)
  FROM tenants tenant
 WHERE tenant.id=entry.tenant_id AND tenant.kind='personal';

WITH file_bases AS (
  SELECT entry.tenant_id,entry.thread_id,entry.resource_id,entry.resource_version_id,
         entry.first_attached_at,
         left(
           COALESCE(
             NULLIF(
               regexp_replace(
                 regexp_replace(btrim(resource.name), '[\\/[:cntrl:]]+', '_', 'g'),
                 '[. ]+$', '', 'g'
               ),
               ''
             ),
             'file'
           ),
           45
         ) AS base_name
    FROM thread_history_file_entries entry
    JOIN tenants tenant ON tenant.id=entry.tenant_id AND tenant.kind='personal'
    JOIN resources resource ON resource.tenant_id=entry.tenant_id AND resource.id=entry.resource_id
), numbered_files AS (
  SELECT *,row_number() OVER (
           PARTITION BY tenant_id,thread_id,base_name
           ORDER BY first_attached_at,resource_id,resource_version_id
         ) AS collision_ordinal
    FROM file_bases
), named_files AS (
  SELECT *,
         CASE
           WHEN collision_ordinal=1 THEN base_name
           WHEN base_name ~ '^.+\.[^.]+$' THEN
             regexp_replace(base_name, '(\.[^.]*)$', '') || '-' || collision_ordinal::text ||
             substring(base_name from '(\.[^.]*)$')
           ELSE base_name || '-' || collision_ordinal::text
         END AS entry_name
    FROM numbered_files
)
UPDATE thread_history_file_entries entry
   SET directory_entry_name=named.entry_name,updated_at=clock_timestamp()
  FROM named_files named
 WHERE entry.tenant_id=named.tenant_id AND entry.thread_id=named.thread_id
   AND entry.resource_id=named.resource_id
   AND entry.resource_version_id=named.resource_version_id
   AND entry.relation_type='user_attachment';

ALTER TABLE thread_history_file_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories FORCE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 区段：agent_deliverable_history
-- ---------------------------------------------------------------------------

-- 正式 deliverable 与用户附件共享个人历史目录；临时、诊断和 trace 文件不进入云盘。
-- 数据回填需要跨多张 FORCE RLS 表读取，迁移事务内短暂关闭并在提交前恢复。
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
ALTER TABLE threads DISABLE ROW LEVEL SECURITY;
ALTER TABLE resources DISABLE ROW LEVEL SECURITY;
ALTER TABLE resource_versions DISABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications DISABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_settlements DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_title_generation_outbox DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries DISABLE ROW LEVEL SECURITY;

ALTER TABLE artifact_publications
  ADD CONSTRAINT artifact_publications_history_source_key
  UNIQUE (tenant_id,id,thread_id,purpose);

ALTER TABLE thread_history_file_entries
  DROP CONSTRAINT thread_history_file_entries_relation_type_check,
  ALTER COLUMN first_receipt_id DROP NOT NULL,
  ADD COLUMN source_artifact_id text,
  ADD COLUMN source_artifact_purpose text GENERATED ALWAYS AS (
    CASE WHEN relation_type='agent_deliverable' THEN 'deliverable'::text ELSE NULL::text END
  ) STORED,
  ADD CONSTRAINT thread_history_file_entries_relation_source_check CHECK (
    (relation_type='user_attachment' AND first_receipt_id IS NOT NULL AND source_artifact_id IS NULL)
    OR
    (relation_type='agent_deliverable' AND first_receipt_id IS NULL AND source_artifact_id IS NOT NULL)
  ),
  ADD CONSTRAINT thread_history_file_entries_artifact_source_fk FOREIGN KEY (
    tenant_id,source_artifact_id,thread_id,source_artifact_purpose
  ) REFERENCES artifact_publications(tenant_id,id,thread_id,purpose) ON DELETE RESTRICT;

DO $$
DECLARE
  item record;
  base_name text;
  candidate text;
  ordinal integer;
  dot_position integer;
BEGIN
  -- 先为只有 Agent 交付物的任务补目录；已有附件目录保持原路径不变。
  FOR item IN
    SELECT publication.tenant_id,publication.thread_id,thread.title,thread.title_source,
           thread.created_at AS thread_created_at,title_outbox.state AS title_generation_state,
           min(settlement.settled_at) AS first_file_at,
           max(settlement.settled_at) AS last_file_at
      FROM artifact_publications publication
      JOIN artifact_publication_settlements settlement
        ON settlement.tenant_id=publication.tenant_id
       AND settlement.artifact_id=publication.id AND settlement.target='published'
      JOIN tenants tenant ON tenant.id=publication.tenant_id AND tenant.kind='personal'
      JOIN threads thread
        ON thread.tenant_id=publication.tenant_id AND thread.id=publication.thread_id
      LEFT JOIN thread_title_generation_outbox title_outbox
        ON title_outbox.tenant_id=thread.tenant_id AND title_outbox.thread_id=thread.id
      JOIN resources resource
        ON resource.tenant_id=publication.tenant_id AND resource.id=publication.resource_id
       AND resource.visibility='searchable'
     WHERE publication.purpose='deliverable'
       AND NOT EXISTS (
         SELECT 1 FROM thread_history_directories directory
          WHERE directory.tenant_id=publication.tenant_id
            AND directory.thread_id=publication.thread_id
       )
     GROUP BY publication.tenant_id,publication.thread_id,thread.title,thread.title_source,
              thread.created_at,title_outbox.state
     ORDER BY publication.tenant_id,thread.created_at,publication.thread_id
  LOOP
    IF item.title_generation_state IN ('pending','claimed') THEN
      candidate := 'pending-' || item.thread_id;
    ELSE
      base_name := left(
        COALESCE(
          NULLIF(
            regexp_replace(
              regexp_replace(btrim(item.title), '[\/[:cntrl:]]+', '_', 'g'),
              '[. ]+$', '', 'g'
            ),
            ''
          ),
          '任务'
        ),
        45
      );
      ordinal := 1;
      LOOP
        candidate := base_name || CASE WHEN ordinal=1 THEN '' ELSE '-' || ordinal::text END;
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM thread_history_directories directory
           WHERE directory.tenant_id=item.tenant_id AND directory.directory_name=candidate
        );
        ordinal := ordinal + 1;
        IF ordinal > 10000 THEN RAISE EXCEPTION '历史目录语义名称冲突过多'; END IF;
      END LOOP;
    END IF;

    INSERT INTO thread_history_directories(
      tenant_id,thread_id,directory_name,directory_timestamp,directory_time_zone,naming_state,
      first_file_at,last_file_at,file_count
    ) VALUES (
      item.tenant_id,item.thread_id,candidate,item.thread_created_at,'Asia/Shanghai',
      CASE WHEN item.title_generation_state IN ('pending','claimed') THEN 'pending'
           WHEN item.title_source IN ('model','user') THEN 'ready' ELSE 'fallback' END,
      item.first_file_at,item.last_file_at,0
    );
  END LOOP;

  -- 每个已发布 deliverable 建立不可变 ResourceVersion 关系，重名序号放在扩展名前。
  FOR item IN
    SELECT publication.tenant_id,publication.thread_id,publication.id AS artifact_id,
           publication.resource_id,publication.resource_version_id,resource.name,
           settlement.settled_at
      FROM artifact_publications publication
      JOIN artifact_publication_settlements settlement
        ON settlement.tenant_id=publication.tenant_id
       AND settlement.artifact_id=publication.id AND settlement.target='published'
      JOIN tenants tenant ON tenant.id=publication.tenant_id AND tenant.kind='personal'
      JOIN resources resource
        ON resource.tenant_id=publication.tenant_id AND resource.id=publication.resource_id
       AND resource.visibility='searchable'
      JOIN resource_versions version
        ON version.tenant_id=publication.tenant_id
       AND version.resource_id=publication.resource_id
       AND version.id=publication.resource_version_id
     WHERE publication.purpose='deliverable'
       AND NOT EXISTS (
         SELECT 1 FROM thread_history_file_entries entry
          WHERE entry.tenant_id=publication.tenant_id
            AND entry.thread_id=publication.thread_id
            AND entry.resource_id=publication.resource_id
            AND entry.resource_version_id=publication.resource_version_id
            AND entry.relation_type='agent_deliverable'
       )
     ORDER BY publication.tenant_id,publication.thread_id,settlement.settled_at,publication.id
  LOOP
    base_name := left(
      COALESCE(
        NULLIF(
          regexp_replace(
            regexp_replace(btrim(item.name), '[\/[:cntrl:]]+', '_', 'g'),
            '[. ]+$', '', 'g'
          ),
          ''
        ),
        'file'
      ),
      45
    );
    ordinal := 1;
    LOOP
      IF ordinal=1 THEN
        candidate := base_name;
      ELSE
        dot_position := length(base_name) - strpos(reverse(base_name), '.') + 1;
        IF dot_position > 1 AND dot_position <= length(base_name) THEN
          candidate := left(base_name,dot_position-1) || '-' || ordinal::text ||
                       substring(base_name from dot_position);
        ELSE
          candidate := base_name || '-' || ordinal::text;
        END IF;
      END IF;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM thread_history_file_entries entry
         WHERE entry.tenant_id=item.tenant_id AND entry.thread_id=item.thread_id
           AND entry.directory_entry_name=candidate
      );
      ordinal := ordinal + 1;
      IF ordinal > 10000 THEN RAISE EXCEPTION '历史文件语义名称冲突过多'; END IF;
    END LOOP;

    INSERT INTO thread_history_file_entries(
      tenant_id,thread_id,resource_id,resource_version_id,relation_type,directory_entry_name,
      first_receipt_id,source_artifact_id,first_attached_at,last_attached_at,attachment_count
    ) VALUES (
      item.tenant_id,item.thread_id,item.resource_id,item.resource_version_id,
      'agent_deliverable',candidate,NULL,item.artifact_id,item.settled_at,item.settled_at,1
    );
  END LOOP;
END
$$;

UPDATE thread_history_directories directory
   SET first_file_at=summary.first_file_at,last_file_at=summary.last_file_at,
       file_count=summary.file_count,version=directory.version+1,updated_at=clock_timestamp()
  FROM (
    SELECT tenant_id,thread_id,min(first_attached_at) AS first_file_at,
           max(last_attached_at) AS last_file_at,count(*)::bigint AS file_count
      FROM thread_history_file_entries GROUP BY tenant_id,thread_id
  ) summary
 WHERE directory.tenant_id=summary.tenant_id AND directory.thread_id=summary.thread_id;

ALTER TABLE thread_history_file_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_title_generation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_title_generation_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_settlements FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 区段：team_collaboration
-- ---------------------------------------------------------------------------

CREATE TABLE team_member_directory (
  team_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  joined_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (team_id,user_id)
);

CREATE INDEX team_member_directory_user_active_idx
  ON team_member_directory(user_id,status,display_name,team_id);

CREATE TABLE thread_forks (
  tenant_id text NOT NULL,
  child_thread_id text NOT NULL,
  source_tenant_id text NOT NULL,
  source_thread_id text NOT NULL,
  fork_kind text NOT NULL CHECK (fork_kind IN ('branch','team_publish')),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,child_thread_id),
  FOREIGN KEY (tenant_id,child_thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_user_id)
    REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT
);

CREATE INDEX thread_forks_source_idx
  ON thread_forks(source_tenant_id,source_thread_id,created_at,child_thread_id);

CREATE TABLE tenant_skill_installations (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  skill_version text NOT NULL,
  invocation_name text NOT NULL CHECK (
    octet_length(invocation_name) BETWEEN 1 AND 128
    AND invocation_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND lower(invocation_name) NOT IN ('clear','help','new','settings','skills')
  ),
  status text NOT NULL CHECK (status IN ('enabled','disabled','uninstalled')),
  version_token bigint NOT NULL DEFAULT 0 CHECK (version_token >= 0),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,skill_id),
  FOREIGN KEY (skill_id,skill_version)
    REFERENCES skill_versions(skill_id,version) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX tenant_skill_installations_invocation_active_unique
  ON tenant_skill_installations(tenant_id,invocation_name)
  WHERE status IN ('enabled','disabled');

CREATE TABLE tenant_skill_installation_commands (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  operation text NOT NULL CHECK (operation IN ('install','configure','uninstall')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,idempotency_key)
);

CREATE TABLE tenant_skill_installation_audits (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 160),
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('install','configure','uninstall')),
  before_status text CHECK (before_status IN ('enabled','disabled','uninstalled')),
  after_status text NOT NULL CHECK (after_status IN ('enabled','disabled','uninstalled')),
  skill_version text NOT NULL,
  invocation_name text NOT NULL,
  version_token bigint NOT NULL CHECK (version_token >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,event_id),
  FOREIGN KEY (skill_id,skill_version)
    REFERENCES skill_versions(skill_id,version) ON DELETE RESTRICT
);

-- 个人 Skill 从“用户全局”迁移到个人 Tenant；团队从空策略开始，避免隐式继承个人能力。
INSERT INTO tenant_skill_installations(
  tenant_id,skill_id,skill_version,invocation_name,status,version_token,installed_at,updated_at
)
SELECT tenant.id,installation.skill_id,installation.skill_version,installation.invocation_name,
       installation.status,installation.version_token,installation.installed_at,installation.updated_at
  FROM user_skill_installations installation
  JOIN tenants tenant ON tenant.kind='personal' AND tenant.owner_user_id=installation.user_id;

INSERT INTO tenant_skill_installation_commands(
  tenant_id,idempotency_key,operation,request_digest,result,created_at
)
SELECT tenant.id,command.idempotency_key,command.operation,command.request_digest,
       command.result,command.created_at
  FROM user_skill_installation_commands command
  JOIN tenants tenant ON tenant.kind='personal' AND tenant.owner_user_id=command.user_id;

INSERT INTO tenant_skill_installation_audits(
  tenant_id,event_id,skill_id,operation,before_status,after_status,
  skill_version,invocation_name,version_token,created_at
)
SELECT tenant.id,audit.event_id,audit.skill_id,audit.operation,audit.before_status,
       audit.after_status,audit.skill_version,audit.invocation_name,audit.version_token,audit.created_at
  FROM user_skill_installation_audits audit
  JOIN tenants tenant ON tenant.kind='personal' AND tenant.owner_user_id=audit.user_id;

ALTER TABLE team_member_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_member_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY team_member_directory_read_policy ON team_member_directory
  FOR SELECT
  USING (
    user_id=NULLIF(current_setting('app.user_id',true),'')
    OR (
      team_id=NULLIF(current_setting('app.tenant_id',true),'')
      AND EXISTS (
        SELECT 1 FROM memberships actor
         WHERE actor.tenant_id=team_member_directory.team_id
           AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
           AND actor.status='active'
      )
    )
  );
CREATE POLICY team_member_directory_manage_policy ON team_member_directory
  FOR ALL
  USING (
    team_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=team_member_directory.team_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    team_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=team_member_directory.team_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  );

ALTER TABLE thread_forks ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_forks FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_forks_tenant_policy ON thread_forks
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));

ALTER TABLE tenant_skill_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_skill_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_skill_installations_read_policy ON tenant_skill_installations
  FOR SELECT USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installations.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active'
    )
  );
CREATE POLICY tenant_skill_installations_manage_policy ON tenant_skill_installations
  FOR ALL USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installations.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  ) WITH CHECK (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installations.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  );

ALTER TABLE tenant_skill_installation_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_skill_installation_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_skill_installation_commands_policy ON tenant_skill_installation_commands
  USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installation_commands.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installation_commands.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  );

ALTER TABLE tenant_skill_installation_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_skill_installation_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_skill_installation_audits_policy ON tenant_skill_installation_audits
  USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installation_audits.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installation_audits.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  );

-- ---------------------------------------------------------------------------
-- 区段：dynamic_worker_tenant_assignment
-- ---------------------------------------------------------------------------

-- Worker 只通过这个无业务载荷的控制面动态选择 Tenant；Run/Thread 等事实继续受原表 FORCE RLS 隔离。
CREATE TABLE worker_tenant_assignments (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('idle','ready','claimed')),
  generation bigint NOT NULL DEFAULT 0
    CHECK (generation >= 0 AND generation <= 9007199254740991),
  claim_token text,
  claimed_by text CHECK (
    claimed_by IS NULL OR octet_length(claimed_by) BETWEEN 1 AND 200
  ),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT worker_tenant_assignments_claim_shape CHECK (
    (
      state='claimed'
      AND claim_token IS NOT NULL
      AND claimed_by IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      state IN ('idle','ready')
      AND claim_token IS NULL
      AND claimed_by IS NULL
      AND lease_expires_at IS NULL
    )
  )
);

CREATE INDEX worker_tenant_assignments_ready_idx
  ON worker_tenant_assignments(next_attempt_at,updated_at,tenant_id)
  WHERE state='ready';
CREATE INDEX worker_tenant_assignments_expired_claim_idx
  ON worker_tenant_assignments(lease_expires_at,updated_at,tenant_id)
  WHERE state='claimed';

-- 已经排队的个人或团队任务必须在迁移后自动进入动态调度，不能依赖用户重新提交。
-- FORCE RLS 对表 Owner 同样生效；迁移事务持有排他锁并只在回填窗口内关闭，随后立即恢复。
LOCK TABLE run_dispatch_outbox IN ACCESS EXCLUSIVE MODE;
ALTER TABLE run_dispatch_outbox DISABLE ROW LEVEL SECURITY;
INSERT INTO worker_tenant_assignments(tenant_id,state,next_attempt_at)
SELECT outbox.tenant_id,'ready',
       min(
         CASE
           WHEN outbox.state='ready' THEN outbox.next_attempt_at
           ELSE outbox.lease_expires_at + interval '1 millisecond'
         END
       )
  FROM run_dispatch_outbox outbox
 WHERE outbox.state IN ('ready','claimed')
 GROUP BY outbox.tenant_id;
ALTER TABLE run_dispatch_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_dispatch_outbox FORCE ROW LEVEL SECURITY;

ALTER TABLE worker_tenant_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_tenant_assignments FORCE ROW LEVEL SECURITY;
-- 普通 Runtime 仍按 app.tenant_id 隔离；全局 claim 只向独立登录角色开放，不能由请求级 GUC 提权。
DO $$
DECLARE
  runtime_role text := NULLIF(current_setting('app.runtime_role',true),'');
  coordinator_role text := NULLIF(current_setting('app.worker_coordinator_role',true),'');
BEGIN
  IF runtime_role IS NULL OR runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.runtime_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
  IF coordinator_role IS NULL OR coordinator_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.worker_coordinator_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
  IF runtime_role=coordinator_role THEN
    RAISE EXCEPTION 'Runtime 与 Worker Coordinator 必须使用不同角色';
  END IF;

  EXECUTE format(
    'CREATE POLICY worker_tenant_assignments_runtime_policy ON worker_tenant_assignments TO %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),''''))',
    runtime_role
  );
  EXECUTE format(
    'CREATE POLICY worker_tenant_assignments_coordinator_select_policy ON worker_tenant_assignments FOR SELECT TO %I USING (true)',
    coordinator_role
  );
  EXECUTE format(
    'CREATE POLICY worker_tenant_assignments_coordinator_claim_policy ON worker_tenant_assignments FOR UPDATE TO %I USING (true) WITH CHECK (true)',
    coordinator_role
  );
END $$;

-- ---------------------------------------------------------------------------
-- 区段：agent_mailbox_terminal_status
-- ---------------------------------------------------------------------------

ALTER TABLE runtime_agent_mailbox_messages NO FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_agent_mailbox_messages DISABLE ROW LEVEL SECURITY;

ALTER TABLE runtime_agent_mailbox_messages
  ADD COLUMN terminal_status text,
  ADD COLUMN error_code text;

UPDATE runtime_agent_mailbox_messages
   SET terminal_status = CASE kind
       WHEN 'final_answer' THEN 'completed'
       WHEN 'error' THEN 'failed'
       ELSE NULL
     END,
       error_code = CASE kind
       WHEN 'error' THEN 'LEGACY_SUBAGENT_ERROR'
       ELSE NULL
     END;

ALTER TABLE runtime_agent_mailbox_messages
  ADD CONSTRAINT runtime_agent_mailbox_terminal_status_check CHECK (
    (kind = 'message' AND terminal_status IS NULL AND error_code IS NULL)
    OR (kind = 'final_answer' AND terminal_status = 'completed' AND error_code IS NULL)
    OR (
      kind = 'error'
      AND terminal_status IN ('interrupted', 'failed')
      AND error_code IS NOT NULL
      AND octet_length(error_code) BETWEEN 1 AND 200
    )
  );

ALTER TABLE runtime_agent_mailbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_agent_mailbox_messages FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 区段：subagent_current_task
-- ---------------------------------------------------------------------------

ALTER TABLE runtime_subagent_conversations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_subagent_conversations DISABLE ROW LEVEL SECURITY;

ALTER TABLE runtime_subagent_conversations
  ADD COLUMN current_task text;

UPDATE runtime_subagent_conversations
   SET current_task = task;

ALTER TABLE runtime_subagent_conversations
  ALTER COLUMN current_task SET NOT NULL,
  ADD CONSTRAINT runtime_subagent_conversation_current_task_check CHECK (
    octet_length(current_task) BETWEEN 1 AND 32768
  );

ALTER TABLE runtime_subagent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_subagent_conversations FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 区段：memory_ingestion_outbox
-- ---------------------------------------------------------------------------

-- 成功 Run 只在本地事务登记记忆任务，第三方提交由异步消费者完成。
CREATE TABLE memory_ingestion_outbox (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  attempt_id text NOT NULL,
  subject_user_id text NOT NULL CHECK (octet_length(subject_user_id) BETWEEN 1 AND 200),
  tenant_kind text NOT NULL CHECK (tenant_kind IN ('personal', 'team')),
  source_through_sequence bigint NOT NULL
    CHECK (source_through_sequence BETWEEN 1 AND 9007199254740991),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'claimed', 'submitted', 'succeeded', 'failed')),
  provider_event_id uuid,
  claim_token text,
  claim_generation bigint NOT NULL DEFAULT 0
    CHECK (claim_generation BETWEEN 0 AND 9007199254740991),
  claimed_by text CHECK (claimed_by IS NULL OR octet_length(claimed_by) BETWEEN 1 AND 200),
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'TIMEOUT', 'PROVIDER_UNAVAILABLE', 'INVALID_RESPONSE', 'REQUEST_REJECTED'
    )
  ),
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES memberships(tenant_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT memory_ingestion_outbox_claim_shape_check CHECK (
    (state = 'claimed' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL
      AND claim_expires_at IS NOT NULL)
    OR
    (state <> 'claimed' AND claim_token IS NULL AND claimed_by IS NULL
      AND claim_expires_at IS NULL)
  ),
  CONSTRAINT memory_ingestion_outbox_provider_shape_check CHECK (
    (state = 'pending' AND provider_event_id IS NULL AND submitted_at IS NULL)
    OR (state = 'claimed')
    OR (state IN ('submitted', 'succeeded') AND provider_event_id IS NOT NULL
      AND submitted_at IS NOT NULL)
    OR (state = 'failed')
  ),
  CONSTRAINT memory_ingestion_outbox_completion_shape_check CHECK (
    (state IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)
  )
);

CREATE INDEX memory_ingestion_outbox_claim_idx
  ON memory_ingestion_outbox(tenant_id, next_attempt_at, created_at, run_id)
  WHERE state IN ('pending', 'claimed', 'submitted');

ALTER TABLE memory_ingestion_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ingestion_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_ingestion_outbox_tenant_policy ON memory_ingestion_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：personalization_settings
-- ---------------------------------------------------------------------------

-- 个人与团队个性化分表持久化，Run 只读取当前版本的低信任偏好快照。
CREATE TABLE user_personalization_settings (
  user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  content text NOT NULL,
  apply_to_team_tasks boolean NOT NULL DEFAULT true,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_personalization_content_check CHECK (
    character_length(content) <= 2000 AND octet_length(content) <= 8192
  )
);

CREATE TABLE team_personalization_settings (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  content text NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  updated_by_user_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,updated_by_user_id)
    REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
  CONSTRAINT team_personalization_content_check CHECK (
    character_length(content) <= 2000 AND octet_length(content) <= 8192
  )
);

ALTER TABLE user_personalization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_personalization_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY user_personalization_self_policy ON user_personalization_settings
  USING (user_id=NULLIF(current_setting('app.user_id',true),''))
  WITH CHECK (user_id=NULLIF(current_setting('app.user_id',true),''));

ALTER TABLE team_personalization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_personalization_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY team_personalization_read_policy ON team_personalization_settings
  FOR SELECT USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=team_personalization_settings.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active'
    )
  );
CREATE POLICY team_personalization_manage_policy ON team_personalization_settings
  FOR ALL USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=team_personalization_settings.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active'
         AND actor.role IN ('owner','admin')
    )
  ) WITH CHECK (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND updated_by_user_id=NULLIF(current_setting('app.user_id',true),'')
    AND EXISTS (
      SELECT 1 FROM tenants tenant
       WHERE tenant.id=team_personalization_settings.tenant_id AND tenant.kind='team'
    )
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=team_personalization_settings.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active'
         AND actor.role IN ('owner','admin')
    )
  );

-- ---------------------------------------------------------------------------
-- 区段：sandbox_provider_identity
-- ---------------------------------------------------------------------------

-- Sandbox Provider 是持久身份的一部分；所有恢复、清理与 Thread Session 路由必须按 provider_key 失败关闭。
ALTER TABLE sandbox_registry
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));
ALTER TABLE cleanup_outbox
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));
ALTER TABLE sandbox_lifecycle_unknown
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));
ALTER TABLE waiting_recovery_checkpoints
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));
ALTER TABLE thread_sandbox_sessions
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));
ALTER TABLE sandbox_lifecycle_effects
  ADD COLUMN provider_key text NOT NULL DEFAULT 'cube'
  CHECK (provider_key IN ('cube','e2b'));

DO $$
DECLARE current_name text;
BEGIN
  SELECT conname INTO current_name FROM pg_constraint
   WHERE conrelid='cleanup_outbox'::regclass AND contype='f'
     AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (tenant_id, attempt_id, registry_id, provider_sandbox_id)%';
  IF current_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE cleanup_outbox DROP CONSTRAINT %I', current_name);
  END IF;

  SELECT conname INTO current_name FROM pg_constraint
   WHERE conrelid='waiting_recovery_checkpoints'::regclass AND contype='f'
     AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (tenant_id, attempt_id, registry_id, provider_sandbox_id)%';
  IF current_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE waiting_recovery_checkpoints DROP CONSTRAINT %I', current_name);
  END IF;

  FOR current_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='sandbox_registry'::regclass AND contype='u'
       AND pg_get_constraintdef(oid) IN (
         'UNIQUE (tenant_id, provider_sandbox_id)',
         'UNIQUE (tenant_id, attempt_id, registry_id, provider_sandbox_id)'
       )
  LOOP
    EXECUTE format('ALTER TABLE sandbox_registry DROP CONSTRAINT %I', current_name);
  END LOOP;

  SELECT conname INTO current_name FROM pg_constraint
   WHERE conrelid='thread_sandbox_sessions'::regclass AND contype='u'
     AND pg_get_constraintdef(oid)='UNIQUE (provider_sandbox_id)';
  IF current_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE thread_sandbox_sessions DROP CONSTRAINT %I', current_name);
  END IF;
END $$;

ALTER TABLE sandbox_registry
  ADD CONSTRAINT sandbox_registry_provider_identity_key
  UNIQUE (tenant_id,provider_key,provider_sandbox_id),
  ADD CONSTRAINT sandbox_registry_cleanup_identity_key
  UNIQUE (tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id);
ALTER TABLE cleanup_outbox
  ADD CONSTRAINT cleanup_outbox_provider_registry_fkey
  FOREIGN KEY (tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id)
  REFERENCES sandbox_registry(tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id)
  ON DELETE RESTRICT;
ALTER TABLE waiting_recovery_checkpoints
  ADD CONSTRAINT waiting_recovery_provider_registry_fkey
  FOREIGN KEY (tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id)
  REFERENCES sandbox_registry(tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id)
  ON DELETE RESTRICT;
ALTER TABLE thread_sandbox_sessions
  ADD CONSTRAINT thread_sandbox_sessions_provider_identity_key
  UNIQUE (provider_key,provider_sandbox_id);

-- ---------------------------------------------------------------------------
-- 区段：user_account_authentication
-- ---------------------------------------------------------------------------

-- 本地产品账号在解析 Tenant 之前按邮箱或随机会话摘要定位；两张表仍以细粒度 RLS
-- 限制为当前认证候选或已经建立的用户上下文，禁止 Runtime 无条件扫描凭据事实。
ALTER TABLE tenants
  ADD CONSTRAINT tenants_personal_owner_identity_key UNIQUE (id, owner_user_id);

CREATE TABLE user_accounts (
  user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  personal_tenant_id text NOT NULL UNIQUE,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  normalized_email text NOT NULL UNIQUE CHECK (
    length(normalized_email) BETWEEN 3 AND 254 AND normalized_email = lower(normalized_email)
  ),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 32),
  password_algorithm text NOT NULL CHECK (password_algorithm = 'scrypt-v1'),
  password_salt bytea NOT NULL CHECK (octet_length(password_salt) = 16),
  password_hash bytea NOT NULL CHECK (octet_length(password_hash) = 32),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (personal_tenant_id, user_id)
    REFERENCES tenants(id, owner_user_id) ON DELETE RESTRICT
);

CREATE TABLE user_sessions (
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES user_accounts(user_id) ON DELETE CASCADE,
  personal_tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  FOREIGN KEY (personal_tenant_id, user_id)
    REFERENCES tenants(id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX user_sessions_user_expiry_idx ON user_sessions(user_id, expires_at DESC);
CREATE INDEX user_sessions_expiry_idx ON user_sessions(expires_at);

ALTER TABLE user_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY user_accounts_authentication_policy ON user_accounts
  USING (
    normalized_email = NULLIF(current_setting('app.auth_email', true), '')
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')
    AND personal_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
  );

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_authentication_policy ON user_sessions
  USING (
    token_digest = NULLIF(current_setting('app.auth_session_digest', true), '')
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')
    AND personal_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
  );

-- ---------------------------------------------------------------------------
-- 区段：scheduled_tasks
-- ---------------------------------------------------------------------------

-- 对话定时任务、不可变修订与动态 Tenant 唤醒。
CREATE TABLE scheduled_tasks (
  tenant_id text NOT NULL,
  id text NOT NULL,
  owner_user_id text NOT NULL,
  source_thread_id text NOT NULL,
  target_thread_id text NOT NULL,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 480),
  instruction text NOT NULL CHECK (octet_length(instruction) BETWEEN 1 AND 16384),
  timezone text NOT NULL CHECK (octet_length(timezone) BETWEEN 1 AND 100),
  rrule text CHECK (rrule IS NULL OR octet_length(rrule) BETWEEN 1 AND 300),
  status text NOT NULL CHECK (status IN ('active','paused','completed','deleted')),
  overlap_policy text NOT NULL CHECK (overlap_policy IN ('coalesce','skip')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,target_thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_tasks_next_run_shape CHECK (
    (status='active' AND next_run_at IS NOT NULL)
    OR (status IN ('paused','completed','deleted'))
  )
);
CREATE INDEX scheduled_tasks_due_idx
  ON scheduled_tasks(tenant_id,next_run_at,id)
  WHERE status='active';
CREATE INDEX scheduled_tasks_owner_idx
  ON scheduled_tasks(tenant_id,owner_user_id,updated_at DESC,id);

CREATE TABLE scheduled_task_revisions (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 480),
  instruction text NOT NULL CHECK (octet_length(instruction) BETWEEN 1 AND 16384),
  timezone text NOT NULL CHECK (octet_length(timezone) BETWEEN 1 AND 100),
  rrule text CHECK (rrule IS NULL OR octet_length(rrule) BETWEEN 1 AND 300),
  first_run_at timestamptz NOT NULL,
  overlap_policy text NOT NULL CHECK (overlap_policy IN ('coalesce','skip')),
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,task_id,revision),
  FOREIGN KEY (tenant_id,task_id) REFERENCES scheduled_tasks(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_run_id) REFERENCES runs(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE scheduled_task_occurrences (
  tenant_id text NOT NULL,
  id text NOT NULL,
  task_id text NOT NULL,
  task_revision integer NOT NULL,
  scheduled_for timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('dispatching','enqueued','skipped','failed')),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  run_id text,
  receipt_id text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,task_id,scheduled_for),
  FOREIGN KEY (tenant_id,task_id,task_revision)
    REFERENCES scheduled_task_revisions(tenant_id,task_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX scheduled_task_occurrences_dispatch_idx
  ON scheduled_task_occurrences(tenant_id,state,next_attempt_at,created_at)
  WHERE state IN ('dispatching','failed');

CREATE TABLE scheduled_task_commands (
  tenant_id text NOT NULL,
  actor_user_id text NOT NULL,
  command_id text NOT NULL CHECK (octet_length(command_id) BETWEEN 1 AND 300),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  task_id text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,actor_user_id,command_id),
  FOREIGN KEY (tenant_id,actor_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,task_id) REFERENCES scheduled_tasks(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_tasks_tenant_policy ON scheduled_tasks
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
ALTER TABLE scheduled_task_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_task_revisions_tenant_policy ON scheduled_task_revisions
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
ALTER TABLE scheduled_task_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_task_occurrences_tenant_policy ON scheduled_task_occurrences
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
ALTER TABLE scheduled_task_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_task_commands_tenant_policy ON scheduled_task_commands
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));

-- ---------------------------------------------------------------------------
-- 区段：admin_control_plane
-- ---------------------------------------------------------------------------

-- 独立后台控制面、不可变配置 revision 与 Run 固定快照。
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

-- ---------------------------------------------------------------------------
-- 区段：provider_model_catalog
-- ---------------------------------------------------------------------------

-- Provider 拥有 Pi 风格模型目录，平台控制启用集合与默认模型。
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

-- ---------------------------------------------------------------------------
-- 区段：admin_user_operations
-- ---------------------------------------------------------------------------

-- 后台用户治理与对话统计只经受限投影和审计状态变更暴露。
DO $$
DECLARE
  control_role text := NULLIF(current_setting('app.admin_control_role', true), '');
BEGIN
  IF control_role IS NULL OR control_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.admin_control_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
END $$;

ALTER TABLE user_accounts
  ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','disabled'));

CREATE TABLE admin_user_account_audits (
  audit_id text PRIMARY KEY CHECK (audit_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'),
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  target_user_id text NOT NULL REFERENCES user_accounts(user_id) ON DELETE RESTRICT,
  previous_status text NOT NULL CHECK (previous_status IN ('active','disabled')),
  status text NOT NULL CHECK (status IN ('active','disabled') AND status <> previous_status),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admin_user_account_audits_created_idx
  ON admin_user_account_audits(created_at DESC,audit_id DESC);

ALTER TABLE admin_user_account_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_user_account_audits FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  migrator_role text := current_user;
  control_role text := current_setting('app.admin_control_role');
BEGIN
  EXECUTE format(
    'CREATE POLICY admin_user_account_audits_migrator_policy ON admin_user_account_audits FOR ALL TO %I USING (true) WITH CHECK (true)',
    migrator_role
  );
  EXECUTE format(
    'CREATE POLICY admin_user_account_audits_control_policy ON admin_user_account_audits FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=actor_user_id AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY user_accounts_admin_control_update_policy ON user_accounts FOR UPDATE TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
  EXECUTE format(
    'CREATE POLICY user_sessions_admin_control_delete_policy ON user_sessions FOR DELETE TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
END $$;

-- 目录只向管理员会话返回账号资料；密码材料和 Session 摘要不会进入投影。
CREATE VIEW admin_user_directory WITH (security_barrier=true) AS
SELECT
  account.user_id,
  account.email,
  account.display_name,
  account.status,
  account.created_at,
  GREATEST(conversation.last_active_at,session.last_active_at) AS last_active_at,
  COALESCE(session.active_sessions,0)::bigint AS active_sessions,
  COALESCE(conversation.conversation_count,0)::bigint AS conversation_count,
  COALESCE(conversation.run_count,0)::bigint AS run_count
FROM user_accounts account
LEFT JOIN LATERAL (
  SELECT
    max(thread.updated_at) AS last_active_at,
    count(DISTINCT (thread.tenant_id,thread.id))::bigint AS conversation_count,
    count(DISTINCT (run.tenant_id,run.id))::bigint AS run_count
  FROM threads thread
  LEFT JOIN runs run ON run.tenant_id=thread.tenant_id AND run.thread_id=thread.id
  WHERE thread.created_by_user_id=account.user_id
) conversation ON true
LEFT JOIN LATERAL (
  SELECT
    max(candidate.created_at) AS last_active_at,
    count(*) FILTER (WHERE candidate.expires_at>clock_timestamp())::bigint AS active_sessions
  FROM user_sessions candidate
  WHERE candidate.user_id=account.user_id
) session ON true
WHERE EXISTS (
  SELECT 1 FROM platform_control_operators actor
   WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
     AND actor.status='active' AND actor.role='admin'
);

CREATE OR REPLACE VIEW admin_runtime_statistics WITH (security_barrier=true) AS
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
  (SELECT count(*)::bigint FROM tenant_skill_installations WHERE status IN ('enabled','disabled')) AS skills_installed,
  (SELECT count(*)::bigint FROM user_accounts) AS users_total,
  (SELECT count(*)::bigint FROM user_accounts WHERE created_at>=clock_timestamp()-interval '24 hours') AS users_registered_24h,
  (SELECT count(DISTINCT created_by_user_id)::bigint FROM threads WHERE updated_at>=clock_timestamp()-interval '7 days') AS users_active_7d,
  (SELECT count(*)::bigint FROM user_accounts WHERE status='disabled') AS users_disabled,
  (SELECT count(*)::bigint FROM threads) AS conversations_total,
  (SELECT count(*)::bigint FROM threads WHERE created_at>=clock_timestamp()-interval '24 hours') AS conversations_created_24h,
  (SELECT count(*)::bigint FROM threads WHERE updated_at>=clock_timestamp()-interval '24 hours') AS conversations_active_24h,
  (SELECT count(*)::bigint FROM threads WHERE status='archived') AS conversations_archived;

-- ---------------------------------------------------------------------------
-- 区段：model_usage_metrics
-- ---------------------------------------------------------------------------

ALTER TABLE thread_continuity_metric_observations
  DROP CONSTRAINT thread_continuity_metric_observations_metric_name_check;

ALTER TABLE thread_continuity_metric_observations
  ADD CONSTRAINT thread_continuity_metric_observations_metric_name_check CHECK (metric_name IN (
    'thread_input_total','steer_apply_latency_ms','steer_to_follow_up_total',
    'follow_up_queue_depth','follow_up_wait_ms','thread_writer_conflict_total',
    'context_rebuild_latency_ms','context_visible_tokens','context_tokens_before_compaction',
    'context_tokens_after_compaction','compaction_latency_ms','compaction_total',
    'context_recovery_digest_mismatch_total','context_window_number',
    'sandbox_handoff_total','sandbox_resume_total','sandbox_resume_latency_ms',
    'sandbox_create_latency_ms','workspace_materialize_latency_ms','sandbox_paused_seconds',
    'sandbox_snapshot_bytes','sandbox_cold_rebuild_total','sandbox_unknown_total',
    'sandbox_revision_mismatch_total','sandbox_idle_running_seconds',
    'model_input_tokens','model_output_tokens','model_cache_read_tokens',
    'model_generation_duration_ms'
  ));

CREATE OR REPLACE VIEW admin_runtime_statistics WITH (security_barrier=true) AS
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
  (SELECT count(*)::bigint FROM tenant_skill_installations WHERE status IN ('enabled','disabled')) AS skills_installed,
  (SELECT count(*)::bigint FROM user_accounts) AS users_total,
  (SELECT count(*)::bigint FROM user_accounts WHERE created_at>=clock_timestamp()-interval '24 hours') AS users_registered_24h,
  (SELECT count(DISTINCT created_by_user_id)::bigint FROM threads WHERE updated_at>=clock_timestamp()-interval '7 days') AS users_active_7d,
  (SELECT count(*)::bigint FROM user_accounts WHERE status='disabled') AS users_disabled,
  (SELECT count(*)::bigint FROM threads) AS conversations_total,
  (SELECT count(*)::bigint FROM threads WHERE created_at>=clock_timestamp()-interval '24 hours') AS conversations_created_24h,
  (SELECT count(*)::bigint FROM threads WHERE updated_at>=clock_timestamp()-interval '24 hours') AS conversations_active_24h,
  (SELECT count(*)::bigint FROM threads WHERE status='archived') AS conversations_archived,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_input_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_input_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_output_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_output_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_cache_read_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_cache_read_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_generation_duration_ms' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_generation_duration_ms_24h;

-- ---------------------------------------------------------------------------
-- 区段：model_usage_admin_index
-- ---------------------------------------------------------------------------

CREATE INDEX model_usage_metrics_admin_query_idx
  ON thread_continuity_metric_observations(metric_name,observed_at DESC)
  WHERE metric_name IN (
    'model_input_tokens','model_output_tokens','model_cache_read_tokens',
    'model_generation_duration_ms'
  );

-- ---------------------------------------------------------------------------
-- 区段：embedded_better_auth
-- ---------------------------------------------------------------------------

-- Better Auth 与 Hoox 共用数据库，但凭据表只向 Runtime 身份边界开放。
DO $$
DECLARE
  runtime_role text := NULLIF(current_setting('app.runtime_role', true), '');
  control_role text := NULLIF(current_setting('app.admin_control_role', true), '');
BEGIN
  IF runtime_role IS NULL OR runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.runtime_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
  IF control_role IS NULL OR control_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.admin_control_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
END $$;

ALTER TABLE user_accounts
  ADD COLUMN better_auth_user_id text UNIQUE,
  ALTER COLUMN password_algorithm DROP NOT NULL,
  ALTER COLUMN password_salt DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD CONSTRAINT user_accounts_password_shape CHECK (
    (password_algorithm IS NULL AND password_salt IS NULL AND password_hash IS NULL)
    OR (password_algorithm='scrypt-v1' AND octet_length(password_salt)=16 AND octet_length(password_hash)=32)
  );

DROP POLICY user_accounts_authentication_policy ON user_accounts;
CREATE POLICY user_accounts_authentication_policy ON user_accounts
  USING (
    normalized_email = NULLIF(current_setting('app.auth_email', true), '')
    OR better_auth_user_id = NULLIF(current_setting('app.auth_better_auth_user_id', true), '')
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')
    AND personal_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
  );

CREATE TABLE better_auth_users (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  phone_number text UNIQUE,
  phone_number_verified boolean,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE better_auth_sessions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES better_auth_users(id) ON DELETE CASCADE
);
CREATE INDEX better_auth_sessions_user_id_idx ON better_auth_sessions(user_id);
CREATE TABLE better_auth_accounts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  issuer text NOT NULL,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES better_auth_users(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL,
  UNIQUE (issuer,account_id)
);
CREATE INDEX better_auth_accounts_user_id_idx ON better_auth_accounts(user_id);
CREATE TABLE better_auth_verifications (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX better_auth_verifications_identifier_idx ON better_auth_verifications(identifier);
CREATE TABLE better_auth_rate_limits (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  last_request bigint NOT NULL
);

CREATE TABLE identity_auth_configuration (
  singleton text PRIMARY KEY CHECK (singleton='global'),
  version_token bigint NOT NULL CHECK (version_token BETWEEN 1 AND 9007199254740991),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration)='object'),
  secrets_ciphertext bytea NOT NULL CHECK (octet_length(secrets_ciphertext) BETWEEN 1 AND 65536),
  secrets_nonce bytea NOT NULL CHECK (octet_length(secrets_nonce)=12),
  secrets_tag bytea NOT NULL CHECK (octet_length(secrets_tag)=16),
  updated_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE identity_auth_audits (
  audit_id text PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  previous_version_token bigint NOT NULL CHECK (previous_version_token BETWEEN 0 AND 9007199254740991),
  version_token bigint NOT NULL CHECK (version_token=previous_version_token+1),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX identity_auth_audits_created_idx ON identity_auth_audits(created_at DESC,audit_id DESC);
CREATE TABLE identity_auth_commands (
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_user_id,idempotency_key)
);

ALTER TABLE better_auth_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE better_auth_users FORCE ROW LEVEL SECURITY;
ALTER TABLE better_auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE better_auth_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE better_auth_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE better_auth_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE better_auth_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE better_auth_verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE better_auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE better_auth_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_configuration FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_audits FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_auth_commands FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  migrator_role text := current_user;
  runtime_role text := current_setting('app.runtime_role');
  control_role text := current_setting('app.admin_control_role');
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['better_auth_users','better_auth_sessions','better_auth_accounts','better_auth_verifications','better_auth_rate_limits'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', table_name||'_migrator_policy', table_name, migrator_role);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', table_name||'_runtime_policy', table_name, runtime_role);
  END LOOP;
  EXECUTE format('CREATE POLICY identity_auth_configuration_migrator_policy ON identity_auth_configuration FOR ALL TO %I USING (true) WITH CHECK (true)', migrator_role);
  EXECUTE format('CREATE POLICY identity_auth_configuration_runtime_policy ON identity_auth_configuration FOR SELECT TO %I USING (true)', runtime_role);
  EXECUTE format('CREATE POLICY identity_auth_configuration_control_policy ON identity_auth_configuration FOR ALL TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'')) WITH CHECK (updated_by=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=updated_by AND actor.status=''active'' AND actor.role=''admin''))', control_role);
  EXECUTE format('CREATE POLICY identity_auth_audits_migrator_policy ON identity_auth_audits FOR ALL TO %I USING (true) WITH CHECK (true)', migrator_role);
  EXECUTE format('CREATE POLICY identity_auth_audits_control_policy ON identity_auth_audits FOR ALL TO %I USING (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),''''))', control_role);
  EXECUTE format('CREATE POLICY identity_auth_commands_migrator_policy ON identity_auth_commands FOR ALL TO %I USING (true) WITH CHECK (true)', migrator_role);
  EXECUTE format('CREATE POLICY identity_auth_commands_control_policy ON identity_auth_commands FOR ALL TO %I USING (actor_user_id=NULLIF(current_setting(''app.user_id'',true),'''')) WITH CHECK (actor_user_id=NULLIF(current_setting(''app.user_id'',true),''''))', control_role);
  EXECUTE format('CREATE POLICY better_auth_sessions_control_delete_policy ON better_auth_sessions FOR DELETE TO %I USING (EXISTS (SELECT 1 FROM user_accounts target JOIN platform_control_operators actor ON actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin'' WHERE target.better_auth_user_id=better_auth_sessions.user_id))', control_role);
END $$;

-- ---------------------------------------------------------------------------
-- 区段：managed_model_provider_credentials
-- ---------------------------------------------------------------------------

-- 模型调用密钥按 Provider Revision 加密托管，配置投影不得含明文。
ALTER TABLE admin_control_config_revisions
  DROP CONSTRAINT admin_control_configuration_shape;

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
        'requestTimeoutMs','enabled'
      ]='{}'::jsonb
      AND configuration->>'providerKey'=object_key
      AND configuration->>'providerKind'='mem0'
      AND configuration->>'apiSecretRef'='deployment:memory-api'
      AND configuration->>'scopeSecretRef'='deployment:memory-scope'
      AND configuration->>'baseUrl' ~ '^https://'
      AND jsonb_typeof(configuration->'enabled')='boolean'
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
      AND (configuration->>'compactionSoftLimitPercent')::bigint BETWEEN 50 AND 95
      AND (configuration->>'compactionTargetPercent')::bigint BETWEEN 20 AND 90
      AND (configuration->>'compactionTargetPercent')::bigint
          < (configuration->>'compactionSoftLimitPercent')::bigint
      AND (configuration->>'compactionRecentUserTokens')::bigint BETWEEN 1 AND 1000000
      AND (configuration->>'compactionMaxOutputTokens')::bigint BETWEEN 128 AND 1000000
      AND (configuration->>'compactionTimeoutMs')::bigint BETWEEN 1000 AND 600000
    )
  );

-- ---------------------------------------------------------------------------
-- 区段：user_run_concurrency
-- ---------------------------------------------------------------------------

-- 运行并发由后台发布配置控制，并按 Tenant 内请求用户全局占槽。
ALTER TABLE admin_control_config_revisions
  DROP CONSTRAINT admin_control_configuration_shape;

UPDATE admin_control_config_revisions
   SET configuration=configuration || jsonb_build_object(
     'workerMaxConcurrentRuns',20,
     'userMaxConcurrentRunsPerTenant',2
   )
 WHERE object_kind='runtime_settings';

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
        'requestTimeoutMs','enabled'
      ]='{}'::jsonb
      AND configuration->>'providerKey'=object_key
      AND configuration->>'providerKind'='mem0'
      AND configuration->>'apiSecretRef'='deployment:memory-api'
      AND configuration->>'scopeSecretRef'='deployment:memory-scope'
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
        'workerMaxConcurrentRuns','userMaxConcurrentRunsPerTenant',
        'compactionSoftLimitPercent','compactionTargetPercent','compactionRecentUserTokens',
        'compactionMaxOutputTokens','compactionTimeoutMs'
      ]='{}'::jsonb
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

CREATE INDEX run_skill_snapshots_user_run_idx
  ON run_skill_snapshots(tenant_id,user_id,run_id);

-- ---------------------------------------------------------------------------
-- 区段：admin_projection_rls
-- ---------------------------------------------------------------------------

-- 聚合视图仍由无 BYPASSRLS 的 Migrator 持有；不增加控制角色的底表权限。
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'runs','threads','run_dispatch_outbox','sandbox_registry','cleanup_outbox',
    'memory_ingestion_outbox','scheduled_tasks','scheduled_task_occurrences',
    'tenant_skill_installations','user_accounts','thread_continuity_metric_observations','user_sessions'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' %s))',
      table_name || '_admin_projection_read', table_name, current_user,
      CASE WHEN table_name='user_sessions' THEN 'AND actor.role=''admin''' ELSE '' END
    );
  END LOOP;
END $$;
CREATE OR REPLACE VIEW admin_runtime_statistics WITH (security_barrier=true) AS
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
  (SELECT count(*)::bigint FROM tenant_skill_installations WHERE status IN ('enabled','disabled')) AS skills_installed,
  (SELECT count(*)::bigint FROM user_accounts) AS users_total,
  (SELECT count(*)::bigint FROM user_accounts WHERE created_at>=clock_timestamp()-interval '24 hours') AS users_registered_24h,
  (SELECT count(DISTINCT created_by_user_id)::bigint FROM threads WHERE updated_at>=clock_timestamp()-interval '7 days') AS users_active_7d,
  (SELECT count(*)::bigint FROM user_accounts WHERE status='disabled') AS users_disabled,
  (SELECT count(*)::bigint FROM threads) AS conversations_total,
  (SELECT count(*)::bigint FROM threads WHERE created_at>=clock_timestamp()-interval '24 hours') AS conversations_created_24h,
  (SELECT count(*)::bigint FROM threads WHERE updated_at>=clock_timestamp()-interval '24 hours') AS conversations_active_24h,
  (SELECT count(*)::bigint FROM threads WHERE status='archived') AS conversations_archived,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_input_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_input_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_output_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_output_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_cache_read_tokens' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_cache_read_tokens_24h,
  (SELECT COALESCE(sum(value),0)::text FROM thread_continuity_metric_observations
    WHERE metric_name='model_generation_duration_ms' AND observed_at>=clock_timestamp()-interval '24 hours') AS model_generation_duration_ms_24h
WHERE EXISTS (
  SELECT 1 FROM platform_control_operators actor
   WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
     AND actor.status='active'
);

-- ---------------------------------------------------------------------------
-- 区段：memory_ingestion_skipped
-- ---------------------------------------------------------------------------

-- 关闭记忆的本地消费使用独立终态；Provider 成功仍必须有真实提交凭据。
ALTER TABLE memory_ingestion_outbox
  DROP CONSTRAINT memory_ingestion_outbox_state_check,
  DROP CONSTRAINT memory_ingestion_outbox_provider_shape_check,
  DROP CONSTRAINT memory_ingestion_outbox_completion_shape_check,
  ADD CONSTRAINT memory_ingestion_outbox_state_check CHECK (
    state IN ('pending', 'claimed', 'submitted', 'succeeded', 'failed', 'skipped')
  ),
  ADD CONSTRAINT memory_ingestion_outbox_provider_shape_check CHECK (
    (state = 'pending' AND provider_event_id IS NULL AND submitted_at IS NULL)
    OR (state = 'claimed')
    OR (state IN ('submitted', 'succeeded') AND provider_event_id IS NOT NULL
      AND submitted_at IS NOT NULL)
    OR (state = 'failed')
    OR (state = 'skipped' AND (
      (provider_event_id IS NULL AND submitted_at IS NULL)
      OR (provider_event_id IS NOT NULL AND submitted_at IS NOT NULL)
    ))
  ),
  ADD CONSTRAINT memory_ingestion_outbox_completion_shape_check CHECK (
    (state IN ('succeeded', 'failed', 'skipped')) = (completed_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 区段：skill_direct_publication
-- ---------------------------------------------------------------------------

ALTER TABLE skill_publication_submissions
  DROP CONSTRAINT skill_publication_review_shape_check,
  ADD CONSTRAINT skill_publication_review_shape_check CHECK (
    (status IN ('draft','submitted') AND reviewed_by IS NULL AND rejection_reason IS NULL)
    OR (status='rejected' AND reviewed_by IS NOT NULL AND rejection_reason IS NOT NULL)
    OR (status='approved' AND reviewed_by IS NOT NULL AND rejection_reason IS NULL)
    OR (status IN ('published','revoked') AND rejection_reason IS NULL)
  );

-- ---------------------------------------------------------------------------
-- 区段：run_compaction_settings_snapshots
-- ---------------------------------------------------------------------------

CREATE TABLE run_compaction_settings_snapshots (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  soft_limit_percent integer NOT NULL CHECK (soft_limit_percent BETWEEN 1 AND 99),
  target_percent integer NOT NULL CHECK (target_percent >= 1 AND target_percent < soft_limit_percent),
  recent_user_tokens integer NOT NULL CHECK (recent_user_tokens BETWEEN 1 AND 10000000),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 10000000),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1 AND 600000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE run_compaction_settings_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_compaction_settings_snapshots FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY run_compaction_settings_migrator_policy ON run_compaction_settings_snapshots FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE format(
    'CREATE POLICY run_compaction_settings_runtime_policy ON run_compaction_settings_snapshots FOR ALL TO %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),''''))',
    current_setting('app.runtime_role')
  );
END $$;

-- ---------------------------------------------------------------------------
-- 区段：managed_memory_configuration
-- ---------------------------------------------------------------------------

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
        'workerMaxConcurrentRuns','userMaxConcurrentRunsPerTenant',
        'compactionSoftLimitPercent','compactionTargetPercent','compactionRecentUserTokens',
        'compactionMaxOutputTokens','compactionTimeoutMs'
      ]='{}'::jsonb
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

ALTER TABLE run_runtime_config_snapshots
  ALTER COLUMN model_object_key DROP NOT NULL,
  ALTER COLUMN model_revision DROP NOT NULL,
  DROP CONSTRAINT run_runtime_config_snapshots_generation_check,
  ADD CONSTRAINT run_runtime_config_snapshots_generation_check CHECK (generation BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT run_runtime_config_model_shape CHECK ((model_object_key IS NULL)=(model_revision IS NULL));

-- ---------------------------------------------------------------------------
-- 区段：tencent_ags_provider
-- ---------------------------------------------------------------------------

-- 腾讯云 AGS 独立持久身份，保留既有 Provider 外键与唯一性边界。
ALTER TABLE sandbox_registry
  DROP CONSTRAINT sandbox_registry_provider_key_check,
  ADD CONSTRAINT sandbox_registry_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
ALTER TABLE cleanup_outbox
  DROP CONSTRAINT cleanup_outbox_provider_key_check,
  ADD CONSTRAINT cleanup_outbox_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
ALTER TABLE sandbox_lifecycle_unknown
  DROP CONSTRAINT sandbox_lifecycle_unknown_provider_key_check,
  ADD CONSTRAINT sandbox_lifecycle_unknown_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
ALTER TABLE waiting_recovery_checkpoints
  DROP CONSTRAINT waiting_recovery_checkpoints_provider_key_check,
  ADD CONSTRAINT waiting_recovery_checkpoints_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
ALTER TABLE thread_sandbox_sessions
  DROP CONSTRAINT thread_sandbox_sessions_provider_key_check,
  ADD CONSTRAINT thread_sandbox_sessions_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));
ALTER TABLE sandbox_lifecycle_effects
  DROP CONSTRAINT sandbox_lifecycle_effects_provider_key_check,
  ADD CONSTRAINT sandbox_lifecycle_effects_provider_key_check CHECK (provider_key IN ('cube','e2b','tencent-ags'));

-- ---------------------------------------------------------------------------
-- 区段：managed_sandbox_configuration
-- ---------------------------------------------------------------------------

-- 配置版本不可变，远端实例在创建前固定版本，停用新建不影响旧实例清理。
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

-- ---------------------------------------------------------------------------
-- 区段：managed_cube_proxy
-- ---------------------------------------------------------------------------

-- Cube 代理与服务地址共同构成版本化连接身份；保留已执行的 0064 原始校验和。
ALTER TABLE sandbox_provider_profiles DROP CONSTRAINT sandbox_provider_profiles_configuration_check2;
ALTER TABLE sandbox_provider_profiles ADD CONSTRAINT sandbox_provider_profiles_configuration_check2
  CHECK (configuration-ARRAY['providerKey','displayName','endpoint','credentialConfigured','policy','cubeProxy']='{}'::jsonb);
ALTER TABLE sandbox_provider_profiles ADD CONSTRAINT sandbox_provider_profiles_cube_proxy_check
  CHECK (NOT configuration ? 'cubeProxy' OR (
    provider_key='cube' AND jsonb_typeof(configuration->'cubeProxy')='object'
    AND (configuration->'cubeProxy') ?& ARRAY['host','port','scheme']
    AND (configuration->'cubeProxy')-ARRAY['host','port','scheme']='{}'::jsonb
    AND configuration->'cubeProxy'->>'scheme' IN ('http','https')
  ));

-- ---------------------------------------------------------------------------
-- 区段：runtime_ptc_dispatches
-- ---------------------------------------------------------------------------

-- 内层调用独立于 Rollout/Thread 历史；只保存开始事实和固定受控回执，不保存程序输出。
CREATE TABLE runtime_ptc_dispatches (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  base_revision_id text,
  run_claim_token text NOT NULL CHECK (run_claim_token ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  run_claim_epoch bigint NOT NULL CHECK (run_claim_epoch BETWEEN 0 AND 9007199254740991),
  workspace_lease_epoch bigint NOT NULL CHECK (workspace_lease_epoch BETWEEN 0 AND 9007199254740991),
  tool_call_id text NOT NULL CHECK (tool_call_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  parent_tool_call_id text NOT NULL CHECK (parent_tool_call_id <> tool_call_id),
  parent_sequence bigint NOT NULL,
  parent_kind text NOT NULL DEFAULT 'tool_call' CHECK (parent_kind = 'tool_call'),
  tool_name text NOT NULL CHECK (tool_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  start_idempotency_key text NOT NULL CHECK (octet_length(start_idempotency_key) BETWEEN 1 AND 512),
  start_digest text NOT NULL CHECK (start_digest ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result_idempotency_key text CHECK (octet_length(result_idempotency_key) BETWEEN 1 AND 512),
  result_digest text CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  result_body jsonb,
  is_truncated boolean,
  blob_reference_id text,
  blob_state text,
  blob_purpose text,
  blob_sha256 text,
  blob_size bigint,
  completed_at timestamptz,
  -- Provider 的调用 ID 可跨 Run/Attempt 复用；调用身份与幂等键只能在完整 stream scope 内唯一。
  PRIMARY KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, tool_call_id),
  UNIQUE (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, start_idempotency_key),
  UNIQUE (tenant_id, thread_id, run_id, attempt_id, agent_thread_id, result_idempotency_key),
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id)
    REFERENCES runtime_rollout_streams(tenant_id, thread_id, run_id, attempt_id, agent_thread_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
               parent_sequence, parent_kind, parent_tool_call_id)
    REFERENCES runtime_rollout_entries(tenant_id, thread_id, run_id, attempt_id, agent_thread_id,
                                      sequence, kind, normalized_tool_call_id)
    ON DELETE RESTRICT,
  -- 引用必须在同租户再次满足 stable/trace 身份；不能把 staged 或 resource Blob 冒充回执。
  FOREIGN KEY (tenant_id, blob_reference_id, blob_state, blob_purpose, blob_sha256, blob_size)
    REFERENCES blob_references(tenant_id, reference_id, state, purpose, sha256, size)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_ptc_dispatch_result_shape_check CHECK (
    (result_idempotency_key IS NULL AND result_digest IS NULL AND result_body IS NULL
     AND is_truncated IS NULL AND blob_reference_id IS NULL AND blob_state IS NULL
     AND blob_purpose IS NULL AND blob_sha256 IS NULL AND blob_size IS NULL AND completed_at IS NULL)
    OR
    (result_idempotency_key IS NOT NULL AND result_digest IS NOT NULL AND result_body IS NOT NULL
     AND is_truncated IS NOT NULL AND blob_reference_id IS NOT NULL
     AND blob_state IS NOT NULL AND blob_purpose IS NOT NULL AND blob_sha256 IS NOT NULL
     AND blob_size IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at
     AND blob_state='stable' AND blob_purpose='trace' AND blob_sha256 ~ '^[0-9a-f]{64}$'
     AND blob_size BETWEEN 0 AND 9007199254740991
     AND jsonb_typeof(result_body)='object' AND octet_length(result_body::text)<=16384
     AND result_body-ARRAY['schemaVersion','toolName','receiptSha256','receiptBytes','receipt','traceBlob','truncation','observation']='{}'::jsonb
     AND (result_body->>'schemaVersion'='2' AND result_body->>'toolName'=tool_name
          AND result_body->>'receiptSha256'=blob_sha256
          AND result_body->'receiptBytes'=to_jsonb(blob_size)
          AND result_body->'traceBlob'=jsonb_build_object('referenceId',blob_reference_id)
          AND jsonb_typeof(result_body->'observation')='string'
          AND result_body->'truncation'->'isTruncated'=to_jsonb(is_truncated)
          AND result_body->'truncation'->'modelVisibleBytes'=to_jsonb(octet_length(result_body->>'observation'))
          AND (result_body->'truncation')-ARRAY['isTruncated','reason','modelVisibleBytes']='{}'::jsonb
          AND result_body->'receipt'=jsonb_build_object(
            'schemaVersion',1,'trust','sandbox_untrusted','toolName',tool_name,
            'outcome',result_body->'receipt'->>'outcome',
            'message',CASE result_body->'receipt'->>'outcome'
              WHEN 'succeeded' THEN '工具调用已完成。' WHEN 'failed' THEN '工具调用未完成。' END)
          AND result_body->'receipt'->>'outcome' IN ('succeeded','failed')) IS TRUE)
  )
);
CREATE INDEX runtime_ptc_dispatches_parent_idx ON runtime_ptc_dispatches(
  tenant_id, thread_id, run_id, attempt_id, agent_thread_id, parent_tool_call_id, started_at, tool_call_id
);
ALTER TABLE runtime_ptc_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_ptc_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_ptc_dispatches_tenant_policy ON runtime_ptc_dispatches
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- ---------------------------------------------------------------------------
-- 区段：runtime_tool_calling_mode_configuration
-- ---------------------------------------------------------------------------

-- 仅扩展运行设置的可选模式字段；旧 Revision 缺字段继续兼容，模型与记忆配置约束保持不变。
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

-- ---------------------------------------------------------------------------
-- 区段：runtime_tool_selection_configuration
-- ---------------------------------------------------------------------------

-- CHECK 不允许子查询；CASE 在展开数组前拒绝非数组与 SQL NULL，避免约束因 NULL 放行。
CREATE FUNCTION runtime_tool_selection_is_valid(enabled_tools jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(enabled_tools)='array' THEN (
      SELECT count(*) <= 14
        AND count(*)=count(DISTINCT tool)
        AND COALESCE(bool_and(
          CASE WHEN jsonb_typeof(tool)='string' THEN
            tool #>> '{}' IN (
              'exec_command','read','edit','write','skill','todo_write','deliver_file',
              'automation_update','spawn_agent','send_message','followup_task','wait_agent',
              'interrupt_agent','list_agents'
            )
          ELSE FALSE END
        ), TRUE)
      FROM jsonb_array_elements(enabled_tools) AS selected(tool)
    )
    ELSE FALSE
  END;
$$;

-- 缺省保留旧行为，显式空数组关闭全部工具；只扩展可选字段，不改写历史 Revision。
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
        OR runtime_tool_selection_is_valid(configuration->'enabledTools')
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

-- ---------------------------------------------------------------------------
-- 区段：runtime_tool_selection_inline_constraint
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 区段：better_auth_provider_account_key
-- ---------------------------------------------------------------------------

-- Better Auth 1.7.3 起按 Provider 与账号标识定位身份，旧 issuer 保留为历史数据。
-- 相同账号键不能被自动合并；冲突时整批迁移回滚，且错误不暴露身份值。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM better_auth_accounts
    GROUP BY provider_id,account_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Better Auth Provider 账号键冲突，禁止自动合并身份';
  END IF;
END $$;

ALTER TABLE better_auth_accounts ALTER COLUMN issuer DROP NOT NULL;
ALTER TABLE better_auth_accounts DROP CONSTRAINT better_auth_accounts_issuer_account_id_key;
ALTER TABLE better_auth_accounts
  ADD CONSTRAINT better_auth_accounts_provider_id_account_id_key UNIQUE (provider_id,account_id);

-- ---------------------------------------------------------------------------
-- 区段：installation_administrator
-- ---------------------------------------------------------------------------

CREATE TABLE installation_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  administrator_user_id text REFERENCES app_users(id) ON DELETE RESTRICT,
  initialized_at timestamptz,
  CHECK ((administrator_user_id IS NULL) = (initialized_at IS NULL))
);
-- 已存在的管理面授权会关闭首次初始化，禁用管理员也不能重新开放安装入口。
INSERT INTO installation_state(singleton,administrator_user_id,initialized_at)
SELECT true,user_id,clock_timestamp() FROM platform_control_operators
WHERE role='admin' ORDER BY created_at LIMIT 1;
INSERT INTO installation_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE installation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE installation_state FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  runtime_role text := current_setting('app.runtime_role');
  migrator_role text := current_user;
BEGIN
  EXECUTE format('CREATE POLICY installation_state_migrator_policy ON installation_state TO %I USING (true) WITH CHECK (true)',migrator_role);
  EXECUTE format('CREATE POLICY installation_state_read_policy ON installation_state FOR SELECT TO %I USING (true)',runtime_role);
  EXECUTE format('CREATE POLICY installation_state_initialize_policy ON installation_state FOR UPDATE TO %I USING (administrator_user_id IS NULL) WITH CHECK (administrator_user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND initialized_at IS NOT NULL)',runtime_role);
  EXECUTE format('CREATE POLICY platform_control_operators_runtime_read_policy ON platform_control_operators FOR SELECT TO %I USING (user_id=NULLIF(current_setting(''app.user_id'',true),''''))',runtime_role);
  EXECUTE format('CREATE POLICY platform_control_operators_initialize_policy ON platform_control_operators FOR INSERT TO %I WITH CHECK (role=''admin'' AND status=''active'' AND user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS(SELECT 1 FROM installation_state WHERE administrator_user_id=user_id))',runtime_role);
END $$;

-- ---------------------------------------------------------------------------
-- 区段：installation_status
-- ---------------------------------------------------------------------------

-- 只公开聚合布尔值，兼容迁移后由运维 SQL 授权的管理员，不暴露其他用户身份。
CREATE VIEW installation_status WITH (security_barrier=true) AS
SELECT administrator_user_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM platform_control_operators WHERE role='admin')
    OR EXISTS(SELECT 1 FROM platform_skill_operators WHERE role='admin') AS initialized
FROM installation_state WHERE singleton=true;
DO $$ BEGIN
  EXECUTE format('GRANT SELECT ON installation_status TO %I',current_setting('app.runtime_role'));
END $$;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY platform_skill_operators_runtime_read_policy ON platform_skill_operators FOR SELECT TO %I USING (user_id=NULLIF(current_setting(''app.user_id'',true),''''))',current_setting('app.runtime_role'));
  EXECUTE format('CREATE POLICY platform_skill_operators_initialize_policy ON platform_skill_operators FOR INSERT TO %I WITH CHECK (role=''admin'' AND status=''active'' AND user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND EXISTS(SELECT 1 FROM installation_state WHERE administrator_user_id=user_id))',current_setting('app.runtime_role'));
END $$;

-- ---------------------------------------------------------------------------
-- 区段：post_deployment_runtime_configuration
-- ---------------------------------------------------------------------------

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
