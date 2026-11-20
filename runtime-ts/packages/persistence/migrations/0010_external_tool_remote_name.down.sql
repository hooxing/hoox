ALTER TABLE external_tool_versions
  DROP CONSTRAINT external_tool_versions_remote_name_source_check;
ALTER TABLE external_tool_versions
  DROP COLUMN remote_tool_name;
