import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("动态 Worker Tenant 调度迁移", () => {
  it("只建立无业务载荷的租约控制面，并回填已有 dispatch 后恢复 FORCE RLS", async () => {
    const sql = await readFile(
      new URL("../migrations/0042_dynamic_worker_tenant_assignment.up.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("CREATE TABLE worker_tenant_assignments");
    expect(sql).toContain("tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT");
    expect(sql).toContain("state IN ('idle','ready','claimed')");
    expect(sql).toContain("worker_tenant_assignments_claim_shape");
    expect(sql).not.toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("LOCK TABLE run_dispatch_outbox IN ACCESS EXCLUSIVE MODE");
    expect(sql).toContain("ALTER TABLE run_dispatch_outbox DISABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE run_dispatch_outbox ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE run_dispatch_outbox FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("WHERE outbox.state IN ('ready','claimed')");
    expect(sql).toContain("worker_tenant_assignments_runtime_policy");
    expect(sql).toContain("worker_tenant_assignments_coordinator_select_policy");
    expect(sql).toContain("worker_tenant_assignments_coordinator_claim_policy");
    expect(sql).toContain("TO %I");
    expect(sql).toContain("current_setting('app.worker_coordinator_role',true)");
    expect(sql).not.toContain("app.worker_id");
    expect(sql).not.toMatch(/CREATE (?:FUNCTION|TRIGGER|PROCEDURE)/u);
  });

  it("Runtime 白名单只授予控制面读取、插入和精确状态推进列", async () => {
    const bootstrap = await readFile(new URL("./role-bootstrap.ts", import.meta.url), "utf8");

    expect(bootstrap).toContain('["worker_tenant_assignments", new Set(["SELECT", "INSERT"])]');
    expect(bootstrap).toContain("hasWorkerTenantAssignmentState");
    expect(bootstrap).toContain(
      "state,generation,claim_token,claimed_by,lease_expires_at,next_attempt_at,updated_at",
    );
    expect(bootstrap).toContain("workerCoordinatorRole");
    expect(bootstrap).toContain(
      "state,generation,claim_token,claimed_by,lease_expires_at,updated_at",
    );
    expect(bootstrap).toContain("Worker Coordinator 表权限偏离白名单");
    expect(bootstrap).toContain("ALTER POLICY worker_tenant_assignments_runtime_policy");
    expect(bootstrap).toContain("worker_tenant_assignments_coordinator_select_policy");
    expect(bootstrap).toContain(
      "GRANT SELECT ON TABLE $" + "{schema}.worker_tenant_assignments TO $" + "{coordinatorRole}",
    );
    expect(bootstrap).not.toMatch(
      /GRANT (?:INSERT|DELETE|TRUNCATE)[^;]*worker_tenant_assignments TO \$\{coordinatorRole\}/u,
    );
    expect(bootstrap).not.toMatch(/GRANT (?:DELETE|TRUNCATE)[^;]*worker_tenant_assignments/u);
  });

  it("迁移入口显式传入五个互异角色，不从 SQL 文本或普通 Runtime 推导 Coordinator", async () => {
    const [migrations, cli, workflow] = await Promise.all([
      readFile(new URL("./migrations.ts", import.meta.url), "utf8"),
      readFile(new URL("./cli.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    ]);

    expect(migrations).toContain("app.worker_coordinator_role");
    expect(migrations).toContain("options.workerCoordinatorRole");
    expect(cli).toContain("DATABASE_WORKER_COORDINATOR_ROLE");
    expect(cli).toContain("DATABASE_TEAM_COORDINATOR_ROLE");
    expect(cli).toContain("workerCoordinatorRole");
    expect(cli).toContain("teamCoordinatorRole");
    expect(workflow.match(/DATABASE_TEAM_COORDINATOR_ROLE:/gu)).toHaveLength(2);
  });

  it("回退只删除可由 durable outbox 重建的派生控制面", async () => {
    const sql = await readFile(
      new URL("../migrations/0042_dynamic_worker_tenant_assignment.down.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("DROP TABLE worker_tenant_assignments");
    expect(sql).not.toContain("run_dispatch_outbox");
    expect(sql).not.toContain("tenants");
  });
});
