ALTER TABLE threads
  ADD COLUMN title_source text NOT NULL DEFAULT 'deterministic'
    CHECK (title_source IN ('deterministic', 'model', 'user')),
  ADD COLUMN title_generated_at timestamptz,
  ADD COLUMN title_generation_version integer NOT NULL DEFAULT 0
    CHECK (title_generation_version >= 0);

CREATE TABLE thread_history_directories (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  directory_name text NOT NULL CHECK (
    octet_length(directory_name) BETWEEN 1 AND 255
    AND directory_name !~ '[[:cntrl:]\\/]'
    AND directory_name NOT IN ('.', '..')
  ),
  directory_timestamp timestamptz NOT NULL,
  directory_time_zone text NOT NULL CHECK (octet_length(directory_time_zone) BETWEEN 1 AND 128),
  naming_state text NOT NULL CHECK (naming_state IN ('ready', 'fallback')),
  first_file_at timestamptz NOT NULL,
  last_file_at timestamptz NOT NULL,
  file_count bigint NOT NULL CHECK (file_count >= 0 AND file_count <= 9007199254740991),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0 AND version <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id),
  UNIQUE (tenant_id, directory_name),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT thread_history_directories_time_check CHECK (first_file_at <= last_file_at)
);

CREATE INDEX thread_history_directories_recent_idx
  ON thread_history_directories(tenant_id, last_file_at DESC, thread_id)
  INCLUDE (directory_name, directory_timestamp, file_count, naming_state);

CREATE TABLE thread_history_file_entries (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  resource_id text NOT NULL,
  resource_version_id text NOT NULL,
  relation_type text NOT NULL DEFAULT 'user_attachment'
    CHECK (relation_type = 'user_attachment'),
  directory_entry_name text NOT NULL CHECK (
    octet_length(directory_entry_name) BETWEEN 1 AND 255
    AND directory_entry_name !~ '[[:cntrl:]\\/]'
    AND directory_entry_name NOT IN ('.', '..')
  ),
  first_receipt_id text NOT NULL,
  first_attached_at timestamptz NOT NULL,
  last_attached_at timestamptz NOT NULL,
  attachment_count bigint NOT NULL CHECK (
    attachment_count > 0 AND attachment_count <= 9007199254740991
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id, resource_id, resource_version_id, relation_type),
  UNIQUE (tenant_id, thread_id, directory_entry_name),
  FOREIGN KEY (tenant_id, thread_id)
    REFERENCES thread_history_directories(tenant_id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id, resource_version_id)
    REFERENCES resource_versions(tenant_id, resource_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, thread_id, first_receipt_id)
    REFERENCES thread_input_receipts(tenant_id, thread_id, receipt_id) ON DELETE RESTRICT,
  CONSTRAINT thread_history_file_entries_time_check CHECK (first_attached_at <= last_attached_at)
);

CREATE INDEX thread_history_file_entries_thread_idx
  ON thread_history_file_entries(tenant_id, thread_id, first_attached_at, directory_entry_name);

ALTER TABLE thread_history_directories ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_history_directories_tenant_policy ON thread_history_directories
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_history_file_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_history_file_entries_tenant_policy ON thread_history_file_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

-- 现有 durable receipt 只回填 personal Tenant 中真正进入队列或 steer 的附件。
WITH expanded AS (
  SELECT receipt.tenant_id, receipt.thread_id, receipt.receipt_id,
         receipt.created_at AS attached_at,
         resource_item.key AS resource_id, version_item.key AS resource_version_id,
         resource.name,
         thread.title, thread.title_source, thread.created_at AS thread_created_at
    FROM thread_input_receipts receipt
    JOIN tenants tenant ON tenant.id=receipt.tenant_id AND tenant.kind='personal'
    JOIN threads thread ON thread.tenant_id=receipt.tenant_id AND thread.id=receipt.thread_id
    CROSS JOIN LATERAL jsonb_each(receipt.input_attachments) resource_item
    CROSS JOIN LATERAL jsonb_each(resource_item.value) version_item
    JOIN resources resource
      ON resource.tenant_id=receipt.tenant_id AND resource.id=resource_item.key
     AND resource.visibility='searchable'
    JOIN resource_versions version
      ON version.tenant_id=receipt.tenant_id
     AND version.resource_id=resource_item.key AND version.id=version_item.key
   WHERE receipt.disposition IN ('queued', 'pending_steer', 'steered')
), directory_candidates AS (
  SELECT tenant_id, thread_id, min(thread_created_at) AS thread_created_at,
         min(title) AS title, min(title_source) AS title_source,
         min(attached_at) AS first_file_at, max(attached_at) AS last_file_at
    FROM expanded
   GROUP BY tenant_id, thread_id
), directory_bases AS (
  SELECT *,
         to_char(thread_created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD_HH24-MI-SS')
         || '_' || left(
           COALESCE(NULLIF(regexp_replace(btrim(title), '[\\/[:cntrl:]]+', '_', 'g'), ''), '任务'),
           45
         ) AS base_name
    FROM directory_candidates
), numbered_directories AS (
  SELECT *, row_number() OVER (
           PARTITION BY tenant_id, base_name ORDER BY thread_created_at, thread_id
         ) AS collision_ordinal
    FROM directory_bases
)
INSERT INTO thread_history_directories(
  tenant_id,thread_id,directory_name,directory_timestamp,directory_time_zone,naming_state,
  first_file_at,last_file_at,file_count
)
SELECT tenant_id,thread_id,
       base_name || CASE WHEN collision_ordinal=1 THEN '' ELSE '-' || collision_ordinal::text END,
       thread_created_at,'Asia/Shanghai',
       CASE WHEN title_source='model' THEN 'ready' ELSE 'fallback' END,
       first_file_at,last_file_at,0
  FROM numbered_directories;

WITH expanded AS (
  SELECT receipt.tenant_id, receipt.thread_id, receipt.receipt_id,
         receipt.created_at AS attached_at,
         resource_item.key AS resource_id, version_item.key AS resource_version_id,
         resource.name
    FROM thread_input_receipts receipt
    JOIN tenants tenant ON tenant.id=receipt.tenant_id AND tenant.kind='personal'
    CROSS JOIN LATERAL jsonb_each(receipt.input_attachments) resource_item
    CROSS JOIN LATERAL jsonb_each(resource_item.value) version_item
    JOIN resources resource
      ON resource.tenant_id=receipt.tenant_id AND resource.id=resource_item.key
     AND resource.visibility='searchable'
    JOIN resource_versions version
      ON version.tenant_id=receipt.tenant_id
     AND version.resource_id=resource_item.key AND version.id=version_item.key
   WHERE receipt.disposition IN ('queued', 'pending_steer', 'steered')
), aggregated AS (
  SELECT tenant_id,thread_id,resource_id,resource_version_id,min(name) AS name,
         (array_agg(receipt_id ORDER BY attached_at,receipt_id))[1] AS first_receipt_id,
         min(attached_at) AS first_attached_at,max(attached_at) AS last_attached_at,
         count(*)::bigint AS attachment_count
    FROM expanded
   GROUP BY tenant_id,thread_id,resource_id,resource_version_id
), file_bases AS (
  SELECT *,
         to_char(first_attached_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD_HH24-MI-SS')
         || '_' || left(
           COALESCE(NULLIF(regexp_replace(btrim(name), '[\\/[:cntrl:]]+', '_', 'g'), ''), 'file'),
           45
         ) AS base_name
    FROM aggregated
), numbered_files AS (
  SELECT *, row_number() OVER (
           PARTITION BY tenant_id,thread_id,base_name
           ORDER BY first_attached_at,resource_id,resource_version_id
         ) AS collision_ordinal
    FROM file_bases
)
INSERT INTO thread_history_file_entries(
  tenant_id,thread_id,resource_id,resource_version_id,relation_type,directory_entry_name,
  first_receipt_id,first_attached_at,last_attached_at,attachment_count
)
SELECT tenant_id,thread_id,resource_id,resource_version_id,'user_attachment',
       base_name || CASE WHEN collision_ordinal=1 THEN '' ELSE '-' || collision_ordinal::text END,
       first_receipt_id,first_attached_at,last_attached_at,attachment_count
  FROM numbered_files;

UPDATE thread_history_directories directory
   SET first_file_at=summary.first_file_at,
       last_file_at=summary.last_file_at,
       file_count=summary.file_count,
       updated_at=clock_timestamp()
  FROM (
    SELECT tenant_id,thread_id,min(first_attached_at) AS first_file_at,
           max(last_attached_at) AS last_file_at,count(*)::bigint AS file_count
      FROM thread_history_file_entries GROUP BY tenant_id,thread_id
  ) summary
 WHERE directory.tenant_id=summary.tenant_id AND directory.thread_id=summary.thread_id;
