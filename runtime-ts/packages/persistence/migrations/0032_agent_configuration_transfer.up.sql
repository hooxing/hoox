ALTER TABLE agent_definition_audits
  DROP CONSTRAINT agent_definition_audits_action_check;
ALTER TABLE agent_definition_audits
  ADD CONSTRAINT agent_definition_audits_action_check
  CHECK (action IN ('created','published','disabled','revoked','availability_changed','imported','exported'));
