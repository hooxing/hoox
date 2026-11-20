DROP POLICY agent_revision_revocations_snapshot_read ON agent_revision_revocations;
DROP TABLE run_agent_snapshots;

-- 回退种子 Revision 时短暂关闭 RLS；迁移事务提交前恢复并强制执行策略。
ALTER TABLE agent_revisions DISABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions DISABLE ROW LEVEL SECURITY;
UPDATE agent_definitions
   SET current_revision_id='agent_default_revision_1',
       generation=generation+1,
       updated_at=clock_timestamp()
 WHERE id='agent_default'
   AND current_revision_id='agent_default_revision_platform_memory';
DELETE FROM agent_revisions
 WHERE id='agent_default_revision_platform_memory'
   AND NOT EXISTS (
     SELECT 1 FROM agent_definitions
      WHERE id='agent_default' AND current_revision_id='agent_default_revision_platform_memory'
   );
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE agent_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions FORCE ROW LEVEL SECURITY;
