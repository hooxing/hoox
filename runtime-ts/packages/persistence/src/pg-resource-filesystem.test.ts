import { tenantId } from "@aisay/domain";
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

class ScriptedHistoryLibraryClient {
  readonly statements: Statement[] = [];

  constructor(private readonly blobPurpose: "resource" | "workspace" = "resource") {}

  async query(sql: string, values?: readonly unknown[]) {
    this.statements.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("set_config('app.tenant_id'")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT kind FROM tenants")) {
      return { rows: [{ kind: "personal" }], rowCount: 1 };
    }
    if (sql.includes("LIMIT $7")) {
      return {
        rows: [
          {
            thread_id: "thread-contract",
            directory_name: "采购合同审查",
            directory_timestamp: "2026-08-07T07:00:00.000Z",
            last_file_at: "2026-08-07T08:00:00.000Z",
            file_count: "2",
          },
          {
            thread_id: "thread-older",
            directory_name: "旧任务",
            directory_timestamp: "2026-08-06T07:00:00.000Z",
            last_file_at: "2026-08-06T08:00:00.000Z",
            file_count: "1",
          },
        ],
        rowCount: 2,
      };
    }
    if (sql.includes("SELECT EXISTS")) {
      return { rows: [{ present: true }], rowCount: 1 };
    }
    if (sql.includes("FROM thread_history_file_entries entry")) {
      return { rows: [historyFileRow(this.blobPurpose)], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release() {}
}

function historyFileRow(blobPurpose: "resource" | "workspace") {
  return {
    thread_id: "thread-contract",
    directory_name: "采购合同审查",
    directory_entry_name: "采购合同.docx",
    last_attached_at: "2026-08-07T08:00:00.000Z",
    resource_id: "resource-contract",
    version_id: "version-contract",
    name: "采购合同.docx",
    media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: "2048",
    digest: "a".repeat(64),
    blob_purpose: blobPurpose,
    blob_incarnation_id: "00000000-0000-4000-8000-000000000001",
    physical_object_key: "opaque-history-object",
  };
}

function poolFor(client: ScriptedResourceFilesystemClient | ScriptedHistoryLibraryClient): Pool {
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

  it("team Tenant 只从当前 Tenant 枚举团队 Thread 入口", async () => {
    const client = new ScriptedResourceFilesystemClient("team");
    const catalog = new PgResourceFilesystemCatalog(poolFor(client));

    await expect(catalog.listThreadIds({ tenantId: tenantId("tenant-team") })).resolves.toEqual([
      "thread-a",
      "thread-b",
    ]);
    const query = client.statements.find((statement) =>
      statement.sql.includes("SELECT thread.id AS thread_id"),
    );
    expect(query?.values).toEqual(["tenant-team"]);
    expect(query?.sql).toContain("thread.tenant_id=$1");
  });

  it("个人云盘按活跃时间和稳定游标分页，并只读取当前页任务文件", async () => {
    const client = new ScriptedHistoryLibraryClient();
    const catalog = new PgResourceFilesystemCatalog(poolFor(client));

    const page = await catalog.listTaskPage({
      tenantId: tenantId("tenant-a"),
      query: "合同",
      activeAfter: "2026-02-07T00:00:00.000Z",
      before: { lastFileAt: "2026-08-07T09:00:00.000Z", threadId: "thread-cursor" },
      limit: 1,
    });

    expect(page).toMatchObject({
      items: [
        {
          threadId: "thread-contract",
          name: "采购合同审查",
          fileCount: 2,
          files: [
            {
              resourceId: "resource-contract",
              versionId: "version-contract",
              entryName: "采购合同.docx",
              attachedAt: "2026-08-07T08:00:00.000Z",
            },
          ],
        },
      ],
      hasMore: true,
      hasOlder: true,
      next: { lastFileAt: "2026-08-07T08:00:00.000Z", threadId: "thread-contract" },
    });
    const directoryQuery = client.statements.find((statement) =>
      statement.sql.includes("LIMIT $7"),
    );
    expect(directoryQuery?.values).toEqual([
      "tenant-a",
      "2026-02-07T00:00:00.000Z",
      null,
      "2026-08-07T09:00:00.000Z",
      "thread-cursor",
      "合同",
      2,
    ]);
    const fileQuery = client.statements.find((statement) =>
      statement.sql.includes("ANY($2::text[])"),
    );
    expect(fileQuery?.values).toEqual(["tenant-a", ["thread-contract"], "合同"]);
  });

  it("历史文件下载解析复用 Stable Blob 事实且不暴露对象键到路径", async () => {
    const client = new ScriptedHistoryLibraryClient();
    const catalog = new PgResourceFilesystemCatalog(poolFor(client));

    const file = await catalog.resolveLibraryFile({
      tenantId: tenantId("tenant-a"),
      resourceId: "resource-contract",
      versionId: "version-contract",
    });

    expect(file).toMatchObject({
      path: "/resources/resource-contract/version-contract/采购合同.docx",
      taskName: "采购合同审查",
      object: {
        tenantId: "tenant-a",
        purpose: "resource",
        physicalObjectKey: "opaque-history-object",
      },
    });
    expect(file?.path).not.toContain("opaque-history-object");
    const query = client.statements.find((statement) =>
      statement.sql.includes("FROM thread_history_file_entries entry"),
    );
    expect(query?.sql).toContain("reference.purpose=version.blob_purpose");
  });

  it("Agent deliverable 直接复用 workspace Stable Blob", async () => {
    const client = new ScriptedHistoryLibraryClient("workspace");
    const catalog = new PgResourceFilesystemCatalog(poolFor(client));

    const file = await catalog.resolveLibraryFile({
      tenantId: tenantId("tenant-a"),
      resourceId: "resource-contract",
      versionId: "version-contract",
    });

    expect(file?.object).toMatchObject({
      purpose: "workspace",
      physicalObjectKey: "opaque-history-object",
    });
  });
});
