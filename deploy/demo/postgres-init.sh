#!/bin/sh
set -eu

# 新数据卷初始化与保留数据卷的发布升级共用本脚本：每条语句都幂等，只创建缺失的角色与 Schema，
# 不修改已有角色的密码或属性；角色安全属性由迁移前置检查失败关闭。
psql --set=ON_ERROR_STOP=1 --quiet --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" \
  --set=runtime_role="$DATABASE_RUNTIME_ROLE" \
  --set=migrator_role="$DATABASE_MIGRATOR_ROLE" \
  --set=skill_role="$DATABASE_SKILL_PUBLISHER_ROLE" \
  --set=worker_role="$DATABASE_WORKER_COORDINATOR_ROLE" \
  --set=directory_role="$DATABASE_TRAJECTORY_DIRECTORY_ROLE" \
  --set=team_role="$DATABASE_TEAM_COORDINATOR_ROLE" \
  --set=webhook_role="$DATABASE_WEBHOOK_DISPATCHER_ROLE" \
  --set=admin_role="$DATABASE_ADMIN_CONTROL_ROLE" \
  --set=runtime_schema="$DATABASE_SCHEMA" <<'SQL'
\getenv runtime_password DATABASE_RUNTIME_PASSWORD
\getenv migrator_password DATABASE_MIGRATOR_PASSWORD
\getenv skill_password DATABASE_SKILL_PUBLISHER_PASSWORD
\getenv worker_password DATABASE_WORKER_COORDINATOR_PASSWORD
\getenv directory_password DATABASE_TRAJECTORY_DIRECTORY_PASSWORD
\getenv team_password DATABASE_TEAM_COORDINATOR_PASSWORD
\getenv webhook_password DATABASE_WEBHOOK_DISPATCHER_PASSWORD
\getenv admin_password DATABASE_ADMIN_CONTROL_PASSWORD
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
SELECT format('CREATE ROLE %I LOGIN NOINHERIT PASSWORD %L', wanted.role_name, wanted.role_password)
  FROM (VALUES
    (:'runtime_role', :'runtime_password'),
    (:'migrator_role', :'migrator_password'),
    (:'skill_role', :'skill_password'),
    (:'worker_role', :'worker_password'),
    (:'directory_role', :'directory_password'),
    (:'team_role', :'team_password'),
    (:'admin_role', :'admin_password'),
    (:'webhook_role', :'webhook_password')
  ) AS wanted(role_name, role_password)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = wanted.role_name)
\gexec
SELECT CASE WHEN length(:'runtime_role')<=52 THEN :'runtime_role'
  ELSE left(:'runtime_role',43)||'_'||left(md5(:'runtime_role'),8) END || '_evaluation' AS evaluation_role
\gset
SELECT format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'evaluation_role')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'evaluation_role')
\gexec
SELECT format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE, ADMIN FALSE', :'evaluation_role', :'runtime_role')
 WHERE NOT EXISTS (SELECT 1 FROM pg_auth_members
   WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname=:'evaluation_role')
     AND member=(SELECT oid FROM pg_roles WHERE rolname=:'runtime_role'))
\gexec
GRANT CONNECT ON DATABASE :"database_name" TO :"directory_role", :"runtime_role", :"migrator_role", :"skill_role", :"worker_role", :"team_role", :"admin_role", :"webhook_role";
CREATE SCHEMA IF NOT EXISTS :"runtime_schema" AUTHORIZATION :"migrator_role";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
