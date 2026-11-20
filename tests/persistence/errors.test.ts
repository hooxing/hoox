import { describe, expect, it } from "vitest";
import { mapPersistenceError } from "../../runtime-ts/packages/persistence/src/errors.js";
import { TransactionCommitUnknownError } from "../../runtime-ts/packages/persistence/src/postgres.js";

describe("持久层公开错误脱敏", () => {
  it("不保留原始 pg error、SQL 或连接信息", () => {
    const original = Object.assign(new Error("包含 SQL 与秘密连接串"), { code: "23505" });
    const mapped = mapPersistenceError(original, "创建任务");
    expect(mapped).toMatchObject({ code: "CONFLICT", message: "创建任务发生并发冲突" });
    expect(mapped.cause).toEqual({ code: "23505" });
    expect(mapped).not.toHaveProperty("original");
    expect(JSON.stringify(mapped)).not.toContain(original.message);
    expect(mapped.message).not.toContain(original.message);
  });

  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ECONNRESET",
    "ECONNABORTED",
    "EPIPE",
  ])("将系统连接错误 %s 映射为脱敏 UNAVAILABLE", (code) => {
    const mapped = mapPersistenceError(
      Object.assign(new Error("包含主机、端口和连接串"), { code }),
      "启动探针",
    );
    expect(mapped).toMatchObject({ code: "UNAVAILABLE", message: "启动探针暂时不可用" });
    expect("cause" in mapped).toBe(false);
  });

  it("将 COMMIT 结果未知通过共享错误边界映射为脱敏 UNAVAILABLE", () => {
    const original = new TransactionCommitUnknownError({
      cause: new Error("包含数据库地址的驱动错误"),
    });
    const mapped = mapPersistenceError(original, "预留 Blob");

    expect(mapped).toMatchObject({ code: "UNAVAILABLE", message: "预留 Blob暂时不可用" });
    expect("cause" in mapped).toBe(false);
    expect(mapped.message).not.toContain("数据库地址");
  });
});

describe("SQLSTATE 诊断脱敏", () => {
  it("只从原始异常链提取合法 SQLSTATE，不保留异常细节", () => {
    const original = Object.assign(new Error("detail: private host; SQL: SELECT secret"), {
      code: "42501",
      detail: "private detail",
      query: "SELECT secret",
    });
    const mapped = mapPersistenceError(original, "读取租户");
    expect(mapped.cause).toEqual({ code: "42501" });
    expect(Object.keys(mapped)).not.toContain("cause");
    expect(JSON.stringify(mapped)).not.toMatch(/private host|private detail|SELECT secret/u);
    expect(JSON.stringify(mapped.cause)).toBe('{"code":"42501"}');
  });

  it("忽略不是 5 位 SQLSTATE 的驱动 code", () => {
    const mapped = mapPersistenceError(
      Object.assign(new Error("hidden"), { code: "ECONNRESET" }),
      "探针",
    );
    expect("cause" in mapped).toBe(false);
  });
});
