import { Pool } from "pg";
import { bootstrapEvaluationRole } from "../src/role-bootstrap.js";

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`缺少 ${name}`);
  return value;
}

function identifier(name: string): string {
  const value = required(name);
  if (!identifierPattern.test(value) || !value.startsWith("m4_ci_")) {
    throw new Error(`${name} 必须是 m4_ci_ 前缀的安全 PostgreSQL 标识符`);
  }
  return value;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

if (process.env.M4_ALLOW_EPHEMERAL_DATABASE_PREPARE !== "true") {
  throw new Error("只允许为显式声明的一次性 M4 CI 数据库执行准备");
}

const adminUrl = new URL(required("M4_DATABASE_ADMIN_URL"));
if (adminUrl.pathname !== "/agent_runtime_ci") {
  throw new Error("M4 CI 准备脚本只允许操作 agent_runtime_ci 数据库");
}
const databaseName = "agent_runtime_ci";
const runtimeRole = identifier("DATABASE_RUNTIME_ROLE");
const migratorRole = identifier("DATABASE_MIGRATOR_ROLE");
const skillPublisherRole = identifier("DATABASE_SKILL_PUBLISHER_ROLE");
const workerCoordinatorRole = identifier("DATABASE_WORKER_COORDINATOR_ROLE");
const trajectoryDirectoryRole = identifier("DATABASE_TRAJECTORY_DIRECTORY_ROLE");
const teamCoordinatorRole = identifier("DATABASE_TEAM_COORDINATOR_ROLE");
const adminControlRole = identifier("DATABASE_ADMIN_CONTROL_ROLE");
const webhookDispatcherRole = identifier("DATABASE_WEBHOOK_DISPATCHER_ROLE");
const schema = identifier("DATABASE_SCHEMA");
const runtimePassword = required("M4_DATABASE_RUNTIME_PASSWORD");
const migratorPassword = required("M4_DATABASE_MIGRATOR_PASSWORD");
const skillPublisherPassword = required("M4_DATABASE_SKILL_PUBLISHER_PASSWORD");
const workerCoordinatorPassword = required("M4_DATABASE_WORKER_COORDINATOR_PASSWORD");
const trajectoryDirectoryPassword = required("M4_DATABASE_TRAJECTORY_DIRECTORY_PASSWORD");
const teamCoordinatorPassword = required("M4_DATABASE_TEAM_COORDINATOR_PASSWORD");
const adminControlPassword = required("M4_DATABASE_ADMIN_CONTROL_PASSWORD");
const webhookDispatcherPassword = required("M4_DATABASE_WEBHOOK_DISPATCHER_PASSWORD");
const pool = new Pool({ connectionString: adminUrl.toString(), max: 1 });

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const admin = await client.query<{ readonly rolsuper: boolean }>(
      "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
    );
    if (admin.rows[0]?.rolsuper !== true) {
      throw new Error("M4 CI 管理连接必须是仅用于准备的一次性超级用户");
    }
    const existing = await client.query<{ readonly present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_roles WHERE rolname = ANY($1::text[])
       ) OR EXISTS (
         SELECT 1 FROM pg_namespace WHERE nspname=$2
       ) AS present`,
      [
        [
          runtimeRole,
          migratorRole,
          skillPublisherRole,
          workerCoordinatorRole,
          trajectoryDirectoryRole,
          teamCoordinatorRole,
          adminControlRole,
          webhookDispatcherRole,
        ],
        schema,
      ],
    );
    if (existing.rows[0]?.present !== false) {
      throw new Error("M4 CI 目标角色或 Schema 已存在，拒绝复用未知状态");
    }
    await client.query(
      `REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE "${databaseName}" FROM PUBLIC;
       REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
       CREATE ROLE "${runtimeRole}" LOGIN PASSWORD ${literal(runtimePassword)}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${migratorRole}" LOGIN PASSWORD ${literal(migratorPassword)}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${skillPublisherRole}" LOGIN PASSWORD ${literal(skillPublisherPassword)}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${trajectoryDirectoryRole}" LOGIN PASSWORD ${literal(trajectoryDirectoryPassword)}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${workerCoordinatorRole}" LOGIN PASSWORD ${literal(workerCoordinatorPassword)}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${teamCoordinatorRole}" LOGIN PASSWORD ${literal(teamCoordinatorPassword)}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${adminControlRole}" LOGIN PASSWORD ${literal(adminControlPassword)}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       CREATE ROLE "${webhookDispatcherRole}" LOGIN PASSWORD ${literal(webhookDispatcherPassword)}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
       GRANT CONNECT ON DATABASE "${databaseName}"
         TO "${trajectoryDirectoryRole}", "${runtimeRole}", "${migratorRole}", "${skillPublisherRole}", "${workerCoordinatorRole}", "${teamCoordinatorRole}", "${adminControlRole}", "${webhookDispatcherRole}";
       CREATE SCHEMA "${schema}" AUTHORIZATION "${migratorRole}"`,
    );
    await bootstrapEvaluationRole(client, runtimeRole);
    const safety = await client.query<{
      readonly runtime_safe: boolean;
      readonly migrator_safe: boolean;
      readonly schema_owned: boolean;
      readonly publisher_safe: boolean;
      readonly coordinator_safe: boolean;
      readonly team_coordinator_safe: boolean;
      readonly admin_control_safe: boolean;
    }>(
      `SELECT
         NOT (runtime.rolsuper OR runtime.rolcreatedb OR runtime.rolcreaterole
           OR runtime.rolreplication OR runtime.rolbypassrls)
           AND NOT has_database_privilege(runtime.oid, current_database(), 'CREATE')
           AND NOT has_database_privilege(runtime.oid, current_database(), 'TEMP')
           AS runtime_safe,
         NOT (migrator.rolsuper OR migrator.rolcreatedb OR migrator.rolcreaterole
           OR migrator.rolreplication OR migrator.rolbypassrls)
           AND NOT has_database_privilege(migrator.oid, current_database(), 'CREATE')
           AND NOT has_schema_privilege(migrator.oid, 'public', 'CREATE')
           AS migrator_safe,
         target.nspowner=migrator.oid AS schema_owned
         ,NOT (publisher.rolsuper OR publisher.rolcreatedb OR publisher.rolcreaterole
           OR publisher.rolreplication OR publisher.rolbypassrls OR publisher.rolinherit)
           AND publisher.rolcanlogin
           AND NOT has_database_privilege(publisher.oid, current_database(), 'CREATE')
           AND NOT has_database_privilege(publisher.oid, current_database(), 'TEMP')
           AS publisher_safe
         ,NOT (coordinator.rolsuper OR coordinator.rolcreatedb OR coordinator.rolcreaterole
           OR coordinator.rolreplication OR coordinator.rolbypassrls OR coordinator.rolinherit)
           AND coordinator.rolcanlogin
           AND NOT has_database_privilege(coordinator.oid, current_database(), 'CREATE')
           AND NOT has_database_privilege(coordinator.oid, current_database(), 'TEMP')
           AS coordinator_safe
         ,NOT (team_coordinator.rolsuper OR team_coordinator.rolcreatedb
           OR team_coordinator.rolcreaterole OR team_coordinator.rolreplication
           OR team_coordinator.rolbypassrls OR team_coordinator.rolinherit)
           AND team_coordinator.rolcanlogin
           AND NOT has_database_privilege(team_coordinator.oid, current_database(), 'CREATE')
           AND NOT has_database_privilege(team_coordinator.oid, current_database(), 'TEMP')
           AS team_coordinator_safe
         ,NOT (admin_control.rolsuper OR admin_control.rolcreatedb
           OR admin_control.rolcreaterole OR admin_control.rolreplication
           OR admin_control.rolbypassrls OR admin_control.rolinherit)
           AND admin_control.rolcanlogin
           AND NOT has_database_privilege(admin_control.oid, current_database(), 'CREATE')
           AND NOT has_database_privilege(admin_control.oid, current_database(), 'TEMP')
           AS admin_control_safe
       FROM pg_roles runtime, pg_roles migrator, pg_roles publisher, pg_roles coordinator,
            pg_roles team_coordinator, pg_roles admin_control,
            pg_namespace target
       WHERE runtime.rolname=$1 AND migrator.rolname=$2 AND publisher.rolname=$4
         AND coordinator.rolname=$5 AND team_coordinator.rolname=$6
         AND admin_control.rolname=$7 AND target.nspname=$3`,
      [
        runtimeRole,
        migratorRole,
        schema,
        skillPublisherRole,
        workerCoordinatorRole,
        teamCoordinatorRole,
        adminControlRole,
      ],
    );
    if (
      safety.rows[0]?.runtime_safe !== true ||
      safety.rows[0]?.migrator_safe !== true ||
      safety.rows[0]?.publisher_safe !== true ||
      safety.rows[0]?.coordinator_safe !== true ||
      safety.rows[0]?.team_coordinator_safe !== true ||
      safety.rows[0]?.admin_control_safe !== true ||
      safety.rows[0]?.schema_owned !== true
    ) {
      throw new Error("M4 CI 受限角色或 Schema 安全断言失败");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}

console.log("M4 CI PostgreSQL 受限角色与专属 Schema 准备完成");
