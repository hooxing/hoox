CREATE TABLE agent_evaluation_suites (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  definition_id text NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 4000),
  reviewer_model jsonb,
  reviewer_rubric text,
  content_version bigint NOT NULL DEFAULT 1 CHECK (content_version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id,id),
  CHECK ((reviewer_model IS NULL) = (reviewer_rubric IS NULL))
);
CREATE TABLE agent_evaluation_cases (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  suite_id text NOT NULL REFERENCES agent_evaluation_suites(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 200),
  input_text text NOT NULL CHECK (octet_length(input_text) <= 65536),
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments)='array'),
  assertions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assertions)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (suite_id,id)
);
CREATE TABLE agent_evaluation_runs (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  definition_id text NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
  suite_id text NOT NULL,
  suite_version bigint NOT NULL CHECK (suite_version > 0),
  revision_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','cancelled','completed','failed')),
  max_concurrency integer NOT NULL CHECK (max_concurrency BETWEEN 1 AND 32),
  total_cases integer NOT NULL CHECK (total_cases >= 0),
  passed_cases integer NOT NULL DEFAULT 0 CHECK (passed_cases >= 0),
  failed_cases integer NOT NULL DEFAULT 0 CHECK (failed_cases >= 0),
  unknown_cases integer NOT NULL DEFAULT 0 CHECK (unknown_cases >= 0),
  cancelled_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (id,suite_id),
  FOREIGN KEY (definition_id,suite_id) REFERENCES agent_evaluation_suites(definition_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (definition_id,revision_id) REFERENCES agent_revisions(definition_id,id) ON DELETE RESTRICT
);
CREATE TABLE agent_evaluation_results (
  evaluation_run_id text NOT NULL REFERENCES agent_evaluation_runs(id) ON DELETE CASCADE,
  suite_id text NOT NULL,
  case_id text NOT NULL,
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  run_origin text NOT NULL DEFAULT 'evaluation' CHECK (run_origin='evaluation'),
  outcome text NOT NULL CHECK (outcome IN ('passed','failed','unknown','cancelled')),
  assertion_results jsonb NOT NULL CHECK (jsonb_typeof(assertion_results)='array'),
  score numeric CHECK (score BETWEEN 0 AND 1),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (evaluation_run_id,case_id),
  FOREIGN KEY (evaluation_run_id,suite_id) REFERENCES agent_evaluation_runs(id,suite_id) ON DELETE CASCADE,
  FOREIGN KEY (suite_id,case_id) REFERENCES agent_evaluation_cases(suite_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,run_origin) REFERENCES runs(tenant_id,id,origin) ON DELETE RESTRICT
);
CREATE INDEX agent_evaluation_runs_suite_idx ON agent_evaluation_runs(suite_id,created_at DESC);
CREATE INDEX agent_evaluation_results_run_idx ON agent_evaluation_results(run_id);
ALTER TABLE agent_evaluation_suites ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_evaluation_suites FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_evaluation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_evaluation_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_evaluation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_evaluation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_evaluation_results FORCE ROW LEVEL SECURITY;
DO $$
DECLARE control_role text := current_setting('app.admin_control_role');
BEGIN
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON agent_evaluation_suites TO %I', control_role);
  EXECUTE format('GRANT SELECT(id,suite_id,name,assertions,created_at,updated_at) ON agent_evaluation_cases TO %I', control_role);
  EXECUTE format('GRANT INSERT,UPDATE,DELETE ON agent_evaluation_cases TO %I', control_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON agent_evaluation_runs TO %I', control_role);
  EXECUTE format('GRANT SELECT,INSERT ON agent_evaluation_results TO %I', control_role);
  EXECUTE format('CREATE POLICY evaluation_suite_admin ON agent_evaluation_suites TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'' AND role IN (''admin'',''operator''))) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'' AND role IN (''admin'',''operator'')))', control_role);
  EXECUTE format('CREATE POLICY evaluation_case_admin ON agent_evaluation_cases TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'' AND role IN (''admin'',''operator''))) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'' AND role IN (''admin'',''operator'')))', control_role);
  EXECUTE format('CREATE POLICY evaluation_run_admin ON agent_evaluation_runs TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'' AND role IN (''admin'',''operator''))) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'' AND role IN (''admin'',''operator'')))', control_role);
  EXECUTE format('CREATE POLICY evaluation_result_admin ON agent_evaluation_results TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'' AND role IN (''admin'',''operator''))) WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators WHERE user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND status=''active'' AND role IN (''admin'',''operator'')))', control_role);
END $$;

CREATE VIEW admin_evaluation_case_projection WITH (security_barrier=true) AS
SELECT test_case.id,test_case.suite_id,test_case.name,
       CASE WHEN EXISTS (
         SELECT 1 FROM platform_control_operators actor
         JOIN user_accounts account ON account.user_id=actor.user_id AND account.status='active'
          WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
            AND actor.status='active' AND actor.role='admin'
       ) THEN test_case.input_text ELSE '' END AS input_text,
       CASE WHEN EXISTS (
         SELECT 1 FROM platform_control_operators actor
         JOIN user_accounts account ON account.user_id=actor.user_id AND account.status='active'
          WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
            AND actor.status='active' AND actor.role='admin'
       ) THEN test_case.attachments ELSE '[]'::jsonb END AS attachments,
       test_case.assertions,test_case.created_at,test_case.updated_at
  FROM agent_evaluation_cases test_case
 WHERE EXISTS (
   SELECT 1 FROM platform_control_operators actor
    WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND actor.status='active' AND actor.role IN ('admin','operator')
 );

DO $$ BEGIN
  EXECUTE format('CREATE POLICY evaluation_case_projection_owner ON agent_evaluation_cases TO %I USING(true)',current_user);
  EXECUTE format('GRANT SELECT ON admin_evaluation_case_projection TO %I',current_setting('app.admin_control_role'));
END $$;
