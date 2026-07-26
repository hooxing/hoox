import type { Pool, PoolClient } from "pg";
import { PersistenceError, mapPersistenceError } from "./errors.js";
import { assertSafeSchemaName, withTransaction } from "./postgres.js";

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;
const tablePrivileges = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;
const sequencePrivileges = ["USAGE", "SELECT", "UPDATE"] as const;
const migrationTable = "runtime_schema_migrations";
const runWorkerTables = new Set([
  "run_execution_inputs",
  "execution_attempts",
  "execution_workspace_fences",
  "run_claims",
  "rollout_projections",
  "run_events",
  "sandbox_registry",
  "cleanup_outbox",
  "sandbox_lifecycle_unknown",
  "runtime_alert_outbox",
  "effect_invocations",
  "external_effect_permits",
  "mutation_receipts",
]);

const runtimeTablePolicy = new Map<string, ReadonlySet<string>>([
  ["app_users", new Set(["SELECT", "INSERT"])],
  ["tenants", new Set(["SELECT", "INSERT"])],
  ["memberships", new Set(["SELECT", "INSERT"])],
  ["threads", new Set(["SELECT", "INSERT", "UPDATE"])],
  ["runs", new Set(["SELECT", "INSERT", "UPDATE"])],
  ["workspaces", new Set(["SELECT", "INSERT", "UPDATE"])],
  ["workspace_revisions", new Set(["SELECT", "INSERT"])],
  ["workspace_write_leases", new Set(["SELECT", "INSERT", "UPDATE", "DELETE"])],
  ["blob_lifecycles", new Set(["SELECT", "INSERT"])],
  ["blob_incarnations", new Set(["SELECT", "INSERT"])],
  ["blob_allocations", new Set(["SELECT", "INSERT"])],
  ["blob_commits", new Set(["SELECT", "INSERT"])],
  ["promotion_authorizations", new Set(["SELECT", "INSERT"])],
  ["promotion_executions", new Set(["SELECT", "INSERT"])],
  ["blob_gc_claims", new Set(["SELECT", "INSERT"])],
  ["retired_blob_tombstones", new Set(["SELECT", "INSERT"])],
  ["blob_references", new Set(["SELECT", "INSERT"])],
  ["run_execution_inputs", new Set(["SELECT", "INSERT"])],
  ["execution_attempts", new Set(["SELECT", "INSERT"])],
  ["execution_workspace_fences", new Set(["SELECT", "INSERT"])],
  ["run_claims", new Set(["SELECT", "INSERT"])],
  ["rollout_projections", new Set(["SELECT", "INSERT"])],
  ["run_events", new Set(["SELECT", "INSERT"])],
  ["sandbox_registry", new Set(["SELECT", "INSERT"])],
  ["cleanup_outbox", new Set(["SELECT", "INSERT"])],
  ["sandbox_lifecycle_unknown", new Set(["SELECT", "INSERT"])],
  ["runtime_alert_outbox", new Set(["SELECT", "INSERT"])],
  ["effect_invocations", new Set(["SELECT", "INSERT"])],
  ["external_effect_permits", new Set(["SELECT", "INSERT"])],
  ["mutation_receipts", new Set(["SELECT", "INSERT"])],
  [migrationTable, new Set()],
]);

const runtimeColumnUpdatePolicy = new Map<string, ReadonlySet<string>>([
  [
    "blob_lifecycles",
    new Set([
      "state",
      "current_incarnation_id",
      "generation",
      "current_claim_id",
      "lease_expires_at",
      "updated_at",
    ]),
  ],
  ["blob_incarnations", new Set(["state", "retired_at"])],
  ["blob_commits", new Set(["status", "version", "snapshot", "updated_at"])],
  [
    "promotion_authorizations",
    new Set(["state", "current_execution_id", "execution_generation", "updated_at"]),
  ],
  ["promotion_executions", new Set(["phase", "proof_status", "updated_at"])],
  ["blob_gc_claims", new Set(["phase", "updated_at"])],
  [
    "retired_blob_tombstones",
    new Set(["generation", "scrub_lease_expires_at", "next_scrub_at", "last_scrubbed_at"]),
  ],
  [
    "blob_references",
    new Set(["state", "lifecycle_id", "incarnation_id", "physical_object_key", "updated_at"]),
  ],
  ["run_execution_inputs", new Set(["answer_text", "updated_at"])],
  [
    "execution_attempts",
    new Set([
      "current_revision_id",
      "status",
      "stage",
      "version",
      "next_event_sequence",
      "projection_version",
      "model_execution_started",
      "updated_at",
      "finished_at",
    ]),
  ],
  ["run_claims", new Set(["expires_at", "updated_at", "released_at"])],
  ["rollout_projections", new Set(["attempt_id", "version", "projection", "digest", "updated_at"])],
  ["sandbox_registry", new Set(["state", "actual_ttl_seconds", "updated_at"])],
  ["cleanup_outbox", new Set(["state", "disposition", "payload", "payload_digest", "updated_at"])],
  ["external_effect_permits", new Set(["consumed_at"])],
]);

async function hasMembershipLockMarker(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass(format('%I.memberships', current_schema()))
          AND attname = 'lock_marker' AND attnum > 0 AND NOT attisdropped
     ) AS present`,
  );
  return result.rows[0]?.present === true;
}

async function hasRunWorkerState(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass(format('%I.run_execution_inputs', current_schema())) IS NOT NULL AS present",
  );
  return result.rows[0]?.present === true;
}

async function activeTablePolicy(
  client: PoolClient,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const policy = new Map(runtimeTablePolicy);
  if (!(await hasRunWorkerState(client))) {
    for (const table of runWorkerTables) policy.delete(table);
  }
  return policy;
}

async function activeColumnUpdatePolicy(
  client: PoolClient,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const policy = new Map(runtimeColumnUpdatePolicy);
  // 0003 之前不存在该列；partial down 后 ACL 必须回到 0002 的真实 Schema，而不是引用未来列。
  policy.set(
    "memberships",
    (await hasMembershipLockMarker(client)) ? new Set(["lock_marker"]) : new Set(),
  );
  if (!(await hasRunWorkerState(client))) {
    for (const table of runWorkerTables) policy.delete(table);
  }
  return policy;
}

export interface MigrationSecurityContext {
  readonly runtimeRole: string;
  readonly migratorRole: string;
  readonly schema: string;
}

function quoteIdentifier(value: string): string {
  if (!rolePattern.test(value)) throw new TypeError("数据库角色名称无效");
  return `"${value}"`;
}

function validateContext(context: MigrationSecurityContext): void {
  quoteIdentifier(context.runtimeRole);
  quoteIdentifier(context.migratorRole);
  assertSafeSchemaName(context.schema);
  if (context.runtimeRole === context.migratorRole) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 与 Migrator 必须使用不同角色");
  }
}

interface MigrationContextSafetyRow {
  readonly runtime_missing: boolean;
  readonly runtime_has_parent: boolean;
  readonly runtime_dangerous: boolean;
  readonly runtime_owns_database: boolean;
  readonly runtime_owns_schema: boolean;
  readonly runtime_owns_relation: boolean;
  readonly runtime_can_create_database_object: boolean;
  readonly runtime_can_create_schema_object: boolean;
  readonly runtime_can_create_temporary_object: boolean;
  readonly migrator_missing: boolean;
  readonly migrator_is_not_current_user: boolean;
  readonly migrator_has_parent: boolean;
  readonly migrator_dangerous: boolean;
  readonly migrator_owns_database: boolean;
  readonly migrator_can_create_database_object: boolean;
  readonly migrator_can_create_other_schema_object: boolean;
  readonly migrator_has_routine_default_acl: boolean;
  readonly migrator_owns_other_schema: boolean;
  readonly migrator_owns_cross_schema_relation: boolean;
  readonly target_schema_has_routine: boolean;
  readonly target_schema_has_prohibited_owned_object: boolean;
  readonly migrator_owns_cross_schema_routine: boolean;
  readonly migrator_owns_cross_schema_object: boolean;
  readonly schema_missing: boolean;
  readonly migrator_is_not_schema_owner: boolean;
  readonly current_schema_mismatch: boolean;
  readonly search_path_mismatch: boolean;
}

/**
 * Runtime 禁止任何上游成员关系，包括 NOINHERIT 但仍可 SET ROLE 的成员关系。
 * Migrator 必须是当前专用 Schema 的直接 owner，且不能借成员关系或数据库权限扩大边界。
 */
async function inspectMigrationContext(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<MigrationContextSafetyRow | undefined> {
  validateContext(context);
  const result = await client.query<MigrationContextSafetyRow>(
    `WITH runtime AS (
       SELECT * FROM pg_roles WHERE rolname = $1
     ), migrator AS (
       SELECT * FROM pg_roles WHERE rolname = $2
     ), target_schema AS (
       SELECT * FROM pg_namespace WHERE nspname = $3
     )
     SELECT
       NOT EXISTS (SELECT 1 FROM runtime) AS runtime_missing,
       EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM runtime))
         AS runtime_has_parent,
       EXISTS (
         SELECT 1 FROM runtime
          WHERE rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
       ) AS runtime_dangerous,
       EXISTS (
         SELECT 1 FROM pg_database
          WHERE datname = current_database() AND datdba = (SELECT oid FROM runtime)
       ) AS runtime_owns_database,
       EXISTS (
         SELECT 1 FROM pg_namespace WHERE nspowner = (SELECT oid FROM runtime)
       ) AS runtime_owns_schema,
       EXISTS (
         SELECT 1 FROM pg_class
          WHERE relkind IN ('r', 'p', 'S', 'v', 'm')
            AND relowner = (SELECT oid FROM runtime)
       ) AS runtime_owns_relation,
       COALESCE(has_database_privilege(
         (SELECT oid FROM runtime), current_database(), 'CREATE'
       ), false) AS runtime_can_create_database_object,
       COALESCE(has_schema_privilege(
         (SELECT oid FROM runtime), $3, 'CREATE'
       ), false) AS runtime_can_create_schema_object,
       COALESCE(has_database_privilege(
         (SELECT oid FROM runtime), current_database(), 'TEMP'
       ), false) AS runtime_can_create_temporary_object,
       NOT EXISTS (SELECT 1 FROM migrator) AS migrator_missing,
       current_user <> $2 AS migrator_is_not_current_user,
       EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM migrator))
         AS migrator_has_parent,
       EXISTS (
         SELECT 1 FROM migrator
          WHERE rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
       ) AS migrator_dangerous,
       EXISTS (
         SELECT 1 FROM pg_database
          WHERE datname = current_database() AND datdba = (SELECT oid FROM migrator)
       ) AS migrator_owns_database,
       COALESCE(has_database_privilege(
         (SELECT oid FROM migrator), current_database(), 'CREATE'
       ), false) AS migrator_can_create_database_object,
       EXISTS (
         SELECT 1 FROM pg_namespace schema_state
          WHERE schema_state.nspname <> $3
            AND schema_state.nspname <> 'information_schema'
            AND schema_state.nspname !~ '^pg_'
            AND has_schema_privilege(
              (SELECT oid FROM migrator), schema_state.oid, 'CREATE'
            )
       ) AS migrator_can_create_other_schema_object,
       EXISTS (
         SELECT 1 FROM pg_default_acl defaults
          WHERE defaults.defaclrole = (SELECT oid FROM migrator)
            -- 不解析 grantee：首版连仅 owner 的 routine 默认 ACL 记录也不接受。
            AND defaults.defaclobjtype = 'f'
       ) AS migrator_has_routine_default_acl,
       EXISTS (
         SELECT 1 FROM pg_namespace
          WHERE nspowner = (SELECT oid FROM migrator) AND nspname <> $3
            AND nspname <> 'information_schema' AND nspname !~ '^pg_'
       ) AS migrator_owns_other_schema,
       EXISTS (
         SELECT 1 FROM pg_class relation
         JOIN pg_namespace schema_state ON schema_state.oid = relation.relnamespace
          WHERE relation.relowner = (SELECT oid FROM migrator)
            AND schema_state.nspname <> $3
            AND schema_state.nspname <> 'information_schema'
            AND schema_state.nspname !~ '^pg_'
       ) AS migrator_owns_cross_schema_relation,
       EXISTS (
         SELECT 1 FROM pg_proc routine
          WHERE routine.pronamespace = (SELECT oid FROM target_schema)
       ) AS target_schema_has_routine,
       EXISTS (
         SELECT 1 FROM pg_type type_state
          WHERE type_state.typowner = (SELECT oid FROM migrator)
            AND type_state.typnamespace = (SELECT oid FROM target_schema)
            -- 表会自动生成复合类型及数组类型；它们是 relation 附属对象，不是独立 type。
            AND type_state.typrelid = 0
            AND NOT EXISTS (
              SELECT 1 FROM pg_type element_type
               WHERE element_type.oid = type_state.typelem
                 AND element_type.typrelid <> 0
                 AND element_type.typnamespace = (SELECT oid FROM target_schema)
            )
         UNION ALL
         SELECT 1
           FROM (
             SELECT oprnamespace AS namespace_oid, oprowner AS owner_oid FROM pg_operator
             UNION ALL
             SELECT connamespace, conowner FROM pg_conversion
             UNION ALL
             SELECT collnamespace, collowner FROM pg_collation
             UNION ALL
             SELECT cfgnamespace, cfgowner FROM pg_ts_config
             UNION ALL
             SELECT dictnamespace, dictowner FROM pg_ts_dict
           ) owned_object
          WHERE owned_object.owner_oid = (SELECT oid FROM migrator)
            AND owned_object.namespace_oid = (SELECT oid FROM target_schema)
       ) AS target_schema_has_prohibited_owned_object,
       EXISTS (
         SELECT 1 FROM pg_proc routine
         JOIN pg_namespace schema_state ON schema_state.oid = routine.pronamespace
          WHERE routine.proowner = (SELECT oid FROM migrator)
            AND schema_state.nspname <> $3
            AND schema_state.nspname <> 'information_schema'
            AND schema_state.nspname !~ '^pg_'
       ) AS migrator_owns_cross_schema_routine,
       EXISTS (
         SELECT 1
           FROM (
             SELECT typnamespace AS namespace_oid, typowner AS owner_oid FROM pg_type
             UNION ALL
             SELECT oprnamespace, oprowner FROM pg_operator
             UNION ALL
             SELECT connamespace, conowner FROM pg_conversion
             UNION ALL
             SELECT collnamespace, collowner FROM pg_collation
             UNION ALL
             SELECT cfgnamespace, cfgowner FROM pg_ts_config
             UNION ALL
             SELECT dictnamespace, dictowner FROM pg_ts_dict
           ) owned_object
           JOIN pg_namespace schema_state ON schema_state.oid = owned_object.namespace_oid
          WHERE owned_object.owner_oid = (SELECT oid FROM migrator)
            AND schema_state.nspname <> $3
            AND schema_state.nspname <> 'information_schema'
            AND schema_state.nspname !~ '^pg_'
       ) AS migrator_owns_cross_schema_object,
       NOT EXISTS (SELECT 1 FROM target_schema) AS schema_missing,
       NOT EXISTS (
         SELECT 1 FROM target_schema WHERE nspowner = (SELECT oid FROM migrator)
       ) AS migrator_is_not_schema_owner,
       current_schema() IS DISTINCT FROM $3 AS current_schema_mismatch,
       current_setting('search_path') IS DISTINCT FROM $3 AS search_path_mismatch`,
    [context.runtimeRole, context.migratorRole, context.schema],
  );
  return result.rows[0];
}

function assertInspectedContextSafe(
  state: MigrationContextSafetyRow | undefined,
  allowRuntimeSchemaCreate: boolean,
): void {
  if (
    state === undefined ||
    Object.entries(state).some(
      ([name, unsafe]) =>
        unsafe && !(allowRuntimeSchemaCreate && name === "runtime_can_create_schema_object"),
    )
  ) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "数据库迁移角色或 Schema 边界不安全");
  }
}

export async function assertMigrationContextSafe(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  assertInspectedContextSafe(await inspectMigrationContext(client, context), false);
}

async function assertBootstrapContextSafe(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  // 独立修复 ACL 时允许先清理来自 PUBLIC/直接授权的目标 Schema CREATE；其余边界不放宽。
  assertInspectedContextSafe(await inspectMigrationContext(client, context), true);
}

interface PrivilegeRow {
  readonly table_name: string;
  readonly privilege: string;
  readonly allowed: boolean;
}

interface EffectiveBoundaryRow {
  readonly schema_usage: boolean;
  readonly schema_create: boolean;
  readonly database_connect: boolean;
  readonly database_create: boolean;
  readonly database_temporary: boolean;
}

async function assertDatabaseAndSchemaBoundary(
  client: PoolClient,
  context: MigrationSecurityContext,
  schemaUsage: boolean,
): Promise<void> {
  const result = await client.query<EffectiveBoundaryRow>(
    `SELECT has_schema_privilege($1, $2, 'USAGE') AS schema_usage,
            has_schema_privilege($1, $2, 'CREATE') AS schema_create,
            has_database_privilege($1, current_database(), 'CONNECT') AS database_connect,
            has_database_privilege($1, current_database(), 'CREATE') AS database_create,
            has_database_privilege($1, current_database(), 'TEMP') AS database_temporary`,
    [context.runtimeRole, context.schema],
  );
  if (
    result.rows[0]?.schema_usage !== schemaUsage ||
    result.rows[0]?.schema_create !== false ||
    result.rows[0]?.database_connect !== true ||
    result.rows[0]?.database_create !== false ||
    result.rows[0]?.database_temporary !== false
  ) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 数据库或 Schema 权限偏离白名单");
  }
}

async function assertNoPublicRelationPrivileges(client: PoolClient): Promise<void> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_class relation
       CROSS JOIN LATERAL aclexplode(
         COALESCE(relation.relacl, acldefault(
           CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
           relation.relowner
         ))
       ) acl
      WHERE relation.relnamespace = current_schema()::regnamespace
        AND relation.relkind IN ('r', 'p', 'S')
        AND acl.grantee = 0`,
  );
  if (result.rows[0]?.count !== "0") {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "PUBLIC 仍持有业务对象权限");
  }
}

async function assertNoPublicSchemaPrivileges(client: PoolClient): Promise<void> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_namespace schema_state
       CROSS JOIN LATERAL aclexplode(
         COALESCE(schema_state.nspacl, acldefault('n'::"char", schema_state.nspowner))
       ) acl
      WHERE schema_state.oid = current_schema()::regnamespace
        AND acl.grantee = 0`,
  );
  if (result.rows[0]?.count !== "0") {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "PUBLIC 仍持有业务 Schema 权限");
  }
}

async function assertRoutinePrivilegeBoundary(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const runtimePrivileges = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_proc routine
      WHERE routine.pronamespace = current_schema()::regnamespace
        AND has_function_privilege($1, routine.oid, 'EXECUTE')`,
    [context.runtimeRole],
  );
  const publicPrivileges = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_proc routine
       CROSS JOIN LATERAL aclexplode(
         COALESCE(routine.proacl, acldefault('f'::"char", routine.proowner))
       ) acl
      WHERE routine.pronamespace = current_schema()::regnamespace
        AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'`,
  );
  if (runtimePrivileges.rows[0]?.count !== "0" || publicPrivileges.rows[0]?.count !== "0") {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Routine 执行权限偏离空白名单");
  }
}

async function assertActiveRuntimeWhitelist(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const tablePolicy = await activeTablePolicy(client);
  const columnUpdatePolicy = await activeColumnUpdatePolicy(client);
  const relationResult = await client.query<{ table_name: string }>(
    `SELECT relname AS table_name
       FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p')
      ORDER BY relname`,
  );
  const actualTables = relationResult.rows.map((row) => row.table_name);
  const expectedTables = [...tablePolicy.keys()].sort();
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "业务表集合与 Runtime 权限策略不一致");
  }

  const privileges = await client.query<PrivilegeRow>(
    `SELECT target.table_name, requested.privilege,
            has_table_privilege(
              $1, format('%I.%I', $2::text, target.table_name), requested.privilege
            ) AS allowed
       FROM unnest($3::text[]) AS target(table_name)
       CROSS JOIN unnest($4::text[]) AS requested(privilege)`,
    [context.runtimeRole, context.schema, expectedTables, tablePrivileges],
  );
  for (const row of privileges.rows) {
    if (row.allowed !== tablePolicy.get(row.table_name)?.has(row.privilege)) {
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 表权限偏离白名单");
    }
  }

  const columnUpdates = await client.query<{
    table_name: string;
    column_name: string;
    allowed: boolean;
  }>(
    `SELECT column_state.table_name, column_state.column_name,
            has_column_privilege(
              $1,
              format('%I.%I', $2::text, column_state.table_name),
              column_state.column_name,
              'UPDATE'
            ) AS allowed
       FROM information_schema.columns column_state
      WHERE column_state.table_schema = $2
        AND column_state.table_name = ANY($3::text[])
      ORDER BY column_state.table_name, column_state.ordinal_position`,
    [context.runtimeRole, context.schema, [...columnUpdatePolicy.keys()]],
  );
  for (const row of columnUpdates.rows) {
    if (row.allowed !== columnUpdatePolicy.get(row.table_name)?.has(row.column_name)) {
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 列级 UPDATE 权限偏离白名单");
    }
  }

  const sequences = await client.query<PrivilegeRow>(
    `SELECT relation.relname AS table_name, requested.privilege,
            has_sequence_privilege(
              $1, format('%I.%I', $2::text, relation.relname), requested.privilege
            ) AS allowed
       FROM pg_class relation
       CROSS JOIN unnest($3::text[]) AS requested(privilege)
      WHERE relation.relnamespace = current_schema()::regnamespace AND relation.relkind = 'S'`,
    [context.runtimeRole, context.schema, sequencePrivileges],
  );
  if (sequences.rows.some((row) => row.allowed)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 不得持有 sequence 权限");
  }
  await assertDatabaseAndSchemaBoundary(client, context, true);
  await assertNoPublicRelationPrivileges(client);
  await assertNoPublicSchemaPrivileges(client);
  await assertRoutinePrivilegeBoundary(client, context);
}

async function assertRuntimeAccessRemoved(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const relations = await client.query<{ table_name: string }>(
    `SELECT relname AS table_name
       FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p')
      ORDER BY relname`,
  );
  if (
    JSON.stringify(relations.rows.map((row) => row.table_name)) !== JSON.stringify([migrationTable])
  ) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "down 后仍残留业务表");
  }
  const privileges = await client.query<PrivilegeRow>(
    `SELECT relation.relname AS table_name, requested.privilege,
            has_table_privilege(
              $1, format('%I.%I', $2::text, relation.relname), requested.privilege
            ) AS allowed
       FROM pg_class relation
       CROSS JOIN unnest($3::text[]) AS requested(privilege)
      WHERE relation.relnamespace = current_schema()::regnamespace
        AND relation.relkind IN ('r', 'p')`,
    [context.runtimeRole, context.schema, tablePrivileges],
  );
  if (privileges.rows.some((row) => row.allowed)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "down 后 Runtime 仍持有表权限");
  }
  const sequences = await client.query<PrivilegeRow>(
    `SELECT relation.relname AS table_name, requested.privilege,
            has_sequence_privilege(
              $1, format('%I.%I', $2::text, relation.relname), requested.privilege
            ) AS allowed
       FROM pg_class relation
       CROSS JOIN unnest($3::text[]) AS requested(privilege)
      WHERE relation.relnamespace = current_schema()::regnamespace AND relation.relkind = 'S'`,
    [context.runtimeRole, context.schema, sequencePrivileges],
  );
  if (sequences.rows.some((row) => row.allowed)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "down 后 Runtime 仍持有 sequence 权限");
  }
  await assertDatabaseAndSchemaBoundary(client, context, false);
  await assertNoPublicRelationPrivileges(client);
  await assertNoPublicSchemaPrivileges(client);
  await assertRoutinePrivilegeBoundary(client, context);
}

/** 在既有迁移事务中收敛 ACL，供 down 保证 DDL 与权限回收原子提交。 */
export async function bootstrapRuntimeAccessOnClient(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  await assertBootstrapContextSafe(client, context);
  const role = quoteIdentifier(context.runtimeRole);
  const schema = quoteIdentifier(context.schema);
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM PUBLIC, ${role}`);
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC, ${role}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC, ${role}`,
  );
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await client.query(
    `GRANT SELECT, INSERT ON TABLE ${schema}.app_users, ${schema}.tenants, ${schema}.memberships TO ${role}`,
  );
  if (await hasMembershipLockMarker(client)) {
    await client.query(`GRANT UPDATE(lock_marker) ON TABLE ${schema}.memberships TO ${role}`);
  }
  await client.query(
    `GRANT SELECT, INSERT, UPDATE ON TABLE ${schema}.threads, ${schema}.runs, ${schema}.workspaces TO ${role}`,
  );
  await client.query(`GRANT SELECT, INSERT ON TABLE ${schema}.workspace_revisions TO ${role}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${schema}.workspace_write_leases TO ${role}`,
  );
  // 生命周期历史与副作用证明只允许追加或状态推进，Runtime 永远不能物理删除审计事实。
  await client.query(
    `GRANT SELECT, INSERT ON TABLE
       ${schema}.blob_lifecycles,
       ${schema}.blob_incarnations,
       ${schema}.blob_commits,
       ${schema}.promotion_authorizations,
       ${schema}.promotion_executions,
       ${schema}.blob_gc_claims,
       ${schema}.retired_blob_tombstones,
       ${schema}.blob_references
     TO ${role}`,
  );
  await client.query(`GRANT SELECT, INSERT ON TABLE ${schema}.blob_allocations TO ${role}`);
  if (await hasRunWorkerState(client)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
       ${schema}.run_execution_inputs,
       ${schema}.execution_attempts,
       ${schema}.execution_workspace_fences,
       ${schema}.run_claims,
       ${schema}.rollout_projections,
       ${schema}.run_events,
       ${schema}.sandbox_registry,
       ${schema}.cleanup_outbox,
       ${schema}.sandbox_lifecycle_unknown,
       ${schema}.runtime_alert_outbox,
       ${schema}.effect_invocations,
       ${schema}.external_effect_permits,
       ${schema}.mutation_receipts
       TO ${role}`,
    );
  }
  await client.query(
    `GRANT UPDATE(state, current_incarnation_id, generation, current_claim_id, lease_expires_at, updated_at)
       ON TABLE ${schema}.blob_lifecycles TO ${role};
     GRANT UPDATE(state, retired_at)
       ON TABLE ${schema}.blob_incarnations TO ${role};
     GRANT UPDATE(status, version, snapshot, updated_at)
       ON TABLE ${schema}.blob_commits TO ${role};
     GRANT UPDATE(state, current_execution_id, execution_generation, updated_at)
       ON TABLE ${schema}.promotion_authorizations TO ${role};
     GRANT UPDATE(phase, proof_status, updated_at)
       ON TABLE ${schema}.promotion_executions TO ${role};
     GRANT UPDATE(phase, updated_at)
       ON TABLE ${schema}.blob_gc_claims TO ${role};
     GRANT UPDATE(generation, scrub_lease_expires_at, next_scrub_at, last_scrubbed_at)
       ON TABLE ${schema}.retired_blob_tombstones TO ${role};
     GRANT UPDATE(state, lifecycle_id, incarnation_id, physical_object_key, updated_at)
       ON TABLE ${schema}.blob_references TO ${role}`,
  );
  if (await hasRunWorkerState(client)) {
    await client.query(
      `GRANT UPDATE(answer_text, updated_at)
       ON TABLE ${schema}.run_execution_inputs TO ${role};
     GRANT UPDATE(
       current_revision_id, status, stage, version, next_event_sequence, projection_version,
       model_execution_started, updated_at, finished_at
     ) ON TABLE ${schema}.execution_attempts TO ${role};
     GRANT UPDATE(expires_at, updated_at, released_at)
       ON TABLE ${schema}.run_claims TO ${role};
     GRANT UPDATE(attempt_id, version, projection, digest, updated_at)
       ON TABLE ${schema}.rollout_projections TO ${role};
     GRANT UPDATE(state, actual_ttl_seconds, updated_at)
       ON TABLE ${schema}.sandbox_registry TO ${role};
     GRANT UPDATE(state, disposition, payload, payload_digest, updated_at)
       ON TABLE ${schema}.cleanup_outbox TO ${role};
       GRANT UPDATE(consumed_at)
         ON TABLE ${schema}.external_effect_permits TO ${role}`,
    );
  }
  await assertActiveRuntimeWhitelist(client, context);
}

/** 独立、可重复的 ACL bootstrap；角色与 Schema preflight 始终先于任何 ACL 变更。 */
export async function bootstrapRuntimeAccess(
  pool: Pool,
  context: MigrationSecurityContext,
): Promise<void> {
  try {
    await withTransaction(pool, (client) => bootstrapRuntimeAccessOnClient(client, context));
  } catch (error) {
    throw mapPersistenceError(error, "配置 Runtime 最小权限");
  }
}

/** 仅在现有 down 事务内调用；数据库级角色 bootstrap 保持不变。 */
export async function teardownRuntimeSchemaAccessOnClient(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const role = quoteIdentifier(context.runtimeRole);
  const schema = quoteIdentifier(context.schema);
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC, ${role}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC, ${role}`,
  );
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM PUBLIC, ${role}`);
  await assertRuntimeAccessRemoved(client, context);
}
