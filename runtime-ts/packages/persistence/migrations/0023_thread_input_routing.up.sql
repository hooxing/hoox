-- ADR-0067 / 阶段 3：统一 receipt 顺序、durable steer 与 disposition 事件。
ALTER TABLE thread_execution_heads
  ADD COLUMN next_input_sequence bigint NOT NULL DEFAULT 1 CHECK (
    next_input_sequence BETWEEN 1 AND 9007199254740991
  );

UPDATE thread_execution_heads
   SET next_input_sequence=next_queue_sequence;

UPDATE thread_execution_heads head
   SET active_turn_id='turn-' || queue.turn_ordinal::text
  FROM thread_follow_up_queue queue
 WHERE queue.tenant_id=head.tenant_id AND queue.thread_id=head.thread_id
   AND queue.run_id=head.active_run_id AND queue.state='active';

ALTER TABLE thread_execution_heads
  ADD CONSTRAINT thread_execution_head_active_turn_id_check CHECK (
    active_turn_id IS NULL OR active_turn_id ~ '^turn-[1-9][0-9]{0,15}$'
  );

ALTER TABLE thread_input_receipts
  DROP CONSTRAINT thread_input_receipts_requested_mode_check,
  DROP CONSTRAINT thread_input_receipts_disposition_check,
  DROP CONSTRAINT thread_input_receipt_state_shape_check,
  DROP CONSTRAINT thread_input_receipt_body_check,
  ALTER COLUMN queued_run_id DROP NOT NULL,
  ALTER COLUMN queue_sequence DROP NOT NULL,
  ADD COLUMN input_sequence bigint,
  ADD COLUMN expected_run_id text,
  ADD COLUMN expected_turn_id text,
  ADD COLUMN fallback_to_follow_up boolean NOT NULL DEFAULT false,
  ADD COLUMN target_run_id text,
  ADD COLUMN target_turn_id text,
  ADD COLUMN fallback_run_id text;

UPDATE thread_input_receipts SET input_sequence=queue_sequence;

ALTER TABLE thread_input_receipts
  ALTER COLUMN input_sequence SET NOT NULL,
  ADD CONSTRAINT thread_input_receipts_input_sequence_key UNIQUE (
    tenant_id,thread_id,input_sequence
  ),
  ADD CONSTRAINT thread_input_receipts_requested_mode_check CHECK (
    requested_mode IN ('auto','steer','follow_up')
  ),
  ADD CONSTRAINT thread_input_receipts_disposition_check CHECK (
    disposition IN ('pending_steer','steered','queued','cancelled','rejected')
  ),
  ADD CONSTRAINT thread_input_receipts_identity_check CHECK (
    (expected_run_id IS NULL OR octet_length(expected_run_id) BETWEEN 1 AND 200)
    AND (expected_turn_id IS NULL OR octet_length(expected_turn_id) BETWEEN 1 AND 200)
    AND (target_run_id IS NULL OR octet_length(target_run_id) BETWEEN 1 AND 200)
    AND (target_turn_id IS NULL OR target_turn_id ~ '^turn-[1-9][0-9]{0,15}$')
    AND (fallback_run_id IS NULL OR octet_length(fallback_run_id) BETWEEN 1 AND 200)
  ),
  ADD CONSTRAINT thread_input_receipts_target_run_fk FOREIGN KEY (
    tenant_id,target_run_id,thread_id
  ) REFERENCES runs(tenant_id,id,thread_id) ON DELETE RESTRICT,
  ADD CONSTRAINT thread_input_receipts_body_check CHECK (
    body_size_bytes BETWEEN 1 AND 1048576
    AND octet_length(input_text)=body_size_bytes
    AND input_text ~ '[^[:space:]]'
  ),
  ADD CONSTRAINT thread_input_receipts_state_shape_check CHECK (
    (
      state='pending' AND disposition='pending_steer'
      AND target_run_id IS NOT NULL AND target_turn_id IS NOT NULL
      AND queued_run_id IS NULL AND queue_sequence IS NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL
      AND consumed_at IS NULL
    ) OR (
      state='pending' AND disposition='queued'
      AND queued_run_id IS NOT NULL AND queue_sequence IS NOT NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL
      AND consumed_at IS NULL
    ) OR (
      state='consumed' AND disposition='steered'
      AND target_run_id IS NOT NULL AND target_turn_id IS NOT NULL
      AND queued_run_id IS NULL AND queue_sequence IS NULL
      AND applied_context_sequence IS NOT NULL AND rejection_code IS NULL
      AND consumed_at IS NOT NULL
    ) OR (
      state='consumed' AND disposition='queued'
      AND queued_run_id IS NOT NULL AND queue_sequence IS NOT NULL
      AND applied_context_sequence IS NULL AND rejection_code IS NULL
      AND consumed_at IS NOT NULL
    ) OR (
      state='cancelled' AND disposition='cancelled'
      AND applied_context_sequence IS NULL AND rejection_code IS NULL
      AND consumed_at IS NULL
    ) OR (
      state='rejected' AND disposition='rejected'
      AND applied_context_sequence IS NULL AND rejection_code IS NOT NULL
      AND consumed_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX thread_input_receipts_fallback_run_key
  ON thread_input_receipts(tenant_id,thread_id,fallback_run_id)
  WHERE fallback_run_id IS NOT NULL;

CREATE INDEX thread_input_receipts_pending_steer_idx
  ON thread_input_receipts(tenant_id,thread_id,target_run_id,input_sequence)
  WHERE state='pending' AND disposition='pending_steer';

CREATE TABLE thread_input_receipt_events (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  receipt_id text NOT NULL,
  event_sequence integer NOT NULL CHECK (event_sequence BETWEEN 1 AND 32),
  event_kind text NOT NULL CHECK (event_kind IN ('accepted','disposition_changed')),
  disposition text NOT NULL CHECK (
    disposition IN ('pending_steer','steered','queued','cancelled','rejected')
  ),
  target_run_id text,
  target_turn_id text,
  queued_run_id text,
  queue_sequence bigint,
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id,receipt_id,event_sequence),
  FOREIGN KEY (tenant_id,thread_id,receipt_id)
    REFERENCES thread_input_receipts(tenant_id,thread_id,receipt_id) ON DELETE RESTRICT,
  CONSTRAINT thread_input_receipt_event_shape_check CHECK (
    (disposition IN ('pending_steer','steered')
      AND target_run_id IS NOT NULL AND target_turn_id IS NOT NULL
      AND queued_run_id IS NULL AND queue_sequence IS NULL AND rejection_code IS NULL)
    OR (disposition='queued' AND queued_run_id IS NOT NULL AND queue_sequence IS NOT NULL
      AND rejection_code IS NULL)
    OR (disposition='cancelled' AND rejection_code IS NULL)
    OR (disposition='rejected' AND rejection_code IS NOT NULL)
  )
);

ALTER TABLE thread_input_receipt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_input_receipt_events FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_input_receipt_events_tenant_policy ON thread_input_receipt_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
