ALTER TABLE cleanup_outbox DROP CONSTRAINT cleanup_outbox_remote_call_shape_check;
ALTER TABLE cleanup_outbox DROP CONSTRAINT cleanup_outbox_consumer_value_size_check;
ALTER TABLE cleanup_outbox DROP CONSTRAINT cleanup_outbox_consumer_claim_shape_check;
DROP INDEX cleanup_outbox_consumer_claim_idx;
ALTER TABLE cleanup_outbox
  DROP COLUMN remote_call_started_at,
  DROP COLUMN attempt_count,
  DROP COLUMN retry_at,
  DROP COLUMN claim_lease_expires_at,
  DROP COLUMN claimed_by,
  DROP COLUMN claim_generation,
  DROP COLUMN claim_token;
