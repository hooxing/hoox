ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries DISABLE ROW LEVEL SECURITY;

DELETE FROM thread_history_file_entries WHERE relation_type='agent_deliverable';

DELETE FROM thread_history_directories directory
 WHERE NOT EXISTS (
   SELECT 1 FROM thread_history_file_entries entry
    WHERE entry.tenant_id=directory.tenant_id AND entry.thread_id=directory.thread_id
 );

UPDATE thread_history_directories directory
   SET first_file_at=summary.first_file_at,last_file_at=summary.last_file_at,
       file_count=summary.file_count,version=directory.version+1,updated_at=clock_timestamp()
  FROM (
    SELECT tenant_id,thread_id,min(first_attached_at) AS first_file_at,
           max(last_attached_at) AS last_file_at,count(*)::bigint AS file_count
      FROM thread_history_file_entries GROUP BY tenant_id,thread_id
  ) summary
 WHERE directory.tenant_id=summary.tenant_id AND directory.thread_id=summary.thread_id;

ALTER TABLE thread_history_file_entries
  DROP CONSTRAINT thread_history_file_entries_artifact_source_fk,
  DROP CONSTRAINT thread_history_file_entries_relation_source_check,
  DROP COLUMN source_artifact_purpose,
  DROP COLUMN source_artifact_id,
  ALTER COLUMN first_receipt_id SET NOT NULL,
  ADD CONSTRAINT thread_history_file_entries_relation_type_check
    CHECK (relation_type='user_attachment');

ALTER TABLE artifact_publications
  DROP CONSTRAINT artifact_publications_history_source_key;

ALTER TABLE thread_history_file_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
