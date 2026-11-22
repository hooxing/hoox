import { describe, expect, it } from "vitest";
import { readDatabaseRoleBootstrapConfiguration } from "./database-role-bootstrap-config.js";

const baseEnvironment = Object.freeze({
  RUNTIME_ENV: "development",
  DATABASE_BOOTSTRAP_URL: "postgresql://database_admin:admin@127.0.0.1:5432/runtime_dev",
  DATABASE_URL: "postgresql://runtime_local:runtime@127.0.0.1/runtime_dev",
  DATABASE_RUNTIME_ROLE: "runtime_local",
  MIGRATION_DATABASE_URL: "postgresql://migrator_local:migrator@127.0.0.1/runtime_dev",
  DATABASE_MIGRATOR_ROLE: "migrator_local",
  SKILL_PUBLISHER_DATABASE_URL: "postgresql://publisher_local:publisher@127.0.0.1/runtime_dev",
  DATABASE_SKILL_PUBLISHER_ROLE: "publisher_local",
  DATABASE_WORKER_COORDINATOR_URL: "postgresql://worker_local:worker@127.0.0.1/runtime_dev",
  DATABASE_WORKER_COORDINATOR_ROLE: "worker_local",
  DATABASE_TEAM_COORDINATOR_URL: "postgresql://team_local:team@127.0.0.1/runtime_dev",
  DATABASE_TEAM_COORDINATOR_ROLE: "team_local",
  ADMIN_CONTROL_DATABASE_URL:
    "postgresql://admin_control_local:admin%27secret@127.0.0.1/runtime_dev",
  DATABASE_TRAJECTORY_DIRECTORY_ROLE: "directory_local",
  DATABASE_TRAJECTORY_DIRECTORY_URL:
    "postgresql://directory_local:placeholder@127.0.0.1/runtime_dev",
  DATABASE_ADMIN_CONTROL_ROLE: "admin_control_local",
  DATABASE_WEBHOOK_DISPATCHER_ROLE: "webhook_dispatcher_local",
  WEBHOOK_DISPATCHER_DATABASE_URL:
    "postgresql://webhook_dispatcher_local:webhook@127.0.0.1/runtime_dev",
});

describe("数据库角色 bootstrap 配置", () => {
  it("从八个应用连接提取角色密码并允许省略默认端口", () => {
    const configuration = readDatabaseRoleBootstrapConfiguration({ ...baseEnvironment });

    expect(configuration.credentials).toHaveLength(8);
    expect(configuration.credentials.at(-2)).toEqual({
      role: "admin_control_local",
      password: "admin'secret",
    });
  });

  it("应用连接指向不同数据库时拒绝运行", () => {
    expect(() =>
      readDatabaseRoleBootstrapConfiguration({
        ...baseEnvironment,
        ADMIN_CONTROL_DATABASE_URL: "postgresql://admin_control_local:admin@127.0.0.1/other_dev",
      }),
    ).toThrow("ADMIN_CONTROL_DATABASE_URL 必须与 DATABASE_BOOTSTRAP_URL 指向同一个数据库");
  });

  it("URL 用户名与声明角色不一致时拒绝运行", () => {
    expect(() =>
      readDatabaseRoleBootstrapConfiguration({
        ...baseEnvironment,
        DATABASE_ADMIN_CONTROL_ROLE: "different_admin_local",
      }),
    ).toThrow("ADMIN_CONTROL_DATABASE_URL 用户名必须与 DATABASE_ADMIN_CONTROL_ROLE 一致");
  });

  it("production 环境禁止使用本地补齐命令", () => {
    expect(() =>
      readDatabaseRoleBootstrapConfiguration({ ...baseEnvironment, RUNTIME_ENV: "production" }),
    ).toThrow("生产环境禁止使用本地数据库角色 bootstrap 命令");
  });
});
