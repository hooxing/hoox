CREATE OR REPLACE VIEW admin_run_event_outline WITH (security_barrier=true) AS
SELECT
  attempt.tenant_id,
  attempt.run_id,
  event.attempt_id,
  event.sequence,
  event.kind,
  event.occurred_at,
  CASE event.kind
    WHEN 'attempt_state_changed' THEN jsonb_strip_nulls(jsonb_build_object(
      'status',event.payload->'status',
      'stage',event.payload->'stage',
      'code',event.payload->'code'
    ))
    WHEN 'run_waiting' THEN jsonb_build_object(
      'question','',
      'checkpointId',event.payload->'checkpointId'
    )
    WHEN 'sandbox_recovery_decided' THEN jsonb_strip_nulls(jsonb_build_object(
      'decision',event.payload->'decision',
      'checkpointId',event.payload->'checkpointId',
      'registryId',event.payload->'registryId',
      'generation',event.payload->'generation',
      'reason',event.payload->'reason'
    ))
    WHEN 'artifact_correction_requested' THEN jsonb_build_object(
      'round',event.payload->'round',
      'maxRounds',event.payload->'maxRounds',
      'code',event.payload->'code',
      'feedback',''
    )
    WHEN 'agent_event' THEN CASE event.payload->>'type'
      WHEN 'thinking.delta' THEN jsonb_build_object('type','thinking.delta','delta','')
      WHEN 'message.delta' THEN jsonb_build_object('type','message.delta','delta','')
      WHEN 'message.completed' THEN jsonb_build_object(
        'type','message.completed','stopReason',event.payload->'stopReason'
      )
      WHEN 'tool.started' THEN jsonb_strip_nulls(jsonb_build_object(
        'type','tool.started',
        'callId',event.payload->'callId',
        'name',event.payload->'name',
        'parentCallId',event.payload->'parentCallId',
        'presentation',CASE WHEN jsonb_typeof(event.payload->'presentation')='object'
          THEN jsonb_build_object('action',event.payload->'presentation'->'action') END
      ))
      WHEN 'tool.updated' THEN jsonb_build_object(
        'type','tool.updated','callId',event.payload->'callId','name',event.payload->'name'
      )
      WHEN 'tool.completed' THEN jsonb_strip_nulls(jsonb_build_object(
        'type','tool.completed',
        'callId',event.payload->'callId',
        'name',event.payload->'name',
        'isError',event.payload->'isError',
        'executionMode',CASE WHEN event.payload->>'executionMode'='playground_mock' THEN 'playground_mock' END,
        'failure',CASE WHEN jsonb_typeof(event.payload->'failure')='object'
          THEN jsonb_build_object('code',event.payload->'failure'->'code','message','') END
      ))
      WHEN 'todo.updated' THEN jsonb_build_object(
        'type','todo.updated',
        'snapshot',jsonb_build_object(
          'schemaVersion',event.payload->'snapshot'->'schemaVersion',
          'version',event.payload->'snapshot'->'version',
          'todos','[]'::jsonb
        )
      )
      WHEN 'queue.updated' THEN jsonb_build_object(
        'type','queue.updated',
        'steering',(
          SELECT COALESCE(jsonb_agg(to_jsonb(''::text)),'[]'::jsonb)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(event.payload->'steering')='array'
              THEN event.payload->'steering' ELSE '[]'::jsonb END)
        ),
        'followUp',(
          SELECT COALESCE(jsonb_agg(to_jsonb(''::text)),'[]'::jsonb)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(event.payload->'followUp')='array'
              THEN event.payload->'followUp' ELSE '[]'::jsonb END)
        )
      )
      WHEN 'runtime.notice' THEN jsonb_build_object(
        'type','runtime.notice',
        'level',event.payload->'level',
        'code',event.payload->'code',
        'message','',
        'source',event.payload->'source'
      )
      WHEN 'error' THEN jsonb_strip_nulls(jsonb_build_object(
        'type','error',
        'code',event.payload->'code',
        'message','',
        'action',event.payload->'action'
      ))
      WHEN 'finalization.started' THEN jsonb_build_object(
        'type','finalization.started','callId',event.payload->'callId'
      )
      WHEN 'finalization.cancelled' THEN jsonb_build_object(
        'type','finalization.cancelled',
        'callId',event.payload->'callId',
        'reason',event.payload->'reason'
      )
      WHEN 'final_answer.committed' THEN jsonb_build_object(
        'type','final_answer.committed','callId',event.payload->'callId'
      )
      WHEN 'compaction.forbidden' THEN jsonb_build_object(
        'type','compaction.forbidden','source',event.payload->'source'
      )
      ELSE jsonb_build_object('type',event.payload->'type')
    END
    ELSE '{}'::jsonb
  END AS payload
FROM run_events event
JOIN execution_attempts attempt
  ON attempt.tenant_id=event.tenant_id AND attempt.attempt_id=event.attempt_id
WHERE EXISTS (
  SELECT 1 FROM platform_control_operators actor
   WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'')
     AND actor.status='active'
);
