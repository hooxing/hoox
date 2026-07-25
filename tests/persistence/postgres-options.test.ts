import { describe, expect, it } from "vitest";
import {
  createPostgresPool,
  withTransaction,
  type Pool,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

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
});
