DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM thread_input_receipt_events LIMIT 1)
     OR EXISTS (
       SELECT 1 FROM thread_input_receipts
        WHERE requested_mode <> 'follow_up'
           OR disposition NOT IN ('queued','cancelled','rejected')
     ) THEN
    RAISE EXCEPTION '阶段 3 input receipt/event 非空，拒绝破坏性回滚';
  END IF;
END $$;

DROP TABLE thread_input_receipt_events;

DROP INDEX thread_input_receipts_pending_steer_idx;
DROP INDEX thread_input_receipts_fallback_run_key;

ALTER TABLE thread_input_receipts
  DROP CONSTRAINT thread_input_receipts_state_shape_check,
  DROP CONSTRAINT thread_input_receipts_body_check,
  DROP CONSTRAINT thread_input_receipts_identity_check,
  DROP CONSTRAINT thread_input_receipts_target_run_fk,
  DROP CONSTRAINT thread_input_receipts_disposition_check,
  DROP CONSTRAINT thread_input_receipts_requested_mode_check,
  DROP CONSTRAINT thread_input_receipts_input_sequence_key,
  DROP COLUMN fallback_run_id,
  DROP COLUMN target_turn_id,
  DROP COLUMN target_run_id,
  DROP COLUMN fallback_to_follow_up,
  DROP COLUMN expected_turn_id,
  DROP COLUMN expected_run_id,
  DROP COLUMN input_sequence,
  ALTER COLUMN queued_run_id SET NOT NULL,
  ALTER COLUMN queue_sequence SET NOT NULL,
  ADD CONSTRAINT thread_input_receipts_requested_mode_check CHECK (requested_mode='follow_up'),
  ADD CONSTRAINT thread_input_receipts_disposition_check CHECK (
    disposition IN ('queued','cancelled','rejected')
  ),
  ADD CONSTRAINT thread_input_receipt_body_check CHECK (
    octet_length(input_text)=body_size_bytes AND input_text ~ '[^[:space:]]'
  ),
  ADD CONSTRAINT thread_input_receipt_state_shape_check CHECK (
    (state='pending' AND disposition='queued' AND consumed_at IS NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL)
    OR (state='consumed' AND disposition='queued' AND consumed_at IS NOT NULL
      AND rejection_code IS NULL)
    OR (state='cancelled' AND disposition='cancelled' AND consumed_at IS NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL)
    OR (state='rejected' AND disposition='rejected' AND consumed_at IS NOT NULL
      AND rejection_code IS NOT NULL)
  );

ALTER TABLE thread_execution_heads
  DROP CONSTRAINT thread_execution_head_active_turn_id_check,
  DROP COLUMN next_input_sequence;
