-- ADR-0153：成功 Run 只在本地事务登记记忆任务，第三方提交由异步消费者完成。
CREATE TABLE memory_ingestion_outbox (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  attempt_id text NOT NULL,
  subject_user_id text NOT NULL CHECK (octet_length(subject_user_id) BETWEEN 1 AND 200),
  tenant_kind text NOT NULL CHECK (tenant_kind IN ('personal', 'team')),
  source_through_sequence bigint NOT NULL
    CHECK (source_through_sequence BETWEEN 1 AND 9007199254740991),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'claimed', 'submitted', 'succeeded', 'failed')),
  provider_event_id uuid,
  claim_token text,
  claim_generation bigint NOT NULL DEFAULT 0
    CHECK (claim_generation BETWEEN 0 AND 9007199254740991),
  claimed_by text CHECK (claimed_by IS NULL OR octet_length(claimed_by) BETWEEN 1 AND 200),
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'TIMEOUT', 'PROVIDER_UNAVAILABLE', 'INVALID_RESPONSE', 'REQUEST_REJECTED'
    )
  ),
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, run_id, thread_id) REFERENCES runs(tenant_id, id, thread_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES execution_attempts(tenant_id, attempt_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES memberships(tenant_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT memory_ingestion_outbox_claim_shape_check CHECK (
    (state = 'claimed' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL
      AND claim_expires_at IS NOT NULL)
    OR
    (state <> 'claimed' AND claim_token IS NULL AND claimed_by IS NULL
      AND claim_expires_at IS NULL)
  ),
  CONSTRAINT memory_ingestion_outbox_provider_shape_check CHECK (
    (state = 'pending' AND provider_event_id IS NULL AND submitted_at IS NULL)
    OR (state = 'claimed')
    OR (state IN ('submitted', 'succeeded') AND provider_event_id IS NOT NULL
      AND submitted_at IS NOT NULL)
    OR (state = 'failed')
  ),
  CONSTRAINT memory_ingestion_outbox_completion_shape_check CHECK (
    (state IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)
  )
);

CREATE INDEX memory_ingestion_outbox_claim_idx
  ON memory_ingestion_outbox(tenant_id, next_attempt_at, created_at, run_id)
  WHERE state IN ('pending', 'claimed', 'submitted');

ALTER TABLE memory_ingestion_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ingestion_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_ingestion_outbox_tenant_policy ON memory_ingestion_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
