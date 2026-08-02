ALTER TABLE thread_input_receipts
  DROP CONSTRAINT thread_input_receipts_attachments_check,
  DROP COLUMN input_attachments;

DROP FUNCTION runtime_valid_user_input_attachments(jsonb);
