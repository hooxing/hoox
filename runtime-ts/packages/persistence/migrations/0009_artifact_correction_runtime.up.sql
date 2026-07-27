ALTER TABLE run_events
  DROP CONSTRAINT run_events_kind_check,
  ADD CONSTRAINT run_events_kind_check CHECK (
    kind IN (
      'agent_event',
      'attempt_state_changed',
      'run_waiting',
      'artifact_correction_requested'
    )
  );

ALTER TABLE run_events
  ADD CONSTRAINT run_events_artifact_correction_payload_check CHECK (
    kind <> 'artifact_correction_requested'
    OR (
      jsonb_typeof(payload) = 'object'
      AND payload ?& ARRAY['round', 'maxRounds', 'code', 'feedback']
      AND payload - ARRAY['round', 'maxRounds', 'code', 'feedback'] = '{}'::jsonb
      AND jsonb_typeof(payload->'round') = 'number'
      AND payload->>'round' IN ('1', '2')
      AND jsonb_typeof(payload->'maxRounds') = 'number'
      AND payload->>'maxRounds' IN ('1', '2')
      AND (payload->>'maxRounds' = '2' OR payload->>'round' = '1')
      AND payload->>'code' = 'ARTIFACT_NOT_READY'
      AND jsonb_typeof(payload->'feedback') = 'string'
      AND octet_length(payload->>'feedback') BETWEEN 1 AND 8192
    )
  );
CREATE UNIQUE INDEX run_events_artifact_correction_round_idx
  ON run_events (tenant_id, attempt_id, (payload->>'round'))
  WHERE kind = 'artifact_correction_requested';

ALTER TABLE external_effect_permits
  DROP CONSTRAINT external_effect_permits_effect_check,
  ADD CONSTRAINT external_effect_permits_effect_check CHECK (
    effect IN ('model_start', 'model_continue', 'tool_execution')
  );
