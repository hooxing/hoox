import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseProductionPostgresTransport } from "../../runtime-ts/packages/process-runtime/src/production-postgres-transport.js";
import {
  createPostgresPool,
  probePostgres,
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
  it("显式保留 production TLS 校验配置，不依赖 URL sslmode", async () => {
    const pool = createPostgresPool({
      connectionString: "postgresql://placeholder.invalid/db",
      ssl: { rejectUnauthorized: true },
    });
    expect(
      (pool as unknown as { readonly options: { readonly ssl: unknown } }).options.ssl,
    ).toEqual({ rejectUnauthorized: true });
    await pool.end();
  });

  it("恶意 PG* 宿主变量不能覆盖 production URL 或关闭 pg TLS 校验", async () => {
    const environmentKeys = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGSSLMODE"] as const;
    const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    process.env.PGHOST = "attacker.invalid";
    process.env.PGPORT = "6543";
    process.env.PGUSER = "attacker_role";
    process.env.PGPASSWORD = "attacker-password";
    process.env.PGSSLMODE = "disable";
    const declaredPassword = "declared-runtime-password";
    let pool: Pool | undefined;
    try {
      const transport = parseProductionPostgresTransport(
        `postgresql://runtime:${declaredPassword}@database.example.invalid:5432/runtime?sslmode=verify-full`,
      );
      pool = createPostgresPool({
        connectionString: transport.connectionString,
        ssl: transport.ssl,
      });
      const poolOptions = (pool as unknown as { readonly options: object }).options;
      const requireFromPersistence = createRequire(
        new URL("../../runtime-ts/packages/persistence/package.json", import.meta.url),
      );
      const { Client } = requireFromPersistence("pg") as {
        readonly Client: new (
          options: object,
        ) => {
          readonly connectionParameters: {
            readonly host: string;
            readonly port: number;
            readonly user: string;
            readonly ssl: unknown;
          };
          readonly password: string;
        };
      };
      const client = new Client(poolOptions);
      expect(client.connectionParameters).toMatchObject({
        host: "database.example.invalid",
        port: 5432,
        user: "runtime",
        ssl: { rejectUnauthorized: true },
      });
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      expect(digest(client.password)).toBe(digest(declaredPassword));
      expect(digest(client.password)).not.toBe(digest(process.env.PGPASSWORD));
    } finally {
      if (pool !== undefined) await pool.end();
      for (const key of environmentKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("运行角色探针同时拒绝 SET ROLE、superuser 与 bypassrls", async () => {
    const fixture = (row: Readonly<Record<string, unknown>>) =>
      ({ query: async () => ({ rows: [row] }) }) as unknown as Pool;
    await expect(
      probePostgres(
        fixture({
          current_user: "runtime",
          session_user: "owner",
          rolsuper: false,
          rolbypassrls: false,
        }),
        "runtime",
      ),
    ).rejects.toThrow("POSTGRES_RUNTIME_ROLE_MISMATCH");
    for (const unsafe of ["rolsuper", "rolbypassrls"] as const) {
      await expect(
        probePostgres(
          fixture({
            current_user: "runtime",
            session_user: "runtime",
            rolsuper: unsafe === "rolsuper",
            rolbypassrls: unsafe === "rolbypassrls",
          }),
          "runtime",
        ),
      ).rejects.toThrow("POSTGRES_RUNTIME_ROLE_UNSAFE");
    }
  });

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
