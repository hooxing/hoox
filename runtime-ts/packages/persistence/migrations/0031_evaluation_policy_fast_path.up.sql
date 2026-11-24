ALTER POLICY evaluation_thread_read ON threads USING (
  is_evaluation AND tenant_id=current_setting('app.tenant_id',true)
  AND CASE WHEN NULLIF(current_setting('app.evaluation_batch',true),'') IS NOT NULL
    THEN id = ANY (ARRAY(SELECT c.planned_run_id FROM evaluation_run_command c))
    ELSE false END
);

ALTER POLICY evaluation_run_read ON runs USING (
  origin='evaluation' AND tenant_id=current_setting('app.tenant_id',true)
  AND CASE WHEN NULLIF(current_setting('app.evaluation_batch',true),'') IS NOT NULL
    THEN id = ANY (ARRAY(SELECT c.planned_run_id FROM evaluation_run_command c))
    ELSE false END
);

ALTER POLICY evaluation_revision_read ON agent_revisions USING (
  CASE WHEN NULLIF(current_setting('app.evaluation_batch',true),'') IS NOT NULL
    THEN id = ANY (ARRAY(SELECT c.revision_id FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL))
    ELSE false END
);

ALTER POLICY evaluation_definition_read ON agent_definitions USING (
  CASE WHEN NULLIF(current_setting('app.evaluation_batch',true),'') IS NOT NULL
    THEN id = ANY (ARRAY(SELECT c.definition_id FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL))
    ELSE false END
);

ALTER POLICY evaluation_thread_guard ON threads WITH CHECK (
  NOT is_evaluation OR (
    NOT is_playground AND tenant_id=current_setting('app.tenant_id',true)
    AND created_by_user_id=current_setting('app.user_id',true)
    AND CASE WHEN NULLIF(current_setting('app.evaluation_batch',true),'') IS NOT NULL
      THEN (id,agent_definition_id) = ANY (ARRAY(
        SELECT ROW(c.planned_run_id,c.definition_id) FROM evaluation_run_command c
         WHERE c.case_snapshot IS NOT NULL
      )) ELSE false END
  )
);

ALTER POLICY evaluation_run_guard ON runs WITH CHECK (
  origin<>'evaluation' OR (
    tenant_id=current_setting('app.tenant_id',true) AND thread_id=id
    AND CASE WHEN NULLIF(current_setting('app.evaluation_batch',true),'') IS NOT NULL
      THEN id = ANY (ARRAY(SELECT c.planned_run_id FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL))
      ELSE false END
  )
);

ALTER POLICY evaluation_snapshot_create ON run_agent_snapshots WITH CHECK (
  tenant_id=current_setting('app.tenant_id',true) AND run_id=thread_id
  AND CASE WHEN NULLIF(current_setting('app.evaluation_batch',true),'') IS NOT NULL
    THEN (run_id,definition_id,revision_id,revision_digest,content) = ANY (ARRAY(
      SELECT ROW(c.planned_run_id,c.definition_id,v.id,v.content_digest,v.content)
        FROM evaluation_run_command c JOIN agent_revisions v ON v.id=c.revision_id
    )) ELSE false END
);
