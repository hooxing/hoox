import { describe, expect, it } from "vitest";
import { getPostgreSqlDiagnosticCause, mapPersistenceError } from "./errors.js";

describe("PostgreSQL 迁移错误诊断", () => {
  it("保留 SQLSTATE 与 message，但不暴露驱动 detail 或连接信息", () => {
    const mapped = mapPersistenceError(
      {
        code: "42501",
        message: "permission denied for table agent_definitions",
        detail: "包含业务行值",
        query: "包含 SQL 文本",
        connectionString: "postgresql://user:secret@database/private",
      },
      "执行向前迁移",
    );

    expect(mapped.code).toBe("UNEXPECTED");
    expect(getPostgreSqlDiagnosticCause(mapped)).toEqual({
      kind: "postgresql",
      code: "42501",
      message: "permission denied for table agent_definitions",
    });
    expect(JSON.stringify(mapped.cause)).not.toContain("业务行值");
    expect(JSON.stringify(mapped.cause)).not.toContain("secret");
    expect(JSON.stringify(mapped.cause)).not.toContain("SQL 文本");
  });
});
