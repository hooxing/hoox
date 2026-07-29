DROP TABLE IF EXISTS workspace_operation_journal;
DROP TABLE IF EXISTS workspace_revision_files;
DROP TABLE IF EXISTS workspace_revision_manifests;
UPDATE workspace_revisions
   SET object_key = 'legacy-manifest-' || digest
 WHERE object_key IS NULL;
ALTER TABLE workspace_revisions ALTER COLUMN object_key SET NOT NULL;
ALTER TABLE workspace_revisions
  ADD CONSTRAINT workspace_revisions_object_key_check CHECK (length(btrim(object_key)) > 0);
