CREATE TABLE skill_namespaces (
  namespace text PRIMARY KEY CHECK (namespace ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  created_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE skill_namespace_publishers (
  namespace text NOT NULL REFERENCES skill_namespaces(namespace) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  granted_by text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_by text REFERENCES app_users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  PRIMARY KEY (namespace, user_id),
  CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);

CREATE TABLE skill_namespace_audits (
  event_id text PRIMARY KEY,
  namespace text NOT NULL REFERENCES skill_namespaces(namespace) ON DELETE RESTRICT,
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  subject_user_id text REFERENCES app_users(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('create','grant','revoke')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE skill_namespace_publishers ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_namespace_publishers FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_namespaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_namespaces FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_namespace_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_namespace_audits FORCE ROW LEVEL SECURITY;

CREATE POLICY skill_namespaces_migrator_policy ON skill_namespaces FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY skill_namespace_publishers_migrator_policy ON skill_namespace_publishers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY skill_namespace_audits_migrator_policy ON skill_namespace_audits FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY skill_namespace_publishers_runtime_session_read_policy
  ON skill_namespace_publishers FOR SELECT
  USING (
    user_id=NULLIF(current_setting('app.user_id',true),'')
    AND revoked_at IS NULL
  );

CREATE POLICY skill_namespaces_publisher_policy ON skill_namespaces FOR ALL
  USING (
    EXISTS (SELECT 1 FROM platform_skill_operators operator
      WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
        AND operator.status='active' AND operator.role='admin')
    OR EXISTS (SELECT 1 FROM skill_namespace_publishers grant_row
      WHERE grant_row.namespace=skill_namespaces.namespace
        AND grant_row.user_id=NULLIF(current_setting('app.user_id',true),'')
        AND grant_row.revoked_at IS NULL)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM platform_skill_operators operator
      WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
        AND operator.status='active' AND operator.role='admin')
  );
CREATE POLICY skill_namespace_publishers_publisher_policy ON skill_namespace_publishers FOR ALL
  USING (
    user_id=NULLIF(current_setting('app.user_id',true),'')
    OR EXISTS (SELECT 1 FROM platform_skill_operators operator
      WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
        AND operator.status='active' AND operator.role='admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM platform_skill_operators operator
      WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
        AND operator.status='active' AND operator.role='admin')
  );
CREATE POLICY skill_namespace_audits_publisher_policy ON skill_namespace_audits FOR ALL
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator
    WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND operator.status='active' AND operator.role='admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_skill_operators operator
    WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND operator.status='active' AND operator.role='admin'));

DROP POLICY skill_publication_submissions_publisher_policy ON skill_publication_submissions;
CREATE POLICY skill_publication_submissions_publisher_policy ON skill_publication_submissions FOR ALL
  USING (
    EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active' AND operator.role='admin')
    OR EXISTS (
      SELECT 1 FROM skill_namespace_publishers grant_row
       WHERE position('.' in canonical_key)>0
         AND grant_row.namespace=split_part(canonical_key,'.',1)
         AND grant_row.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND grant_row.revoked_at IS NULL
    )
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active' AND operator.role='admin')
    OR (status NOT IN ('approved','rejected') AND EXISTS (
      SELECT 1 FROM skill_namespace_publishers grant_row
       WHERE position('.' in canonical_key)>0
         AND grant_row.namespace=split_part(canonical_key,'.',1)
         AND grant_row.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND grant_row.revoked_at IS NULL
    ))
  );
CREATE POLICY skill_publication_submissions_reviewer_read_policy ON skill_publication_submissions FOR SELECT
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator
    WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND operator.status='active' AND operator.role='reviewer'));
CREATE POLICY skill_publication_submissions_reviewer_update_policy ON skill_publication_submissions FOR UPDATE
  USING (
    status='submitted'
    AND EXISTS (SELECT 1 FROM platform_skill_operators operator
      WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
        AND operator.status='active' AND operator.role='reviewer')
  )
  WITH CHECK (
    status IN ('approved','rejected')
    AND reviewed_by=NULLIF(current_setting('app.user_id',true),'')
    AND published_skill_id IS NULL
    AND EXISTS (SELECT 1 FROM platform_skill_operators operator
      WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
        AND operator.status='active' AND operator.role='reviewer')
  );
DROP POLICY skill_publication_files_publisher_policy ON skill_publication_files;
CREATE POLICY skill_publication_files_publisher_policy ON skill_publication_files FOR ALL
  USING (EXISTS (SELECT 1 FROM skill_publication_submissions submission WHERE submission.submission_id=skill_publication_files.submission_id))
  WITH CHECK (EXISTS (SELECT 1 FROM skill_publication_submissions submission WHERE submission.submission_id=skill_publication_files.submission_id));
CREATE POLICY skill_publication_files_reviewer_read_policy ON skill_publication_files FOR SELECT
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator
    WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND operator.status='active' AND operator.role='reviewer'));
DROP POLICY skill_publication_commands_publisher_policy ON skill_publication_commands;
CREATE POLICY skill_publication_commands_publisher_policy ON skill_publication_commands FOR ALL
  USING (actor_user_id=NULLIF(current_setting('app.user_id',true),'') AND EXISTS (
    SELECT 1 FROM skill_publication_submissions submission
     WHERE submission.submission_id=skill_publication_commands.submission_id
  ))
  WITH CHECK (actor_user_id=NULLIF(current_setting('app.user_id',true),'') AND EXISTS (
    SELECT 1 FROM skill_publication_submissions submission
     WHERE submission.submission_id=skill_publication_commands.submission_id
  ));
DROP POLICY skill_publication_audits_publisher_policy ON skill_publication_audits;
CREATE POLICY skill_publication_audits_publisher_policy ON skill_publication_audits FOR ALL
  USING (EXISTS (SELECT 1 FROM skill_publication_submissions submission WHERE submission.submission_id=skill_publication_audits.submission_id))
  WITH CHECK (EXISTS (SELECT 1 FROM skill_publication_submissions submission WHERE submission.submission_id=skill_publication_audits.submission_id));
CREATE POLICY skill_publication_audits_reviewer_read_policy ON skill_publication_audits FOR SELECT
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator
    WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND operator.status='active' AND operator.role='reviewer'));
DROP POLICY skills_admin_publisher_policy ON skills;
CREATE POLICY skills_admin_publisher_policy ON skills FOR ALL
  USING (
    EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active' AND operator.role='admin')
    OR EXISTS (SELECT 1 FROM skill_namespace_publishers grant_row WHERE position('.' in canonical_key)>0 AND grant_row.namespace=split_part(canonical_key,'.',1) AND grant_row.user_id=NULLIF(current_setting('app.user_id',true),'') AND grant_row.revoked_at IS NULL)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active' AND operator.role='admin')
    OR EXISTS (SELECT 1 FROM skill_namespace_publishers grant_row WHERE position('.' in canonical_key)>0 AND grant_row.namespace=split_part(canonical_key,'.',1) AND grant_row.user_id=NULLIF(current_setting('app.user_id',true),'') AND grant_row.revoked_at IS NULL)
  );
CREATE POLICY skills_agent_admin_read_policy ON skills FOR SELECT
  USING (EXISTS (SELECT 1 FROM platform_control_operators actor
    WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND actor.status='active' AND actor.role IN ('operator','admin')));
DROP POLICY skill_versions_admin_publisher_policy ON skill_versions;
CREATE POLICY skill_versions_admin_publisher_policy ON skill_versions FOR ALL
  USING (EXISTS (SELECT 1 FROM skills skill WHERE skill.id=skill_versions.skill_id))
  WITH CHECK (EXISTS (SELECT 1 FROM skills skill WHERE skill.id=skill_versions.skill_id));
CREATE POLICY skill_versions_agent_admin_read_policy ON skill_versions FOR SELECT
  USING (EXISTS (SELECT 1 FROM platform_control_operators actor
    WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND actor.status='active' AND actor.role IN ('operator','admin')));
DROP POLICY skill_version_files_admin_publisher_policy ON skill_version_files;
CREATE POLICY skill_version_files_admin_publisher_policy ON skill_version_files FOR ALL
  USING (EXISTS (SELECT 1 FROM skills skill JOIN skill_versions version ON version.skill_id=skill.id WHERE version.skill_id=skill_version_files.skill_id AND version.version=skill_version_files.skill_version))
  WITH CHECK (EXISTS (SELECT 1 FROM skills skill JOIN skill_versions version ON version.skill_id=skill.id WHERE version.skill_id=skill_version_files.skill_id AND version.version=skill_version_files.skill_version));
CREATE POLICY skill_version_files_agent_admin_read_policy ON skill_version_files FOR SELECT
  USING (EXISTS (SELECT 1 FROM platform_control_operators actor
    WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND actor.status='active' AND actor.role IN ('operator','admin')));

ALTER TABLE skill_publication_audits ADD COLUMN namespace text;
ALTER TABLE skill_publication_audits ADD COLUMN skill_version text;
UPDATE skill_publication_audits audit SET namespace=CASE WHEN position('.' in submission.canonical_key)>0 THEN split_part(submission.canonical_key,'.',1) ELSE 'legacy' END, skill_version=submission.skill_version
  FROM skill_publication_submissions submission WHERE submission.submission_id=audit.submission_id;
ALTER TABLE skill_publication_audits ALTER COLUMN namespace SET NOT NULL;
ALTER TABLE skill_publication_audits ALTER COLUMN skill_version SET NOT NULL;

