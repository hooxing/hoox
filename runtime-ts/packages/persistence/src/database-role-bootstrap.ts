import type { PoolClient } from "pg";
import { PersistenceError } from "./errors.js";
import { inspectDatabaseRoleScope } from "./role-bootstrap.js";

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/u;

export interface DatabaseRoleCredential {
  readonly role: string;
  readonly password: string;
}

export interface DatabaseRoleBootstrapResult {
  readonly createdRoles: readonly string[];
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quotePassword(password: string): string {
  if (password.length === 0 || password.includes("\0")) {
    throw new TypeError("数据库角色密码不能为空或包含空字符");
  }
  return `'${password.replaceAll("'", "''")}'`;
}

function assertDistinctRoles(credentials: readonly DatabaseRoleCredential[]): void {
  if (credentials.length === 0) throw new TypeError("至少需要一个数据库角色");
  const roles = credentials.map(({ role }) => role);
  if (new Set(roles).size !== roles.length) {
    throw new TypeError("数据库应用角色必须互不相同");
  }
  for (const credential of credentials) {
    if (!rolePattern.test(credential.role)) {
      throw new TypeError("数据库角色名格式无效");
    }
    quotePassword(credential.password);
  }
}

interface BootstrapAuthorityRow {
  readonly can_manage_roles: boolean;
  readonly owns_database: boolean;
  readonly database_name: string;
}

/**
 * 使用只存在于运维入口的 Database Admin 连接补齐缺失角色。
 * 已存在角色的密码和属性不在这里隐式修改，避免把未知集群状态静默覆盖。
 */
export async function bootstrapMissingDatabaseRoles(
  client: PoolClient,
  credentials: readonly DatabaseRoleCredential[],
): Promise<DatabaseRoleBootstrapResult> {
  assertDistinctRoles(credentials);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('hoox:database-role-bootstrap:' || current_database(), 0))",
  );

  const authority = await client.query<BootstrapAuthorityRow>(
    `SELECT (admin.rolsuper OR admin.rolcreaterole) AS can_manage_roles,
            (admin.rolsuper OR database.datdba=admin.oid) AS owns_database,
            database.datname AS database_name
       FROM pg_roles admin
       JOIN pg_database database ON database.datname=current_database()
      WHERE admin.rolname=current_user`,
  );
  const state = authority.rows[0];
  if (state?.can_manage_roles !== true || state.owns_database !== true) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      "DATABASE_BOOTSTRAP_URL 必须使用拥有当前数据库且可管理角色的 Database Admin",
    );
  }

  const inspection = await inspectDatabaseRoleScope(
    client,
    credentials.map(({ role }) => role),
  );
  if (inspection.reusedRoles.length > 0) {
    const details = inspection.reusedRoles
      .map(({ role, databases }) => `${role} -> ${databases.join("/")}`)
      .join(", ");
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      `数据库应用角色被其他数据库复用：${details}`,
    );
  }

  await client.query("SET LOCAL standard_conforming_strings = on");
  const missing = new Set(inspection.missingRoles);
  for (const credential of credentials) {
    if (!missing.has(credential.role)) continue;
    await client.query(
      `CREATE ROLE ${quoteIdentifier(credential.role)} LOGIN PASSWORD ${quotePassword(credential.password)}
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
  }

  if (inspection.missingRoles.length > 0) {
    const database = quoteIdentifier(state.database_name);
    const roles = inspection.missingRoles.map(quoteIdentifier).join(", ");
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${roles}`);
  }

  return { createdRoles: inspection.missingRoles };
}
