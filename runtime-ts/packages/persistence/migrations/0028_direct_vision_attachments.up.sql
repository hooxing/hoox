-- 当前 user turn 的附件只持久化不可变 Resource/Version 身份；图片字节仍留在 BlobStore。
CREATE FUNCTION runtime_valid_user_input_attachments(attachment_list jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  attachment jsonb;
  resource_id text;
  version_id text;
  attachment_identity text;
  attachment_identities text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(attachment_list) <> 'array'
     OR jsonb_array_length(attachment_list) > 20 THEN
    RETURN false;
  END IF;
  FOR attachment IN SELECT value FROM jsonb_array_elements(attachment_list) LOOP
    resource_id := attachment->>'resourceId';
    version_id := attachment->>'versionId';
    IF jsonb_typeof(attachment) <> 'object'
       OR resource_id IS NULL OR version_id IS NULL
       OR attachment <> jsonb_build_object('resourceId', resource_id, 'versionId', version_id)
       OR resource_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
       OR version_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' THEN
      RETURN false;
    END IF;
    attachment_identity := resource_id || E'\x1f' || version_id;
    IF attachment_identity = ANY(attachment_identities) THEN
      RETURN false;
    END IF;
    attachment_identities := array_append(attachment_identities, attachment_identity);
  END LOOP;
  RETURN true;
END;
$$;

ALTER TABLE thread_input_receipts
  ADD COLUMN input_attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT thread_input_receipts_attachments_check
    CHECK (runtime_valid_user_input_attachments(input_attachments));
