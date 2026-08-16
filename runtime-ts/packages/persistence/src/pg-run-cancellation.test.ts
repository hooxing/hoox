import type { ExecutionScope } from "@aisay/run-contracts";
import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgRunCancellationReader } from "./pg-run-cancellation.js";

function scope(): ExecutionScope {
  return {
    tenantId: "tenant-cancel",
    threadId: "thread-cancel",
    runId: "run-cancel",
    rootRunId: "run-cancel",
    workspaceId: "workspace-cancel",
  } as unknown as ExecutionScope;
}

function poolWithStatus(status: string | undefined) {
  const query = vi.fn(async (text: string) => {
    const rows =
      text.includes("SELECT status FROM runs") && status !== undefined ? [{ status }] : [];
    return { rows } as unknown as QueryResult;
  });
  const release = vi.fn();
  const pool = {
    connect: async () => ({ query, release }) as unknown as PoolClient,
  } as unknown as Pool;
  return { pool, query, release };
}

describe("PostgreSQL Run 取消读取", () => {
  it("只把完整 scope 下的 cancelled 状态解释为业务取消", async () => {
    const cancelled = poolWithStatus("cancelled");
    const active = poolWithStatus("running");

    await expect(new PgRunCancellationReader(cancelled.pool).isCancelled(scope())).resolves.toBe(
      true,
    );
    await expect(new PgRunCancellationReader(active.pool).isCancelled(scope())).resolves.toBe(
      false,
    );

    expect(cancelled.query).toHaveBeenCalledWith(expect.stringContaining("thread_id=$3"), [
      "tenant-cancel",
      "run-cancel",
      "thread-cancel",
    ]);
    expect(cancelled.release).toHaveBeenCalledOnce();
  });
});
