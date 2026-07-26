-- 0005 由 Run dispatch 预留；cleanup 消费事实从 0006 开始，避免并行分支竞争版本号。
ALTER TABLE cleanup_outbox
  ADD COLUMN claim_token text,
  ADD COLUMN claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  ADD COLUMN claimed_by text,
  ADD COLUMN claim_lease_expires_at timestamptz,
  ADD COLUMN retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN remote_call_started_at timestamptz;

ALTER TABLE cleanup_outbox ADD CONSTRAINT cleanup_outbox_consumer_claim_shape_check CHECK (
  (claim_token IS NULL AND claimed_by IS NULL AND claim_lease_expires_at IS NULL)
  OR (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND claim_lease_expires_at IS NOT NULL)
);
ALTER TABLE cleanup_outbox ADD CONSTRAINT cleanup_outbox_remote_call_shape_check CHECK (
  remote_call_started_at IS NULL OR (state = 'started' AND disposition = 'close')
);
CREATE INDEX cleanup_outbox_consumer_claim_idx
  ON cleanup_outbox (tenant_id, retry_at, claim_lease_expires_at)
  WHERE state IN ('pending','started');
