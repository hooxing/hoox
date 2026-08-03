DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM skill_invocations) THEN
    RAISE EXCEPTION 'Skill Runtime 调用事实非空，拒绝破坏性回滚';
  END IF;
  IF EXISTS (SELECT 1 FROM run_skill_snapshots) THEN
    RAISE EXCEPTION 'Run Skill 快照事实非空，拒绝破坏性回滚';
  END IF;
  IF EXISTS (SELECT 1 FROM blob_lifecycles WHERE purpose = 'skill') THEN
    RAISE EXCEPTION 'Skill Blob 生命周期事实非空，拒绝破坏性回滚';
  END IF;
END
$$;

DROP TABLE skill_invocations;
DROP TABLE run_skill_snapshot_items;
DROP TABLE run_skill_snapshots;
DROP POLICY skill_version_files_runtime_snapshot_read_policy ON skill_version_files;
DROP POLICY skill_versions_runtime_snapshot_read_policy ON skill_versions;
DROP POLICY skills_runtime_snapshot_read_policy ON skills;

ALTER TABLE blob_references
  DROP CONSTRAINT blob_references_purpose_check,
  ADD CONSTRAINT blob_references_purpose_check CHECK (
    purpose IN ('workspace', 'resource', 'artifact', 'trace', 'preview')
  );

ALTER TABLE blob_lifecycles
  DROP CONSTRAINT blob_lifecycles_purpose_check,
  ADD CONSTRAINT blob_lifecycles_purpose_check CHECK (
    purpose IN ('workspace', 'resource', 'artifact', 'trace', 'preview')
  );
