-- ADR-0055：先持久化命令意图，再推进 trace Blob；索引失败可由同命令或到期清理恢复。
CREATE TABLE model_wire_trace_cleanup_commands (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  command_id text NOT NULL CHECK (octet_length(command_id) BETWEEN 1 AND 200),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  expires_before timestamptz NOT NULL,
  batch_size integer NOT NULL CHECK (batch_size BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('pending', 'references_released', 'completed')),
  deleted_count integer CHECK (deleted_count BETWEEN 0 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, command_id),
  CONSTRAINT model_wire_trace_cleanup_command_shape_check CHECK (
    (status = 'pending' AND deleted_count IS NULL AND completed_at IS NULL)
    OR (status = 'references_released' AND deleted_count IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND deleted_count IS NOT NULL AND completed_at IS NOT NULL)
  )
);

-- 引用释放前先留下完整 stable 身份；清理 consumer 据此显式调用既有 GC，不能只让正文变得不可见。
CREATE TABLE model_wire_trace_cleanup_items (
  tenant_id text NOT NULL,
  cleanup_command_id text NOT NULL,
  blob_reference_id text NOT NULL,
  lifecycle_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose = 'trace'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size BETWEEN 0 AND 9007199254740991),
  incarnation_id uuid NOT NULL,
  physical_object_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'retry', 'completed')),
  outcome text CHECK (outcome IN ('deleted', 'still_referenced')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, cleanup_command_id, blob_reference_id),
  FOREIGN KEY (tenant_id, cleanup_command_id)
    REFERENCES model_wire_trace_cleanup_commands(tenant_id, command_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, lifecycle_id, purpose, sha256, size)
    REFERENCES blob_lifecycles(tenant_id, lifecycle_id, purpose, sha256, size) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    REFERENCES blob_incarnations(tenant_id, lifecycle_id, incarnation_id, physical_object_key)
    ON DELETE RESTRICT,
  CONSTRAINT model_wire_trace_cleanup_item_shape_check CHECK (
    (state IN ('pending', 'retry') AND outcome IS NULL)
    OR (state = 'completed' AND outcome IS NOT NULL)
  )
);

-- 到期后只保留最小幂等墓碑，阻止旧命令在引用释放后重新创建永久悬空引用。
CREATE TABLE model_wire_trace_expiry_tombstones (
  tenant_id text NOT NULL,
  attempt_id text NOT NULL,
  model_turn bigint NOT NULL CHECK (model_turn BETWEEN 0 AND 9007199254740991),
  transport_attempt bigint NOT NULL CHECK (transport_attempt BETWEEN 0 AND 9007199254740991),
  part text NOT NULL CHECK (part IN ('request', 'response')),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  blob_operation_id text NOT NULL CHECK (blob_operation_id ~ '^trace-[0-9a-f]{64}$'),
  sha256 text,
  size bigint CHECK (size BETWEEN 0 AND 9007199254740991),
  cleanup_command_id text NOT NULL,
  expired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  staging_swept_at timestamptz,
  PRIMARY KEY (tenant_id, attempt_id, model_turn, transport_attempt, part),
  FOREIGN KEY (tenant_id, cleanup_command_id)
    REFERENCES model_wire_trace_cleanup_commands(tenant_id, command_id) ON DELETE RESTRICT,
  CONSTRAINT model_wire_trace_expiry_tombstone_body_check CHECK (
    (sha256 IS NULL AND size IS NULL) OR (sha256 ~ '^[0-9a-f]{64}$' AND size IS NOT NULL)
  )
);
CREATE INDEX model_wire_trace_tombstone_staging_sweep_idx
  ON model_wire_trace_expiry_tombstones(
    tenant_id, staging_swept_at ASC NULLS FIRST, expired_at, attempt_id, model_turn,
    transport_attempt, part
  );

-- reference_id 已经唯一；该冗余唯一键让下游 FK 同时证明 stable/state/purpose 与完整物理身份。
ALTER TABLE blob_references ADD CONSTRAINT blob_references_model_wire_identity_unique
  UNIQUE (
    tenant_id, reference_id, operation_id, state, purpose, sha256, size,
    lifecycle_id, incarnation_id, physical_object_key
  );

CREATE TABLE model_wire_trace_records (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  workspace_id text NOT NULL,
  root_run_id text NOT NULL,
  model_turn bigint NOT NULL CHECK (model_turn BETWEEN 0 AND 9007199254740991),
  transport_attempt bigint NOT NULL CHECK (transport_attempt BETWEEN 0 AND 9007199254740991),
  part text NOT NULL CHECK (part IN ('request', 'response')),
  command_digest text NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  blob_operation_id text NOT NULL CHECK (blob_operation_id ~ '^trace-[0-9a-f]{64}$'),
  capture_status text NOT NULL CHECK (capture_status IN ('complete', 'truncated', 'aborted', 'failed')),
  capture_error_code text CHECK (capture_error_code IN ('CAPTURE_UNAVAILABLE', 'BODY_UNREADABLE')),
  persistence_status text NOT NULL CHECK (persistence_status IN (
    'pending', 'stored', 'unknown', 'conflict', 'unavailable', 'not_captured'
  )),
  sha256 text,
  size bigint,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  blob_reference_id text,
  blob_state text,
  blob_purpose text,
  blob_lifecycle_id uuid,
  blob_incarnation_id uuid,
  physical_object_key text,
  processing_token uuid,
  processing_lease_expires_at timestamptz,
  retention_recovery_at timestamptz,
  cleanup_command_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, attempt_id, model_turn, transport_attempt, part),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id)
    REFERENCES execution_attempts(
      tenant_id, attempt_id, run_id, thread_id, workspace_id, root_run_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, cleanup_command_id)
    REFERENCES model_wire_trace_cleanup_commands(tenant_id, command_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, blob_reference_id, blob_operation_id, blob_state, blob_purpose, sha256, size,
    blob_lifecycle_id, blob_incarnation_id, physical_object_key
  ) REFERENCES blob_references(
    tenant_id, reference_id, operation_id, state, purpose, sha256, size,
    lifecycle_id, incarnation_id, physical_object_key
  ) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT model_wire_trace_identity_check CHECK (
    octet_length(thread_id) BETWEEN 1 AND 200 AND octet_length(run_id) BETWEEN 1 AND 200
    AND octet_length(attempt_id) BETWEEN 1 AND 200
    AND octet_length(workspace_id) BETWEEN 1 AND 200 AND octet_length(root_run_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT model_wire_trace_body_check CHECK (
    (
      persistence_status = 'not_captured' AND capture_error_code IS NOT NULL
      AND sha256 IS NULL AND size IS NULL AND blob_reference_id IS NULL
      AND blob_state IS NULL AND blob_purpose IS NULL AND blob_lifecycle_id IS NULL
      AND blob_incarnation_id IS NULL AND physical_object_key IS NULL
    )
    OR
    (
      persistence_status IN ('pending', 'unknown', 'conflict', 'unavailable')
      AND capture_error_code IS NULL AND sha256 ~ '^[0-9a-f]{64}$'
      AND size BETWEEN 0 AND 9007199254740991 AND blob_reference_id IS NULL
      AND blob_state IS NULL AND blob_purpose IS NULL AND blob_lifecycle_id IS NULL
      AND blob_incarnation_id IS NULL AND physical_object_key IS NULL
    )
    OR
    (
      persistence_status = 'stored' AND capture_error_code IS NULL
      AND sha256 ~ '^[0-9a-f]{64}$' AND size BETWEEN 0 AND 9007199254740991
      AND blob_reference_id IS NOT NULL AND blob_state = 'stable' AND blob_purpose = 'trace'
      AND blob_lifecycle_id IS NOT NULL AND blob_incarnation_id IS NOT NULL
      AND physical_object_key IS NOT NULL
    )
  ),
  CONSTRAINT model_wire_trace_processing_lease_shape_check CHECK (
    (processing_token IS NULL AND processing_lease_expires_at IS NULL)
    OR (processing_token IS NOT NULL AND processing_lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX model_wire_trace_records_run_idx ON model_wire_trace_records(
  tenant_id, run_id, attempt_id, model_turn, transport_attempt, part
);
CREATE INDEX model_wire_trace_records_expiry_idx ON model_wire_trace_records(
  tenant_id, expires_at, attempt_id, model_turn, transport_attempt, part
) WHERE cleanup_command_id IS NULL;
CREATE INDEX model_wire_trace_records_recovery_sweep_idx ON model_wire_trace_records(
  tenant_id, retention_recovery_at ASC NULLS FIRST, expires_at, attempt_id,
  model_turn, transport_attempt, part
) WHERE cleanup_command_id IS NULL;

ALTER TABLE model_wire_trace_cleanup_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_wire_trace_cleanup_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY model_wire_trace_cleanup_commands_tenant_policy
  ON model_wire_trace_cleanup_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE model_wire_trace_cleanup_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_wire_trace_cleanup_items FORCE ROW LEVEL SECURITY;
CREATE POLICY model_wire_trace_cleanup_items_tenant_policy ON model_wire_trace_cleanup_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE model_wire_trace_expiry_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_wire_trace_expiry_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY model_wire_trace_expiry_tombstones_tenant_policy
  ON model_wire_trace_expiry_tombstones
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE model_wire_trace_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_wire_trace_records FORCE ROW LEVEL SECURITY;
CREATE POLICY model_wire_trace_records_tenant_select_policy ON model_wire_trace_records FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY model_wire_trace_records_tenant_insert_policy ON model_wire_trace_records FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY model_wire_trace_records_tenant_update_policy ON model_wire_trace_records FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY model_wire_trace_records_expired_delete_policy ON model_wire_trace_records FOR DELETE
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
    AND expires_at <= clock_timestamp() AND cleanup_command_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM model_wire_trace_cleanup_commands cleanup
       WHERE cleanup.tenant_id = model_wire_trace_records.tenant_id
         AND cleanup.command_id = model_wire_trace_records.cleanup_command_id
         AND cleanup.status = 'pending'
    )
    AND EXISTS (
      SELECT 1 FROM model_wire_trace_expiry_tombstones tombstone
       WHERE tombstone.tenant_id = model_wire_trace_records.tenant_id
         AND tombstone.attempt_id = model_wire_trace_records.attempt_id
         AND tombstone.model_turn = model_wire_trace_records.model_turn
         AND tombstone.transport_attempt = model_wire_trace_records.transport_attempt
         AND tombstone.part = model_wire_trace_records.part
         AND tombstone.command_digest = model_wire_trace_records.command_digest
         AND tombstone.blob_operation_id = model_wire_trace_records.blob_operation_id
         AND tombstone.cleanup_command_id = model_wire_trace_records.cleanup_command_id
    )
  );

-- Runtime 虽持有 blob_references DELETE，但 RLS 只允许删除已到期、且由完整命令/物理身份绑定的 trace 引用。
DROP POLICY blob_references_isolation_policy ON blob_references;
CREATE POLICY blob_references_tenant_select_policy ON blob_references FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY blob_references_tenant_insert_policy ON blob_references FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY blob_references_tenant_update_policy ON blob_references FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
CREATE POLICY blob_references_expired_trace_delete_policy ON blob_references FOR DELETE
  USING (
    current_user = pg_get_userbyid(
      (SELECT relation.relowner FROM pg_class relation WHERE relation.oid = 'blob_references'::regclass)
    )
    OR (
      tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
      AND purpose = 'trace' AND state = 'stable'
      AND EXISTS (
        SELECT 1 FROM model_wire_trace_cleanup_items item
         WHERE item.tenant_id = blob_references.tenant_id
           AND item.blob_reference_id = blob_references.reference_id
           AND item.purpose = blob_references.purpose
           AND item.sha256 = blob_references.sha256
           AND item.size = blob_references.size
           AND item.lifecycle_id = blob_references.lifecycle_id
           AND item.incarnation_id = blob_references.incarnation_id
           AND item.physical_object_key = blob_references.physical_object_key
           AND (
             EXISTS (
               SELECT 1 FROM model_wire_trace_records record
                WHERE record.tenant_id = blob_references.tenant_id
                  AND record.cleanup_command_id = item.cleanup_command_id
                  AND record.blob_operation_id = blob_references.operation_id
                  AND record.sha256 = blob_references.sha256
                  AND record.size = blob_references.size
                  AND record.expires_at <= clock_timestamp()
             )
             OR EXISTS (
               SELECT 1 FROM model_wire_trace_expiry_tombstones tombstone
                WHERE tombstone.tenant_id = blob_references.tenant_id
                  AND tombstone.cleanup_command_id = item.cleanup_command_id
                  AND tombstone.blob_operation_id = blob_references.operation_id
                  AND tombstone.sha256 = blob_references.sha256
                  AND tombstone.size = blob_references.size
             )
           )
      )
    )
  );
