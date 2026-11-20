#!/bin/sh
set -eu

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" \
  --set=runtime_role="$DATABASE_RUNTIME_ROLE" \
  --set=runtime_password="$DATABASE_RUNTIME_PASSWORD" \
  --set=migrator_role="$DATABASE_MIGRATOR_ROLE" \
  --set=migrator_password="$DATABASE_MIGRATOR_PASSWORD" \
  --set=skill_role="$DATABASE_SKILL_PUBLISHER_ROLE" \
  --set=skill_password="$DATABASE_SKILL_PUBLISHER_PASSWORD" \
  --set=worker_role="$DATABASE_WORKER_COORDINATOR_ROLE" \
  --set=worker_password="$DATABASE_WORKER_COORDINATOR_PASSWORD" \
  --set=team_role="$DATABASE_TEAM_COORDINATOR_ROLE" \
  --set=team_password="$DATABASE_TEAM_COORDINATOR_PASSWORD" \
  --set=webhook_role="$DATABASE_WEBHOOK_DISPATCHER_ROLE" \
  --set=webhook_password="$DATABASE_WEBHOOK_DISPATCHER_PASSWORD" \
  --set=admin_role="$DATABASE_ADMIN_CONTROL_ROLE" \
  --set=admin_password="$DATABASE_ADMIN_CONTROL_PASSWORD" \
  --set=runtime_schema="$DATABASE_SCHEMA" <<'SQL'
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
CREATE ROLE :"runtime_role" LOGIN NOINHERIT PASSWORD :'runtime_password';
CREATE ROLE :"migrator_role" LOGIN NOINHERIT PASSWORD :'migrator_password';
CREATE ROLE :"skill_role" LOGIN NOINHERIT PASSWORD :'skill_password';
CREATE ROLE :"worker_role" LOGIN NOINHERIT PASSWORD :'worker_password';
CREATE ROLE :"team_role" LOGIN NOINHERIT PASSWORD :'team_password';
CREATE ROLE :"admin_role" LOGIN NOINHERIT PASSWORD :'admin_password';
CREATE ROLE :"webhook_role" LOGIN NOINHERIT PASSWORD :'webhook_password';
GRANT CONNECT ON DATABASE :"database_name" TO :"runtime_role", :"migrator_role", :"skill_role", :"worker_role", :"team_role", :"admin_role", :"webhook_role";
CREATE SCHEMA :"runtime_schema" AUTHORIZATION :"migrator_role";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
