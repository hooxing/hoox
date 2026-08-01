-- ADR-0063：显式记录每个 V2 Run 的 Workspace base/result 关系，不复制文件树。
ALTER TABLE run_execution_inputs ADD CONSTRAINT run_execution_inputs_result_scope_unique
  UNIQUE (tenant_id, run_id, thread_id, workspace_id);

CREATE TABLE run_workspace_results (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  workspace_id text NOT NULL,
  base_revision_id text,
  result_revision_id text,
  outcome text NOT NULL CHECK (outcome IN ('committed', 'unchanged', 'failed_before_commit')),
  manifest_digest text CHECK (manifest_digest IS NULL OR manifest_digest ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, run_id, thread_id, workspace_id),
  FOREIGN KEY (tenant_id, run_id, thread_id, workspace_id)
    REFERENCES run_execution_inputs(tenant_id, run_id, thread_id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, base_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, result_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT run_workspace_result_shape_check CHECK (
    (outcome = 'committed' AND result_revision_id IS NOT NULL
      AND result_revision_id IS DISTINCT FROM base_revision_id
      AND manifest_digest IS NOT NULL AND committed_at IS NOT NULL)
    OR (outcome = 'unchanged' AND result_revision_id IS NOT DISTINCT FROM base_revision_id
      AND committed_at IS NOT NULL)
    OR (outcome = 'failed_before_commit' AND result_revision_id IS NULL
      AND manifest_digest IS NULL AND committed_at IS NULL)
  )
);

ALTER TABLE run_workspace_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_workspace_results FORCE ROW LEVEL SECURITY;
CREATE POLICY run_workspace_results_tenant_policy ON run_workspace_results
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
