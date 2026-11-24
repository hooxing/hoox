DO $$
DECLARE
  runtime text := current_setting('app.runtime_role');
  evaluation text := CASE WHEN length(runtime)<=52 THEN runtime||'_evaluation'
  ELSE left(runtime,43)||'_'||left(md5(runtime),8)||'_evaluation' END;
BEGIN
  EXECUTE format($policy$CREATE POLICY evaluation_role_thread_insert_guard ON threads
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      is_evaluation AND NOT is_playground
      AND tenant_id=current_setting('app.tenant_id',true)
      AND created_by_user_id=current_setting('app.user_id',true)
      AND EXISTS (SELECT 1 FROM evaluation_run_command c
        WHERE c.case_snapshot IS NOT NULL AND c.planned_run_id=threads.id
          AND c.definition_id=threads.agent_definition_id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_run_insert_guard ON runs
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      origin='evaluation' AND tenant_id=current_setting('app.tenant_id',true)
      AND thread_id=id AND EXISTS (SELECT 1 FROM evaluation_run_command c
        WHERE c.case_snapshot IS NOT NULL AND c.planned_run_id=runs.id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_worker_assignment_insert_guard ON worker_tenant_assignments
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true)
      AND EXISTS (SELECT 1 FROM evaluation_run_command c JOIN threads t ON t.id=c.planned_run_id
        WHERE c.case_snapshot IS NOT NULL AND c.planned_run_id=t.id
          AND t.tenant_id=worker_tenant_assignments.tenant_id AND t.is_evaluation)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_snapshot_insert_guard ON run_agent_snapshots
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true) AND run_id=thread_id
      AND EXISTS (SELECT 1 FROM evaluation_run_command c
        JOIN agent_revisions v ON v.id=c.revision_id
        WHERE c.case_snapshot IS NOT NULL AND c.planned_run_id=run_agent_snapshots.run_id
          AND c.definition_id=run_agent_snapshots.definition_id
          AND c.revision_id=run_agent_snapshots.revision_id
          AND v.id=run_agent_snapshots.revision_id
          AND v.content_digest=run_agent_snapshots.revision_digest
          AND v.content=run_agent_snapshots.content)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_workspace_insert_guard ON workspaces
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true) AND EXISTS (
        SELECT 1 FROM evaluation_run_command c JOIN threads t ON t.id=c.planned_run_id
        WHERE c.case_snapshot IS NOT NULL AND t.is_evaluation
          AND c.planned_run_id=workspaces.thread_id AND t.tenant_id=workspaces.tenant_id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_skill_snapshot_insert_guard ON run_skill_snapshots
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true) AND user_id=current_setting('app.user_id',true)
      AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL
        AND c.planned_run_id=run_skill_snapshots.run_id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_skill_item_insert_guard ON run_skill_snapshot_items
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true)
      AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL
        AND c.planned_run_id=run_skill_snapshot_items.run_id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_thread_head_insert_guard ON thread_execution_heads
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true)
      AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL
        AND c.planned_run_id=thread_execution_heads.thread_id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_receipt_insert_guard ON thread_input_receipts
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true) AND thread_id=queued_run_id
      AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL
        AND c.planned_run_id=thread_input_receipts.thread_id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_follow_up_insert_guard ON thread_follow_up_queue
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true) AND thread_id=run_id
      AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL
        AND c.planned_run_id=thread_follow_up_queue.run_id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_receipt_event_insert_guard ON thread_input_receipt_events
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true)
      AND EXISTS (SELECT 1 FROM evaluation_run_command c JOIN runs r
        ON r.tenant_id=thread_input_receipt_events.tenant_id AND r.id=c.planned_run_id
        WHERE c.planned_run_id=thread_input_receipt_events.thread_id AND (
          c.case_snapshot IS NOT NULL OR (r.status='cancelled'
            AND event_kind='disposition_changed' AND disposition='cancelled'
            AND (c.cancel_requested_at IS NOT NULL OR NOT c.member_active
              OR NOT c.account_active OR NOT c.actor_active))))
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_continuity_metric_insert_guard ON thread_continuity_metric_observations
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true) AND run_id=thread_id
      AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL
        AND c.planned_run_id=thread_continuity_metric_observations.run_id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_execution_input_insert_guard ON run_execution_inputs
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true) AND run_id=thread_id AND root_run_id=run_id
      AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL
        AND c.planned_run_id=run_execution_inputs.run_id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_dispatch_insert_guard ON run_dispatch_outbox
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true) AND run_id=thread_id AND root_run_id=run_id
      AND EXISTS (SELECT 1 FROM evaluation_run_command c WHERE c.case_snapshot IS NOT NULL
        AND c.planned_run_id=run_dispatch_outbox.run_id)
    )$policy$,evaluation);
  EXECUTE format($policy$CREATE POLICY evaluation_role_workspace_result_insert_guard ON run_workspace_results
    AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (
      tenant_id=current_setting('app.tenant_id',true) AND run_id=thread_id
      AND EXISTS (SELECT 1 FROM evaluation_run_command c JOIN runs r
        ON r.tenant_id=run_workspace_results.tenant_id AND r.id=c.planned_run_id
        WHERE c.planned_run_id=run_workspace_results.run_id
          AND (c.case_snapshot IS NOT NULL OR (r.status='cancelled'
            AND (c.cancel_requested_at IS NOT NULL OR NOT c.member_active
              OR NOT c.account_active OR NOT c.actor_active))))
    )$policy$,evaluation);
END $$;
