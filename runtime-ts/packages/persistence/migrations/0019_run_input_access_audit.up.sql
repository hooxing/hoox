ALTER TABLE admin_run_content_access_audits
  ALTER COLUMN attempt_id DROP NOT NULL,
  ADD COLUMN query_summary jsonb,
  ADD COLUMN returned_run_count integer CHECK (returned_run_count IS NULL OR returned_run_count >= 0);
