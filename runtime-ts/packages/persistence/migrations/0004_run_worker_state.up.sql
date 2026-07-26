-- ADR-0011/0014 的生产事实表。所有时间由 PostgreSQL 生成，应用不得提交发生时间。
CREATE TABLE run_execution_inputs (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  base_revision_id text,
  input_text text NOT NULL CHECK (length(input_text) BETWEEN 1 AND 1048576),
  answer_text text,
  initial_projection jsonb NOT NULL CHECK (jsonb_typeof(initial_projection) = 'object'),
  initial_projection_digest text NOT NULL CHECK (initial_projection_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, run_id, thread_id, workspace_id, root_run_id),
  FOREIGN KEY (tenant_id, run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, root_run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, thread_id) REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, base_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT run_execution_root_check CHECK (root_run_id = run_id)
);

CREATE TABLE execution_attempts (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  base_revision_id text,
  current_revision_id text,
  status text NOT NULL CHECK (status IN (
    'claimed', 'running', 'waiting', 'finalizing', 'succeeded', 'failed',
    'cancelled', 'recovery_required', 'abandoned'
  )),
  stage text NOT NULL CHECK (stage IN (
    'claimed', 'cleanup_intent_persisted', 'model_execution_started', 'model_settled',
    'workspace_verified', 'finalizing', 'sandbox_settled', 'finished'
  )),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0 AND version <= 9007199254740991),
  next_event_sequence bigint NOT NULL DEFAULT 0 CHECK (
    next_event_sequence >= 0 AND next_event_sequence <= 9007199254740991
  ),
  projection_version bigint NOT NULL DEFAULT 0 CHECK (
    projection_version >= 0 AND projection_version <= 9007199254740991
  ),
  model_execution_started boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, attempt_id),
  UNIQUE (tenant_id, run_id, attempt_id),
  UNIQUE (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id),
  FOREIGN KEY (tenant_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES run_execution_inputs(tenant_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, current_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT execution_attempt_finished_shape_check CHECK (
    (status IN ('waiting', 'succeeded', 'failed', 'cancelled', 'recovery_required', 'abandoned')
      AND finished_at IS NOT NULL)
    OR
    (status IN ('claimed', 'running', 'finalizing') AND finished_at IS NULL)
  )
);

CREATE UNIQUE INDEX execution_attempts_one_active_run_idx
  ON execution_attempts (tenant_id, run_id)
  WHERE status IN ('claimed', 'running', 'finalizing');
CREATE INDEX execution_attempts_recovery_idx
  ON execution_attempts (tenant_id, status, updated_at)
  WHERE status IN ('recovery_required', 'claimed', 'running', 'finalizing');

CREATE TABLE execution_workspace_fences (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0 AND lease_epoch <= 9007199254740991),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  initial_expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, attempt_id),
  UNIQUE (tenant_id, attempt_id, lease_epoch),
  UNIQUE (tenant_id, workspace_id, root_run_id, lease_epoch),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT
);

CREATE TABLE run_claims (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) BETWEEN 1 AND 200),
  claim_token text NOT NULL CHECK (length(claim_token) BETWEEN 1 AND 200),
  claim_epoch bigint NOT NULL CHECK (claim_epoch > 0 AND claim_epoch <= 9007199254740991),
  workspace_lease_epoch bigint NOT NULL CHECK (
    workspace_lease_epoch > 0 AND workspace_lease_epoch <= 9007199254740991
  ),
  expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  PRIMARY KEY (tenant_id, attempt_id),
  UNIQUE (tenant_id, run_id, claim_epoch),
  UNIQUE (tenant_id, claim_token),
  UNIQUE (
    tenant_id, attempt_id, claim_token, claim_epoch, root_run_id, workspace_lease_epoch
  ),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_workspace_fences(tenant_id, attempt_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, attempt_id, workspace_lease_epoch)
    REFERENCES execution_workspace_fences(tenant_id, attempt_id, lease_epoch),
  CONSTRAINT run_claim_release_shape_check CHECK (
    (released_at IS NULL AND expires_at > acquired_at) OR released_at IS NOT NULL
  )
);
CREATE INDEX run_claims_expiry_idx ON run_claims (expires_at) WHERE released_at IS NULL;

CREATE TABLE rollout_projections (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0 AND version <= 9007199254740991),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, run_id, attempt_id)
    REFERENCES execution_attempts(tenant_id, run_id, attempt_id) ON DELETE RESTRICT
);

CREATE TABLE run_events (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0 AND sequence <= 9007199254740991),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  kind text NOT NULL CHECK (kind IN ('agent_event', 'attempt_state_changed', 'run_waiting')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, sequence),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT
);

CREATE TABLE sandbox_registry (
  tenant_id text NOT NULL,
  registry_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  provider_sandbox_id text NOT NULL,
  request_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('acquiring', 'ready', 'pausing', 'paused', 'closing', 'closed', 'unknown')),
  actual_ttl_seconds integer NOT NULL CHECK (actual_ttl_seconds BETWEEN 1 AND 86400),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, registry_id),
  UNIQUE (tenant_id, provider_sandbox_id),
  UNIQUE (tenant_id, attempt_id, registry_id, provider_sandbox_id),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(
      tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id
    ) ON DELETE RESTRICT
);

CREATE TABLE cleanup_outbox (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  idempotency_key text NOT NULL,
  registry_id text NOT NULL,
  provider_sandbox_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'started', 'completed', 'unknown')),
  armed boolean NOT NULL DEFAULT true CHECK (armed),
  armed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  identity_digest text NOT NULL CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
  disposition text CHECK (disposition IN ('pause', 'close')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, idempotency_key),
  FOREIGN KEY (tenant_id, attempt_id, registry_id, provider_sandbox_id)
    REFERENCES sandbox_registry(tenant_id, attempt_id, registry_id, provider_sandbox_id)
    ON DELETE RESTRICT,
  CONSTRAINT cleanup_outbox_disposition_shape_check CHECK (
    (state = 'pending' AND disposition IS NULL)
    OR (state IN ('started', 'completed', 'unknown') AND disposition IS NOT NULL)
  )
);
CREATE INDEX cleanup_outbox_dispatch_idx
  ON cleanup_outbox (tenant_id, state, updated_at) WHERE state IN ('pending', 'started', 'unknown');

CREATE TABLE sandbox_lifecycle_unknown (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_id text NOT NULL,
  provider_sandbox_id text,
  actual_ttl_seconds integer NOT NULL CHECK (actual_ttl_seconds BETWEEN 1 AND 86400),
  stage text NOT NULL CHECK (stage IN ('create_response', 'cleanup_after_create', 'cleanup_after_reconcile')),
  event_payload jsonb NOT NULL CHECK (jsonb_typeof(event_payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, idempotency_key),
  UNIQUE (tenant_id, attempt_id, request_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT
);

CREATE TABLE runtime_alert_outbox (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  idempotency_key text NOT NULL,
  code text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, idempotency_key),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT
);

CREATE TABLE effect_invocations (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  call_id text NOT NULL,
  tool_name text NOT NULL CHECK (length(btrim(tool_name)) BETWEEN 1 AND 200),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, call_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT
);

CREATE TABLE external_effect_permits (
  tenant_id text NOT NULL,
  permit_id text NOT NULL,
  attempt_id text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('model_start', 'tool_execution')),
  call_id text NOT NULL,
  tool_name text NOT NULL,
  args_digest text NOT NULL CHECK (args_digest ~ '^[0-9a-f]{64}$'),
  attempt_version bigint NOT NULL CHECK (attempt_version >= 0 AND attempt_version <= 9007199254740991),
  run_claim_token text NOT NULL,
  run_claim_epoch bigint NOT NULL,
  workspace_root_run_id text NOT NULL,
  workspace_lease_epoch bigint NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, permit_id),
  UNIQUE (tenant_id, attempt_id, effect, call_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, attempt_id, run_claim_token, run_claim_epoch,
    workspace_root_run_id, workspace_lease_epoch
  ) REFERENCES run_claims(
    tenant_id, attempt_id, claim_token, claim_epoch, root_run_id, workspace_lease_epoch
  ) ON DELETE RESTRICT,
  CONSTRAINT external_effect_permit_time_check CHECK (expires_at > issued_at),
  CONSTRAINT external_effect_permit_consume_check CHECK (
    consumed_at IS NULL OR consumed_at >= issued_at
  )
);
CREATE UNIQUE INDEX external_effect_permits_one_model_start_idx
  ON external_effect_permits (tenant_id, attempt_id)
  WHERE effect = 'model_start';

-- Runtime 端口之外仍可能存在受限 SQL 调用方，因此大小和标识边界必须由数据库再次兜底。
ALTER TABLE run_execution_inputs ADD CONSTRAINT run_execution_inputs_byte_size_check CHECK (
  octet_length(run_id) BETWEEN 1 AND 200
  AND octet_length(thread_id) BETWEEN 1 AND 200
  AND octet_length(workspace_id) BETWEEN 1 AND 200
  AND octet_length(root_run_id) BETWEEN 1 AND 200
  AND (base_revision_id IS NULL OR octet_length(base_revision_id) BETWEEN 1 AND 200)
  AND octet_length(input_text) BETWEEN 1 AND 1048576
  AND (answer_text IS NULL OR octet_length(answer_text) BETWEEN 1 AND 1048576)
  AND octet_length(initial_projection::text) <= 65536
);
ALTER TABLE execution_attempts ADD CONSTRAINT execution_attempts_identifier_size_check CHECK (
  octet_length(attempt_id) BETWEEN 1 AND 200
  AND octet_length(run_id) BETWEEN 1 AND 200
  AND octet_length(thread_id) BETWEEN 1 AND 200
  AND octet_length(workspace_id) BETWEEN 1 AND 200
  AND octet_length(root_run_id) BETWEEN 1 AND 200
);
ALTER TABLE run_claims ADD CONSTRAINT run_claims_identifier_size_check CHECK (
  octet_length(worker_id) BETWEEN 1 AND 200
  AND octet_length(claim_token) BETWEEN 1 AND 200
);
ALTER TABLE rollout_projections ADD CONSTRAINT rollout_projections_byte_size_check CHECK (
  octet_length(projection::text) <= 65536
);
ALTER TABLE run_events ADD CONSTRAINT run_events_payload_byte_size_check CHECK (
  octet_length(payload::text) <= 65536
);
ALTER TABLE sandbox_registry ADD CONSTRAINT sandbox_registry_identifier_size_check CHECK (
  octet_length(registry_id) BETWEEN 1 AND 200
  AND octet_length(provider_sandbox_id) BETWEEN 1 AND 200
  AND octet_length(request_id) BETWEEN 1 AND 200
);
ALTER TABLE cleanup_outbox ADD CONSTRAINT cleanup_outbox_byte_size_check CHECK (
  octet_length(idempotency_key) BETWEEN 1 AND 512
  AND octet_length(registry_id) BETWEEN 1 AND 200
  AND octet_length(provider_sandbox_id) BETWEEN 1 AND 200
  AND octet_length(payload::text) <= 65536
);
ALTER TABLE sandbox_lifecycle_unknown
  ADD CONSTRAINT sandbox_lifecycle_unknown_byte_size_check CHECK (
    octet_length(idempotency_key) BETWEEN 1 AND 512
    AND octet_length(request_id) BETWEEN 1 AND 200
    AND (provider_sandbox_id IS NULL OR octet_length(provider_sandbox_id) BETWEEN 1 AND 200)
    AND octet_length(event_payload::text) <= 65536
  );
ALTER TABLE runtime_alert_outbox ADD CONSTRAINT runtime_alert_outbox_byte_size_check CHECK (
  octet_length(idempotency_key) BETWEEN 1 AND 512
  AND octet_length(payload::text) <= 65536
);
ALTER TABLE effect_invocations ADD CONSTRAINT effect_invocations_identifier_size_check CHECK (
  octet_length(call_id) BETWEEN 1 AND 200
  AND octet_length(tool_name) BETWEEN 1 AND 200
);
ALTER TABLE external_effect_permits
  ADD CONSTRAINT external_effect_permits_identifier_size_check CHECK (
    octet_length(permit_id) BETWEEN 1 AND 200
    AND octet_length(call_id) BETWEEN 1 AND 200
    AND octet_length(tool_name) BETWEEN 1 AND 200
    AND octet_length(run_claim_token) BETWEEN 1 AND 200
    AND octet_length(workspace_root_run_id) BETWEEN 1 AND 200
  );
CREATE TABLE mutation_receipts (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  idempotency_key text NOT NULL,
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  previous_attempt_version bigint NOT NULL CHECK (previous_attempt_version >= 0),
  attempt_version bigint NOT NULL CHECK (attempt_version = previous_attempt_version + 1),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  database_now timestamptz NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, idempotency_key),
  UNIQUE (tenant_id, run_id, idempotency_key),
  FOREIGN KEY (tenant_id, run_id, attempt_id)
    REFERENCES execution_attempts(tenant_id, run_id, attempt_id) ON DELETE RESTRICT
);
ALTER TABLE mutation_receipts ADD CONSTRAINT mutation_receipts_byte_size_check CHECK (
  octet_length(idempotency_key) BETWEEN 1 AND 512
  AND octet_length(receipt::text) <= 65536
  AND octet_length(result_snapshot::text) <= 65536
);

-- 每张业务表都强制 Tenant RLS；Runtime 角色不是 owner 且不能 BYPASSRLS。
ALTER TABLE run_execution_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_execution_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY run_execution_inputs_tenant_policy ON run_execution_inputs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE execution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_attempts_tenant_policy ON execution_attempts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE execution_workspace_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_workspace_fences FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_workspace_fences_tenant_policy ON execution_workspace_fences
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE run_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY run_claims_tenant_policy ON run_claims
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE rollout_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE rollout_projections FORCE ROW LEVEL SECURITY;
CREATE POLICY rollout_projections_tenant_policy ON rollout_projections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY run_events_tenant_policy ON run_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE sandbox_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_registry_tenant_policy ON sandbox_registry
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE cleanup_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleanup_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY cleanup_outbox_tenant_policy ON cleanup_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE sandbox_lifecycle_unknown ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_lifecycle_unknown FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_lifecycle_unknown_tenant_policy ON sandbox_lifecycle_unknown
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE runtime_alert_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_alert_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_alert_outbox_tenant_policy ON runtime_alert_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE effect_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE effect_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY effect_invocations_tenant_policy ON effect_invocations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE external_effect_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_effect_permits FORCE ROW LEVEL SECURITY;
CREATE POLICY external_effect_permits_tenant_policy ON external_effect_permits
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE mutation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY mutation_receipts_tenant_policy ON mutation_receipts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
