ALTER TABLE runtime_subagent_conversations
  DROP CONSTRAINT runtime_subagent_conversation_current_task_check,
  DROP COLUMN current_task;
