DO $$
DECLARE
  runtime_role text := current_setting('app.runtime_role');
BEGIN
  -- 只为当前 Run 的不可变 Agent 快照开放对应模型版本，不开放其他草稿或凭据。
  EXECUTE format($policy$
    CREATE POLICY runtime_agent_pinned_model_read ON admin_control_config_revisions FOR SELECT TO %I
    USING (object_kind='model_provider' AND EXISTS (
      SELECT 1 FROM run_agent_snapshots snapshot
      WHERE snapshot.tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
        AND snapshot.run_id=NULLIF(current_setting('app.pinned_model_run_id',true),'')
        AND snapshot.content #>> '{model,mode}'='pinned'
        AND snapshot.content #>> '{model,providerKey}'=admin_control_config_revisions.object_key
        AND snapshot.content #> '{model,providerRevision}'=to_jsonb(admin_control_config_revisions.revision)
        AND admin_control_config_revisions.configuration->'models' @> jsonb_build_array(
          jsonb_build_object('id',snapshot.content #>> '{model,modelId}','enabled',true)
        )
    ))
  $policy$, runtime_role);
END $$;
