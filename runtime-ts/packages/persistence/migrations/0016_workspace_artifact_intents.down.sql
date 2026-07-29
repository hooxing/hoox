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
UPDATE artifact_publications dependent
   SET replaces_artifact_id=NULL
  FROM workspace_artifact_publication_intents intent
 WHERE dependent.tenant_id=intent.tenant_id
   AND dependent.replaces_artifact_id=intent.artifact_id;
DELETE FROM artifact_publication_settlements settlement
 USING workspace_artifact_publication_intents intent
 WHERE settlement.tenant_id=intent.tenant_id
   AND settlement.artifact_id=intent.artifact_id;
DELETE FROM artifact_publication_commands command
 USING workspace_artifact_publication_intents intent
 WHERE command.tenant_id=intent.tenant_id
   AND command.artifact_id=intent.artifact_id;
DELETE FROM artifact_publications publication
 USING workspace_artifact_publication_intents intent
 WHERE publication.tenant_id=intent.tenant_id
   AND publication.id=intent.artifact_id;
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
