ALTER TABLE runtime_agent_mailbox_messages
  ADD COLUMN terminal_status text,
  ADD COLUMN error_code text;

UPDATE runtime_agent_mailbox_messages
   SET terminal_status = CASE kind
       WHEN 'final_answer' THEN 'completed'
       WHEN 'error' THEN 'failed'
       ELSE NULL
     END,
       error_code = CASE kind
       WHEN 'error' THEN 'LEGACY_SUBAGENT_ERROR'
       ELSE NULL
     END;

ALTER TABLE runtime_agent_mailbox_messages
  ADD CONSTRAINT runtime_agent_mailbox_terminal_status_check CHECK (
    (kind = 'message' AND terminal_status IS NULL AND error_code IS NULL)
    OR (kind = 'final_answer' AND terminal_status = 'completed' AND error_code IS NULL)
    OR (
      kind = 'error'
      AND terminal_status IN ('interrupted', 'failed')
      AND error_code IS NOT NULL
      AND octet_length(error_code) BETWEEN 1 AND 200
    )
  );
