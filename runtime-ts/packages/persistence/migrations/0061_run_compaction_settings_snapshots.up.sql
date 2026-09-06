CREATE TABLE run_compaction_settings_snapshots (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  soft_limit_percent integer NOT NULL CHECK (soft_limit_percent BETWEEN 1 AND 99),
  target_percent integer NOT NULL CHECK (target_percent >= 1 AND target_percent < soft_limit_percent),
  recent_user_tokens integer NOT NULL CHECK (recent_user_tokens BETWEEN 1 AND 10000000),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 10000000),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1 AND 600000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE run_compaction_settings_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_compaction_settings_snapshots FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY run_compaction_settings_migrator_policy ON run_compaction_settings_snapshots FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE format(
    'CREATE POLICY run_compaction_settings_runtime_policy ON run_compaction_settings_snapshots FOR ALL TO %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),''''))',
    current_setting('app.runtime_role')
  );
END $$;
