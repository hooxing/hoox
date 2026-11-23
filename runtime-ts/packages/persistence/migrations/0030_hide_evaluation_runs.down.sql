ALTER TABLE runs DISABLE ROW LEVEL SECURITY;
ALTER TABLE threads DISABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM runs WHERE origin='evaluation')
     OR EXISTS (SELECT 1 FROM threads WHERE is_evaluation) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='EVALUATION_SOURCE_DATA_PREVENTS_ROLLBACK';
  END IF;
END $$;

ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;

ALTER POLICY threads_read_policy ON threads
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND (NOT is_playground OR NULLIF(current_setting('app.user_id',true),'') IS NULL));
ALTER POLICY runs_read ON runs
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND (origin<>'playground' OR NULLIF(current_setting('app.user_id',true),'') IS NULL));
DROP POLICY evaluation_revision_read ON agent_revisions;
DROP POLICY evaluation_definition_read ON agent_definitions;
DROP POLICY evaluation_snapshot_create ON run_agent_snapshots;
DROP POLICY evaluation_run_create ON runs;
DROP POLICY evaluation_run_read ON runs;
DROP POLICY evaluation_run_guard ON runs;
DROP POLICY evaluation_thread_create ON threads;
DROP POLICY evaluation_thread_read ON threads;
DROP POLICY evaluation_thread_guard ON threads;
ALTER TABLE threads DROP COLUMN is_evaluation;
