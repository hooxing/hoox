DROP POLICY threads_update_policy ON threads;
DROP POLICY threads_insert_policy ON threads;
DROP POLICY threads_read_policy ON threads;
CREATE POLICY threads_isolation_policy ON threads
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE threads DROP CONSTRAINT threads_agent_definition_fk;
ALTER TABLE threads DROP COLUMN agent_definition_id;
ALTER TABLE agent_definitions DROP CONSTRAINT agent_definitions_current_revision_fk;
DROP TABLE agent_revision_revocations;
DROP POLICY agent_definitions_runtime_read ON agent_definitions;
DROP POLICY agent_revisions_runtime_read ON agent_revisions;
DROP TABLE agent_definition_audits;
DROP TABLE agent_definition_commands;
DROP TABLE agent_revisions;
DROP TABLE agent_definition_tenants;
DROP TABLE agent_definitions;
