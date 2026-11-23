import { createServer, type Socket } from "node:net";
import { type Client, Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgWebhookOutboxStore } from "./pg-webhooks.js";
import { TransactionCommitUnknownError, withTransaction } from "./postgres.js";

function fixture(hangOn: string) {
  const release = vi.fn();
  const statements: string[] = [];
  const client = {
    release,
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith(hangOn)) return new Promise<never>(() => undefined);
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as PoolClient;
  return {
    client,
    release,
    statements,
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
  };
}

async function halfOpenPostgresFixture() {
  const sockets = new Set<Socket>();
  // 完成认证与 BEGIN，但收到 Terminate/FIN 后不回送 FIN，确保优雅关闭无法伪装成销毁完成。
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    let startup = true;
    let buffered = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length >= (startup ? 4 : 5)) {
        const length = buffered.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (buffered.length < length) return;
        const message = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        if (startup) {
          startup = false;
          socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]));
        } else if (message[0] === 81) {
          socket.write(Buffer.from([67, 0, 0, 0, 10, 66, 69, 71, 73, 78, 0, 90, 0, 0, 0, 5, 84]));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试 TCP 监听失败");
  const pool = new Pool({
    host: "127.0.0.1",
    port: address.port,
    user: "placeholder",
    password: "placeholder",
    database: "placeholder",
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 1_000,
  });
  let client: PoolClient | undefined;
  const close = async () => {
    if (client !== undefined) (client as unknown as Client).connection.stream.destroy();
    for (const socket of sockets) socket.destroy();
    await pool.end();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  try {
    client = await pool.connect();
    return { pool, client, stream: (client as unknown as Client).connection.stream, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("PostgreSQL 客户端事务截止时间", () => {
  it.each(["BEGIN", "SELECT", "ROLLBACK", "COMMIT"])(
    "静默断流卡在 %s 时有界返回并淘汰连接",
    async (phase) => {
      const { pool, release, statements } = fixture(phase);
      const pending = withTransaction(
        pool,
        async (client) => {
          if (phase === "ROLLBACK") throw new Error("业务失败");
          await client.query("SELECT 1");
        },
        { deadlineMs: 10 },
      );
      if (phase === "COMMIT")
        await expect(pending).rejects.toBeInstanceOf(TransactionCommitUnknownError);
      else
        await expect(pending).rejects.toThrow(
          phase === "ROLLBACK" ? "业务失败" : "POSTGRES_TRANSACTION_DEADLINE_EXCEEDED",
        );
      expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      if (phase === "COMMIT") expect(statements).not.toContain("ROLLBACK");
    },
  );

  it("连接池等待超时不执行事务，迟到连接被淘汰", async () => {
    let connect!: (client: PoolClient) => void;
    const pool = {
      connect: () =>
        new Promise<PoolClient>((resolve) => {
          connect = resolve;
        }),
    } as unknown as Pool;
    const operation = vi.fn();
    await expect(withTransaction(pool, operation, { deadlineMs: 10 })).rejects.toThrow(
      "POSTGRES_TRANSACTION_DEADLINE_EXCEEDED",
    );
    const { client, release } = fixture("never");
    connect(client);
    await vi.waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error)));
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(["迟到空闲连接", "无查询操作悬挂"])(
    "%s 超时后强制销毁真实 pg Socket 并完成池移除",
    async (mode) => {
      const { pool, client, stream, close } = await halfOpenPostgresFixture();
      const removed = vi.fn();
      pool.on("remove", removed);
      let finishConnect!: (connected: PoolClient) => void;
      const connecting = new Promise<PoolClient>((resolve) => {
        finishConnect = resolve;
      });
      const transactionPool = {
        connect: () => (mode === "迟到空闲连接" ? connecting : Promise.resolve(client)),
      } as unknown as Pool;
      const operation = vi.fn(async () => new Promise<never>(() => undefined));
      try {
        await expect(
          withTransaction(transactionPool, operation, { deadlineMs: 100 }),
        ).rejects.toThrow("POSTGRES_TRANSACTION_DEADLINE_EXCEEDED");
        if (mode === "迟到空闲连接") {
          expect(operation).not.toHaveBeenCalled();
          finishConnect(client);
        } else {
          expect(operation).toHaveBeenCalledOnce();
        }
        await vi.waitFor(
          () => {
            expect(stream.destroyed).toBe(true);
            expect(removed).toHaveBeenCalledExactlyOnceWith(client);
            expect(pool.totalCount).toBe(0);
          },
          { timeout: 500, interval: 10 },
        );
      } finally {
        await close();
      }
    },
  );

  it("成功事务在时限前提交并正常归还连接", async () => {
    const { pool, release } = fixture("never");
    await expect(withTransaction(pool, async () => "ok", { deadlineMs: 100 })).resolves.toBe("ok");
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("领取、发送前复核和结算都使用客户端截止时间", async () => {
    vi.useFakeTimers();
    try {
      for (const method of ["claim", "permitSend", "settle"] as const) {
        const { pool, release } = fixture("BEGIN");
        const store = new PgWebhookOutboxStore(pool);
        const delivery = {
          tenantId: "tenant_a",
          id: "delivery_a",
          webhookId: "wh_a",
          eventId: "evt_a",
          endpointUrl: "https://8.8.8.8",
          payload: {},
          attempts: 1,
          claimToken: "owner:token",
        };
        const operation =
          method === "claim"
            ? store.claim({ owner: "owner" })
            : method === "permitSend"
              ? store.permitSend(delivery, 1000)
              : store.settle(delivery, { kind: "delivered" });
        const rejected = expect(operation).rejects.toThrow(
          "POSTGRES_TRANSACTION_DEADLINE_EXCEEDED",
        );
        await vi.advanceTimersByTimeAsync(5_000);
        await rejected;
        expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
