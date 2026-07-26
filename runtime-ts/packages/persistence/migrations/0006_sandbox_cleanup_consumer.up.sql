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
  -- pause 也是不可判定的远端调用；崩溃后同样只能进入 unknown，不能被恢复为 close。
  remote_call_started_at IS NULL OR (state IN ('started', 'completed', 'unknown') AND disposition IN ('pause', 'close'))
);
ALTER TABLE cleanup_outbox ADD CONSTRAINT cleanup_outbox_consumer_value_size_check CHECK (
  (claim_token IS NULL OR octet_length(claim_token) BETWEEN 1 AND 512)
  AND (claimed_by IS NULL OR octet_length(claimed_by) BETWEEN 1 AND 200)
  AND claim_generation <= 9007199254740991
  AND attempt_count <= 2147483647
);
CREATE INDEX cleanup_outbox_consumer_claim_idx
  ON cleanup_outbox (tenant_id, retry_at, claim_lease_expires_at)
  WHERE state IN ('pending','started');
