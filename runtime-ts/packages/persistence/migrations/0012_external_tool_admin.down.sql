DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM external_tool_registration_drafts)
     OR EXISTS (SELECT 1 FROM external_tool_draft_credentials)
     OR EXISTS (SELECT 1 FROM external_tool_publish_batches)
     OR EXISTS (SELECT 1 FROM external_tool_publish_batch_versions)
     OR EXISTS (SELECT 1 FROM external_tool_admin_commands)
     OR EXISTS (SELECT 1 FROM external_tool_admin_publish_claims)
     OR EXISTS (SELECT 1 FROM external_tool_admin_audits) THEN
    RAISE EXCEPTION '拒绝回退：外部工具注册、发布或审计数据无法恢复';
  END IF;
END $$;
DROP VIEW external_tool_selectable_versions;
DROP TABLE external_tool_admin_audits, external_tool_admin_commands, external_tool_admin_publish_claims,
  external_tool_publish_batch_versions, external_tool_publish_batches,
  external_tool_draft_credentials, external_tool_registration_drafts;
