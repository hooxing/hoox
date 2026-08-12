ALTER TABLE runtime_agent_mailbox_messages
  DROP CONSTRAINT runtime_agent_mailbox_terminal_status_check,
  DROP COLUMN error_code,
  DROP COLUMN terminal_status;
