DROP POLICY agent_control_read ON agent_revision_revocations;
DROP POLICY agent_control_read ON agent_revisions;
DROP POLICY agent_control_read ON agent_definition_tenants;
DROP POLICY agent_control_read ON agent_definitions;

DROP POLICY agent_control_manage ON agent_definition_tenants;
ALTER POLICY agent_definitions_admin_manage ON agent_definitions TO PUBLIC;
ALTER POLICY agent_revisions_admin_manage ON agent_revisions TO PUBLIC;
ALTER POLICY agent_revision_revocations_admin ON agent_revision_revocations TO PUBLIC;
ALTER POLICY agent_commands_admin ON agent_definition_commands TO PUBLIC;
ALTER POLICY agent_audits_admin ON agent_definition_audits TO PUBLIC;
ALTER POLICY agent_definition_tenants_policy ON agent_definition_tenants
  USING ((tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND available) OR EXISTS (
    SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND o.status='active' AND o.role IN ('operator','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'')
    AND o.status='active' AND o.role IN ('operator','admin')));

-- 保留已存在的范围变更审计，只限制回退后的新记录。
ALTER TABLE agent_definition_audits DROP CONSTRAINT agent_definition_audits_action_check;
ALTER TABLE agent_definition_audits ADD CONSTRAINT agent_definition_audits_action_check
  CHECK (action IN ('created','published','disabled','revoked')) NOT VALID;
