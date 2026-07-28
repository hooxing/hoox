CREATE TABLE runtime_recovery_metrics (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  metric_id uuid NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  registry_id text NOT NULL,
  reason text NOT NULL,
  cleanup_outcome text NOT NULL CHECK (cleanup_outcome IN ('settled', 'unknown', 'failed')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, metric_id),
  FOREIGN KEY (tenant_id, run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, thread_id)
    REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT
);

ALTER TABLE runtime_recovery_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_recovery_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_recovery_metrics_isolation_policy ON runtime_recovery_metrics
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

REVOKE ALL ON runtime_recovery_metrics FROM PUBLIC;
