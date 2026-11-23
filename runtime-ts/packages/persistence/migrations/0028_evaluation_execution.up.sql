ALTER TABLE agent_evaluation_runs
  ADD COLUMN tenant_id text,
  ADD COLUMN cancel_requested_at timestamptz;

UPDATE agent_evaluation_runs evaluation
   SET tenant_id=account.personal_tenant_id
  FROM user_accounts account
 WHERE account.user_id=evaluation.created_by;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM agent_evaluation_runs WHERE tenant_id IS NULL) THEN
    RAISE EXCEPTION 'existing evaluation runs have no executor tenant';
  END IF;
END $$;

ALTER TABLE agent_evaluation_runs
  ALTER COLUMN tenant_id SET NOT NULL,
  ADD CONSTRAINT agent_evaluation_runs_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE TABLE agent_evaluation_case_jobs (
  evaluation_run_id text NOT NULL,
  suite_id text NOT NULL,
  case_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','starting','running','completed','failed','unknown','cancelled')),
  tenant_id text NOT NULL,
  run_id text,
  run_origin text NOT NULL DEFAULT 'evaluation' CHECK (run_origin='evaluation'),
  planned_run_id text NOT NULL DEFAULT gen_random_uuid()::text UNIQUE,
  case_snapshot jsonb NOT NULL,
  case_name text NOT NULL,
  assertions_snapshot jsonb NOT NULL CHECK (jsonb_typeof(assertions_snapshot)='array'),
  claim_token uuid,
  generation bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT '-infinity',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (evaluation_run_id,case_id),
  FOREIGN KEY (evaluation_run_id,suite_id)
    REFERENCES agent_evaluation_runs(id,suite_id) ON DELETE CASCADE,
  FOREIGN KEY (suite_id,case_id)
    REFERENCES agent_evaluation_cases(suite_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,run_origin)
    REFERENCES runs(tenant_id,id,origin) ON DELETE RESTRICT,
  CHECK (run_id IS NULL OR run_id=planned_run_id),
  CHECK ((claim_token IS NULL) = (lease_until IS NULL))
);

CREATE INDEX agent_evaluation_case_jobs_dispatch_idx
  ON agent_evaluation_case_jobs(status,lease_until,evaluation_run_id);
CREATE INDEX agent_evaluation_runs_tenant_idx
  ON agent_evaluation_runs(tenant_id,created_at DESC);

ALTER TABLE agent_evaluation_case_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_evaluation_case_jobs FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE VIEW admin_evaluation_executor_scope WITH (security_barrier=true) AS
SELECT actor.user_id,account.personal_tenant_id AS tenant_id
  FROM platform_control_operators actor
  JOIN user_accounts account ON account.user_id=actor.user_id
 WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
   AND actor.status='active' AND actor.role IN ('admin','operator') AND account.status='active';

DO $$
DECLARE control_role text := current_setting('app.admin_control_role');
BEGIN
  EXECUTE format('GRANT INSERT ON agent_evaluation_case_jobs TO %I', control_role);
  EXECUTE format('GRANT SELECT(evaluation_run_id,suite_id,case_id,status,tenant_id,run_id,run_origin,planned_run_id,case_name,assertions_snapshot,claim_token,generation,lease_until,next_poll_at,updated_at) ON agent_evaluation_case_jobs TO %I', control_role);
  EXECUTE format('GRANT UPDATE(status,run_id,claim_token,generation,lease_until,next_poll_at,updated_at) ON agent_evaluation_case_jobs TO %I', control_role);
  EXECUTE format('GRANT SELECT ON admin_evaluation_executor_scope TO %I', control_role);
  EXECUTE format('GRANT SELECT ON admin_evaluation_case_projection TO %I', control_role);
  EXECUTE format('CREATE POLICY evaluation_case_job_admin ON agent_evaluation_case_jobs TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'' AND role IN (''admin'',''operator''))) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'' AND role IN (''admin'',''operator'')))', control_role);
END $$;

-- 无会话的循环只发现队列元数据；正文与跨进程命令均须另行鉴权。
CREATE VIEW admin_evaluation_queue WITH (security_barrier=true) AS
SELECT b.id AS batch_id,b.created_by,b.max_concurrency,b.cancel_requested_at,j.case_id,j.status,
       j.lease_until,j.next_poll_at,j.updated_at
  FROM agent_evaluation_case_jobs j JOIN agent_evaluation_runs b ON b.id=j.evaluation_run_id
 WHERE b.status IN ('queued','running') AND j.status IN ('queued','starting','running');

CREATE VIEW evaluation_run_command WITH (security_barrier=true) AS
SELECT j.planned_run_id,j.evaluation_run_id,CASE WHEN m.status='active' AND account.status='active' AND actor.role='admin' AND actor.status='active' AND b.cancel_requested_at IS NULL THEN j.case_snapshot END AS case_snapshot,
       b.definition_id,b.revision_id,b.cancel_requested_at,COALESCE(m.status='active',false) AS member_active,
       COALESCE(account.status='active',false) AS account_active,
       COALESCE(actor.role='admin' AND actor.status='active',false) AS actor_active
  FROM agent_evaluation_case_jobs j JOIN agent_evaluation_runs b ON b.id=j.evaluation_run_id
  LEFT JOIN user_accounts account ON account.user_id=b.created_by AND account.personal_tenant_id=b.tenant_id
  LEFT JOIN memberships m ON m.user_id=b.created_by AND m.tenant_id=b.tenant_id
  LEFT JOIN platform_control_operators actor ON actor.user_id=b.created_by
 WHERE b.created_by=current_setting('app.user_id',true) AND j.tenant_id=b.tenant_id
   AND j.tenant_id=current_setting('app.tenant_id',true)
   AND j.claim_token::text=current_setting('app.evaluation_token',true)
   AND j.generation::text=current_setting('app.evaluation_generation',true)
   AND b.id=current_setting('app.evaluation_batch',true)
   AND j.status IN ('starting','running') AND j.lease_until>statement_timestamp();
DO $$ BEGIN
  EXECUTE format('CREATE POLICY evaluation_queue_projection ON agent_evaluation_runs FOR SELECT TO %I USING(true)',current_user);
  EXECUTE format('CREATE POLICY evaluation_queue_projection ON agent_evaluation_case_jobs FOR SELECT TO %I USING(true)',current_user);
  EXECUTE format('GRANT SELECT ON admin_evaluation_queue TO %I',current_setting('app.admin_control_role'));
  EXECUTE format('GRANT SELECT ON evaluation_run_command TO %I',current_setting('app.runtime_role'));
END $$;

DO $$
DECLARE role_name text := current_setting('app.admin_control_role');
BEGIN
  EXECUTE format($policy$CREATE POLICY evaluation_driver ON agent_evaluation_runs TO %I USING(id=current_setting('app.evaluation_batch',true) AND created_by=current_setting('app.user_id',true))$policy$,role_name);
  EXECUTE format($policy$CREATE POLICY evaluation_driver ON agent_evaluation_case_jobs TO %I USING(evaluation_run_id=current_setting('app.evaluation_batch',true) AND EXISTS(SELECT 1 FROM agent_evaluation_runs b WHERE b.id=evaluation_run_id AND b.created_by=current_setting('app.user_id',true)))$policy$,role_name);
  EXECUTE format($policy$CREATE POLICY evaluation_driver_result ON agent_evaluation_results FOR INSERT TO %I WITH CHECK(evaluation_run_id=current_setting('app.evaluation_batch',true) AND EXISTS(SELECT 1 FROM agent_evaluation_runs b WHERE b.id=evaluation_run_id AND b.created_by=current_setting('app.user_id',true)))$policy$,role_name);
END $$;
-- Artifact 只投影当前个人空间本次正文审计绑定的成功发布，不开放底表或其他 Tenant。
CREATE VIEW admin_evaluation_artifact_evidence WITH (security_barrier=true) AS
SELECT p.name,p.media_type FROM artifact_publications p
JOIN artifact_publication_settlements s ON s.tenant_id=p.tenant_id AND s.artifact_id=p.id AND s.target='published'
JOIN admin_run_content_access_audits a ON a.tenant_id=p.tenant_id AND a.run_id=p.run_id AND a.attempt_id=p.attempt_id
JOIN admin_evaluation_executor_scope e ON e.user_id=a.actor_user_id AND e.tenant_id=a.tenant_id
WHERE a.audit_id=current_setting('app.run_content_audit_id',true) AND a.access_transaction=pg_current_xact_id_if_assigned()
  AND a.query_summary->>'reason'='评测结算' AND p.tenant_id=current_setting('app.tenant_id',true)
  AND EXISTS(SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=e.user_id AND actor.status='active' AND actor.role='admin');
DO $$ BEGIN
  EXECUTE format('GRANT SELECT ON admin_evaluation_artifact_evidence TO %I',current_setting('app.admin_control_role'));
END $$;
