DROP TABLE IF EXISTS thread_history_file_entries;
DROP TABLE IF EXISTS thread_history_directories;

ALTER TABLE threads
  DROP COLUMN IF EXISTS title_generation_version,
  DROP COLUMN IF EXISTS title_generated_at,
  DROP COLUMN IF EXISTS title_source;
