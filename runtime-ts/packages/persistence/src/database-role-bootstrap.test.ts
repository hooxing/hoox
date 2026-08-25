import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { bootstrapMissingDatabaseRoles } from "./database-role-bootstrap.js";

const credentials = Object.freeze([
  { role: "runtime_local", password: "runtime-secret" },
  { role: "admin_control_local", password: "admin's-secret" },
]);

function clientForScope(
  rows: readonly object[],
  authority: object = {
    can_manage_roles: true,
    owns_database: true,
    database_name: "agent_runtime_dev",
  },
): PoolClient {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("can_manage_roles")) return { rows: [authority] };
      if (sql.includes("pg_shdepend")) return { rows };
      return { rows: [] };
    }),
  } as unknown as PoolClient;
}

describe("PostgreSQL 缺失角色 bootstrap", () => {
  it("只创建缺失角色并授予当前数据库 CONNECT", async () => {
    const client = clientForScope([
      {
        requested_role: "runtime_local",
        role_name: "runtime_local",
        outside_database_names_json: "[]",
      },
      {
        requested_role: "admin_control_local",
        role_name: null,
        outside_database_names_json: "[]",
      },
    ]);

    await expect(bootstrapMissingDatabaseRoles(client, credentials)).resolves.toEqual({
      createdRoles: ["admin_control_local"],
    });

    const queries = vi.mocked(client.query).mock.calls.map(([sql]) => String(sql));
    expect(queries).toContainEqual(expect.stringContaining("pg_advisory_xact_lock"));
    expect(queries).not.toContainEqual(expect.stringContaining('CREATE ROLE "runtime_local"'));
    expect(queries).toContainEqual(
      expect.stringContaining(`CREATE ROLE "admin_control_local" LOGIN PASSWORD 'admin''s-secret'`),
    );
    expect(queries).toContainEqual(
      'GRANT CONNECT ON DATABASE "agent_runtime_dev" TO "admin_control_local"',
    );
  });

  it("角色被其他数据库依赖时拒绝创建任何角色", async () => {
    const client = clientForScope([
      {
        requested_role: "runtime_local",
        role_name: "runtime_local",
        outside_database_names_json: '["other_dev"]',
      },
      {
        requested_role: "admin_control_local",
        role_name: null,
        outside_database_names_json: "[]",
      },
    ]);

    await expect(bootstrapMissingDatabaseRoles(client, credentials)).rejects.toThrow(
      "数据库应用角色被其他数据库复用：runtime_local -> other_dev",
    );
    expect(vi.mocked(client.query).mock.calls.map(([sql]) => String(sql))).not.toContainEqual(
      expect.stringContaining("CREATE ROLE"),
    );
  });

  it("管理连接权限不足时失败关闭", async () => {
    const client = clientForScope([], {
      can_manage_roles: false,
      owns_database: true,
      database_name: "agent_runtime_dev",
    });

    await expect(bootstrapMissingDatabaseRoles(client, credentials)).rejects.toThrow(
      "DATABASE_BOOTSTRAP_URL 必须使用拥有当前数据库且可管理角色的 Database Admin",
    );
  });
});
