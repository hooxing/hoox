ALTER TABLE thread_input_receipts
  DROP CONSTRAINT thread_input_receipts_attachments_check,
  DROP COLUMN input_attachments;
