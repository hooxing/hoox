import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  insertHistoryAgentDeliverable,
  shouldIndexArtifactInHistory,
} from "./pg-personal-history.js";

interface Statement {
  readonly sql: string;
  readonly values?: readonly unknown[];
}

class ScriptedPersonalHistoryClient {
  readonly statements: Statement[] = [];
  private entryCandidateChecks = 0;

  constructor(private readonly supportedTenant = true) {}

  async query(sql: string, values?: readonly unknown[]) {
    this.statements.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.includes("SELECT thread.title")) {
      return this.supportedTenant
        ? {
            rows: [
              {
                title: "季度报告",
                title_source: "model",
                thread_created_at: new Date("2026-08-08T01:00:00.000Z"),
                title_generation_state: "completed",
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes("thread_history_directories") && sql.includes("thread_id=$2")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("thread_history_directories") && sql.includes("directory_name=$2")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("relation_type='agent_deliverable'")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("directory_entry_name=$3")) {
      this.entryCandidateChecks += 1;
      return { rows: [], rowCount: this.entryCandidateChecks === 1 ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  }
}

function client(value: ScriptedPersonalHistoryClient): PoolClient {
  return value as unknown as PoolClient;
}

describe("Agent 正式交付物历史目录", () => {
  it("仅在启用时登记普通和 API Run 的正式交付物", () => {
    for (const [enabled, purpose, runOrigin, expected] of [
      [true, "deliverable", "normal", true],
      [true, "deliverable", "api", true],
      [true, "deliverable", "playground", false],
      [true, "deliverable", "evaluation", false],
      [true, "diagnostic", "normal", false],
      [true, "trace", "normal", false],
      [false, "deliverable", "normal", false],
    ] as const) {
      expect(
        shouldIndexArtifactInHistory({ historyFilesystemEnabled: enabled, purpose, runOrigin }),
      ).toBe(expected);
    }
  });

  it("创建语义任务目录并以 artifact 身份写入 deliverable，文件重名在扩展名前编号", async () => {
    const scripted = new ScriptedPersonalHistoryClient();
    await insertHistoryAgentDeliverable(client(scripted), {
      tenantId: "tenant-a",
      threadId: "thread-a",
      artifactId: "artifact-a",
      resourceId: "resource-a",
      resourceVersionId: "version-a",
      resourceName: "报告.docx",
      publishedAt: "2026-08-08T02:00:00.000Z",
      timeZone: "Asia/Shanghai",
    });

    const directoryInsert = scripted.statements.find((statement) =>
      statement.sql.includes("INSERT INTO thread_history_directories"),
    );
    expect(directoryInsert?.values).toEqual([
      "tenant-a",
      "thread-a",
      "季度报告",
      new Date("2026-08-08T01:00:00.000Z"),
      "Asia/Shanghai",
      "ready",
      "2026-08-08T02:00:00.000Z",
    ]);
    const fileInsert = scripted.statements.find((statement) =>
      statement.sql.includes("INSERT INTO thread_history_file_entries"),
    );
    expect(fileInsert?.sql).toContain("'agent_deliverable'");
    expect(fileInsert?.sql).toContain("source_artifact_id");
    expect(fileInsert?.values).toEqual([
      "tenant-a",
      "thread-a",
      "resource-a",
      "version-a",
      "报告-2.docx",
      "artifact-a",
      "2026-08-08T02:00:00.000Z",
    ]);
    expect(
      scripted.statements.some((statement) =>
        statement.sql.includes("UPDATE thread_history_directories directory"),
      ),
    ).toBe(true);
  });

  it("个人和团队 Tenant 共用同一份隔离的历史目录规则", async () => {
    const scripted = new ScriptedPersonalHistoryClient();
    await insertHistoryAgentDeliverable(client(scripted), {
      tenantId: "tenant-team",
      threadId: "thread-team",
      artifactId: "artifact-team",
      resourceId: "resource-team",
      resourceVersionId: "version-team",
      resourceName: "团队报告.pdf",
      publishedAt: "2026-08-08T02:00:00.000Z",
      timeZone: "Asia/Shanghai",
    });

    expect(
      scripted.statements.some((statement) =>
        statement.sql.includes("tenant.kind IN ('personal','team')"),
      ),
    ).toBe(true);
    expect(
      scripted.statements.some((statement) =>
        statement.sql.includes("INSERT INTO thread_history_file_entries"),
      ),
    ).toBe(true);
  });
});
