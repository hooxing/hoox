-- 0016 扩展前的 CHECK 不接受 workspace purpose。回退只清理由本迁移 intent
-- 确定性派生的事实，并解除后续 correction 对这些事实的 replacement 引用。
-- migrator 不是 BYPASSRLS 角色；RLS 只在当前 DDL 事务内关闭，清理后立即恢复。
ALTER TABLE workspace_artifact_publication_intents DISABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_settlements DISABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_commands DISABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications DISABLE ROW LEVEL SECURITY;
ALTER TABLE resource_versions DISABLE ROW LEVEL SECURITY;
ALTER TABLE resources DISABLE ROW LEVEL SECURITY;
ALTER TABLE blob_references DISABLE ROW LEVEL SECURITY;
ALTER TABLE blob_commits DISABLE ROW LEVEL SECURITY;
-- 使用同一未提交 DDL 事务内的短命辅助表；migrator 按最小权限不持有数据库 TEMP。
CREATE TABLE workspace_artifact_down_publications (
  tenant_id text NOT NULL,
  artifact_id text NOT NULL,
  PRIMARY KEY (tenant_id,artifact_id)
);
-- 兼容修复前 beginPublication 已复用 workspace ResourceVersion 的事实，并递归包含其
-- replacement 后继；先固化闭包，后续删除 settlement 时不会再丢失图关系。
WITH RECURSIVE publication_closure(tenant_id,artifact_id) AS (
  SELECT publication.tenant_id,publication.id
    FROM artifact_publications publication
    JOIN workspace_artifact_publication_intents intent
      ON intent.tenant_id=publication.tenant_id
     AND intent.resource_version_id=publication.resource_version_id
  UNION
  SELECT dependent.tenant_id,dependent.id
    FROM artifact_publications dependent
    JOIN publication_closure parent
      ON parent.tenant_id=dependent.tenant_id
     AND parent.artifact_id=dependent.replaces_artifact_id
)
INSERT INTO workspace_artifact_down_publications(tenant_id,artifact_id)
SELECT tenant_id,artifact_id FROM publication_closure;
UPDATE workspace_artifact_publication_intents intent
   SET replaces_artifact_id=NULL
  FROM workspace_artifact_down_publications closure
 WHERE intent.tenant_id=closure.tenant_id
   AND intent.replaces_artifact_id=closure.artifact_id;
UPDATE artifact_publications publication
   SET replaces_artifact_id=NULL
  FROM workspace_artifact_down_publications closure
 WHERE publication.tenant_id=closure.tenant_id
   AND publication.id=closure.artifact_id
   AND publication.replaces_artifact_id IS NOT NULL;
DELETE FROM artifact_publication_settlements settlement
 USING workspace_artifact_down_publications closure
 WHERE settlement.tenant_id=closure.tenant_id
   AND settlement.artifact_id=closure.artifact_id;
DELETE FROM artifact_publication_commands command
 USING workspace_artifact_down_publications closure
 WHERE command.tenant_id=closure.tenant_id
   AND command.artifact_id=closure.artifact_id;
DELETE FROM artifact_publications publication
 USING workspace_artifact_down_publications closure
 WHERE publication.tenant_id=closure.tenant_id
   AND publication.id=closure.artifact_id;
DELETE FROM resource_versions version
 USING workspace_artifact_publication_intents intent
 WHERE version.tenant_id=intent.tenant_id
   AND version.id=intent.resource_version_id;
DELETE FROM resources resource
 USING workspace_artifact_publication_intents intent
 WHERE resource.tenant_id=intent.tenant_id
   AND resource.id=intent.resource_id;
-- resource head FK 是 deferred；删除父子事实后先冲刷约束事件，随后才能 ALTER 被引用表。
SET CONSTRAINTS resources_latest_version_fk IMMEDIATE;
DELETE FROM blob_references reference
 USING workspace_artifact_publication_intents intent
 WHERE reference.tenant_id=intent.tenant_id
   AND reference.reference_id=intent.blob_reference_id;
DELETE FROM blob_commits commit_record
 USING workspace_artifact_publication_intents intent
 WHERE commit_record.tenant_id=intent.tenant_id
   AND commit_record.operation_id=intent.blob_operation_id;
DROP TABLE workspace_artifact_down_publications;
ALTER TABLE artifact_publication_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_settlements FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
ALTER TABLE blob_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE blob_references FORCE ROW LEVEL SECURITY;
ALTER TABLE blob_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE blob_commits FORCE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS workspace_artifact_publication_intents;
ALTER TABLE external_effect_permits
  DROP CONSTRAINT IF EXISTS external_effect_permits_artifact_intent_key;
ALTER TABLE effect_invocations
  DROP CONSTRAINT IF EXISTS effect_invocations_artifact_intent_key;
ALTER TABLE artifact_publications
  DROP CONSTRAINT IF EXISTS artifact_publication_workspace_source_fk,
  DROP CONSTRAINT IF EXISTS artifact_publication_workspace_source_shape,
  DROP COLUMN IF EXISTS source_relative_path,
  DROP COLUMN IF EXISTS workspace_revision_id,
  DROP COLUMN IF EXISTS source_workspace_id,
  ADD CONSTRAINT artifact_publications_blob_purpose_check CHECK (blob_purpose='resource');
ALTER TABLE resource_versions
  DROP CONSTRAINT IF EXISTS resource_version_workspace_source_fk,
  DROP CONSTRAINT IF EXISTS resource_version_blob_source_shape,
  DROP COLUMN IF EXISTS source_relative_path,
  DROP COLUMN IF EXISTS source_workspace_revision_id,
  DROP COLUMN IF EXISTS source_workspace_id,
  ADD CONSTRAINT resource_versions_blob_purpose_check CHECK (blob_purpose='resource');
ALTER TABLE workspace_revision_files
  DROP CONSTRAINT IF EXISTS workspace_revision_files_artifact_source_key;
ALTER TABLE blob_references
  DROP CONSTRAINT IF EXISTS blob_references_lifecycle_identity_fk;
