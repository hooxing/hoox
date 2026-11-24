ALTER POLICY evaluation_thread_read ON threads USING (
  is_evaluation AND tenant_id=current_setting('app.tenant_id',true)
  AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.planned_run_id=threads.id)
);
ALTER POLICY evaluation_run_read ON runs USING (
  origin='evaluation' AND tenant_id=current_setting('app.tenant_id',true)
  AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.planned_run_id=runs.id)
);
ALTER POLICY evaluation_revision_read ON agent_revisions USING (
  EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL AND c.revision_id=agent_revisions.id)
);
ALTER POLICY evaluation_definition_read ON agent_definitions USING (
  EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL AND c.definition_id=agent_definitions.id)
);
ALTER POLICY evaluation_thread_guard ON threads WITH CHECK (
  NOT is_evaluation OR (NOT is_playground AND tenant_id=current_setting('app.tenant_id',true)
    AND created_by_user_id=current_setting('app.user_id',true) AND EXISTS
    (SELECT 1 FROM evaluation_run_command cmd WHERE cmd.case_snapshot IS NOT NULL AND cmd.planned_run_id=threads.id AND cmd.definition_id=threads.agent_definition_id))
);
ALTER POLICY evaluation_run_guard ON runs WITH CHECK (
  origin<>'evaluation' OR (tenant_id=current_setting('app.tenant_id',true) AND thread_id=id AND EXISTS
    (SELECT 1 FROM evaluation_run_command cmd WHERE cmd.case_snapshot IS NOT NULL AND cmd.planned_run_id=runs.id))
);
ALTER POLICY evaluation_snapshot_create ON run_agent_snapshots WITH CHECK (
  tenant_id=current_setting('app.tenant_id',true) AND run_id=thread_id AND EXISTS (
    SELECT 1 FROM evaluation_run_command c JOIN agent_revisions v ON v.id=c.revision_id
     WHERE c.planned_run_id=run_agent_snapshots.run_id AND c.definition_id=run_agent_snapshots.definition_id
       AND v.id=run_agent_snapshots.revision_id AND v.content_digest=run_agent_snapshots.revision_digest
       AND v.content=run_agent_snapshots.content
  )
);
