ALTER TABLE threads
  ADD COLUMN has_client_tool_history boolean NOT NULL DEFAULT false;

UPDATE threads AS thread
   SET has_client_tool_history=true
 WHERE EXISTS (
   SELECT 1 FROM client_tool_calls AS call
    WHERE call.tenant_id=thread.tenant_id AND call.thread_id=thread.id
 );
