DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_skill_operators)
     OR EXISTS (SELECT 1 FROM skill_publication_submissions)
     OR EXISTS (SELECT 1 FROM skill_publication_files)
     OR EXISTS (SELECT 1 FROM skill_publication_commands)
     OR EXISTS (SELECT 1 FROM skill_publication_audits) THEN
    RAISE EXCEPTION 'Skill 管理发布事实非空，拒绝破坏性回滚';
  END IF;
END
$$;

DO $$
DECLARE
  publisher_role text := NULLIF(current_setting('app.skill_publisher_role', true), '');
BEGIN
  IF publisher_role IS NULL OR publisher_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'Skill Publisher 数据库角色配置无效';
  END IF;
  EXECUTE format('REVOKE ALL PRIVILEGES ON platform_skill_operators,skill_publication_submissions,skill_publication_files,skill_publication_commands,skill_publication_audits,skills,skill_versions,skill_version_files FROM %I', publisher_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I', current_schema(), publisher_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', current_schema(), publisher_role);
END
$$;

DROP POLICY IF EXISTS skills_admin_publisher_policy ON skills;
DROP POLICY IF EXISTS skill_versions_admin_publisher_policy ON skill_versions;
DROP POLICY IF EXISTS skill_version_files_admin_publisher_policy ON skill_version_files;

DROP TABLE skill_publication_audits;
DROP TABLE skill_publication_commands;
DROP TABLE skill_publication_files;
DROP TABLE skill_publication_submissions;
DROP TABLE platform_skill_operators;
