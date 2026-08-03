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
