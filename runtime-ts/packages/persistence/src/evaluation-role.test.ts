import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapEvaluationRole,
  evaluationRoleName,
  setLocalEvaluationRole,
} from "./evaluation-role.js";

describe("评测角色", () => {
  it("从 Runtime 身份稳定派生，长名称保留摘要且不超出 PostgreSQL 标识符上限", () => {
    expect(evaluationRoleName("m4_ci_runtime")).toBe("m4_ci_runtime_evaluation");
    const runtime = "runtime_".padEnd(63, "a");
    expect(evaluationRoleName(runtime)).toBe(
      `${runtime.slice(0, 43)}_${createHash("md5").update(runtime).digest("hex").slice(0, 8)}_evaluation`,
    );
    expect(evaluationRoleName(runtime)).toHaveLength(63);
    expect(evaluationRoleName(runtime)).not.toBe(evaluationRoleName(`${runtime.slice(0, 62)}b`));
    expect(() => evaluationRoleName('runtime"; RESET ROLE')).toThrow(TypeError);
  });

  it.each([true, false])("幂等补齐 NOLOGIN 角色和不继承的成员关系，已有=%s", async (exists) => {
    const client = {
      query: vi.fn(async (statement: string) => {
        if (statement.includes("AS safe")) return { rows: [{ safe: true }] };
        return { rows: [], rowCount: exists ? 1 : 0 };
      }),
    } as unknown as PoolClient;
    await bootstrapEvaluationRole(client, "runtime_test");
    const statements = vi.mocked(client.query).mock.calls.map(([statement]) => String(statement));
    expect(statements.some((statement) => statement.includes("CREATE ROLE"))).toBe(!exists);
    expect(
      statements.some((statement) =>
        statement.includes("WITH INHERIT FALSE, SET TRUE, ADMIN FALSE"),
      ),
    ).toBe(!exists);
    expect(statements.some((statement) => statement.includes("ALTER ROLE"))).toBe(false);
  });

  it("不修复已有不安全身份，校验失败必须由调用事务回滚", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ safe: false }], rowCount: 1 })),
    } as unknown as PoolClient;
    await expect(bootstrapEvaluationRole(client, "runtime_test")).rejects.toMatchObject({
      code: "CONSTRAINT_VIOLATION",
    });
    expect(
      vi.mocked(client.query).mock.calls.map(([statement]) => String(statement)),
    ).not.toContainEqual(expect.stringMatching(/CREATE ROLE|ALTER ROLE|GRANT /u));
  });

  it("只使用事务内 SET LOCAL ROLE，不修改池连接的会话角色", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ role: "runtime_test" }] })),
    } as unknown as PoolClient;
    await setLocalEvaluationRole(client);
    expect(client.query).toHaveBeenLastCalledWith('SET LOCAL ROLE "runtime_test_evaluation"');
  });
});
