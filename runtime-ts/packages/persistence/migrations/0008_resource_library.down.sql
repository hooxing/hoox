DROP TABLE IF EXISTS resource_promotion_idempotency;
DROP TABLE IF EXISTS resource_promotion_authorizations;
ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_latest_version_fk;
DROP TABLE IF EXISTS resource_versions;
DROP TABLE IF EXISTS resources;
ALTER TABLE blob_references DROP CONSTRAINT IF EXISTS blob_references_resource_version_key;
ALTER TABLE workspace_revisions
  DROP CONSTRAINT IF EXISTS workspace_revisions_resource_authorization_key;
