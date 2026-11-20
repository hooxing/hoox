CREATE TABLE run_agent_snapshots (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  definition_id text NOT NULL,
  revision_id text NOT NULL,
  revision_digest text NOT NULL CHECK (revision_digest ~ '^[a-f0-9]{64}$'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content)='object' AND octet_length(content::text) BETWEEN 2 AND 131072),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (definition_id,revision_id) REFERENCES agent_revisions(definition_id,id) ON DELETE RESTRICT
);
CREATE INDEX run_agent_snapshots_revocation_idx ON run_agent_snapshots(tenant_id,revision_id);

ALTER TABLE run_agent_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_agent_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY run_agent_snapshots_read ON run_agent_snapshots FOR SELECT
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
-- 和 Skill 快照一样，待转队列的输入可以先固定候选 Run，故此处只引用 Thread。
CREATE POLICY run_agent_snapshots_insert ON run_agent_snapshots FOR INSERT
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND EXISTS (
    SELECT 1 FROM threads t
    JOIN agent_definitions d ON d.id=t.agent_definition_id
    JOIN agent_revisions r ON r.definition_id=d.id AND r.id=d.current_revision_id
    WHERE t.tenant_id=run_agent_snapshots.tenant_id AND t.id=run_agent_snapshots.thread_id
      AND d.id=run_agent_snapshots.definition_id AND d.status='published'
      AND (d.availability_mode='all_tenants' OR EXISTS (
        SELECT 1 FROM agent_definition_tenants scope
         WHERE scope.definition_id=d.id AND scope.tenant_id=t.tenant_id AND scope.available
      ))
      AND r.id=run_agent_snapshots.revision_id AND r.status='published'
      AND r.content_digest=run_agent_snapshots.revision_digest AND r.content=run_agent_snapshots.content
  ));

-- 当前定义的可见状态不能控制已绑定 Run 对紧急撤销事实的读取。
DO $$
DECLARE runtime_role text := current_setting('app.runtime_role');
BEGIN
  EXECUTE format('CREATE POLICY agent_revision_revocations_snapshot_read ON agent_revision_revocations FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM run_agent_snapshots s WHERE s.revision_id=agent_revision_revocations.revision_id))', runtime_role);
  EXECUTE format('GRANT SELECT, INSERT ON run_agent_snapshots TO %I', runtime_role);
END $$;

-- 默认 Agent 的新 Revision 改为跟随平台记忆设置，保留原种子 Revision 不变。
-- 种子修订由迁移身份写入；DDL 与数据更新处于同一事务，结束前恢复并强制 RLS。
ALTER TABLE agent_revisions DISABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions DISABLE ROW LEVEL SECURITY;
INSERT INTO agent_revisions(id,definition_id,revision,status,content,content_digest,created_by)
SELECT 'agent_default_revision_platform_memory',
       source.definition_id,
       (SELECT COALESCE(max(revision),0)+1 FROM agent_revisions WHERE definition_id='agent_default'),
       'published',
       (source.content - 'longTermMemoryEnabled') || '{"memory":{"mode":"platform_default"}}'::jsonb,
       '7c720acae2f5e32c596a4ac8c4a74ce3f4dc979582e557c182c58ff8306ba1a9',
       'system'
  FROM agent_revisions source
 WHERE source.id='agent_default_revision_1'
   AND NOT EXISTS (
     SELECT 1 FROM agent_revisions existing
      WHERE existing.id='agent_default_revision_platform_memory'
   );
UPDATE agent_definitions
   SET current_revision_id='agent_default_revision_platform_memory',
       generation=generation+1,
       updated_at=clock_timestamp()
 WHERE id='agent_default' AND current_revision_id='agent_default_revision_1'
   AND EXISTS (
     SELECT 1 FROM agent_revisions revision
      WHERE revision.id='agent_default_revision_platform_memory'
        AND revision.definition_id='agent_default'
   );
ALTER TABLE agent_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions FORCE ROW LEVEL SECURITY;
