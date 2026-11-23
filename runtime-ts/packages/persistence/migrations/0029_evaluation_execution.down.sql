DROP VIEW admin_evaluation_artifact_evidence;

DROP POLICY evaluation_driver ON agent_evaluation_runs;
DROP POLICY evaluation_driver_result ON agent_evaluation_results;
DROP VIEW evaluation_run_command;
DROP VIEW admin_evaluation_queue;
DROP POLICY evaluation_queue_projection ON agent_evaluation_runs;

DROP VIEW IF EXISTS admin_evaluation_executor_scope;
DROP TABLE IF EXISTS agent_evaluation_case_jobs;
ALTER TABLE agent_evaluation_runs
  DROP CONSTRAINT IF EXISTS agent_evaluation_runs_tenant_fkey,
  DROP COLUMN IF EXISTS tenant_id,
  DROP COLUMN IF EXISTS cancel_requested_at;
