-- 回退到旧的时间前缀命名；时间元数据从未被删除。
-- 与 up 相同，跨 Tenant 数据改名必须在原子事务中短暂关闭 RLS。
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
ALTER TABLE threads DISABLE ROW LEVEL SECURITY;
ALTER TABLE resources DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries DISABLE ROW LEVEL SECURITY;

UPDATE thread_history_directories directory
   SET directory_name='timestamp-migration-' || md5(directory.tenant_id || E'\x1f' || directory.thread_id)
  FROM tenants tenant
 WHERE tenant.id=directory.tenant_id AND tenant.kind='personal'
   AND directory.naming_state IN ('ready','fallback');

WITH directory_bases AS (
  SELECT directory.tenant_id,directory.thread_id,directory.directory_timestamp,
         to_char(directory.directory_timestamp AT TIME ZONE directory.directory_time_zone,
                 'YYYY-MM-DD_HH24-MI-SS') || '_' ||
         left(
           COALESCE(NULLIF(regexp_replace(btrim(thread.title), '[\\/[:cntrl:]]+', '_', 'g'), ''), '任务'),
           45
         ) AS base_name
    FROM thread_history_directories directory
    JOIN tenants tenant ON tenant.id=directory.tenant_id AND tenant.kind='personal'
    JOIN threads thread ON thread.tenant_id=directory.tenant_id AND thread.id=directory.thread_id
   WHERE directory.naming_state IN ('ready','fallback')
), numbered_directories AS (
  SELECT *,row_number() OVER (
           PARTITION BY tenant_id,base_name ORDER BY directory_timestamp,thread_id
         ) AS collision_ordinal
    FROM directory_bases
)
UPDATE thread_history_directories directory
   SET directory_name=numbered.base_name ||
         CASE WHEN numbered.collision_ordinal=1 THEN ''
              ELSE '-' || numbered.collision_ordinal::text END,
       version=directory.version+1,updated_at=clock_timestamp()
  FROM numbered_directories numbered
 WHERE directory.tenant_id=numbered.tenant_id AND directory.thread_id=numbered.thread_id;

UPDATE thread_history_file_entries entry
   SET directory_entry_name='timestamp-migration-' ||
       md5(entry.tenant_id || E'\x1f' || entry.thread_id || E'\x1f' ||
           entry.resource_id || E'\x1f' || entry.resource_version_id)
  FROM tenants tenant
 WHERE tenant.id=entry.tenant_id AND tenant.kind='personal';

WITH file_bases AS (
  SELECT entry.tenant_id,entry.thread_id,entry.resource_id,entry.resource_version_id,
         entry.first_attached_at,
         to_char(entry.first_attached_at AT TIME ZONE directory.directory_time_zone,
                 'YYYY-MM-DD_HH24-MI-SS') || '_' ||
         left(
           COALESCE(NULLIF(regexp_replace(btrim(resource.name), '[\\/[:cntrl:]]+', '_', 'g'), ''), 'file'),
           45
         ) AS base_name
    FROM thread_history_file_entries entry
    JOIN tenants tenant ON tenant.id=entry.tenant_id AND tenant.kind='personal'
    JOIN thread_history_directories directory
      ON directory.tenant_id=entry.tenant_id AND directory.thread_id=entry.thread_id
    JOIN resources resource ON resource.tenant_id=entry.tenant_id AND resource.id=entry.resource_id
), numbered_files AS (
  SELECT *,row_number() OVER (
           PARTITION BY tenant_id,thread_id,base_name
           ORDER BY first_attached_at,resource_id,resource_version_id
         ) AS collision_ordinal
    FROM file_bases
)
UPDATE thread_history_file_entries entry
   SET directory_entry_name=numbered.base_name ||
         CASE WHEN numbered.collision_ordinal=1 THEN ''
              ELSE '-' || numbered.collision_ordinal::text END,
       updated_at=clock_timestamp()
  FROM numbered_files numbered
 WHERE entry.tenant_id=numbered.tenant_id AND entry.thread_id=numbered.thread_id
   AND entry.resource_id=numbered.resource_id
   AND entry.resource_version_id=numbered.resource_version_id
   AND entry.relation_type='user_attachment';

ALTER TABLE thread_history_file_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories FORCE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
