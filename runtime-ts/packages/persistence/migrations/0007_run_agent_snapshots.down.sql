DROP POLICY agent_revision_revocations_snapshot_read ON agent_revision_revocations;
DROP TABLE run_agent_snapshots;
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
