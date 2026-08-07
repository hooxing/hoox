import { tenantId } from "@cube-runtime/domain";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PgResourceFilesystemCatalog } from "./pg-resource-filesystem.js";

interface Statement {
  readonly sql: string;
  readonly values?: readonly unknown[];
}

class ScriptedResourceFilesystemClient {
  readonly statements: Statement[] = [];

  constructor(private readonly tenantKind: "personal" | "team") {}

  async query(sql: string, values?: readonly unknown[]) {
    this.statements.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("set_config('app.tenant_id'")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT kind FROM tenants")) {
      return { rows: [{ kind: this.tenantKind }], rowCount: 1 };
    }
    if (sql.includes("SELECT thread.id AS thread_id")) {
      return {
        rows: [{ thread_id: "thread-a" }, { thread_id: "thread-b" }],
        rowCount: 2,
      };
    }
    return { rows: [], rowCount: 0 };
  }

  release() {}
}

function poolFor(client: ScriptedResourceFilesystemClient): Pool {
  return {
    async connect() {
      return client;
    },
  } as unknown as Pool;
}

describe("PostgreSQL ResourceFS 稳定 Thread 入口", () => {
  it("personal Tenant 预声明全部 Thread ID，不依赖是否已有历史文件", async () => {
    const client = new ScriptedResourceFilesystemClient("personal");
    const catalog = new PgResourceFilesystemCatalog(poolFor(client));

    await expect(catalog.listThreadIds({ tenantId: tenantId("tenant-a") })).resolves.toEqual([
      "thread-a",
      "thread-b",
    ]);

    const query = client.statements.find((statement) =>
      statement.sql.includes("SELECT thread.id AS thread_id"),
    );
    expect(query?.sql).toContain("FROM threads thread");
    expect(query?.sql).not.toContain("thread_history_file_entries");
    expect(query?.sql).not.toContain("resource_versions");
    expect(query?.sql).not.toContain("blob_references");
  });

  it("team Tenant 不暴露个人 Thread 入口", async () => {
    const client = new ScriptedResourceFilesystemClient("team");
    const catalog = new PgResourceFilesystemCatalog(poolFor(client));

    await expect(
      catalog.listThreadIds({ tenantId: tenantId("tenant-team") }),
    ).resolves.toBeUndefined();
    expect(
      client.statements.some((statement) =>
        statement.sql.includes("SELECT thread.id AS thread_id"),
      ),
    ).toBe(false);
  });
});
