-- 受控回退先解除本迁移创建的专属 trace 引用；共享 lifecycle 仍只由既有 GC 判定回收。
ALTER TABLE model_wire_trace_records NO FORCE ROW LEVEL SECURITY;
ALTER TABLE blob_references NO FORCE ROW LEVEL SECURITY;
SET CONSTRAINTS ALL DEFERRED;
DELETE FROM blob_references reference
 USING model_wire_trace_records record
 WHERE reference.tenant_id = record.tenant_id
   AND reference.operation_id = record.blob_operation_id
   AND reference.purpose = 'trace'
   AND reference.sha256 = record.sha256
   AND reference.size = record.size
   AND (
     record.blob_reference_id IS NULL
     OR (
       record.persistence_status = 'stored'
       AND reference.reference_id = record.blob_reference_id
       AND reference.state = record.blob_state
       AND reference.purpose = record.blob_purpose
       AND reference.lifecycle_id = record.blob_lifecycle_id
       AND reference.incarnation_id = record.blob_incarnation_id
       AND reference.physical_object_key = record.physical_object_key
     )
   );
DELETE FROM model_wire_trace_records;
SET CONSTRAINTS ALL IMMEDIATE;

DROP POLICY blob_references_tenant_select_policy ON blob_references;
DROP POLICY blob_references_tenant_insert_policy ON blob_references;
DROP POLICY blob_references_tenant_update_policy ON blob_references;
DROP POLICY blob_references_expired_trace_delete_policy ON blob_references;
CREATE POLICY blob_references_isolation_policy ON blob_references
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
ALTER TABLE blob_references FORCE ROW LEVEL SECURITY;

DROP TABLE model_wire_trace_records;
DROP TABLE model_wire_trace_expiry_tombstones;
DROP TABLE model_wire_trace_cleanup_items;
DROP TABLE model_wire_trace_cleanup_commands;
ALTER TABLE blob_references DROP CONSTRAINT blob_references_model_wire_identity_unique;
