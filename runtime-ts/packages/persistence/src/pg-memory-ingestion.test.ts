import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { BlobStore } from "./blob-store.js";
import { enqueueMemoryIngestion, PgMemoryIngestionStore } from "./pg-memory-ingestion.js";

interface Statement {
  readonly sql: string;
  readonly values?: readonly unknown[];
}

class ScriptedMemoryClient {
  readonly statements: Statement[] = [];
  releasedWith: unknown;

  constructor(private readonly runOrigin: "normal" | "playground" = "normal") {}

  async query(sql: string, values?: readonly unknown[]) {
    this.statements.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("set_config('app.tenant_id'")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT origin FROM runs")) {
      return { rows: [{ origin: this.runOrigin }], rowCount: 1 };
    }
    if (sql.includes("SELECT memory.run_id,memory.thread_id,memory.attempt_id")) {
      return {
        rows:
          this.runOrigin === "playground"
            ? []
            : [
                {
                  run_id: "run-memory",
                  thread_id: "thread-memory",
                  attempt_id: "attempt-memory",
                  subject_user_id: "user-memory",
                  tenant_kind: "personal",
                  source_through_sequence: "2",
                  provider_event_id: null,
                  claim_generation: "0",
                  attempt_count: 0,
                },
              ],
        rowCount: this.runOrigin === "playground" ? 0 : 1,
      };
    }
    if (sql.includes("RETURNING claim_generation::text")) {
      return { rows: [{ claim_generation: "1" }], rowCount: 1 };
    }
    if (sql.includes("FROM thread_context_entries")) {
      const bodies = [
        { sequence: "1", kind: "user_message", body: { text: "用户输入" } },
        { sequence: "2", kind: "assistant_message", body: { text: "助手回答" } },
      ] as const;
      return {
        rows: bodies.map((item) => ({
          sequence: item.sequence,
          kind: item.kind,
          body_inline: item.body,
          body_reference_id: null,
          body_sha256: createHash("sha256").update(JSON.stringify(item.body), "utf8").digest("hex"),
          body_size: String(Buffer.byteLength(JSON.stringify(item.body), "utf8")),
          body_incarnation_id: null,
          body_physical_object_key: null,
        })),
        rowCount: 2,
      };
    }
    if (sql.includes("UPDATE memory_ingestion_outbox SET")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO memory_ingestion_outbox")) {
      return { rows: [], rowCount: this.runOrigin === "playground" ? 0 : 1 };
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

function poolFor(client: ScriptedMemoryClient): Pool {
  return {
    async connect() {
      return client;
    },
  } as unknown as Pool;
}

const noBlobReads = {
  getBytes: async () => {
    throw new Error("内联记忆正文不应读取 Blob");
  },
} as unknown as BlobStore;

describe("PostgreSQL 记忆 Outbox", () => {
  it("在成功 Run 事务内只登记 durable 引用并唤醒后台 Tenant 调度", async () => {
    const client = new ScriptedMemoryClient();
    await enqueueMemoryIngestion(client as unknown as PoolClient, {
      tenantId: "tenant-memory",
      threadId: "thread-memory",
      runId: "run-memory",
      attemptId: "attempt-memory",
      sourceThroughSequence: 2,
    });

    const outbox = client.statements.find((statement) =>
      statement.sql.includes("INSERT INTO memory_ingestion_outbox"),
    );
    const wake = client.statements.find((statement) =>
      statement.sql.includes("INSERT INTO worker_tenant_assignments"),
    );
    expect(outbox?.values).toEqual([
      "tenant-memory",
      "run-memory",
      "thread-memory",
      "attempt-memory",
      2,
    ]);
    expect(outbox?.sql).not.toContain("input_text");
    expect(wake?.values).toEqual(["tenant-memory", expect.any(Date)]);
  });

  it("Playground 来源不新建长期记忆任务，且旧待消费任务不会被领取", async () => {
    const client = new ScriptedMemoryClient("playground");
    await enqueueMemoryIngestion(client as unknown as PoolClient, {
      tenantId: "tenant-memory",
      threadId: "thread-memory",
      runId: "run-memory",
      attemptId: "attempt-memory",
      sourceThroughSequence: 2,
    });
    expect(
      client.statements.some((statement) =>
        statement.sql.includes("INSERT INTO worker_tenant_assignments"),
      ),
    ).toBe(false);
    expect(
      client.statements.find((statement) =>
        statement.sql.includes("INSERT INTO memory_ingestion_outbox"),
      )?.sql,
    ).toContain("run.origin<>'playground'");

    const store = new PgMemoryIngestionStore(poolFor(client), noBlobReads);
    await expect(
      store.claimNext({
        tenantId: "tenant-memory",
        workerId: "worker-memory",
        leaseMs: 30_000,
      }),
    ).resolves.toBeUndefined();
    const claimQuery = client.statements.find((statement) =>
      statement.sql.includes("SELECT memory.run_id"),
    );
    expect(claimQuery?.sql).toContain("source_run.origin<>'playground'");
    expect(
      client.statements.some((statement) => statement.sql.includes("FROM thread_context_entries")),
    ).toBe(false);
  });

  it("领取任务后仅从 Context 恢复 user 与 assistant 文本并保持 claim 栅栏", async () => {
    const client = new ScriptedMemoryClient();
    const store = new PgMemoryIngestionStore(poolFor(client), noBlobReads);

    const claim = await store.claimNext({
      tenantId: "tenant-memory",
      workerId: "worker-memory",
      leaseMs: 30_000,
    });

    expect(claim).toMatchObject({
      tenantId: "tenant-memory",
      tenantKind: "personal",
      userId: "user-memory",
      threadId: "thread-memory",
      runId: "run-memory",
      claimGeneration: 1,
      attemptCount: 1,
      messages: [
        { role: "user", content: "用户输入" },
        { role: "assistant", content: "助手回答" },
      ],
    });
    const contextRead = client.statements.find((statement) =>
      statement.sql.includes("FROM thread_context_entries"),
    );
    // sequence::text 只是驱动传输格式；排序必须继续使用 bigint 列，避免 10 排在 2 前面。
    expect(contextRead?.sql).toContain("ORDER BY visible.sequence");
    if (claim === undefined) throw new Error("记忆任务领取失败");
    expect(
      await store.complete(claim, {
        eventId: "c7251cb0-e33e-4e98-b4f4-161aca5de4d0",
        status: "SUCCEEDED",
      }),
    ).toBe(true);
    const completion = client.statements.find(
      (statement) =>
        statement.sql.includes("UPDATE memory_ingestion_outbox SET") &&
        statement.sql.includes("state='succeeded'"),
    );
    expect(completion?.sql).toContain("claim_token=$3");
    expect(completion?.sql).toContain("claim_generation=$4");
    expect(completion?.values?.[4]).toBe("c7251cb0-e33e-4e98-b4f4-161aca5de4d0");
    expect(client.releasedWith).toBeUndefined();
  });
});
