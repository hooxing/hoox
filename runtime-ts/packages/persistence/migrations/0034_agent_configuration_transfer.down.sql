-- Migrator 是目标 Schema 的 owner；事务内暂时关闭 RLS，保证回退检查覆盖全部审计行。
ALTER TABLE agent_definition_audits DISABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_definition_audits WHERE action IN ('imported','exported')
  ) THEN
    RAISE EXCEPTION 'Agent 配置导入导出审计已存在，不能回退审计动作';
  END IF;
END $$;
ALTER TABLE agent_definition_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_audits FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_audits
  DROP CONSTRAINT agent_definition_audits_action_check;
ALTER TABLE agent_definition_audits
  ADD CONSTRAINT agent_definition_audits_action_check
  CHECK (action IN ('created','published','disabled','revoked','availability_changed'));
