-- 回退只恢复旧约束且不校验存量行：已写入的 schemaVersion 3 内联回执保留，新写入恢复为
-- 必须引用 stable trace Blob。
ALTER TABLE runtime_ptc_dispatches DROP CONSTRAINT runtime_ptc_dispatch_result_shape_check;
ALTER TABLE runtime_ptc_dispatches ADD CONSTRAINT runtime_ptc_dispatch_result_shape_check CHECK (

    (result_idempotency_key IS NULL AND result_digest IS NULL AND result_body IS NULL
     AND is_truncated IS NULL AND blob_reference_id IS NULL AND blob_state IS NULL
     AND blob_purpose IS NULL AND blob_sha256 IS NULL AND blob_size IS NULL AND completed_at IS NULL)
    OR
    (result_idempotency_key IS NOT NULL AND result_digest IS NOT NULL AND result_body IS NOT NULL
     AND is_truncated IS NOT NULL AND blob_reference_id IS NOT NULL
     AND blob_state IS NOT NULL AND blob_purpose IS NOT NULL AND blob_sha256 IS NOT NULL
     AND blob_size IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at
     AND blob_state='stable' AND blob_purpose='trace' AND blob_sha256 ~ '^[0-9a-f]{64}$'
     AND blob_size BETWEEN 0 AND 9007199254740991
     AND jsonb_typeof(result_body)='object' AND octet_length(result_body::text)<=16384
     AND result_body-ARRAY['schemaVersion','toolName','receiptSha256','receiptBytes','receipt','traceBlob','truncation','observation']='{}'::jsonb
     AND (result_body->>'schemaVersion'='2' AND result_body->>'toolName'=tool_name
          AND result_body->>'receiptSha256'=blob_sha256
          AND result_body->'receiptBytes'=to_jsonb(blob_size)
          AND result_body->'traceBlob'=jsonb_build_object('referenceId',blob_reference_id)
          AND jsonb_typeof(result_body->'observation')='string'
          AND result_body->'truncation'->'isTruncated'=to_jsonb(is_truncated)
          AND result_body->'truncation'->'modelVisibleBytes'=to_jsonb(octet_length(result_body->>'observation'))
          AND (result_body->'truncation')-ARRAY['isTruncated','reason','modelVisibleBytes']='{}'::jsonb
          AND result_body->'receipt'=jsonb_build_object(
            'schemaVersion',1,'trust','sandbox_untrusted','toolName',tool_name,
            'outcome',result_body->'receipt'->>'outcome',
            'message',CASE result_body->'receipt'->>'outcome'
              WHEN 'succeeded' THEN '工具调用已完成。' WHEN 'failed' THEN '工具调用未完成。' END)
          AND result_body->'receipt'->>'outcome' IN ('succeeded','failed')) IS TRUE)
) NOT VALID;
