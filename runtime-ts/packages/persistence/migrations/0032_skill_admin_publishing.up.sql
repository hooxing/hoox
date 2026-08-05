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
