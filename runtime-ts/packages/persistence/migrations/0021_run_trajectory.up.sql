CREATE TABLE run_trajectory_entries (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  agent_thread_id text NOT NULL DEFAULT '',
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  source text NOT NULL CHECK (source IN ('pi','runtime')),
  event_type text NOT NULL CHECK (octet_length(event_type) BETWEEN 1 AND 256),
  occurred_at timestamptz NOT NULL,
  monotonic_offset_ms double precision NOT NULL CHECK (monotonic_offset_ms >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size BETWEEN 0 AND 9007199254740991),
  persistence_status text NOT NULL CHECK (persistence_status IN ('pending','stored','unavailable')),
  blob_operation_id text NOT NULL CHECK (blob_operation_id ~ '^trace-[0-9a-f]{64}$'),
  blob_reference_id text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id, agent_thread_id, sequence),
  FOREIGN KEY (tenant_id, attempt_id, run_id, thread_id)
    REFERENCES execution_attempts(tenant_id, attempt_id, run_id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, blob_reference_id)
    REFERENCES blob_references(tenant_id, reference_id) ON DELETE RESTRICT,
  CONSTRAINT run_trajectory_blob_shape_check CHECK (
    (persistence_status='stored' AND blob_reference_id IS NOT NULL)
    OR (persistence_status IN ('pending','unavailable') AND blob_reference_id IS NULL)
  )
);
CREATE INDEX run_trajectory_attempt_sequence_idx
  ON run_trajectory_entries(tenant_id, run_id, attempt_id, occurred_at, agent_thread_id, sequence);
CREATE INDEX run_trajectory_expiry_idx
  ON run_trajectory_entries(tenant_id, expires_at, attempt_id, sequence);

ALTER TABLE run_trajectory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_trajectory_entries FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  runtime_role text := current_setting('app.runtime_role');
  control_role text := current_setting('app.admin_control_role');
  migrator_role text := current_user;
BEGIN
  EXECUTE format(
    'CREATE POLICY run_trajectory_runtime_policy ON run_trajectory_entries FOR ALL TO %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),''''))',
    runtime_role
  );
  EXECUTE format(
    'CREATE POLICY run_trajectory_migrator_policy ON run_trajectory_entries FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active''))',
    migrator_role
  );
  EXECUTE format(
    'CREATE POLICY run_trajectory_cleanup_directory_policy ON run_trajectory_entries FOR SELECT TO %I USING (true)',
    migrator_role
  );
  EXECUTE format(
    'GRANT SELECT,INSERT,DELETE ON run_trajectory_entries TO %I',
    runtime_role
  );
  EXECUTE format(
    'GRANT UPDATE(persistence_status,blob_reference_id,updated_at) ON run_trajectory_entries TO %I',
    runtime_role
  );
END $$;

CREATE VIEW run_trajectory_cleanup_tenants WITH (security_barrier=true) AS
SELECT DISTINCT tenant_id FROM run_trajectory_entries;
DO $$
BEGIN
  EXECUTE format(
    'GRANT SELECT ON run_trajectory_cleanup_tenants TO %I',
    current_setting('app.runtime_role')
  );
END $$;
REVOKE ALL ON run_trajectory_cleanup_tenants FROM PUBLIC;

CREATE VIEW admin_run_trajectory_directory WITH (security_barrier=true) AS
SELECT entry.tenant_id, entry.thread_id, entry.run_id, entry.attempt_id, entry.agent_thread_id, entry.sequence,
       entry.source, entry.event_type, entry.occurred_at, entry.monotonic_offset_ms,
       entry.sha256, entry.size, entry.persistence_status, entry.blob_reference_id,
       reference.purpose AS blob_purpose, reference.state AS blob_state,
       reference.media_type AS blob_media_type,
       reference.lifecycle_id, reference.incarnation_id, reference.physical_object_key,
       entry.expires_at
  FROM run_trajectory_entries entry
  LEFT JOIN blob_references reference
    ON reference.tenant_id=entry.tenant_id AND reference.reference_id=entry.blob_reference_id
  LEFT JOIN blob_lifecycles lifecycle
    ON lifecycle.tenant_id=reference.tenant_id AND lifecycle.lifecycle_id=reference.lifecycle_id
  LEFT JOIN blob_incarnations incarnation
    ON incarnation.tenant_id=reference.tenant_id AND incarnation.lifecycle_id=reference.lifecycle_id
   AND incarnation.incarnation_id=reference.incarnation_id
 WHERE entry.expires_at > clock_timestamp()
   AND entry.persistence_status='stored'
   AND reference.state='stable' AND reference.purpose='trace'
   AND lifecycle.state='active' AND lifecycle.purpose='trace'
   AND lifecycle.current_incarnation_id=reference.incarnation_id
   AND incarnation.state='active' AND incarnation.purpose='trace'
   AND EXISTS (
     SELECT 1 FROM admin_run_content_access_audits access
     JOIN platform_control_operators actor ON actor.user_id=access.actor_user_id
      WHERE access.audit_id=NULLIF(current_setting('app.run_content_audit_id',true),'')
        AND access.actor_user_id=NULLIF(current_setting('app.user_id',true),'')
        AND access.access_transaction=pg_current_xact_id_if_assigned()
        AND access.tenant_id=entry.tenant_id
        AND access.run_id=entry.run_id
        AND access.attempt_id=entry.attempt_id
        AND actor.status='active' AND actor.role='admin'
   );
DO $$
BEGIN
  EXECUTE format(
    'GRANT SELECT ON admin_run_trajectory_directory TO %I',
    current_setting('app.admin_control_role')
  );
END $$;
