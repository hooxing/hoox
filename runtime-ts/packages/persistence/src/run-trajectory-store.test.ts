import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  PgRunTrajectoryStore,
  RUN_TRAJECTORY_PAGE_BYTE_BUDGET,
  type RunTrajectoryEventInput,
} from "./run-trajectory-store.js";

function poolFixture(query: (sql: string, values?: readonly unknown[]) => Promise<unknown>) {
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK")
        return { rowCount: null, rows: [] };
      if (sql.includes("set_config('app.tenant_id'")) return { rowCount: null, rows: [] };
      return (await query(sql, values)) as never;
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, client };
}

const event: RunTrajectoryEventInput = {
  context: {
    tenantId: "tenant_a",
    threadId: "thread_a",
    runId: "run_a",
    attemptId: "attempt_a",
  },
  event: {
    schemaVersion: 1,
    sequence: 1,
    occurredAt: "2026-11-22T00:00:00.000Z",
    monotonicOffsetMs: 0,
    source: "pi",
    type: "turn_start",
    event: { type: "turn_start" },
  },
};

describe("PgRunTrajectoryStore", () => {
  it("对象不可用时保留未终结的恢复锚点，不抛出正文或凭据", async () => {
    const queries: string[] = [];
    const { pool } = poolFixture(async (sql) => {
      queries.push(sql);
      return { rowCount: 1, rows: [] };
    });
    const traceBlobs = { persistTrace: vi.fn(async () => ({ outcome: "unavailable" as const })) };
    const store = new PgRunTrajectoryStore(pool, {} as never, traceBlobs);
    await expect(store.persist(event)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(traceBlobs.persistTrace).toHaveBeenCalledTimes(1);
    expect(queries.some((sql) => sql.includes("persistence_status='unavailable'"))).toBe(false);
  });

  it("对象写入结果未知时保留 pending operation 作为恢复锚点", async () => {
    const queries: string[] = [];
    const { pool } = poolFixture(async (sql) => {
      queries.push(sql);
      return { rowCount: 1, rows: [] };
    });
    const traceBlobs = { persistTrace: vi.fn(async () => ({ outcome: "unknown" as const })) };
    const store = new PgRunTrajectoryStore(pool, {} as never, traceBlobs);
    await expect(store.persist(event)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(queries.some((sql) => sql.includes("persistence_status='unavailable'"))).toBe(false);
  });

  it("同一子 Agent 不同 followUp Session 的同序号事件使用不同索引与 Blob 幂等键", async () => {
    const inserts: { values?: readonly unknown[]; sql: string }[] = [];
    const { pool } = poolFixture(async (sql, values) => {
      if (sql.startsWith("INSERT INTO run_trajectory_entries"))
        inserts.push({ sql, ...(values === undefined ? {} : { values }) });
      return { rowCount: 1, rows: [] };
    });
    const traceBlobs = {
      persistTrace: vi.fn(
        async (input: { idempotencyKey: string; body: Buffer; sha256: string }) => ({
          outcome: "persisted" as const,
          referenceId: `reference-${traceBlobs.persistTrace.mock.calls.length}`,
          blob: { size: input.body.byteLength, sha256: input.sha256 },
        }),
      ),
    };
    const store = new PgRunTrajectoryStore(pool, {} as never, traceBlobs as never);
    for (const agentTurnId of ["turn-first", "turn-follow-up"]) {
      await store.persist({
        ...event,
        context: { ...event.context, agentThreadId: "child-a", agentTurnId },
      });
    }
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.values?.[5]).toBe("turn-first");
    expect(inserts[1]?.values?.[5]).toBe("turn-follow-up");
    const keys = traceBlobs.persistTrace.mock.calls.map(([input]) => input.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toMatch(/^run-trajectory:[0-9a-f]{64}$/u);
    expect(keys[1]).toMatch(/^run-trajectory:[0-9a-f]{64}$/u);
  });

  it("保留期清理只删除到期索引并回收对应 Blob", async () => {
    const statements: string[] = [];
    const { pool } = poolFixture(async (sql) => {
      statements.push(sql);
      if (sql.startsWith("SELECT entry.tenant_id")) {
        return {
          rowCount: 1,
          rows: [
            {
              tenant_id: "tenant_a",
              attempt_id: "attempt_a",
              agent_thread_id: "",
              sequence: "1",
              persistence_status: "stored",
              blob_reference_id: "reference_a",
              sha256: "a".repeat(64),
              size: "10",
              blob_media_type: "application/json",
              incarnation_id: "incarnation_a",
              physical_object_key: "trace/object-a",
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const gc = { collectIfUnreachable: vi.fn(async () => "deleted" as const) };
    const store = new PgRunTrajectoryStore(pool, {} as never, undefined, 30, gc);
    await expect(store.cleanupExpired("tenant_a")).resolves.toBe(1);
    expect(gc.collectIfUnreachable).toHaveBeenCalledWith(
      { tenantId: "tenant_a" },
      expect.objectContaining({ purpose: "trace", sha256: "a".repeat(64) }),
    );
    expect(statements.find((sql) => sql.startsWith("SELECT entry.tenant_id"))).toContain(
      "GREATEST(entry.expires_at,entry.updated_at)<=statement_timestamp()",
    );
  });

  it("对象删除失败时保留索引，后续 Scheduler 批次可重试", async () => {
    const { pool, client } = poolFixture(async (sql) => {
      if (sql.startsWith("SELECT entry.tenant_id")) {
        return {
          rowCount: 1,
          rows: [
            {
              tenant_id: "tenant_a",
              attempt_id: "attempt_a",
              agent_thread_id: "",
              sequence: "1",
              persistence_status: "stored",
              blob_reference_id: "reference_a",
              sha256: "b".repeat(64),
              size: "10",
              blob_media_type: "application/json",
              incarnation_id: "incarnation_b",
              physical_object_key: "trace/object-b",
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const gc = {
      collectIfUnreachable: vi
        .fn<() => Promise<"deleted">>()
        .mockRejectedValueOnce(new Error("object delete failed"))
        .mockResolvedValue("deleted"),
    };
    const store = new PgRunTrajectoryStore(pool, {} as never, undefined, 30, gc);
    await expect(store.cleanupExpired("tenant_a")).rejects.toThrow("object delete failed");
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).startsWith("DELETE FROM run_trajectory_entries"),
      ),
    ).toBe(false);
    await expect(store.cleanupExpired("tenant_a")).resolves.toBe(1);
    expect(gc.collectIfUnreachable).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "pending 恢复先绑定再释放；绑定未命中时不重试（命中 %s）",
    async (matches) => {
      const operations: string[] = [];
      const { pool } = poolFixture(async (sql) => {
        if (sql.startsWith("SELECT entry.tenant_id")) {
          operations.push("select");
          if (operations.length > 1) throw new Error("重复选择过期行");
          return {
            rows: [
              {
                attempt_id: "attempt_a",
                sequence: "1",
                agent_thread_id: "",
                persistence_status: "pending",
                blob_reference_id: null,
                blob_operation_id: "trace-operation",
                sha256: "c".repeat(64),
                size: "10",
              },
            ],
          };
        }
        if (sql.startsWith("UPDATE run_trajectory_entries SET updated_at")) {
          operations.push("defer");
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE run_trajectory_entries")) {
          operations.push("bind");
          return {
            rows: matches
              ? [
                  {
                    blob_reference_id: "reference_a",
                    blob_media_type: "application/json",
                    incarnation_id: "incarnation_a",
                    physical_object_key: "trace/object-a",
                  },
                ]
              : [],
          };
        }
        operations.push(sql.startsWith("UPDATE blob_references") ? "release" : "delete");
        return { rowCount: 1, rows: [] };
      });
      const store = new PgRunTrajectoryStore(
        pool,
        {} as never,
        undefined,
        30,
        {
          collectIfUnreachable: async () => {
            operations.push("gc");
            return "deleted";
          },
        },
        {
          recoverForRetention: async () => {
            operations.push("recover");
            return "completed";
          },
        },
      );
      await expect(store.cleanupExpired("tenant_a", 1)).resolves.toBe(matches ? 1 : 0);
      expect(operations).toEqual([
        "select",
        "recover",
        "bind",
        ...(matches ? ["release", "gc", "delete"] : ["defer"]),
      ]);
    },
  );

  it("大于页预算的事件返回有界占位符且不下载正文", async () => {
    const { pool } = poolFixture(async (sql) => {
      if (sql.startsWith("SELECT sequence")) {
        return {
          rowCount: 1,
          rows: [
            {
              sequence: "1",
              agent_thread_id: "",
              source: "pi",
              event_type: "large_event",
              occurred_at: new Date("2026-11-22T00:00:00.000Z"),
              monotonic_offset_ms: 1,
              sha256: "d".repeat(64),
              size: String(RUN_TRAJECTORY_PAGE_BYTE_BUDGET + 1),
              blob_media_type: "application/json",
              incarnation_id: "incarnation_large",
              physical_object_key: "trace/large",
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const blobs = { getBytes: vi.fn() };
    const store = new PgRunTrajectoryStore(pool, blobs as never, undefined);
    await expect(
      store.readPage({
        actorUserId: "user_admin",
        auditId: "audit_large",
        tenantId: "tenant_a",
        runId: "run_a",
        attemptId: "attempt_a",
        limit: 50,
      }),
    ).resolves.toMatchObject({
      hasMore: true,
      records: [{ truncated: true, event: { $cubeInternalType: "truncated" } }],
    });
    expect(blobs.getBytes).not.toHaveBeenCalled();
  });
});
