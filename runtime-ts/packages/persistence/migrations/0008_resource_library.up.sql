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
