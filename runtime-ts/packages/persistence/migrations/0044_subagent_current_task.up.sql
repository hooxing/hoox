ALTER TABLE runtime_subagent_conversations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_subagent_conversations DISABLE ROW LEVEL SECURITY;

ALTER TABLE runtime_subagent_conversations
  ADD COLUMN current_task text;

UPDATE runtime_subagent_conversations
   SET current_task = task;

ALTER TABLE runtime_subagent_conversations
  ALTER COLUMN current_task SET NOT NULL,
  ADD CONSTRAINT runtime_subagent_conversation_current_task_check CHECK (
    octet_length(current_task) BETWEEN 1 AND 32768
  );

ALTER TABLE runtime_subagent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_subagent_conversations FORCE ROW LEVEL SECURITY;
