ALTER TABLE external_tool_versions
  ADD COLUMN http_method text CHECK (http_method IS NULL OR http_method IN ('GET','POST'));

ALTER TABLE external_tool_versions
  ADD CONSTRAINT external_tool_versions_http_method_source_check
  CHECK (source = 'http' OR http_method IS NULL);

-- 运行角色只能读取受当前 Run 快照引用且未撤销的版本及其密文，不授予三张底表 ACL。
CREATE VIEW runtime_run_external_tool_snapshots WITH (security_barrier = true) AS
SELECT snapshot.tenant_id,
       snapshot.run_id,
       version.tool_version_id,
       version.source,
       version.endpoint,
       version.model_tool_name,
       version.remote_tool_name,
       version.description,
       version.input_schema,
       version.input_schema_digest,
       version.timeout_ms,
       version.max_response_bytes,
       version.side_effect,
       version.idempotent,
       version.credential_ref,
       version.credential_configured,
       version.http_method,
       credential.cipher_version,
       credential.nonce,
       credential.ciphertext,
       credential.auth_tag
  FROM run_agent_snapshots snapshot
  CROSS JOIN LATERAL jsonb_array_elements(snapshot.content #> '{tools,externalTools}') AS authorized(item)
  JOIN external_tool_versions version
    ON version.tool_version_id = authorized.item->>'versionId'
   AND version.source = authorized.item->>'kind'
  LEFT JOIN external_tool_credentials credential
    ON credential.tool_version_id = version.tool_version_id
 WHERE snapshot.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
   AND snapshot.run_id = NULLIF(current_setting('app.external_tool_run_id', true), '')
   AND NOT EXISTS (
     SELECT 1 FROM external_tool_revocations revoked
      WHERE revoked.tool_version_id = version.tool_version_id
   );

DO $$
DECLARE runtime_role text := current_setting('app.runtime_role');
BEGIN
  IF runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN RAISE EXCEPTION 'app.runtime_role 无效'; END IF;
  EXECUTE format('GRANT SELECT ON runtime_run_external_tool_snapshots TO %I', runtime_role);
END $$;

ALTER TABLE runtime_subagent_conversations
  ADD COLUMN external_tool_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(external_tool_version_ids) = 'array' AND jsonb_array_length(external_tool_version_ids) <= 64);
