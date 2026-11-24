import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertDatabaseRolesCurrentDatabaseScoped } from "./role-bootstrap.js";

const context = Object.freeze({
  runtimeRole: "runtime_local",
  migratorRole: "migrator_local",
  skillPublisherRole: "publisher_local",
  workerCoordinatorRole: "worker_local",
  teamCoordinatorRole: "team_local",
  adminControlRole: "admin_control_local",
  schema: "agent_runtime",
});

function row(role: string, databases: readonly string[] = []): object {
  return {
    requested_role: role,
    role_name: role,
    outside_database_names_json: JSON.stringify(databases),
  };
}

function clientWith(rows: readonly object[]): PoolClient {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as PoolClient;
}

describe("PostgreSQL 应用角色数据库作用域", () => {
  it("登录角色与评测角色只依赖当前数据库时通过，并查询集群级依赖目录", async () => {
    const client = clientWith([
      row(context.runtimeRole),
      row("runtime_local_evaluation"),
      row(context.migratorRole),
      row(context.skillPublisherRole),
      row(context.workerCoordinatorRole),
      row(context.teamCoordinatorRole),
      row(context.adminControlRole),
    ]);

    await expect(
      assertDatabaseRolesCurrentDatabaseScoped(client, context),
    ).resolves.toBeUndefined();

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("pg_shdepend"), [
      [
        context.runtimeRole,
        "runtime_local_evaluation",
        context.migratorRole,
        context.skillPublisherRole,
        context.workerCoordinatorRole,
        context.teamCoordinatorRole,
        context.adminControlRole,
      ],
    ]);
  });

  it("任一角色被其他数据库依赖时报告角色和数据库", async () => {
    const client = clientWith([
      row(context.runtimeRole, ["other_dev"]),
      row("runtime_local_evaluation"),
      row(context.migratorRole),
      row(context.skillPublisherRole),
      row(context.workerCoordinatorRole),
      row(context.teamCoordinatorRole),
      row(context.adminControlRole),
    ]);

    await expect(assertDatabaseRolesCurrentDatabaseScoped(client, context)).rejects.toThrow(
      "数据库应用角色被其他数据库复用：runtime_local -> other_dev",
    );
  });

  it("角色缺失时报告缺失角色和可执行修复命令", async () => {
    const client = clientWith([
      row(context.runtimeRole),
      row("runtime_local_evaluation"),
      row(context.migratorRole),
      row(context.skillPublisherRole),
      row(context.workerCoordinatorRole),
      row(context.teamCoordinatorRole),
      {
        requested_role: context.adminControlRole,
        role_name: null,
        outside_database_names_json: "[]",
      },
    ]);

    await expect(assertDatabaseRolesCurrentDatabaseScoped(client, context)).rejects.toThrow(
      "缺少数据库应用角色：admin_control_local；请先运行 pnpm db:roles:bootstrap",
    );
  });

  it("查询结果不完整时不误报为跨数据库复用", async () => {
    const client = clientWith([row(context.runtimeRole)]);

    await expect(assertDatabaseRolesCurrentDatabaseScoped(client, context)).rejects.toThrow(
      "数据库角色作用域检查结果不完整",
    );
  });
});
