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
