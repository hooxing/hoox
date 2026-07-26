import { describe, expect, it } from "vitest";
import {
  createPostgresPool,
  TransactionCommitUnknownError,
  withTransaction,
  type Pool,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

function commitFailurePool(commitError: Error & { readonly code?: string }): {
  readonly pool: Pool;
  readonly queries: readonly string[];
  releasedWith(): Error | undefined;
} {
  const queries: string[] = [];
  let releaseError: Error | undefined;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql === "COMMIT") throw commitError;
      return { rows: [], rowCount: 0 };
    },
    release: (error?: Error) => {
      releaseError = error;
    },
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    queries,
    releasedWith: () => releaseError,
  };
}

describe("PostgreSQL 运行时配置校验", () => {
  it.each([
    ["maxConnections", 0],
    ["maxConnections", 101],
    ["idleTimeoutMs", 999],
    ["connectionTimeoutMs", 60_001],
    ["statementTimeoutMs", -1],
  ] as const)("拒绝越界配置 %s=%s", (name, value) => {
    expect(() =>
      createPostgresPool({
        connectionString: "postgresql://placeholder.invalid/db",
        [name]: value,
      }),
    ).toThrow("必须是");
  });

  it("在取得连接之前拒绝非白名单隔离级别", async () => {
    const neverConnect = {
      connect: () => {
        throw new Error("不应尝试连接");
      },
    } as unknown as Pool;
    await expect(
      withTransaction(neverConnect, async () => undefined, {
        isolationLevel: "READ UNCOMMITTED" as "READ COMMITTED",
      }),
    ).rejects.toThrow("隔离级别不在运行时白名单");
  });

  it("连接类 COMMIT 异常标记为结果未知且不在未知连接上回滚", async () => {
    const networkError = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const fixture = commitFailurePool(networkError);
    await expect(withTransaction(fixture.pool, async () => "written")).rejects.toBeInstanceOf(
      TransactionCommitUnknownError,
    );
    expect(fixture.queries).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT"]);
    expect(fixture.releasedWith()).toBe(networkError);
  });

  it.each(["40001", "40P01", "23505"])(
    "SQLSTATE %s 明确拒绝 COMMIT，不误报结果未知",
    async (code) => {
      const databaseError = Object.assign(new Error("database rejected commit"), { code });
      const fixture = commitFailurePool(databaseError);
      await expect(withTransaction(fixture.pool, async () => "written")).rejects.toBe(
        databaseError,
      );
      expect(fixture.queries).toEqual([
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        "COMMIT",
        "ROLLBACK",
      ]);
      expect(fixture.releasedWith()).toBeUndefined();
    },
  );
});
