ALTER TABLE agent_definition_audits DROP CONSTRAINT agent_definition_audits_action_check;
ALTER TABLE agent_definition_audits ADD CONSTRAINT agent_definition_audits_action_check
  CHECK (action IN ('created','published','disabled','revoked','availability_changed'));

-- 后台只读权限不扩展 Runtime 的 Tenant 视野；已撤销的 Revision 仍属于发布历史。
DO $$
DECLARE
  control_role text := current_setting('app.admin_control_role');
  table_name text;
  policy_name text;
  predicate text;
  active_actor text := $predicate$EXISTS (
    SELECT 1 FROM platform_control_operators o
    WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active'
  )$predicate$;
BEGIN
  -- 管理策略只在控制面连接生效，Runtime 的 app.user_id 不授予管理视野。
  FOR table_name, policy_name IN VALUES
    ('agent_definitions', 'agent_definitions_admin_manage'),
    ('agent_revisions', 'agent_revisions_admin_manage'),
    ('agent_revision_revocations', 'agent_revision_revocations_admin'),
    ('agent_definition_commands', 'agent_commands_admin'),
    ('agent_definition_audits', 'agent_audits_admin')
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I TO %I', policy_name, table_name, control_role);
  END LOOP;
  ALTER POLICY agent_definition_tenants_policy ON agent_definition_tenants
    USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND available)
    WITH CHECK (false);
  EXECUTE format(
    $policy$CREATE POLICY agent_control_manage ON agent_definition_tenants TO %I
      USING (EXISTS (SELECT 1 FROM platform_control_operators o
        WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')))$policy$,
    control_role
  );

  -- 范围表参与 Definition 的 Runtime 策略，不反查 Definition 以免形成 RLS 递归。
  FOR table_name, predicate IN VALUES
    ('agent_definitions', 'status<>''draft'''),
    ('agent_definition_tenants', 'true'),
    ('agent_revisions', 'status IN (''published'',''revoked'')'),
    ('agent_revision_revocations', 'true')
  LOOP
    EXECUTE format('CREATE POLICY agent_control_read ON %I FOR SELECT TO %I USING ((%s) AND %s)',
      table_name, control_role, predicate, active_actor);
  END LOOP;
END $$;
