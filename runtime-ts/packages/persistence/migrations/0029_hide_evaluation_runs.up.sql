ALTER TABLE threads
  ADD COLUMN is_evaluation boolean NOT NULL DEFAULT false;

ALTER POLICY threads_read_policy ON threads
  USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND (NOT is_playground OR NULLIF(current_setting('app.user_id',true),'') IS NULL)
    AND (NOT is_evaluation OR NULLIF(current_setting('app.user_id',true),'') IS NULL)
  );

ALTER POLICY runs_read ON runs
  USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND (origin<>'playground' OR NULLIF(current_setting('app.user_id',true),'') IS NULL)
    AND (origin<>'evaluation' OR NULLIF(current_setting('app.user_id',true),'') IS NULL)
  );

-- 普通受理策略不能借公开 Revision 插入伪造的评测来源；命令视图固定两个主键。
CREATE POLICY evaluation_thread_guard ON threads AS RESTRICTIVE FOR INSERT WITH CHECK (
  NOT is_evaluation OR (NOT is_playground AND tenant_id=current_setting('app.tenant_id',true)
    AND created_by_user_id=current_setting('app.user_id',true) AND EXISTS
    (SELECT 1 FROM evaluation_run_command cmd WHERE cmd.case_snapshot IS NOT NULL AND cmd.planned_run_id=threads.id AND cmd.definition_id=threads.agent_definition_id)));
CREATE POLICY evaluation_run_guard ON runs AS RESTRICTIVE FOR INSERT WITH CHECK (
  origin<>'evaluation' OR (tenant_id=current_setting('app.tenant_id',true) AND thread_id=id AND EXISTS
    (SELECT 1 FROM evaluation_run_command cmd WHERE cmd.case_snapshot IS NOT NULL AND cmd.planned_run_id=runs.id)));
DO $$
DECLARE runtime text := current_setting('app.runtime_role');
BEGIN
  EXECUTE format('ALTER POLICY evaluation_thread_guard ON threads TO %I',runtime);
  EXECUTE format('ALTER POLICY evaluation_run_guard ON runs TO %I',runtime);
  EXECUTE format('CREATE POLICY evaluation_thread_read ON threads FOR SELECT TO %I USING(is_evaluation AND tenant_id=current_setting(''app.tenant_id'',true) AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.planned_run_id=threads.id))',runtime);
  EXECUTE format('CREATE POLICY evaluation_thread_create ON threads FOR INSERT TO %I WITH CHECK(is_evaluation)',runtime);
  EXECUTE format('CREATE POLICY evaluation_run_read ON runs FOR SELECT TO %I USING(origin=''evaluation'' AND tenant_id=current_setting(''app.tenant_id'',true) AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.planned_run_id=runs.id))',runtime);
  EXECUTE format('CREATE POLICY evaluation_run_create ON runs FOR INSERT TO %I WITH CHECK(origin=''evaluation'')',runtime);
  EXECUTE format('CREATE POLICY evaluation_revision_read ON agent_revisions FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL AND c.revision_id=agent_revisions.id))',runtime);
  EXECUTE format('CREATE POLICY evaluation_definition_read ON agent_definitions FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL AND c.definition_id=agent_definitions.id))',runtime);
  EXECUTE format('CREATE POLICY evaluation_snapshot_create ON run_agent_snapshots FOR INSERT TO %I WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true) AND run_id=thread_id AND EXISTS (SELECT 1 FROM evaluation_run_command c JOIN agent_revisions v ON v.id=c.revision_id WHERE c.planned_run_id=run_agent_snapshots.run_id AND c.definition_id=run_agent_snapshots.definition_id AND v.id=run_agent_snapshots.revision_id AND v.content_digest=run_agent_snapshots.revision_digest AND v.content=run_agent_snapshots.content))',runtime);
END $$;
