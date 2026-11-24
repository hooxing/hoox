import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { PersistenceError } from "./errors.js";

export function evaluationRoleName(runtimeRole: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(runtimeRole)) {
    throw new TypeError("数据库 Runtime 角色名称无效");
  }
  const prefix =
    runtimeRole.length <= 52
      ? runtimeRole
      : `${runtimeRole.slice(0, 43)}_${createHash("md5").update(runtimeRole).digest("hex").slice(0, 8)}`;
  return `${prefix}_evaluation`;
}

export async function bootstrapEvaluationRole(
  client: PoolClient,
  runtimeRole: string,
): Promise<void> {
  const role = evaluationRoleName(runtimeRole);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('hoox:evaluation-role:' || $1,0))",
    [runtimeRole],
  );
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
  if (!existing.rowCount) {
    await client.query(
      `CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
  }
  const membership = await client.query(
    `SELECT 1 FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname=$1)
       AND member=(SELECT oid FROM pg_roles WHERE rolname=$2)`,
    [role, runtimeRole],
  );
  if (!membership.rowCount) {
    await client.query(
      `GRANT "${role}" TO "${runtimeRole}" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`,
    );
  }
  await assertEvaluationRoleSafe(client, runtimeRole);
}

export async function assertEvaluationRoleSafe(
  client: PoolClient,
  runtimeRole: string,
  repairSchema?: string,
): Promise<void> {
  const result = await client.query<{ safe: boolean }>(
    `SELECT NOT (role.rolcanlogin OR role.rolinherit OR role.rolsuper OR role.rolcreatedb
              OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls)
       AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=role.oid)
       AND EXISTS (SELECT 1 FROM pg_auth_members edge JOIN pg_roles runtime ON runtime.oid=edge.member
         WHERE edge.roleid=role.oid AND runtime.rolname=$2
           AND NOT edge.inherit_option AND edge.set_option AND NOT edge.admin_option)
       AND NOT EXISTS (SELECT 1 FROM pg_auth_members edge JOIN pg_roles runtime ON runtime.oid=edge.member
         WHERE edge.roleid=role.oid AND runtime.rolname<>$2)
       AND NOT EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
         AND refobjid=role.oid AND (deptype='o' OR
           (dbid<>0 AND dbid<>(SELECT oid FROM pg_database WHERE datname=current_database()))))
       AND NOT has_database_privilege(role.oid,current_database(),'CREATE')
       AND NOT has_database_privilege(role.oid,current_database(),'TEMP')
       AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname!~'^pg_'
         AND nspname<>'information_schema' AND ($3::text IS NULL OR nspname<>$3)
         AND has_schema_privilege(role.oid,oid,'CREATE')) AS safe
       FROM pg_roles role WHERE role.rolname=$1`,
    [evaluationRoleName(runtimeRole), runtimeRole, repairSchema ?? null],
  );
  if (result.rows[0]?.safe !== true) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "评测数据库角色或成员关系边界不安全");
  }
}

export async function setLocalEvaluationRole(client: PoolClient): Promise<void> {
  const result = await client.query<{ role: string }>("SELECT current_user AS role");
  const runtimeRole = result.rows[0]?.role;
  if (runtimeRole === undefined) throw new Error("缺少 Runtime 数据库身份");
  await client.query(`SET LOCAL ROLE "${evaluationRoleName(runtimeRole)}"`);
}
