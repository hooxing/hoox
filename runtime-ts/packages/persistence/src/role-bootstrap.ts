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

const runtimeTablePolicy = new Map<string, ReadonlySet<string>>([
  ["app_users", new Set(["SELECT", "INSERT"])],
  ["tenants", new Set(["SELECT", "INSERT"])],
  ["memberships", new Set(["SELECT", "INSERT"])],
  ["threads", new Set(["SELECT", "INSERT", "UPDATE"])],
  ["runs", new Set(["SELECT", "INSERT", "UPDATE"])],
  ["workspaces", new Set(["SELECT", "INSERT", "UPDATE"])],
  ["workspace_revisions", new Set(["SELECT", "INSERT"])],
  ["workspace_write_leases", new Set(["SELECT", "INSERT", "UPDATE", "DELETE"])],
  [migrationTable, new Set()],
]);

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
  readonly migrator_missing: boolean;
  readonly migrator_is_not_current_user: boolean;
  readonly migrator_has_parent: boolean;
  readonly migrator_dangerous: boolean;
  readonly migrator_owns_database: boolean;
  readonly migrator_can_create_database_object: boolean;
  readonly schema_missing: boolean;
  readonly migrator_is_not_schema_owner: boolean;
  readonly current_schema_mismatch: boolean;
  readonly search_path_mismatch: boolean;
}

/**
 * Runtime 禁止任何上游成员关系，包括 NOINHERIT 但仍可 SET ROLE 的成员关系。
 * Migrator 必须是当前专用 Schema 的直接 owner，且不能借成员关系或数据库权限扩大边界。
 */
export async function assertMigrationContextSafe(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
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
       NOT EXISTS (SELECT 1 FROM target_schema) AS schema_missing,
       NOT EXISTS (
         SELECT 1 FROM target_schema WHERE nspowner = (SELECT oid FROM migrator)
       ) AS migrator_is_not_schema_owner,
       current_schema() IS DISTINCT FROM $3 AS current_schema_mismatch,
       current_setting('search_path') IS DISTINCT FROM $3 AS search_path_mismatch`,
    [context.runtimeRole, context.migratorRole, context.schema],
  );
  const state = result.rows[0];
  if (state === undefined || Object.values(state).some((unsafe) => unsafe)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "数据库迁移角色或 Schema 边界不安全");
  }
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

async function assertActiveRuntimeWhitelist(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const relationResult = await client.query<{ table_name: string }>(
    `SELECT relname AS table_name
       FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p')
      ORDER BY relname`,
  );
  const actualTables = relationResult.rows.map((row) => row.table_name);
  const expectedTables = [...runtimeTablePolicy.keys()].sort();
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
    if (row.allowed !== runtimeTablePolicy.get(row.table_name)?.has(row.privilege)) {
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 表权限偏离白名单");
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
}

/** 在既有迁移事务中收敛 ACL，供 down 保证 DDL 与权限回收原子提交。 */
export async function bootstrapRuntimeAccessOnClient(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  await assertMigrationContextSafe(client, context);
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
  await client.query(
    `GRANT SELECT, INSERT, UPDATE ON TABLE ${schema}.threads, ${schema}.runs, ${schema}.workspaces TO ${role}`,
  );
  await client.query(`GRANT SELECT, INSERT ON TABLE ${schema}.workspace_revisions TO ${role}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${schema}.workspace_write_leases TO ${role}`,
  );
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
