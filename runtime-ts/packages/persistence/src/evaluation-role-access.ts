import type { PoolClient } from "pg";
import { PersistenceError } from "./errors.js";
import { evaluationRoleName } from "./evaluation-role.js";

const reads = [
  "threads",
  "runs",
  "workspaces",
  "agent_definitions",
  "agent_revisions",
  "agent_definition_tenants",
  "skills",
  "skill_versions",
  "skill_version_files",
  "tenant_skill_installations",
  "run_agent_snapshots",
  "run_skill_snapshots",
  "thread_execution_heads",
  "thread_input_receipts",
  "thread_follow_up_queue",
  "thread_input_receipt_events",
  "run_execution_inputs",
  "worker_tenant_assignments",
  "resources",
  "resource_versions",
  "blob_references",
  "artifact_publications",
  "artifact_publication_settlements",
  "workspace_revisions",
  "workspace_revision_manifests",
  "evaluation_run_command",
] as const;
const inserts = [
  "threads",
  "runs",
  "workspaces",
  "run_agent_snapshots",
  "run_skill_snapshots",
  "run_skill_snapshot_items",
  "thread_execution_heads",
  "thread_input_receipts",
  "thread_follow_up_queue",
  "thread_input_receipt_events",
  "thread_continuity_metric_observations",
  "run_execution_inputs",
  "run_dispatch_outbox",
  "run_workspace_results",
  "worker_tenant_assignments",
] as const;
const columnReads: Readonly<Record<string, readonly string[]>> = {
  memberships: ["tenant_id", "user_id", "status", "role"],
  thread_continuity_metric_observations: ["tenant_id", "observation_id"],
};
const updates: Readonly<Record<string, readonly string[]>> = {
  threads: ["updated_at"],
  runs: ["status", "updated_at", "version"],
  workspaces: ["updated_at"],
  thread_execution_heads: [
    "next_input_sequence",
    "next_queue_sequence",
    "next_turn_ordinal",
    "version",
    "updated_at",
    "active_run_id",
    "active_turn_id",
    "writer_owner",
    "writer_token",
    "writer_expires_at",
  ],
  thread_input_receipts: ["state", "disposition", "updated_at", "consumed_at"],
  thread_follow_up_queue: [
    "state",
    "finished_at",
    "consumption_receipt",
    "activated_at",
    "claim_owner",
    "claim_token",
    "claim_expires_at",
  ],
  worker_tenant_assignments: ["state", "next_attempt_at", "updated_at"],
};

export async function grantEvaluationAccess(
  client: PoolClient,
  context: { readonly schema: string; readonly runtimeRole: string },
): Promise<boolean> {
  const marker = await client.query<{ enabled: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=$1
       AND tablename='threads' AND policyname='normal_thread_source') AS enabled`,
    [context.schema],
  );
  const enabled = marker.rows[0]?.enabled === true;
  const roleName = evaluationRoleName(context.runtimeRole);
  const role = `"${roleName}"`;
  const schema = `"${context.schema}"`;
  const columnGrants = await client.query<{ table_name: string; column_name: string }>(
    `SELECT relation.relname AS table_name,attribute.attname AS column_name
       FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE namespace.nspname=$1 AND attribute.attacl IS NOT NULL
        AND EXISTS (SELECT 1 FROM aclexplode(attribute.attacl) acl
          WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=$2))`,
    [context.schema, roleName],
  );
  for (const row of columnGrants.rows) {
    const table = `"${row.table_name.replaceAll('"', '""')}"`;
    const column = `"${row.column_name.replaceAll('"', '""')}"`;
    await client.query(`REVOKE ALL PRIVILEGES (${column}) ON ${schema}.${table} FROM ${role}`);
  }
  if (!enabled) {
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role};
       REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role};
       REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA ${schema} FROM ${role}`,
    );
  }
  if (enabled) {
    await client.query(`ALTER POLICY worker_tenant_assignments_runtime_policy
      ON ${schema}.worker_tenant_assignments TO "${context.runtimeRole}",${role}`);
    const policies = await client.query<{ table_name: string; policy_name: string }>(
      `SELECT tablename AS table_name,policyname AS policy_name FROM pg_policies
        WHERE schemaname=$1 AND policyname IN (
          'evaluation_thread_read','evaluation_thread_create','evaluation_thread_guard',
          'evaluation_run_read','evaluation_run_create','evaluation_run_guard',
          'evaluation_revision_read','evaluation_definition_read','evaluation_snapshot_create')`,
      [context.schema],
    );
    for (const policy of policies.rows) {
      await client.query(
        `ALTER POLICY ${policy.policy_name} ON ${schema}.${policy.table_name} TO ${role}`,
      );
    }
    await client.query(`ALTER POLICY normal_thread_source ON ${schema}.threads TO "${context.runtimeRole}";
      ALTER POLICY normal_run_source ON ${schema}.runs TO "${context.runtimeRole}"`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(
      `GRANT SELECT ON ${reads.map((table) => `${schema}.${table}`).join(",")} TO ${role}`,
    );
    await client.query(
      `GRANT INSERT ON ${inserts.map((table) => `${schema}.${table}`).join(",")} TO ${role}`,
    );
    for (const [table, columns] of Object.entries(columnReads)) {
      await client.query(`GRANT SELECT(${columns.join(",")}) ON ${schema}.${table} TO ${role}`);
    }
    for (const [table, columns] of Object.entries(updates)) {
      await client.query(`GRANT UPDATE(${columns.join(",")}) ON ${schema}.${table} TO ${role}`);
    }
  }
  const privileges = await client.query<{
    schema_name: string;
    table_name: string;
    column_name: string;
    privilege: string;
    allowed: boolean;
  }>(
    `SELECT namespace.nspname AS schema_name,relation.relname AS table_name,attribute.attname AS column_name,requested.privilege,
       has_column_privilege($1,relation.oid,attribute.attnum,requested.privilege) AS allowed
       FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       JOIN pg_attribute attribute ON attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped
       CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) requested(privilege)
      WHERE namespace.nspname!~'^pg_' AND namespace.nspname<>'information_schema'
        AND relation.relkind IN ('r','p','v','m','f')`,
    [roleName],
  );
  for (const row of privileges.rows) {
    const expected =
      enabled &&
      row.schema_name === context.schema &&
      ((row.privilege === "SELECT" &&
        ((reads as readonly string[]).includes(row.table_name) ||
          columnReads[row.table_name]?.includes(row.column_name) === true)) ||
        (row.privilege === "INSERT" && (inserts as readonly string[]).includes(row.table_name)) ||
        (row.privilege === "UPDATE" &&
          updates[row.table_name]?.includes(row.column_name) === true));
    if (row.allowed !== expected) {
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        `评测权限偏离白名单：${row.schema_name}.${row.table_name}.${row.column_name}.${row.privilege}`,
      );
    }
  }
  const forbidden = await client.query<{ safe: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM pg_namespace namespace
         WHERE namespace.nspname!~'^pg_' AND namespace.nspname<>'information_schema'
           AND (has_schema_privilege($1,namespace.oid,'CREATE') OR
             (namespace.nspname<>$2 AND has_schema_privilege($1,namespace.oid,'USAGE'))))
       AND NOT EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname!~'^pg_' AND namespace.nspname<>'information_schema' AND (
         (relation.relkind IN ('r','p','v','m','f') AND has_table_privilege($1,relation.oid,'DELETE,TRUNCATE,TRIGGER'))
         OR (relation.relkind='S' AND has_sequence_privilege($1,relation.oid,'USAGE,SELECT,UPDATE'))))
       AND NOT EXISTS (SELECT 1 FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
         WHERE namespace.nspname!~'^pg_' AND namespace.nspname<>'information_schema'
           AND has_function_privilege($1,routine.oid,'EXECUTE')) AS safe`,
    [roleName, context.schema],
  );
  if (forbidden.rows[0]?.safe !== true) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "评测角色不得持有删除、序列或 Routine 权限");
  }
  return enabled;
}
