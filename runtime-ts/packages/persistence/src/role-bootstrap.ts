import type { Pool, PoolClient } from "pg";
import { PersistenceError, mapPersistenceError } from "./errors.js";
import { withTransaction } from "./postgres.js";

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;

function quoteIdentifier(value: string): string {
  if (!rolePattern.test(value)) throw new TypeError("数据库角色名称无效");
  return `"${value}"`;
}

interface RoleSafetyRow {
  readonly role_missing: boolean;
  readonly dangerous_attribute: boolean;
  readonly owns_database: boolean;
  readonly owns_schema: boolean;
  readonly owns_table: boolean;
  readonly can_create_database_object: boolean;
  readonly can_create_schema_object: boolean;
}

/**
 * 在任何业务 DDL 之前执行。角色闭包保守地包含所有可继承或可 SET ROLE 到的上游角色，
 * 避免 Runtime 通过间接成员关系取得 owner、BYPASSRLS 或管理权限。
 */
export async function assertRuntimeRoleSafe(
  client: PoolClient,
  runtimeRole: string,
): Promise<void> {
  quoteIdentifier(runtimeRole);
  const result = await client.query<RoleSafetyRow>(
    `WITH RECURSIVE role_closure(oid) AS (
       SELECT oid FROM pg_roles WHERE rolname = $1
       UNION
       SELECT membership.roleid
         FROM pg_auth_members membership
         JOIN role_closure reachable ON reachable.oid = membership.member
     )
     SELECT
       NOT EXISTS (SELECT 1 FROM role_closure) AS role_missing,
       EXISTS (
         SELECT 1 FROM pg_roles role_state JOIN role_closure USING (oid)
          WHERE role_state.rolsuper OR role_state.rolbypassrls OR role_state.rolcreatedb
             OR role_state.rolcreaterole OR role_state.rolreplication
       ) AS dangerous_attribute,
       EXISTS (
         SELECT 1 FROM pg_database database_state
          WHERE database_state.datname = current_database()
            AND database_state.datdba IN (SELECT oid FROM role_closure)
       ) AS owns_database,
       EXISTS (
         SELECT 1 FROM pg_namespace schema_state
          WHERE schema_state.nspname = current_schema()
            AND schema_state.nspowner IN (SELECT oid FROM role_closure)
       ) AS owns_schema,
       EXISTS (
         SELECT 1 FROM pg_class table_state
          WHERE table_state.relnamespace = current_schema()::regnamespace
            AND table_state.relkind IN ('r', 'p', 'S', 'v', 'm')
            AND table_state.relowner IN (SELECT oid FROM role_closure)
       ) AS owns_table,
       COALESCE(has_database_privilege(
         (SELECT oid FROM pg_roles WHERE rolname = $1), current_database(), 'CREATE'
       ), false)
         AS can_create_database_object,
       COALESCE(has_schema_privilege(
         (SELECT oid FROM pg_roles WHERE rolname = $1), current_schema(), 'CREATE'
       ), false)
         AS can_create_schema_object`,
    [runtimeRole],
  );
  const state = result.rows[0];
  if (
    state === undefined ||
    state.role_missing ||
    state.dangerous_attribute ||
    state.owns_database ||
    state.owns_schema ||
    state.owns_table ||
    state.can_create_database_object ||
    state.can_create_schema_object
  ) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 数据库角色边界不安全");
  }
}

/** Schema 迁移之外的可重复 ACL bootstrap；不会被普通 down 隐式回滚。 */
export async function bootstrapRuntimeAccess(pool: Pool, runtimeRole: string): Promise<void> {
  try {
    await withTransaction(pool, async (client) => {
      await assertRuntimeRoleSafe(client, runtimeRole);
      const role = quoteIdentifier(runtimeRole);
      const schemaResult = await client.query<{ schema_name: string }>(
        "SELECT current_schema() AS schema_name",
      );
      const schemaName = schemaResult.rows[0]?.schema_name;
      if (schemaName === undefined) throw new PersistenceError("UNEXPECTED", "无法识别当前 Schema");
      const schema = quoteIdentifier(schemaName);

      await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`);
      await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`);
      await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC, ${role}`);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await client.query(
        `GRANT SELECT, INSERT ON TABLE app_users, tenants, memberships TO ${role}`,
      );
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON TABLE threads, runs, workspaces TO ${role}`,
      );
      await client.query(`GRANT SELECT, INSERT ON TABLE workspace_revisions TO ${role}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE workspace_write_leases TO ${role}`,
      );
      // 对审计型 Revision 额外显式撤销，防止未来默认权限或人工授权扩大边界。
      await client.query(`REVOKE UPDATE, DELETE ON TABLE workspace_revisions FROM ${role}`);
    });
  } catch (error) {
    throw mapPersistenceError(error, "配置 Runtime 最小权限");
  }
}

/** down 后只撤销当前 Schema 的动态 ACL；数据库级角色 bootstrap 保持不变。 */
export async function teardownRuntimeSchemaAccess(pool: Pool, runtimeRole: string): Promise<void> {
  try {
    await withTransaction(pool, async (client) => {
      const role = quoteIdentifier(runtimeRole);
      const schemaResult = await client.query<{ schema_name: string }>(
        "SELECT current_schema() AS schema_name",
      );
      const schemaName = schemaResult.rows[0]?.schema_name;
      if (schemaName === undefined) throw new PersistenceError("UNEXPECTED", "无法识别当前 Schema");
      const schema = quoteIdentifier(schemaName);
      await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`);
      await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`);
      await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${role}`);
    });
  } catch (error) {
    throw mapPersistenceError(error, "撤销 Runtime Schema 权限");
  }
}
