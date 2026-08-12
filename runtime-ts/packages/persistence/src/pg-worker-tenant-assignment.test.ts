import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  PgWorkerTenantAssignments,
  type PgClaimedWorkerTenantAssignment,
} from "./pg-worker-tenant-assignment.js";

interface Statement {
  readonly sql: string;
  readonly values?: readonly unknown[];
}

class ScriptedAssignmentClient {
  readonly statements: Statement[] = [];
  releasedWith: unknown;

  constructor(
    private readonly mode:
      | "claim"
      | "settle-ready"
      | "settle-idle"
      | "settle-stale"
      | "settle-expired"
      | "wake"
      | "unused",
  ) {}

  async query(sql: string, values?: readonly unknown[]) {
    this.statements.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("set_config('app.tenant_id'")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT tenant_id,generation")) {
      return { rows: [{ tenant_id: "team-dynamic", generation: "6" }], rowCount: 1 };
    }
    if (sql.includes("RETURNING generation")) {
      return { rows: [{ generation: "7" }], rowCount: 1 };
    }
    if (sql.includes("SELECT 1 FROM worker_tenant_assignments")) {
      return this.mode === "settle-stale" || this.mode === "settle-expired"
        ? { rows: [], rowCount: 0 }
        : { rows: [{ "?column?": 1 }], rowCount: 1 };
    }
    if (sql.includes("SELECT min(")) {
      return {
        rows: [
          {
            next_attempt_at:
              this.mode === "settle-ready" ? new Date("2026-08-09T16:00:00.000Z") : null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE worker_tenant_assignments")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO worker_tenant_assignments")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(error?: unknown) {
    this.releasedWith = error;
  }
}

function poolFor(client: ScriptedAssignmentClient): Pool {
  return {
    async connect() {
      return client;
    },
  } as unknown as Pool;
}

function storeFor(input: {
  readonly runtime?: ScriptedAssignmentClient;
  readonly coordinator?: ScriptedAssignmentClient;
}): PgWorkerTenantAssignments {
  return new PgWorkerTenantAssignments({
    runtime: poolFor(input.runtime ?? new ScriptedAssignmentClient("unused")),
    coordinator: poolFor(input.coordinator ?? new ScriptedAssignmentClient("unused")),
  });
}

const assignment = Object.freeze({
  tenantId: "team-dynamic",
  generation: 7,
  claimToken: "tenant-assignment-token",
  workerId: "worker-dynamic",
}) satisfies PgClaimedWorkerTenantAssignment;

describe("PostgreSQL 动态 Worker Tenant 调度", () => {
  it("跨 Tenant 只领取控制面租约，并以数据库时钟和 SKIP LOCKED 保持公平竞争", async () => {
    const coordinator = new ScriptedAssignmentClient("claim");
    const runtime = new ScriptedAssignmentClient("unused");
    const store = storeFor({ runtime, coordinator });

    await expect(
      store.claim({ workerId: "worker-dynamic", leaseMilliseconds: 30_000 }),
    ).resolves.toMatchObject({
      tenantId: "team-dynamic",
      generation: 7,
      workerId: "worker-dynamic",
    });

    const selection = coordinator.statements.find((statement) =>
      statement.sql.includes("SELECT tenant_id,generation"),
    );
    const claiming = coordinator.statements.find((statement) =>
      statement.sql.includes("RETURNING generation"),
    );
    expect(runtime.statements).toEqual([]);
    expect(
      coordinator.statements.some((statement) =>
        statement.sql.includes("set_config('app.worker_id'"),
      ),
    ).toBe(false);
    expect(selection?.sql).toContain("ORDER BY");
    expect(selection?.sql).toContain("next_attempt_at");
    expect(selection?.sql).toContain("updated_at,tenant_id");
    expect(selection?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(selection?.sql).not.toContain("run_dispatch_outbox");
    expect(claiming?.sql).toContain("generation=generation+1");
    expect(claiming?.sql).toContain("clock_timestamp()");
    expect(coordinator.releasedWith).toBeUndefined();
  });

  it("settle 回到 Tenant RLS 内计算下一次 dispatch，并保留租约栅栏", async () => {
    const client = new ScriptedAssignmentClient("settle-ready");
    const coordinator = new ScriptedAssignmentClient("unused");
    const store = storeFor({ runtime: client, coordinator });

    await expect(store.settle(assignment)).resolves.toBe(true);

    const tenantContextIndex = client.statements.findIndex((statement) =>
      statement.sql.includes("set_config('app.tenant_id'"),
    );
    const outboxIndex = client.statements.findIndex((statement) =>
      statement.sql.includes("FROM run_dispatch_outbox outbox"),
    );
    const update = client.statements.find(
      (statement) =>
        statement.sql.includes("UPDATE worker_tenant_assignments") &&
        statement.sql.includes("next_attempt_at=COALESCE"),
    );
    expect(tenantContextIndex).toBeGreaterThanOrEqual(0);
    expect(outboxIndex).toBeGreaterThan(tenantContextIndex);
    expect(coordinator.statements).toEqual([]);
    const pending = client.statements.find((statement) =>
      statement.sql.includes("FROM run_dispatch_outbox outbox"),
    );
    expect(pending?.sql).toContain("greatest(");
    expect(pending?.sql).toContain("statement_timestamp()");
    expect(pending?.sql).toContain("FROM memory_ingestion_outbox memory");
    expect(update?.values?.slice(0, 5)).toEqual([
      assignment.tenantId,
      assignment.generation,
      assignment.claimToken,
      assignment.workerId,
      "ready",
    ]);
  });

  it("没有后续 dispatch 时进入 idle，过期旧 generation 的 settle 是安全 no-op", async () => {
    const idleClient = new ScriptedAssignmentClient("settle-idle");
    await expect(storeFor({ runtime: idleClient }).settle(assignment)).resolves.toBe(true);
    const idleUpdate = idleClient.statements.find(
      (statement) =>
        statement.sql.includes("UPDATE worker_tenant_assignments") &&
        statement.sql.includes("next_attempt_at=COALESCE"),
    );
    expect(idleUpdate?.values?.[4]).toBe("idle");

    const staleClient = new ScriptedAssignmentClient("settle-stale");
    await expect(storeFor({ runtime: staleClient }).settle(assignment)).resolves.toBe(false);
    expect(
      staleClient.statements.some((statement) =>
        statement.sql.includes("FROM run_dispatch_outbox outbox"),
      ),
    ).toBe(false);

    const expiredClient = new ScriptedAssignmentClient("settle-expired");
    await expect(storeFor({ runtime: expiredClient }).settle(assignment)).resolves.toBe(false);
    const leaseFence = expiredClient.statements.find((statement) =>
      statement.sql.includes("SELECT 1 FROM worker_tenant_assignments"),
    );
    expect(leaseFence?.sql).toContain("lease_expires_at>=clock_timestamp()");
    expect(
      expiredClient.statements.some((statement) =>
        statement.sql.includes("FROM run_dispatch_outbox outbox"),
      ),
    ).toBe(false);
  });

  it("durable dispatch 可在当前 Tenant 事务内幂等唤醒被领取或 idle 的控制面行", async () => {
    const client = new ScriptedAssignmentClient("wake");
    const coordinator = new ScriptedAssignmentClient("unused");
    await storeFor({ runtime: client, coordinator }).wake("team-dynamic");

    const wake = client.statements.find((statement) =>
      statement.sql.includes("INSERT INTO worker_tenant_assignments"),
    );
    expect(wake?.sql).toContain("ON CONFLICT (tenant_id) DO UPDATE");
    expect(wake?.sql).toContain("WHEN worker_tenant_assignments.state='claimed' THEN 'claimed'");
    expect(wake?.sql).toContain("LEAST(");
    expect(wake?.values).toEqual(["team-dynamic", 0]);
    expect(coordinator.statements).toEqual([]);
  });

  it("拒绝无界租约与空 Worker 身份", async () => {
    const store = storeFor({ coordinator: new ScriptedAssignmentClient("claim") });
    await expect(store.claim({ workerId: " ", leaseMilliseconds: 30_000 })).rejects.toThrow(
      "workerId",
    );
    await expect(store.claim({ workerId: "worker", leaseMilliseconds: 999 })).rejects.toThrow(
      "lease",
    );
  });
});
