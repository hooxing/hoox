-- ADR-0069：Thread/Workspace Sandbox 只是可验证缓存；Workspace Revision 与 Thread Context
-- 仍是事实源。Session、唯一 lease 与外部 lifecycle effect 分表保存，UNKNOWN 永不自动重试。
CREATE TABLE thread_sandbox_sessions (
  tenant_id text NOT NULL,
  session_id text NOT NULL CHECK (octet_length(session_id) BETWEEN 8 AND 200),
  thread_id text NOT NULL,
  workspace_id text NOT NULL,
  registry_id text NOT NULL CHECK (octet_length(registry_id) BETWEEN 8 AND 200),
  provider_sandbox_id text NOT NULL CHECK (octet_length(provider_sandbox_id) BETWEEN 1 AND 200),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  state text NOT NULL CHECK (
    state IN ('running', 'pausing', 'paused', 'resuming', 'terminated', 'unknown')
  ),
  materialized_revision_id text,
  materialization_attested boolean NOT NULL DEFAULT false,
  paused_at timestamptz,
  retention_expires_at timestamptz,
  current_effect_id text,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  terminated_at timestamptz,
  PRIMARY KEY (tenant_id, session_id),
  UNIQUE (tenant_id, registry_id),
  -- Provider 账号下的 ID 是全局 capability；一旦登记就不能跨 Tenant/generation 重放。
  UNIQUE (provider_sandbox_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, thread_id)
    REFERENCES workspaces(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, materialized_revision_id)
    REFERENCES workspace_revisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT thread_sandbox_session_state_shape_check CHECK (
    (state = 'running' AND current_effect_id IS NULL
      AND paused_at IS NULL AND retention_expires_at IS NULL AND terminated_at IS NULL)
    OR (state IN ('pausing', 'resuming') AND current_effect_id IS NOT NULL
      AND terminated_at IS NULL)
    OR (state = 'paused' AND paused_at IS NOT NULL AND retention_expires_at IS NOT NULL
      AND current_effect_id IS NULL AND terminated_at IS NULL
      AND retention_expires_at > paused_at)
    OR (state = 'terminated' AND current_effect_id IS NULL AND terminated_at IS NOT NULL)
    OR (state = 'unknown' AND current_effect_id IS NOT NULL AND terminated_at IS NULL)
  )
);

-- unknown 已被隔离，允许 cold rebuild 新 generation；可复用状态同一 Thread/Workspace 仍只有一个。
CREATE UNIQUE INDEX thread_sandbox_sessions_one_reusable_idx
  ON thread_sandbox_sessions(tenant_id, thread_id, workspace_id)
  WHERE state IN ('running', 'pausing', 'paused', 'resuming');
CREATE INDEX thread_sandbox_sessions_retention_idx
  ON thread_sandbox_sessions(tenant_id, retention_expires_at)
  WHERE state = 'paused';

CREATE TABLE thread_sandbox_leases (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  lease_id text NOT NULL CHECK (octet_length(lease_id) BETWEEN 8 AND 200),
  lease_token text NOT NULL CHECK (octet_length(lease_token) BETWEEN 16 AND 200),
  lease_epoch bigint NOT NULL CHECK (lease_epoch BETWEEN 1 AND 9007199254740991),
  run_id text NOT NULL,
  attempt_id text,
  owner text NOT NULL CHECK (octet_length(owner) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, session_id, lease_id),
  UNIQUE (tenant_id, lease_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES thread_sandbox_sessions(tenant_id, session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES execution_attempts(tenant_id, attempt_id) ON DELETE RESTRICT,
  CONSTRAINT thread_sandbox_lease_time_check CHECK (expires_at > created_at),
  CONSTRAINT thread_sandbox_lease_release_check CHECK (
    released_at IS NULL OR released_at >= created_at
  )
);
CREATE UNIQUE INDEX thread_sandbox_leases_one_unreleased_idx
  ON thread_sandbox_leases(tenant_id, session_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX thread_sandbox_leases_one_run_idx
  ON thread_sandbox_leases(tenant_id, run_id) WHERE released_at IS NULL;

CREATE TABLE sandbox_lifecycle_effects (
  tenant_id text NOT NULL,
  effect_id text NOT NULL CHECK (octet_length(effect_id) BETWEEN 8 AND 200),
  operation_id text NOT NULL CHECK (octet_length(operation_id) BETWEEN 8 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  session_id text NOT NULL CHECK (octet_length(session_id) BETWEEN 8 AND 200),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  effect_kind text NOT NULL CHECK (effect_kind IN ('create', 'pause', 'resume', 'terminate')),
  state text NOT NULL CHECK (
    state IN ('pending', 'started', 'succeeded', 'failed_not_applied', 'unknown')
  ),
  run_id text,
  attempt_id text,
  provider_sandbox_id text,
  expected_session_state text CHECK (
    expected_session_state IN ('running', 'pausing', 'paused', 'resuming', 'terminated', 'unknown')
  ),
  resulting_session_state text CHECK (
    resulting_session_state IN ('running', 'paused', 'terminated')
  ),
  provider_receipt_digest text CHECK (provider_receipt_digest ~ '^[0-9a-f]{64}$'),
  claim_token text,
  claimed_by text,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (
    claim_generation BETWEEN 0 AND 9007199254740991
  ),
  claim_expires_at timestamptz,
  remote_call_started_at timestamptz,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, effect_id),
  UNIQUE (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES execution_attempts(tenant_id, attempt_id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_lifecycle_effect_claim_shape_check CHECK (
    (claim_token IS NULL AND claimed_by IS NULL AND claim_expires_at IS NULL)
    OR (state IN ('started', 'unknown') AND octet_length(claim_token) BETWEEN 16 AND 200
      AND octet_length(claimed_by) BETWEEN 1 AND 200 AND claim_expires_at IS NOT NULL)
  ),
  CONSTRAINT sandbox_lifecycle_effect_state_shape_check CHECK (
    (state = 'pending' AND remote_call_started_at IS NULL AND completed_at IS NULL)
    OR (state = 'started' AND completed_at IS NULL)
    OR (state IN ('succeeded', 'failed_not_applied', 'unknown') AND completed_at IS NOT NULL)
  )
);
CREATE INDEX sandbox_lifecycle_effects_pending_idx
  ON sandbox_lifecycle_effects(tenant_id, created_at)
  WHERE state IN ('pending', 'started', 'unknown');

ALTER TABLE thread_sandbox_sessions
  ADD CONSTRAINT thread_sandbox_sessions_current_effect_fk
  FOREIGN KEY (tenant_id, current_effect_id)
  REFERENCES sandbox_lifecycle_effects(tenant_id, effect_id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE thread_sandbox_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_sandbox_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_sandbox_sessions_tenant_policy ON thread_sandbox_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE thread_sandbox_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_sandbox_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_sandbox_leases_tenant_policy ON thread_sandbox_leases
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE sandbox_lifecycle_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_lifecycle_effects FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_lifecycle_effects_tenant_policy ON sandbox_lifecycle_effects
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
