-- ADR-0063：旧 /runs 在 V2 开关开启时先保存不可变输入，再进入 Thread FIFO。
CREATE TABLE thread_input_receipts (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  receipt_id text NOT NULL CHECK (octet_length(receipt_id) BETWEEN 1 AND 200),
  client_request_id text NOT NULL CHECK (octet_length(client_request_id) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  requested_mode text NOT NULL CHECK (requested_mode = 'follow_up'),
  state text NOT NULL CHECK (state IN ('pending', 'consumed', 'cancelled', 'rejected')),
  disposition text NOT NULL CHECK (disposition IN ('queued', 'cancelled', 'rejected')),
  queued_run_id text NOT NULL,
  queue_sequence bigint NOT NULL CHECK (queue_sequence BETWEEN 1 AND 9007199254740991),
  input_text text NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  body_size_bytes bigint NOT NULL CHECK (body_size_bytes BETWEEN 1 AND 1048576),
  applied_context_sequence bigint CHECK (
    applied_context_sequence BETWEEN 0 AND 9007199254740991
  ),
  rejection_code text,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, thread_id, receipt_id),
  UNIQUE (tenant_id, thread_id, client_request_id),
  UNIQUE (tenant_id, thread_id, queued_run_id),
  UNIQUE (tenant_id, thread_id, queue_sequence),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, queued_run_id, thread_id)
    REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  CONSTRAINT thread_input_receipt_body_check CHECK (
    octet_length(input_text) = body_size_bytes AND input_text ~ '[^[:space:]]'
  ),
  CONSTRAINT thread_input_receipt_state_shape_check CHECK (
    (state = 'pending' AND disposition = 'queued' AND consumed_at IS NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL)
    OR (state = 'consumed' AND disposition = 'queued' AND consumed_at IS NOT NULL
      AND rejection_code IS NULL)
    OR (state = 'cancelled' AND disposition = 'cancelled' AND consumed_at IS NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL)
    OR (state = 'rejected' AND disposition = 'rejected' AND consumed_at IS NOT NULL
      AND rejection_code IS NOT NULL)
  )
);

CREATE TABLE thread_follow_up_queue (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  queue_sequence bigint NOT NULL CHECK (queue_sequence BETWEEN 1 AND 9007199254740991),
  turn_ordinal bigint NOT NULL CHECK (turn_ordinal BETWEEN 1 AND 9007199254740991),
  receipt_id text NOT NULL,
  run_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'active', 'finished', 'failed', 'cancelled')),
  claim_owner text,
  claim_token text,
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch BETWEEN 0 AND 9007199254740991),
  claim_expires_at timestamptz,
  consumption_receipt jsonb,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, thread_id, queue_sequence),
  UNIQUE (tenant_id, thread_id, turn_ordinal),
  UNIQUE (tenant_id, thread_id, receipt_id),
  UNIQUE (tenant_id, thread_id, run_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, run_id, thread_id)
    REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id, receipt_id)
    REFERENCES thread_input_receipts(tenant_id, thread_id, receipt_id) ON DELETE RESTRICT,
  CONSTRAINT thread_follow_up_queue_claim_shape_check CHECK (
    (
      claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL
    ) OR (
      state = 'active'
      AND octet_length(claim_owner) BETWEEN 1 AND 200
      AND octet_length(claim_token) BETWEEN 1 AND 200
      AND claim_epoch > 0
      AND claim_expires_at IS NOT NULL
    )
  ),
  CONSTRAINT thread_follow_up_queue_state_shape_check CHECK (
    (state = 'queued' AND activated_at IS NULL AND finished_at IS NULL
      AND consumption_receipt IS NULL)
    OR (state = 'active' AND activated_at IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('finished', 'failed', 'cancelled') AND finished_at IS NOT NULL
      AND consumption_receipt IS NOT NULL)
  )
);
CREATE UNIQUE INDEX thread_follow_up_queue_one_active_idx
  ON thread_follow_up_queue(tenant_id, thread_id) WHERE state = 'active';
CREATE INDEX thread_follow_up_queue_fifo_idx
  ON thread_follow_up_queue(tenant_id, thread_id, queue_sequence) WHERE state = 'queued';

-- 阶段 1 只固定激活瞬间的 cursor；不创建 Thread Context facts 或读取路径。
ALTER TABLE run_execution_inputs ADD COLUMN context_through_sequence bigint CHECK (
  context_through_sequence BETWEEN 0 AND 9007199254740991
);

ALTER TABLE thread_input_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_input_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_input_receipts_tenant_policy ON thread_input_receipts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE thread_follow_up_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_follow_up_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_follow_up_queue_tenant_policy ON thread_follow_up_queue
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
