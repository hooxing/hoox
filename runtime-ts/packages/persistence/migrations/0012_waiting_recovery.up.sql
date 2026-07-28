-- ADR-0033：waiting 恢复权、外部副作用 intent 与决定事实必须由 PostgreSQL 线性化。
ALTER TABLE run_events DROP CONSTRAINT run_events_kind_check;
ALTER TABLE run_events ADD CONSTRAINT run_events_kind_check CHECK (
  kind IN ('agent_event','attempt_state_changed','run_waiting','artifact_correction_requested','sandbox_recovery_decided')
);
CREATE UNIQUE INDEX run_events_waiting_recovery_checkpoint_idx
  ON run_events(tenant_id,attempt_id,(payload->>'checkpointId'))
  WHERE kind='sandbox_recovery_decided';
ALTER TABLE run_events ADD CONSTRAINT run_events_waiting_recovery_payload_check CHECK (
  kind <> 'sandbox_recovery_decided' OR (
    jsonb_typeof(payload)='object'
    AND octet_length(payload->>'checkpointId') BETWEEN 1 AND 200
    AND payload->>'decision' IN ('sandbox_reused','sandbox_rebuilt')
    AND (
      (payload->>'decision'='sandbox_reused' AND payload ?& ARRAY['registryId','generation'])
      OR (payload->>'decision'='sandbox_rebuilt' AND payload ? 'reason')
    )
  )
);

ALTER TABLE runtime_rollout_entries DROP CONSTRAINT runtime_rollout_entries_kind_check;
ALTER TABLE runtime_rollout_entries ADD CONSTRAINT runtime_rollout_entries_kind_check CHECK (
  kind IN ('user','assistant','tool_call','tool_result','waiting','terminal','sandbox_recovery')
);

ALTER TABLE sandbox_registry ADD COLUMN generation bigint NOT NULL DEFAULT 1;
ALTER TABLE sandbox_registry ADD CONSTRAINT sandbox_registry_generation_check CHECK (
  generation BETWEEN 1 AND 9007199254740991
);
CREATE UNIQUE INDEX runtime_rollout_waiting_recovery_checkpoint_idx
  ON runtime_rollout_entries(tenant_id,attempt_id,agent_thread_id,(body->>'checkpointId'))
  WHERE kind='sandbox_recovery';

CREATE TABLE waiting_recovery_checkpoints (
  tenant_id text NOT NULL,
  checkpoint_id text NOT NULL CHECK (octet_length(checkpoint_id) BETWEEN 1 AND 200),
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  base_revision_id text,
  workspace_head_state text NOT NULL CHECK (workspace_head_state IN ('found','empty')),
  workspace_head_revision_id text,
  registry_id text,
  provider_sandbox_id text,
  sandbox_generation bigint,
  sandbox_expected_generation bigint,
  sandbox_lifecycle text CHECK (sandbox_lifecycle IN (
    'paused','pause_unknown','connect_unknown','create_unknown','materialize_unknown'
  )),
  sandbox_paused_at timestamptz,
  sandbox_expires_at timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','effect_pending','resolved','unknown')),
  claim_owner text,
  claim_token text,
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch BETWEEN 0 AND 9007199254740991),
  claim_expires_at timestamptz,
  decision jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, checkpoint_id),
  UNIQUE (tenant_id, attempt_id, checkpoint_id),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, workspace_head_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id, registry_id, provider_sandbox_id)
    REFERENCES sandbox_registry(tenant_id, attempt_id, registry_id, provider_sandbox_id)
    ON DELETE RESTRICT,
  CONSTRAINT waiting_recovery_head_shape CHECK (
    (workspace_head_state='found' AND workspace_head_revision_id IS NOT NULL)
    OR (workspace_head_state='empty' AND workspace_head_revision_id IS NULL)
  ),
  CONSTRAINT waiting_recovery_sandbox_shape CHECK (
    (registry_id IS NULL AND provider_sandbox_id IS NULL AND sandbox_generation IS NULL
      AND sandbox_expected_generation IS NULL AND sandbox_lifecycle IS NULL
      AND sandbox_paused_at IS NULL AND sandbox_expires_at IS NULL)
    OR
    (registry_id IS NOT NULL AND provider_sandbox_id IS NOT NULL
      AND sandbox_generation > 0 AND sandbox_expected_generation > 0
      AND sandbox_lifecycle IS NOT NULL AND sandbox_paused_at IS NOT NULL
      AND sandbox_expires_at > sandbox_paused_at
      AND sandbox_expires_at <= sandbox_paused_at + interval '10 minutes')
  ),
  CONSTRAINT waiting_recovery_claim_shape CHECK (
    (state='pending' AND claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
    OR (state IN ('claimed','effect_pending') AND claim_owner IS NOT NULL
      AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (state IN ('resolved','unknown') AND decision IS NOT NULL)
  ),
  CONSTRAINT waiting_recovery_decision_shape CHECK (
    decision IS NULL OR (
      jsonb_typeof(decision)='object'
      AND (
        (decision->>'outcome'='external_effect_unknown'
          AND decision->>'effect' IN ('pause','connect','create','materialize')
          AND decision->'requestAutomaticRetry'='false'::jsonb)
        OR (decision->>'outcome'='workspace_head_unavailable'
          AND decision->'requestAutomaticRetry'='false'::jsonb)
        OR decision->>'outcome'='workspace_conflict'
        OR (decision->>'outcome'='resume'
          AND decision->>'workspace' IN ('unchanged','replan')
          AND decision->'sandbox'->>'kind' IN ('sandbox_reused','sandbox_rebuilt')
          AND (decision->'sandbox'->>'kind'<>'sandbox_reused'
            OR (octet_length(decision->'sandbox'->>'registryId') BETWEEN 1 AND 200
              AND jsonb_typeof(decision->'sandbox'->'generation')='number'
              AND (decision->'sandbox'->>'generation')::numeric BETWEEN 1 AND 9007199254740991
              AND (decision->'sandbox'->>'generation')::numeric=trunc((decision->'sandbox'->>'generation')::numeric)))
          AND (decision->'sandbox'->>'kind'<>'sandbox_rebuilt'
            OR decision->'sandbox'->>'reason' IN (
              'missing','ttl_expired','generation_mismatch','scope_mismatch','base_revision_mismatch'
            )))
      )
    )
  )
);

CREATE TABLE waiting_recovery_effect_outbox (
  tenant_id text NOT NULL,
  checkpoint_id text NOT NULL,
  intent_id text NOT NULL CHECK (octet_length(intent_id) BETWEEN 1 AND 200),
  claim_epoch bigint NOT NULL CHECK (claim_epoch > 0),
  effect text NOT NULL CHECK (effect IN ('connect','create','materialize')),
  state text NOT NULL CHECK (state IN ('pending','completed','unknown')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, checkpoint_id, intent_id),
  UNIQUE (tenant_id, checkpoint_id, effect),
  FOREIGN KEY (tenant_id, checkpoint_id) REFERENCES waiting_recovery_checkpoints(tenant_id, checkpoint_id)
    ON DELETE RESTRICT,
  CONSTRAINT waiting_recovery_effect_payload_shape CHECK (
    (state='pending' AND payload ? 'plan')
    OR (state='completed' AND payload ? 'plan' AND payload ? 'proof'
      AND octet_length(payload->'proof'->>'registryId') BETWEEN 1 AND 200
      AND octet_length(payload->'proof'->>'providerSandboxId') BETWEEN 1 AND 200
      AND jsonb_typeof(payload->'proof'->'generation')='number'
      AND (payload->'proof'->>'generation')::numeric BETWEEN 1 AND 9007199254740991
      AND (payload->'proof'->>'generation')::numeric=trunc((payload->'proof'->>'generation')::numeric))
    OR (state='unknown' AND payload->>'unknownEffect' IN ('connect','create','materialize'))
  )
);

CREATE INDEX waiting_recovery_claim_idx ON waiting_recovery_checkpoints(tenant_id,state,claim_expires_at);
CREATE INDEX waiting_recovery_effect_dispatch_idx ON waiting_recovery_effect_outbox(tenant_id,state,updated_at);

ALTER TABLE waiting_recovery_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiting_recovery_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY waiting_recovery_checkpoints_tenant_policy ON waiting_recovery_checkpoints
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE waiting_recovery_effect_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiting_recovery_effect_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY waiting_recovery_effect_outbox_tenant_policy ON waiting_recovery_effect_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
