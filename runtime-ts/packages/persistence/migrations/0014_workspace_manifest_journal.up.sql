-- Workspace revision 从此以逐文件 stable Blob manifest 为唯一内容事实。旧 object_key 仅保留给
-- 迁移前的兼容读取，新的 Runtime 提交必须写 NULL，不能把单一对象键伪装成 manifest。
--
-- 不能把已有 current_revision 仅改成 NULL object_key 后继续运行：旧 revision 没有逐文件
-- incarnation，任何“猜测式”转换都会把不可审计的 Blob 当成可读内容。升级前必须先由受控
-- 运维回填工具生成 manifest，或清空这些 head；本迁移明确拒绝这种半升级状态。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspaces WHERE current_revision_id IS NOT NULL) THEN
    RAISE EXCEPTION
      '0014 requires workspace manifest backfill before upgrade: existing current_revision_id found';
  END IF;
END $$;

ALTER TABLE workspace_revisions ALTER COLUMN object_key DROP NOT NULL;
ALTER TABLE workspace_revisions DROP CONSTRAINT IF EXISTS workspace_revisions_object_key_check;

CREATE TABLE workspace_revision_manifests (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  revision_id text NOT NULL,
  thread_id text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  total_bytes bigint NOT NULL CHECK (total_bytes >= 0 AND total_bytes <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, revision_id),
  FOREIGN KEY (tenant_id, workspace_id, revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, workspace_id, thread_id)
    REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT
);

CREATE TABLE workspace_revision_files (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  revision_id text NOT NULL,
  relative_path text NOT NULL CHECK (
    length(relative_path) BETWEEN 1 AND 4096
    AND relative_path !~ '(^/|\\|(^|/)\\.\\.?(/|$)|[[:cntrl:]])'
  ),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0 AND size <= 9007199254740991),
  blob_lifecycle_id uuid NOT NULL,
  blob_incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, revision_id, relative_path),
  FOREIGN KEY (tenant_id, workspace_id, revision_id)
    REFERENCES workspace_revision_manifests(tenant_id, workspace_id, revision_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, blob_lifecycle_id, blob_incarnation_id, physical_object_key)
    REFERENCES blob_incarnations(tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    ON DELETE RESTRICT
);

CREATE INDEX workspace_revision_files_blob_reachability_idx
  ON workspace_revision_files (tenant_id, blob_lifecycle_id, blob_incarnation_id);

-- Journal 把完整 identity 永久绑定到 operationKey。unknown 只能从 running 单调进入，
-- complete 后绝不允许被降级，供 Worker 崩溃后从稳定事实继续。
CREATE TABLE workspace_operation_journal (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  thread_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('materialize', 'publish')),
  operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  identity jsonb NOT NULL CHECK (jsonb_typeof(identity) = 'object'),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'retryable', 'terminal', 'unknown')),
  result jsonb,
  failure_phase text,
  failure_code text,
  unknown_fact jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, workspace_id, thread_id, kind, operation_key),
  FOREIGN KEY (tenant_id, workspace_id, thread_id)
    REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operation_journal_result_shape CHECK (
    (status = 'completed' AND result IS NOT NULL AND failure_phase IS NULL AND failure_code IS NULL)
    OR (status = 'running' AND result IS NULL AND failure_phase IS NULL AND failure_code IS NULL AND unknown_fact IS NULL)
    OR (status IN ('retryable', 'terminal') AND result IS NULL AND failure_phase IS NOT NULL AND failure_code IS NOT NULL)
    OR (status = 'unknown' AND result IS NULL AND unknown_fact IS NOT NULL)
  )
);

ALTER TABLE workspace_revision_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_revision_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_revision_manifests_isolation_policy ON workspace_revision_manifests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE workspace_revision_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_revision_files FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_revision_files_isolation_policy ON workspace_revision_files
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE workspace_operation_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_operation_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_operation_journal_isolation_policy ON workspace_operation_journal
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE ALL ON workspace_revision_manifests, workspace_revision_files, workspace_operation_journal FROM PUBLIC;
