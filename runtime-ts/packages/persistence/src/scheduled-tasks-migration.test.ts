import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("定时任务迁移", () => {
  it("建立任务、修订、触发记录、命令幂等与 Tenant RLS", async () => {
    const [sql, roles, assignments] = await Promise.all([
      readFile(new URL("../migrations/0049_scheduled_tasks.up.sql", import.meta.url), "utf8"),
      readFile(new URL("./role-bootstrap.ts", import.meta.url), "utf8"),
      readFile(new URL("./pg-worker-tenant-assignment.ts", import.meta.url), "utf8"),
    ]);
    for (const table of [
      "scheduled_tasks",
      "scheduled_task_revisions",
      "scheduled_task_occurrences",
      "scheduled_task_commands",
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("UNIQUE (tenant_id,task_id,scheduled_for)");
    expect(sql).toContain(
      "FOREIGN KEY (tenant_id,target_thread_id) REFERENCES threads(tenant_id,id)",
    );
    expect(sql).toContain("WHERE state IN ('dispatching','failed')");
    expect(roles).toContain('["scheduled_tasks", new Set(["SELECT", "INSERT"])]');
    expect(roles).toContain('"scheduled_task_occurrences"');
    expect(assignments).toContain("FROM scheduled_tasks task");
    expect(assignments).toContain("occurrence.updated_at+interval '5 minutes'");
  });
});
