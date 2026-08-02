-- 当前 user turn 的附件只持久化不可变 Resource/Version 身份；图片字节仍留在 BlobStore。
-- JSON 使用 resourceId -> versionId -> ordinal 的规范映射：对象键天然排除重复身份，ordinal 保留用户顺序。
-- 只使用 PostgreSQL 内建 immutable JSONPath，避免在首版空 routine manifest 中引入可执行数据库代码。
ALTER TABLE thread_input_receipts
  ADD COLUMN input_attachments jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT thread_input_receipts_attachments_check
    CHECK (
      jsonb_typeof(input_attachments) = 'object'
      AND jsonb_array_length(jsonb_path_query_array(input_attachments, '$.*.*')) <= 20
      AND NOT jsonb_path_exists(
        input_attachments,
        '$.* ? (@.type() != "object")'
      )
      AND NOT jsonb_path_exists(
        input_attachments,
        '$.keyvalue() ? (!(@.key like_regex "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"))'
      )
      AND NOT jsonb_path_exists(
        input_attachments,
        '$.*.keyvalue() ? (!(@.key like_regex "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"))'
      )
      AND NOT jsonb_path_exists(
        input_attachments,
        '$.keyvalue() ? (!exists(@.value.*))'
      )
      AND NOT jsonb_path_exists(
        input_attachments,
        '$.*.* ? (!(@.type() == "number" && @ >= 0 && @ < 20 && @.floor() == @))'
      )
    );
