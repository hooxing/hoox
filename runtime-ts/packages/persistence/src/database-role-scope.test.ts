import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertDatabaseRolesCurrentDatabaseScoped } from "./role-bootstrap.js";

const context = Object.freeze({
  runtimeRole: "runtime_local",
  migratorRole: "migrator_local",
  skillPublisherRole: "publisher_local",
  workerCoordinatorRole: "worker_local",
  teamCoordinatorRole: "team_local",
  schema: "agent_runtime",
});

function clientWith(rows: readonly object[]): PoolClient {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as PoolClient;
}

describe("PostgreSQL 应用角色数据库作用域", () => {
  it("五个角色只依赖当前数据库时通过，并查询集群级依赖目录", async () => {
    const client = clientWith(
      [
        context.runtimeRole,
        context.migratorRole,
        context.skillPublisherRole,
        context.workerCoordinatorRole,
        context.teamCoordinatorRole,
      ].map((role_name) => ({ role_name, outside_database_count: 0 })),
    );

    await expect(
      assertDatabaseRolesCurrentDatabaseScoped(client, context),
    ).resolves.toBeUndefined();

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("pg_shdepend"), [
      [
        context.runtimeRole,
        context.migratorRole,
        context.skillPublisherRole,
        context.workerCoordinatorRole,
        context.teamCoordinatorRole,
      ],
    ]);
  });

  it("任一角色被其他数据库依赖时在 DDL 和 ACL 变更前失败", async () => {
    const client = clientWith([
      { role_name: context.runtimeRole, outside_database_count: 1 },
      { role_name: context.migratorRole, outside_database_count: 0 },
      { role_name: context.skillPublisherRole, outside_database_count: 0 },
      { role_name: context.workerCoordinatorRole, outside_database_count: 0 },
      { role_name: context.teamCoordinatorRole, outside_database_count: 0 },
    ]);

    await expect(assertDatabaseRolesCurrentDatabaseScoped(client, context)).rejects.toThrow(
      "数据库应用角色不得被其他数据库复用",
    );
  });

  it("角色缺失时同样失败关闭", async () => {
    const client = clientWith([{ role_name: context.runtimeRole, outside_database_count: 0 }]);

    await expect(assertDatabaseRolesCurrentDatabaseScoped(client, context)).rejects.toThrow(
      "数据库应用角色不得被其他数据库复用",
    );
  });
});
