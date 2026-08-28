import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PgRunDispatchOutbox } from "./pg-run-dispatch.js";

interface Statement {
  readonly sql: string;
  readonly values?: readonly unknown[];
}

class ScriptedDispatchClient {
  readonly statements: Statement[] = [];
  releasedWith: unknown;

  constructor(
    private readonly activeThreadCount: number,
    private readonly activeUserCount = activeThreadCount,
  ) {}

  async query(sql: string, values?: readonly unknown[]) {
    this.statements.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.includes("WITH active_user_runs AS")) {
      return {
        rows: [
          {
            outbox_id: "outbox-user-limit",
            run_id: "run-user-limit",
            thread_id: "thread-user-limit",
            workspace_id: "workspace-user-limit",
            root_run_id: "run-user-limit",
            base_revision_id: null,
            generation: "3",
            user_id: "user-a",
            active_run_count: String(this.activeUserCount),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT count(*)::text AS count")) {
      const count = sql.includes("active_dispatch.thread_id=$2")
        ? this.activeThreadCount
        : this.activeUserCount;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }
    if (sql.includes("UPDATE run_dispatch_outbox")) {
      return { rows: [{ generation: "4" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(error?: unknown) {
    this.releasedWith = error;
  }
}

function outboxFor(client: ScriptedDispatchClient): PgRunDispatchOutbox {
  return new PgRunDispatchOutbox({ connect: async () => client } as unknown as Pool);
}

const claimInput = Object.freeze({
  tenantId: "tenant-user-limit",
  dispatcherId: "worker-user-limit",
  limit: 1,
  leaseMilliseconds: 30_000,
  userMaxConcurrentRunsPerTenant: 2,
});

describe("PostgreSQL Run dispatch 用户并发占槽", () => {
  it("按 Tenant+User 复核活跃 Run，并在 advisory lock 内原子领取", async () => {
    const client = new ScriptedDispatchClient(0);

    await expect(outboxFor(client).claim(claimInput)).resolves.toMatchObject([
      {
        outboxId: "outbox-user-limit",
        generation: 4,
        scope: {
          tenantId: claimInput.tenantId,
          runId: "run-user-limit",
          threadId: "thread-user-limit",
        },
      },
    ]);

    const selection = client.statements.find((statement) =>
      statement.sql.includes("WITH active_user_runs AS"),
    );
    const advisoryIndex = client.statements.findIndex((statement) =>
      statement.sql.includes("pg_advisory_xact_lock"),
    );
    const selectionIndex = client.statements.findIndex((statement) =>
      statement.sql.includes("WITH active_user_runs AS"),
    );
    const recountIndexes = client.statements
      .map((statement, index) =>
        statement.sql.includes("SELECT count(*)::text AS count") ? index : -1,
      )
      .filter((index) => index >= 0);
    const updateIndex = client.statements.findIndex((statement) =>
      statement.sql.includes("UPDATE run_dispatch_outbox"),
    );
    expect(selection?.sql).toContain("JOIN run_skill_snapshots");
    expect(selection?.sql).toContain("attempt.status IN ('claimed','running','finalizing')");
    expect(selection?.sql).toContain("claim.expires_at>=clock_timestamp()");
    expect(selection?.sql).toContain("ORDER BY COALESCE(active.active_run_count,0)");
    expect(selection?.sql).toContain("AND NOT EXISTS (");
    expect(selection?.sql).toContain("active_attempt.thread_id=outbox.thread_id");
    expect(selection?.sql).toContain("FOR UPDATE OF outbox SKIP LOCKED");
    expect(selection?.values?.slice(0, 2)).toEqual([
      claimInput.tenantId,
      claimInput.userMaxConcurrentRunsPerTenant,
    ]);
    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(selectionIndex).toBeGreaterThan(advisoryIndex);
    expect(recountIndexes).toHaveLength(2);
    expect(recountIndexes[0]).toBeGreaterThan(selectionIndex);
    expect(updateIndex).toBeGreaterThan(recountIndexes[1] ?? -1);
    expect(client.releasedWith).toBeUndefined();
  });

  it("用户已经占满配置槽位时保留 dispatch 为 ready", async () => {
    const client = new ScriptedDispatchClient(0, 2);

    await expect(outboxFor(client).claim(claimInput)).resolves.toEqual([]);

    expect(
      client.statements.some((statement) => statement.sql.includes("UPDATE run_dispatch_outbox")),
    ).toBe(false);
  });

  it("同一 Thread 已有有效执行租约时不领取第二个 Run", async () => {
    const client = new ScriptedDispatchClient(1, 0);

    await expect(outboxFor(client).claim(claimInput)).resolves.toEqual([]);

    expect(
      client.statements.some((statement) => statement.sql.includes("UPDATE run_dispatch_outbox")),
    ).toBe(false);
  });

  it("拒绝越界的用户并发配置", async () => {
    const client = new ScriptedDispatchClient(0);
    await expect(
      outboxFor(client).claim({ ...claimInput, userMaxConcurrentRunsPerTenant: 0 }),
    ).rejects.toThrow("单用户在 Tenant 内并行 Run 上限无效");
    expect(client.statements).toEqual([]);
  });
});
