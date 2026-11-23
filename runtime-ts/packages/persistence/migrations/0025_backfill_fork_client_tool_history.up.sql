-- 跨租户历史回填仅在迁移事务内暂时关闭 RLS，迁移提交前恢复 FORCE RLS。
ALTER TABLE client_tool_calls DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_forks DISABLE ROW LEVEL SECURITY;
ALTER TABLE threads DISABLE ROW LEVEL SECURITY;

WITH RECURSIVE sensitive_threads(tenant_id, thread_id) AS (
  SELECT tenant_id, thread_id FROM client_tool_calls
  UNION
  SELECT fork.tenant_id, fork.child_thread_id
    FROM thread_forks AS fork
    JOIN sensitive_threads AS source
      ON source.tenant_id=fork.source_tenant_id
     AND source.thread_id=fork.source_thread_id
)
UPDATE threads AS thread
   SET has_client_tool_history=true
  FROM sensitive_threads AS sensitive
 WHERE sensitive.tenant_id=thread.tenant_id
   AND sensitive.thread_id=thread.id
   AND thread.has_client_tool_history=false;

ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_forks ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_forks FORCE ROW LEVEL SECURITY;
ALTER TABLE client_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_tool_calls FORCE ROW LEVEL SECURITY;
