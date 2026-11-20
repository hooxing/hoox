ALTER TABLE external_tool_versions
  ADD COLUMN remote_tool_name text;

-- 历史版本无法安全反推出原始名称；NOT VALID 允许保留它们，运行时缺名时必须失败关闭。
ALTER TABLE external_tool_versions
  ADD CONSTRAINT external_tool_versions_remote_name_source_check
  CHECK (
    (source = 'mcp' AND remote_tool_name IS NOT NULL AND octet_length(remote_tool_name) BETWEEN 1 AND 512)
    OR (source = 'http' AND remote_tool_name IS NULL)
  ) NOT VALID;
