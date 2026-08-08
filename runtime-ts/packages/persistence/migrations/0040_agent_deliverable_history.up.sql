-- 正式 deliverable 与用户附件共享个人历史目录；临时、诊断和 trace 文件不进入云盘。
-- 数据回填需要跨多张 FORCE RLS 表读取，迁移事务内短暂关闭并在提交前恢复。
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
ALTER TABLE threads DISABLE ROW LEVEL SECURITY;
ALTER TABLE resources DISABLE ROW LEVEL SECURITY;
ALTER TABLE resource_versions DISABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications DISABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_settlements DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_title_generation_outbox DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries DISABLE ROW LEVEL SECURITY;

ALTER TABLE artifact_publications
  ADD CONSTRAINT artifact_publications_history_source_key
  UNIQUE (tenant_id,id,thread_id,purpose);

ALTER TABLE thread_history_file_entries
  DROP CONSTRAINT thread_history_file_entries_relation_type_check,
  ALTER COLUMN first_receipt_id DROP NOT NULL,
  ADD COLUMN source_artifact_id text,
  ADD COLUMN source_artifact_purpose text GENERATED ALWAYS AS (
    CASE WHEN relation_type='agent_deliverable' THEN 'deliverable'::text ELSE NULL::text END
  ) STORED,
  ADD CONSTRAINT thread_history_file_entries_relation_source_check CHECK (
    (relation_type='user_attachment' AND first_receipt_id IS NOT NULL AND source_artifact_id IS NULL)
    OR
    (relation_type='agent_deliverable' AND first_receipt_id IS NULL AND source_artifact_id IS NOT NULL)
  ),
  ADD CONSTRAINT thread_history_file_entries_artifact_source_fk FOREIGN KEY (
    tenant_id,source_artifact_id,thread_id,source_artifact_purpose
  ) REFERENCES artifact_publications(tenant_id,id,thread_id,purpose) ON DELETE RESTRICT;

DO $$
DECLARE
  item record;
  base_name text;
  candidate text;
  ordinal integer;
  dot_position integer;
BEGIN
  -- 先为只有 Agent 交付物的任务补目录；已有附件目录保持原路径不变。
  FOR item IN
    SELECT publication.tenant_id,publication.thread_id,thread.title,thread.title_source,
           thread.created_at AS thread_created_at,title_outbox.state AS title_generation_state,
           min(settlement.settled_at) AS first_file_at,
           max(settlement.settled_at) AS last_file_at
      FROM artifact_publications publication
      JOIN artifact_publication_settlements settlement
        ON settlement.tenant_id=publication.tenant_id
       AND settlement.artifact_id=publication.id AND settlement.target='published'
      JOIN tenants tenant ON tenant.id=publication.tenant_id AND tenant.kind='personal'
      JOIN threads thread
        ON thread.tenant_id=publication.tenant_id AND thread.id=publication.thread_id
      LEFT JOIN thread_title_generation_outbox title_outbox
        ON title_outbox.tenant_id=thread.tenant_id AND title_outbox.thread_id=thread.id
      JOIN resources resource
        ON resource.tenant_id=publication.tenant_id AND resource.id=publication.resource_id
       AND resource.visibility='searchable'
     WHERE publication.purpose='deliverable'
       AND NOT EXISTS (
         SELECT 1 FROM thread_history_directories directory
          WHERE directory.tenant_id=publication.tenant_id
            AND directory.thread_id=publication.thread_id
       )
     GROUP BY publication.tenant_id,publication.thread_id,thread.title,thread.title_source,
              thread.created_at,title_outbox.state
     ORDER BY publication.tenant_id,thread.created_at,publication.thread_id
  LOOP
    IF item.title_generation_state IN ('pending','claimed') THEN
      candidate := 'pending-' || item.thread_id;
    ELSE
      base_name := left(
        COALESCE(
          NULLIF(
            regexp_replace(
              regexp_replace(btrim(item.title), '[\/[:cntrl:]]+', '_', 'g'),
              '[. ]+$', '', 'g'
            ),
            ''
          ),
          '任务'
        ),
        45
      );
      ordinal := 1;
      LOOP
        candidate := base_name || CASE WHEN ordinal=1 THEN '' ELSE '-' || ordinal::text END;
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM thread_history_directories directory
           WHERE directory.tenant_id=item.tenant_id AND directory.directory_name=candidate
        );
        ordinal := ordinal + 1;
        IF ordinal > 10000 THEN RAISE EXCEPTION '历史目录语义名称冲突过多'; END IF;
      END LOOP;
    END IF;

    INSERT INTO thread_history_directories(
      tenant_id,thread_id,directory_name,directory_timestamp,directory_time_zone,naming_state,
      first_file_at,last_file_at,file_count
    ) VALUES (
      item.tenant_id,item.thread_id,candidate,item.thread_created_at,'Asia/Shanghai',
      CASE WHEN item.title_generation_state IN ('pending','claimed') THEN 'pending'
           WHEN item.title_source IN ('model','user') THEN 'ready' ELSE 'fallback' END,
      item.first_file_at,item.last_file_at,0
    );
  END LOOP;

  -- 每个已发布 deliverable 建立不可变 ResourceVersion 关系，重名序号放在扩展名前。
  FOR item IN
    SELECT publication.tenant_id,publication.thread_id,publication.id AS artifact_id,
           publication.resource_id,publication.resource_version_id,resource.name,
           settlement.settled_at
      FROM artifact_publications publication
      JOIN artifact_publication_settlements settlement
        ON settlement.tenant_id=publication.tenant_id
       AND settlement.artifact_id=publication.id AND settlement.target='published'
      JOIN tenants tenant ON tenant.id=publication.tenant_id AND tenant.kind='personal'
      JOIN resources resource
        ON resource.tenant_id=publication.tenant_id AND resource.id=publication.resource_id
       AND resource.visibility='searchable'
      JOIN resource_versions version
        ON version.tenant_id=publication.tenant_id
       AND version.resource_id=publication.resource_id
       AND version.id=publication.resource_version_id
     WHERE publication.purpose='deliverable'
       AND NOT EXISTS (
         SELECT 1 FROM thread_history_file_entries entry
          WHERE entry.tenant_id=publication.tenant_id
            AND entry.thread_id=publication.thread_id
            AND entry.resource_id=publication.resource_id
            AND entry.resource_version_id=publication.resource_version_id
            AND entry.relation_type='agent_deliverable'
       )
     ORDER BY publication.tenant_id,publication.thread_id,settlement.settled_at,publication.id
  LOOP
    base_name := left(
      COALESCE(
        NULLIF(
          regexp_replace(
            regexp_replace(btrim(item.name), '[\/[:cntrl:]]+', '_', 'g'),
            '[. ]+$', '', 'g'
          ),
          ''
        ),
        'file'
      ),
      45
    );
    ordinal := 1;
    LOOP
      IF ordinal=1 THEN
        candidate := base_name;
      ELSE
        dot_position := length(base_name) - strpos(reverse(base_name), '.') + 1;
        IF dot_position > 1 AND dot_position <= length(base_name) THEN
          candidate := left(base_name,dot_position-1) || '-' || ordinal::text ||
                       substring(base_name from dot_position);
        ELSE
          candidate := base_name || '-' || ordinal::text;
        END IF;
      END IF;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM thread_history_file_entries entry
         WHERE entry.tenant_id=item.tenant_id AND entry.thread_id=item.thread_id
           AND entry.directory_entry_name=candidate
      );
      ordinal := ordinal + 1;
      IF ordinal > 10000 THEN RAISE EXCEPTION '历史文件语义名称冲突过多'; END IF;
    END LOOP;

    INSERT INTO thread_history_file_entries(
      tenant_id,thread_id,resource_id,resource_version_id,relation_type,directory_entry_name,
      first_receipt_id,source_artifact_id,first_attached_at,last_attached_at,attachment_count
    ) VALUES (
      item.tenant_id,item.thread_id,item.resource_id,item.resource_version_id,
      'agent_deliverable',candidate,NULL,item.artifact_id,item.settled_at,item.settled_at,1
    );
  END LOOP;
END
$$;

UPDATE thread_history_directories directory
   SET first_file_at=summary.first_file_at,last_file_at=summary.last_file_at,
       file_count=summary.file_count,version=directory.version+1,updated_at=clock_timestamp()
  FROM (
    SELECT tenant_id,thread_id,min(first_attached_at) AS first_file_at,
           max(last_attached_at) AS last_file_at,count(*)::bigint AS file_count
      FROM thread_history_file_entries GROUP BY tenant_id,thread_id
  ) summary
 WHERE directory.tenant_id=summary.tenant_id AND directory.thread_id=summary.thread_id;

ALTER TABLE thread_history_file_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_file_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_history_directories FORCE ROW LEVEL SECURITY;
ALTER TABLE thread_title_generation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_title_generation_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publication_settlements FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
