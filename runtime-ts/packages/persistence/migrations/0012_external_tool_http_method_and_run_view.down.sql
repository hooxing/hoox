DROP VIEW runtime_run_external_tool_snapshots;
ALTER TABLE external_tool_versions
  DROP CONSTRAINT external_tool_versions_http_method_source_check,
  DROP COLUMN http_method;
ALTER TABLE runtime_subagent_conversations DROP COLUMN external_tool_version_ids;
