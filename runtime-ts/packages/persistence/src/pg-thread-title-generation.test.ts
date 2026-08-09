import type { ThreadTitleGenerationClaim } from "@cube-runtime/thread-title";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  enqueueThreadTitleGeneration,
  PgThreadTitleGenerationStore,
} from "./pg-thread-title-generation.js";
import { PgRunDispatchCreation } from "./pg-run-dispatch.js";

interface Statement {
  readonly sql: string;
  readonly values?: readonly unknown[];
}

class ScriptedTitleClient {
  readonly statements: Statement[] = [];
  releasedWith: unknown;

  constructor(private readonly mode: "claim" | "complete" | "fallback") {}

  async query(sql: string, values?: readonly unknown[]) {
    this.statements.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("set_config('app.tenant_id'")) return { rows: [], rowCount: 1 };
    if (this.mode === "claim") {
      if (sql.includes("FROM thread_title_generation_outbox outbox")) {
        return {
          rows: [
            {
              thread_id: "thread-a",
              source_receipt_id: "receipt-a",
              request_digest: "a".repeat(64),
              expected_title_generation_version: 0,
              claim_generation: "3",
              attempt_count: 2,
              input_text: "请审查采购合同的付款风险",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("RETURNING claim_generation::text,attempt_count")) {
        return { rows: [{ claim_generation: "4", attempt_count: 3 }], rowCount: 1 };
      }
      if (sql.includes("CROSS JOIN LATERAL jsonb_each(receipt.input_attachments)")) {
        return {
          rows: [
            {
              name: "供应商采购合同.docx",
              media_type: "application/vnd.openxmlformats",
              ordinal: 0,
            },
          ],
          rowCount: 1,
        };
      }
    }
    if (sql.includes("FROM thread_title_generation_outbox") && sql.includes("FOR UPDATE")) {
      return { rows: [{ "?column?": 1 }], rowCount: 1 };
    }
    if (sql.includes("UPDATE threads")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT title,title_source,created_at FROM threads")) {
      return {
        rows: [
          {
            title: this.mode === "complete" ? "采购合同付款风险" : "请审查采购合同",
            title_source: this.mode === "complete" ? "model" : "deterministic",
            created_at: new Date("2026-08-07T08:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT naming_state")) {
      return { rows: [{ naming_state: "pending" }], rowCount: 1 };
    }
    if (sql.includes("SELECT 1 FROM thread_history_directories")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("UPDATE thread_history_directories")) return { rows: [], rowCount: 1 };
    if (sql.includes("UPDATE thread_title_generation_outbox")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }

  release(error?: unknown) {
    this.releasedWith = error;
  }
}

function poolFor(client: ScriptedTitleClient): Pool {
  return {
    async connect() {
      return client;
    },
  } as unknown as Pool;
}

const claim = Object.freeze({
  tenantId: "tenant-a",
  threadId: "thread-a",
  sourceReceiptId: "receipt-a",
  requestDigest: "a".repeat(64),
  expectedTitleGenerationVersion: 0,
  claimToken: "title-claim-a",
  claimGeneration: 4,
  attemptCount: 3,
  sourceText: "请审查采购合同的付款风险",
  attachments: Object.freeze([]),
}) satisfies ThreadTitleGenerationClaim;

describe("PostgreSQL 低成本 Thread 标题任务", () => {
  it("直接 Run 入口启用标题任务时必须同时启用 V2 receipt", () => {
    expect(
      () => new PgRunDispatchCreation({} as Pool, { historyTitleGenerationEnabled: true }),
    ).toThrow("历史标题生成依赖 V2 串行队列 receipt");
  });

  it("只为可用空间、确定性标题和已接受首条 receipt 幂等创建任务", async () => {
    const statements: Statement[] = [];
    const client = {
      async query(sql: string, values?: readonly unknown[]) {
        statements.push({ sql, ...(values === undefined ? {} : { values }) });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;

    await enqueueThreadTitleGeneration(client, {
      tenantId: "tenant-a",
      threadId: "thread-a",
      receiptId: "receipt-a",
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("tenant.kind IN ('personal','team')");
    expect(statements[0]?.sql).toContain("thread.title_source='deterministic'");
    expect(statements[0]?.sql).toContain(
      "receipt.disposition IN ('queued','pending_steer','steered')",
    );
    expect(statements[0]?.sql).toContain("ON CONFLICT (tenant_id,thread_id) DO NOTHING");
  });

  it("领取任务时允许接管过期 claim，且崩溃接管不会重复增加 attempt", async () => {
    const client = new ScriptedTitleClient("claim");
    const store = new PgThreadTitleGenerationStore(poolFor(client));

    await expect(
      store.claimNext({ tenantId: "tenant-a", workerId: "scheduler-a", leaseMs: 60_000 }),
    ).resolves.toMatchObject({
      tenantId: "tenant-a",
      threadId: "thread-a",
      claimGeneration: 4,
      attemptCount: 3,
      sourceText: "请审查采购合同的付款风险",
      attachments: [{ name: "供应商采购合同.docx", mediaType: "application/vnd.openxmlformats" }],
    });

    const selection = client.statements.find((statement) =>
      statement.sql.includes("FROM thread_title_generation_outbox outbox"),
    );
    const claiming = client.statements.find((statement) =>
      statement.sql.includes("RETURNING claim_generation::text,attempt_count"),
    );
    expect(selection?.sql).toContain(
      "outbox.state='claimed' AND outbox.claim_expires_at<=clock_timestamp()",
    );
    expect(claiming?.sql).toContain(
      "CASE WHEN state='pending' THEN attempt_count+1 ELSE attempt_count END",
    );
    expect(client.releasedWith).toBeUndefined();
  });

  it("成功结果以 Thread CAS 和 claim fencing 原子写回，并将 pending 目录一次性公开", async () => {
    const client = new ScriptedTitleClient("complete");
    const store = new PgThreadTitleGenerationStore(poolFor(client));

    await expect(
      store.complete(claim, {
        title: "采购合同付款风险",
        modelKey: "b".repeat(64),
        durationMs: 120,
        promptTokens: 42,
        completionTokens: 8,
      }),
    ).resolves.toBe(true);

    const threadUpdate = client.statements.find((statement) =>
      statement.sql.includes("UPDATE threads"),
    );
    expect(threadUpdate?.sql).toContain("title_source='deterministic'");
    expect(threadUpdate?.sql).toContain("title_generation_version=$4");
    const directoryUpdate = client.statements.find((statement) =>
      statement.sql.includes("UPDATE thread_history_directories"),
    );
    expect(directoryUpdate?.values?.[2]).toContain("采购合同付款风险");
    expect(directoryUpdate?.values?.[3]).toBe("ready");
    const outboxUpdate = client.statements.find(
      (statement) =>
        statement.sql.includes("UPDATE thread_title_generation_outbox") &&
        statement.sql.includes("model_key=$7"),
    );
    expect(outboxUpdate?.values?.slice(5)).toEqual(["succeeded", "b".repeat(64), 42, 8, 120]);
  });

  it("达到最大次数后保留确定性标题，并以 fallback 公开历史目录", async () => {
    const client = new ScriptedTitleClient("fallback");
    const store = new PgThreadTitleGenerationStore(poolFor(client));

    await expect(
      store.fail(claim, {
        errorCode: "PROVIDER_UNAVAILABLE",
        maximumAttempts: 3,
        retryBaseMs: 5_000,
      }),
    ).resolves.toBe(true);

    const directoryUpdate = client.statements.find((statement) =>
      statement.sql.includes("UPDATE thread_history_directories"),
    );
    expect(directoryUpdate?.values?.[3]).toBe("fallback");
    const outboxUpdate = client.statements.find(
      (statement) =>
        statement.sql.includes("UPDATE thread_title_generation_outbox") &&
        statement.sql.includes("last_error_code=$7"),
    );
    expect(outboxUpdate?.values?.slice(5)).toEqual(["fallback", "PROVIDER_UNAVAILABLE"]);
  });
});
