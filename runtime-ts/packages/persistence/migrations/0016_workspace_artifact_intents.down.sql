DROP TABLE IF EXISTS workspace_artifact_publication_intents;
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
