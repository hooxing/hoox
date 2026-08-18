import { tenantId, userId } from "@hoox/domain";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queueMocks = vi.hoisted(() => ({
  cancelThreadQueuedRun: vi.fn(),
  lockThreadExecutionHead: vi.fn(),
}));

vi.mock("./pg-thread-run-queue.js", () => queueMocks);

import { PgTeamCollaborationRepository } from "./pg-team-collaboration.js";

interface Statement {
  readonly sql: string;
  readonly values?: readonly unknown[];
}

class ScriptedTeamCollaborationClient {
  readonly statements: Statement[] = [];
  releasedWith: unknown;
  private readonly runReadCounts = new Map<string, number>();

  constructor(
    private readonly actor: "owner" | "member" = "owner",
    private readonly runBatchesByThread: Readonly<
      Record<string, readonly (readonly string[])[]>
    > = {},
  ) {}

  async query(sql: string, values?: readonly unknown[]) {
    this.statements.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("set_config('app.tenant_id'")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT role FROM memberships")) {
      if (
        sql.includes("FOR SHARE") &&
        this.statements.some((item) => item.sql.includes("READ ONLY"))
      ) {
        throw Object.assign(new Error("只读事务不能获取行锁"), { code: "25006" });
      }
      return { rows: [{ role: this.actor }], rowCount: 1 };
    }
    if (sql.includes("SELECT id AS membership_id")) {
      return {
        rows: [
          {
            membership_id: "membership-owner",
            user_id: String(values?.[0] === scope.tenantId ? scope.userId : "member"),
            role: this.actor,
            joined_at: "2026-08-12T00:00:00.000Z",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT thread.id")) {
      const rows = Object.keys(this.runBatchesByThread).map((id) => ({ id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("SELECT run.id")) {
      const threadId = String(values?.[1]);
      const readCount = this.runReadCounts.get(threadId) ?? 0;
      this.runReadCounts.set(threadId, readCount + 1);
      const rows = (this.runBatchesByThread[threadId]?.[readCount] ?? []).map((id) => ({ id }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 1 };
  }

  release(error?: unknown) {
    this.releasedWith = error;
  }
}

function poolFor(client: ScriptedTeamCollaborationClient): Pool {
  return {
    async connect() {
      return client;
    },
  } as unknown as Pool;
}

const scope = Object.freeze({
  tenantId: tenantId("team-dissolve"),
  userId: userId("owner-dissolve"),
});

describe("PostgreSQL 团队成员只读查询", () => {
  it("活跃成员校验不在 READ ONLY 事务中申请 FOR SHARE 行锁", async () => {
    const client = new ScriptedTeamCollaborationClient("owner");
    const repository = new PgTeamCollaborationRepository(poolFor(client));

    await expect(repository.listMembers({ scope })).resolves.toEqual([
      {
        membershipId: "membership-owner",
        userId: scope.userId,
        role: "owner",
        joinedAt: "2026-08-12T00:00:00.000Z",
      },
    ]);

    const roleQuery = client.statements.find((statement) =>
      statement.sql.includes("SELECT role FROM memberships"),
    );
    expect(client.statements[0]?.sql).toContain("READ ONLY");
    expect(roleQuery?.sql).not.toContain("FOR SHARE");
    expect(client.statements.at(-1)?.sql).toBe("COMMIT");
  });
});

describe("PostgreSQL 团队解散队列收敛", () => {
  beforeEach(() => {
    queueMocks.cancelThreadQueuedRun.mockReset();
    queueMocks.lockThreadExecutionHead.mockReset();
    queueMocks.lockThreadExecutionHead.mockResolvedValue({ active_run_id: null });
  });

  it("先封停 ready/claimed dispatch，再按 active 优先同步所有非终态 Run，最后撤销成员", async () => {
    const client = new ScriptedTeamCollaborationClient("owner", {
      "thread-a": [["run-queued", "run-active", "run-waiting"], []],
    });
    queueMocks.lockThreadExecutionHead.mockResolvedValue({ active_run_id: "run-active" });
    const repository = new PgTeamCollaborationRepository(poolFor(client));

    await expect(repository.dissolve({ scope })).resolves.toEqual({
      outcome: "succeeded",
      value: undefined,
    });

    const roleQuery = client.statements.find((statement) =>
      statement.sql.includes("SELECT role FROM memberships"),
    );
    expect(roleQuery?.sql).toContain("FOR SHARE");
    const outboxIndexes = client.statements.flatMap((statement, index) =>
      statement.sql.includes("UPDATE run_dispatch_outbox") ? [index] : [],
    );
    const outboxIndex = outboxIndexes[0] ?? -1;
    const runIndex = client.statements.findIndex((statement) =>
      statement.sql.includes("UPDATE runs"),
    );
    const membershipIndex = client.statements.findIndex((statement) =>
      statement.sql.includes("UPDATE memberships SET status='revoked'"),
    );
    const assignmentIndex = client.statements.findIndex((statement) =>
      statement.sql.includes("UPDATE worker_tenant_assignments"),
    );
    const outbox = client.statements[outboxIndex];
    expect(outboxIndex).toBeGreaterThanOrEqual(0);
    expect(outboxIndexes).toHaveLength(2);
    expect(outboxIndex).toBeLessThan(runIndex);
    expect(runIndex).toBeLessThan(outboxIndexes[1] ?? -1);
    expect(outboxIndexes[1]).toBeLessThan(assignmentIndex);
    expect(assignmentIndex).toBeLessThan(membershipIndex);
    expect(outbox?.sql).toContain("state IN ('ready','claimed')");
    expect(outbox?.sql).toContain("state='cancelled'");
    expect(outbox?.sql).toContain("generation+1");
    expect(outbox?.sql).toContain("claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL");
    expect(outbox?.sql).toContain("last_error_code='team_dissolved'");
    expect(client.statements[runIndex]?.sql).toContain("status IN ('queued','running','waiting')");
    expect(client.statements[assignmentIndex]?.sql).toContain("state='idle'");
    expect(client.statements[assignmentIndex]?.sql).toContain("generation+1");
    expect(client.statements[assignmentIndex]?.sql).toContain(
      "claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL",
    );
    expect(queueMocks.cancelThreadQueuedRun.mock.calls.map((call) => call[1].runId)).toEqual([
      "run-active",
      "run-queued",
      "run-waiting",
    ]);
    expect(client.statements.at(-1)?.sql).toBe("COMMIT");
    expect(client.releasedWith).toBeUndefined();
  });

  it("取消状态机失败时整体回滚，不提前撤销最后一个 Membership", async () => {
    const client = new ScriptedTeamCollaborationClient("owner", {
      "thread-a": [["run-active"]],
    });
    queueMocks.lockThreadExecutionHead.mockResolvedValue({ active_run_id: "run-active" });
    queueMocks.cancelThreadQueuedRun.mockRejectedValue(new Error("queue cancellation failed"));
    const repository = new PgTeamCollaborationRepository(poolFor(client));

    await expect(repository.dissolve({ scope })).rejects.toThrow();

    expect(
      client.statements.some((statement) =>
        statement.sql.includes("UPDATE memberships SET status='revoked'"),
      ),
    ).toBe(false);
    expect(client.statements.some((statement) => statement.sql === "ROLLBACK")).toBe(true);
    expect(client.statements.some((statement) => statement.sql === "COMMIT")).toBe(false);
  });

  it("非 Owner 不触碰投递、Run 或成员状态", async () => {
    const client = new ScriptedTeamCollaborationClient("member", {
      "thread-a": [["run-queued"]],
    });
    const repository = new PgTeamCollaborationRepository(poolFor(client));

    await expect(repository.dissolve({ scope })).resolves.toEqual({ outcome: "not_authorized" });

    expect(
      client.statements.some((statement) => statement.sql.includes("UPDATE run_dispatch_outbox")),
    ).toBe(false);
    expect(queueMocks.cancelThreadQueuedRun).not.toHaveBeenCalled();
    expect(
      client.statements.some((statement) =>
        statement.sql.includes("UPDATE memberships SET status='revoked'"),
      ),
    ).toBe(false);
  });

  it("active 取消产生 steer fallback 时继续收敛，并封停该过程新建的 dispatch", async () => {
    const client = new ScriptedTeamCollaborationClient("owner", {
      "thread-a": [["run-active"], ["run-fallback"], []],
    });
    queueMocks.lockThreadExecutionHead
      .mockResolvedValueOnce({ active_run_id: "run-active" })
      .mockResolvedValueOnce({ active_run_id: "run-fallback" })
      .mockResolvedValueOnce({ active_run_id: null });
    const repository = new PgTeamCollaborationRepository(poolFor(client));

    await expect(repository.dissolve({ scope })).resolves.toMatchObject({ outcome: "succeeded" });

    expect(queueMocks.cancelThreadQueuedRun.mock.calls.map((call) => call[1].runId)).toEqual([
      "run-active",
      "run-fallback",
    ]);
    expect(
      client.statements.filter((statement) => statement.sql.includes("UPDATE run_dispatch_outbox")),
    ).toHaveLength(2);
  });
});
