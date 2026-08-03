DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_skill_installations LIMIT 1)
     OR EXISTS (SELECT 1 FROM user_skill_installation_audits LIMIT 1)
     OR EXISTS (SELECT 1 FROM user_skill_installation_commands LIMIT 1) THEN
    RAISE EXCEPTION 'Skill 安装或审计事实非空，拒绝破坏性回滚';
  END IF;
END
$$;

DROP TABLE user_skill_installation_audits;
DROP TABLE user_skill_installation_commands;
DROP TABLE user_skill_installations;
DROP TABLE skill_version_files;
ALTER TABLE skills DROP CONSTRAINT skills_recommended_version_fk;
DROP TABLE skill_versions;
DROP TABLE skills;
