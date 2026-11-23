ALTER TABLE threads
  ADD COLUMN has_client_tool_history boolean NOT NULL DEFAULT false;

-- Migrator 不持有 BYPASSRLS；该全租户回填仅在迁移事务内暂时关闭 RLS，并在提交前恢复。
ALTER TABLE client_tool_calls DISABLE ROW LEVEL SECURITY;
ALTER TABLE threads DISABLE ROW LEVEL SECURITY;

UPDATE threads AS thread
   SET has_client_tool_history=true
 WHERE EXISTS (
   SELECT 1 FROM client_tool_calls AS call
    WHERE call.tenant_id=thread.tenant_id AND call.thread_id=thread.id
 );

ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
ALTER TABLE client_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_tool_calls FORCE ROW LEVEL SECURITY;
