-- 模型阶段只记录不可下载意图；RuntimeMutation 提交最终 Revision 时才建立
-- ResourceVersion、Artifact 与 settlement 的完整事实链。
ALTER TABLE blob_references
  ADD CONSTRAINT blob_references_lifecycle_identity_fk FOREIGN KEY (
    tenant_id,lifecycle_id,purpose,sha256,size
  ) REFERENCES blob_lifecycles(
    tenant_id,lifecycle_id,purpose,sha256,size
  ) ON DELETE RESTRICT;

ALTER TABLE workspace_revision_files
  ADD CONSTRAINT workspace_revision_files_artifact_source_key UNIQUE (
    tenant_id,workspace_id,revision_id,relative_path,content_sha256,size,
    blob_lifecycle_id,blob_incarnation_id,physical_object_key
  );

-- Workspace stable 对象的 purpose 是对象键身份的一部分，不能把同一物理键伪装成
-- resource purpose。ResourceVersion/Artifact 只在完整反向绑定 Revision file 时允许
-- 保存 workspace purpose；普通 Resource 来源仍保持 resource-only。
ALTER TABLE resource_versions
  DROP CONSTRAINT resource_versions_blob_purpose_check,
  ADD COLUMN source_workspace_id text,
  ADD COLUMN source_workspace_revision_id text,
  ADD COLUMN source_relative_path text,
  ADD CONSTRAINT resource_version_blob_source_shape CHECK (
    (blob_purpose='resource' AND source_workspace_id IS NULL
      AND source_workspace_revision_id IS NULL AND source_relative_path IS NULL)
    OR (blob_purpose='workspace' AND source_workspace_id IS NOT NULL
      AND source_workspace_revision_id IS NOT NULL AND source_relative_path IS NOT NULL)
  ),
  ADD CONSTRAINT resource_version_workspace_source_fk FOREIGN KEY (
    tenant_id,source_workspace_id,source_workspace_revision_id,source_relative_path,
    digest,size,blob_lifecycle_id,blob_incarnation_id,physical_object_key
  ) REFERENCES workspace_revision_files(
    tenant_id,workspace_id,revision_id,relative_path,content_sha256,size,
    blob_lifecycle_id,blob_incarnation_id,physical_object_key
  ) ON DELETE RESTRICT;

ALTER TABLE artifact_publications
  DROP CONSTRAINT artifact_publications_blob_purpose_check,
  ADD COLUMN source_workspace_id text,
  ADD COLUMN workspace_revision_id text,
  ADD COLUMN source_relative_path text,
  ADD CONSTRAINT artifact_publication_workspace_source_shape CHECK (
    (blob_purpose='resource' AND source_workspace_id IS NULL
      AND workspace_revision_id IS NULL AND source_relative_path IS NULL)
    OR (blob_purpose='workspace' AND source_workspace_id IS NOT NULL
      AND workspace_revision_id IS NOT NULL AND source_relative_path IS NOT NULL)
  ),
  ADD CONSTRAINT artifact_publication_workspace_source_fk FOREIGN KEY (
    tenant_id,source_workspace_id,workspace_revision_id,source_relative_path,digest,size,
    blob_lifecycle_id,blob_incarnation_id,physical_object_key
  ) REFERENCES workspace_revision_files(
    tenant_id,workspace_id,revision_id,relative_path,content_sha256,size,
    blob_lifecycle_id,blob_incarnation_id,physical_object_key
  ) ON DELETE RESTRICT;

CREATE TABLE workspace_artifact_publication_intents (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  call_id text NOT NULL CHECK (octet_length(call_id) BETWEEN 1 AND 256),
  permit_id text NOT NULL CHECK (octet_length(permit_id) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  tool_args_digest text NOT NULL CHECK (tool_args_digest ~ '^[0-9a-f]{64}$'),
  requested_artifact_id text NOT NULL,
  artifact_id text NOT NULL,
  resource_id text NOT NULL,
  resource_version_id text NOT NULL,
  blob_reference_id text NOT NULL,
  blob_operation_id text NOT NULL CHECK (
    blob_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ),
  replaces_artifact_id text,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  purpose text NOT NULL CHECK (purpose IN ('deliverable','diagnostic','trace')),
  deliverable_key text,
  normalized_deliverable_key text GENERATED ALWAYS AS (coalesce(deliverable_key,'')) STORED,
  source_relative_path text NOT NULL CHECK (
    length(source_relative_path) BETWEEN 1 AND 4096
    AND source_relative_path !~ '(^/|\\|(^|/)\.\.?(/|$)|[[:cntrl:]])'
  ),
  resource_name text NOT NULL CHECK (octet_length(resource_name) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,attempt_id,idempotency_key),
  UNIQUE (tenant_id,attempt_id,call_id),
  UNIQUE (tenant_id,attempt_id,requested_artifact_id),
  UNIQUE (tenant_id,artifact_id),
  UNIQUE (tenant_id,resource_id),
  UNIQUE (tenant_id,resource_version_id),
  UNIQUE (tenant_id,blob_reference_id),
  UNIQUE (tenant_id,blob_operation_id),
  FOREIGN KEY (tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id)
    REFERENCES execution_attempts(
      tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,deliverable_key)
    REFERENCES artifact_deliverable_declarations(tenant_id,run_id,deliverable_key)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,replaces_artifact_id)
    REFERENCES artifact_publications(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT workspace_artifact_intent_deliverable_shape CHECK (
    (purpose='deliverable' AND deliverable_key IS NOT NULL)
    OR (purpose<>'deliverable' AND deliverable_key IS NULL)
  )
);

ALTER TABLE workspace_artifact_publication_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_artifact_publication_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_artifact_publication_intents_tenant_policy
  ON workspace_artifact_publication_intents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE ALL ON workspace_artifact_publication_intents FROM PUBLIC;
