ALTER TABLE thread_history_directories
  DROP CONSTRAINT thread_history_directories_naming_state_check,
  ADD CONSTRAINT thread_history_directories_naming_state_check
    CHECK (naming_state IN ('pending', 'ready', 'fallback'));

CREATE TABLE thread_title_generation_outbox (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  source_receipt_id text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  expected_title_generation_version integer NOT NULL
    CHECK (expected_title_generation_version >= 0),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'claimed', 'succeeded', 'fallback', 'superseded')),
  claim_token text,
  claim_generation bigint NOT NULL DEFAULT 0
    CHECK (claim_generation >= 0 AND claim_generation <= 9007199254740991),
  claimed_by text,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'MODEL_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'INVALID_RESPONSE', 'INVALID_TITLE'
    )
  ),
  model_key text CHECK (model_key IS NULL OR model_key ~ '^[a-f0-9]{64}$'),
  prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id, source_receipt_id)
    REFERENCES thread_input_receipts(tenant_id, thread_id, receipt_id) ON DELETE RESTRICT,
  CONSTRAINT thread_title_generation_outbox_claim_check CHECK (
    (state = 'claimed' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL
      AND claim_expires_at IS NOT NULL)
    OR
    (state <> 'claimed' AND claim_token IS NULL AND claimed_by IS NULL
      AND claim_expires_at IS NULL)
  ),
  CONSTRAINT thread_title_generation_outbox_completion_check CHECK (
    (state IN ('succeeded', 'fallback', 'superseded')) = (completed_at IS NOT NULL)
  )
);

CREATE INDEX thread_title_generation_outbox_claim_idx
  ON thread_title_generation_outbox(tenant_id, next_attempt_at, created_at, thread_id)
  WHERE state IN ('pending', 'claimed');

ALTER TABLE thread_title_generation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_title_generation_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_title_generation_outbox_tenant_policy ON thread_title_generation_outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
