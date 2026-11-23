import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { PgClientToolCallHistoryReader } from "./pg-client-tool-calls.js";

function readerPool(rows: readonly { readonly has_client_tool_history: boolean }[]) {
  const client = {
    async query(sql: string) {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK")
        return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.tenant_id'")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT has_client_tool_history FROM threads"))
        return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PoolClient;
  return {
    async connect() {
      return client;
    },
  } as unknown as Pool;
}

describe("客户端工具历史标记读取", () => {
  it("只有明确读取到 false 时才允许正文诊断", async () => {
    const input = { tenantId: "tenant-reader", threadId: "thread-reader" };
    await expect(
      new PgClientToolCallHistoryReader(
        readerPool([{ has_client_tool_history: false }]),
      ).hasClientToolHistoryForThread(input),
    ).resolves.toBe(false);
    await expect(
      new PgClientToolCallHistoryReader(
        readerPool([{ has_client_tool_history: true }]),
      ).hasClientToolHistoryForThread(input),
    ).resolves.toBe(true);
    await expect(
      new PgClientToolCallHistoryReader(readerPool([])).hasClientToolHistoryForThread(input),
    ).resolves.toBe(true);
  });
});
