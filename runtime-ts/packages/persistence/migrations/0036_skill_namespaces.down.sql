DROP POLICY skill_namespaces_publisher_policy ON skill_namespaces;
DROP POLICY skill_namespace_publishers_publisher_policy ON skill_namespace_publishers;
DROP POLICY skill_namespace_audits_publisher_policy ON skill_namespace_audits;
DROP POLICY skill_publication_submissions_reviewer_read_policy ON skill_publication_submissions;
DROP POLICY skill_publication_submissions_reviewer_update_policy ON skill_publication_submissions;
DROP POLICY skill_publication_files_reviewer_read_policy ON skill_publication_files;
DROP POLICY skill_publication_audits_reviewer_read_policy ON skill_publication_audits;

DROP POLICY skill_publication_submissions_publisher_policy ON skill_publication_submissions;
CREATE POLICY skill_publication_submissions_publisher_policy ON skill_publication_submissions FOR ALL
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active'))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active'));
DROP POLICY skill_publication_files_publisher_policy ON skill_publication_files;
CREATE POLICY skill_publication_files_publisher_policy ON skill_publication_files FOR ALL
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active'))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active'));
DROP POLICY skill_publication_commands_publisher_policy ON skill_publication_commands;
CREATE POLICY skill_publication_commands_publisher_policy ON skill_publication_commands FOR ALL
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active'))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active'));
DROP POLICY skill_publication_audits_publisher_policy ON skill_publication_audits;
CREATE POLICY skill_publication_audits_publisher_policy ON skill_publication_audits FOR ALL
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active'))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active'));
DROP POLICY skills_admin_publisher_policy ON skills;
DROP POLICY skills_agent_admin_read_policy ON skills;
CREATE POLICY skills_admin_publisher_policy ON skills FOR ALL
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active' AND operator.role='admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active' AND operator.role='admin'));
DROP POLICY skill_versions_admin_publisher_policy ON skill_versions;
DROP POLICY skill_versions_agent_admin_read_policy ON skill_versions;
CREATE POLICY skill_versions_admin_publisher_policy ON skill_versions FOR ALL
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active' AND operator.role='admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active' AND operator.role='admin'));
DROP POLICY skill_version_files_admin_publisher_policy ON skill_version_files;
DROP POLICY skill_version_files_agent_admin_read_policy ON skill_version_files;
CREATE POLICY skill_version_files_admin_publisher_policy ON skill_version_files FOR ALL
  USING (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active' AND operator.role='admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_skill_operators operator WHERE operator.user_id=NULLIF(current_setting('app.user_id',true),'') AND operator.status='active' AND operator.role='admin'));

ALTER TABLE skill_publication_audits DROP COLUMN namespace, DROP COLUMN skill_version;
ALTER POLICY skills_authenticated_read_policy ON skills TO PUBLIC;
ALTER POLICY skill_versions_authenticated_read_policy ON skill_versions TO PUBLIC;
ALTER POLICY skill_version_files_authenticated_read_policy ON skill_version_files TO PUBLIC;
DROP TABLE skill_namespace_audits;
DROP TABLE skill_namespace_publishers;
DROP TABLE skill_namespaces;
