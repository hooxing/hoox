DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM team_member_directory LIMIT 1)
     OR EXISTS (SELECT 1 FROM thread_forks LIMIT 1)
     OR EXISTS (SELECT 1 FROM tenant_skill_installations LIMIT 1)
     OR EXISTS (SELECT 1 FROM tenant_skill_installation_commands LIMIT 1)
     OR EXISTS (SELECT 1 FROM tenant_skill_installation_audits LIMIT 1) THEN
    RAISE EXCEPTION '团队协作、分支或 Tenant Skill 事实非空，拒绝破坏性回滚';
  END IF;
END
$$;

DROP TABLE tenant_skill_installation_audits;
DROP TABLE tenant_skill_installation_commands;
DROP TABLE tenant_skill_installations;
DROP TABLE thread_forks;
DROP TABLE team_member_directory;
