ALTER TABLE external_tool_versions
  ADD COLUMN http_method text CHECK (http_method IS NULL OR http_method IN ('GET','POST'));

ALTER TABLE external_tool_versions
  ADD CONSTRAINT external_tool_versions_http_method_source_check
  CHECK (source = 'http' OR http_method IS NULL);

ALTER TABLE external_effect_permits ADD COLUMN tool_version_id text,
  ADD CONSTRAINT external_permit_version_binding CHECK (
    (tool_version_id IS NOT NULL) = (effect='tool_execution' AND tool_name ~ '^(mcp|http)__')
  ) NOT VALID;

-- 仅 Worker 专用连接可见。会话传入的是栅栏证明，不是授权事实；不投影可复用的 claim token。
CREATE VIEW worker_run_external_tool_snapshots WITH (security_barrier = true) AS
SELECT snapshot.tenant_id,snapshot.run_id,attempt.thread_id,attempt.workspace_id,attempt.root_run_id,
       attempt.base_revision_id,version.tool_version_id,version.source,version.endpoint,
       version.model_tool_name,version.remote_tool_name,version.description,version.input_schema,
       version.input_schema_digest,version.timeout_ms,version.max_response_bytes,version.side_effect,
       version.idempotent,version.credential_ref,version.credential_configured,version.http_method,
       revoked.tool_version_id IS NOT NULL AS revoked,
       credential.cipher_version,credential.nonce,credential.ciphertext,credential.auth_tag
  FROM run_agent_snapshots snapshot
  JOIN runs r ON r.tenant_id=snapshot.tenant_id AND r.id=snapshot.run_id AND r.status='running'
  JOIN execution_attempts attempt ON attempt.tenant_id=r.tenant_id AND attempt.run_id=r.id
   AND attempt.thread_id=snapshot.thread_id AND attempt.status IN ('claimed','running','finalizing')
  JOIN run_claims claim ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
   AND claim.claim_token=current_setting('app.external_claim_token',true)
   AND claim.claim_epoch::text=current_setting('app.external_claim_epoch',true)
   AND claim.released_at IS NULL AND claim.expires_at>clock_timestamp()
  JOIN execution_workspace_fences fence ON fence.tenant_id=attempt.tenant_id AND fence.attempt_id=attempt.attempt_id
   AND fence.lease_epoch=claim.workspace_lease_epoch
  JOIN workspace_write_leases lease ON lease.tenant_id=attempt.tenant_id AND lease.workspace_id=attempt.workspace_id
   AND lease.root_run_id=attempt.root_run_id AND lease.epoch=fence.lease_epoch
   AND lease.epoch::text=current_setting('app.external_lease_epoch',true) AND lease.expires_at>clock_timestamp()
  LEFT JOIN thread_follow_up_queue queue ON queue.tenant_id=r.tenant_id AND queue.thread_id=attempt.thread_id AND queue.run_id=r.id
  LEFT JOIN thread_execution_heads head ON head.tenant_id=r.tenant_id AND head.thread_id=attempt.thread_id
  CROSS JOIN LATERAL jsonb_array_elements(snapshot.content #> '{tools,externalTools}') AS authorized(item)
  JOIN external_tool_versions version ON version.tool_version_id=authorized.item->>'versionId' AND version.source=authorized.item->>'kind'
  LEFT JOIN external_tool_revocations revoked ON revoked.tool_version_id=version.tool_version_id
  LEFT JOIN external_tool_credentials credential ON credential.tool_version_id=version.tool_version_id AND revoked.tool_version_id IS NULL
 WHERE snapshot.tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
   AND (queue.run_id IS NULL OR (queue.state='active' AND queue.claim_owner=claim.worker_id AND queue.claim_token=claim.claim_token
     AND queue.claim_epoch=claim.claim_epoch AND queue.claim_expires_at>clock_timestamp() AND head.active_run_id=r.id
     AND head.writer_owner=claim.worker_id AND head.writer_token=claim.claim_token AND head.writer_epoch=claim.claim_epoch
     AND head.writer_expires_at>clock_timestamp()));

-- 许可消费只可见版本标识、工具名和撤销位。行锁与撤销 INSERT 的外键 KEY SHARE 互斥，直到事务结束。
CREATE VIEW runtime_external_tool_permit_gate WITH (security_barrier=true) AS
SELECT snapshot.tenant_id,snapshot.run_id,version.tool_version_id,version.model_tool_name,
       EXISTS(SELECT 1 FROM external_tool_revocations revoked WHERE revoked.tool_version_id=version.tool_version_id) AS revoked
  FROM run_agent_snapshots snapshot
  CROSS JOIN LATERAL jsonb_array_elements(snapshot.content #> '{tools,externalTools}') AS authorized(item)
  JOIN external_tool_versions version ON version.tool_version_id=authorized.item->>'versionId' AND version.source=authorized.item->>'kind'
 WHERE snapshot.tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
 FOR UPDATE OF version;

DO $$
BEGIN
  EXECUTE format('GRANT SELECT ON worker_run_external_tool_snapshots TO %I', current_setting('app.worker_coordinator_role'));
  EXECUTE format('GRANT SELECT ON runtime_external_tool_permit_gate TO %I', current_setting('app.runtime_role'));
END $$;

ALTER TABLE runtime_subagent_conversations
  ADD COLUMN external_tool_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(external_tool_version_ids) = 'array' AND jsonb_array_length(external_tool_version_ids) <= 64);
