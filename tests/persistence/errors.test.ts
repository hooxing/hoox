import { describe, expect, it } from "vitest";
import { mapPersistenceError } from "../../runtime-ts/packages/persistence/src/errors.js";

describe("持久层公开错误脱敏", () => {
  it("不保留原始 pg error、SQL 或连接信息", () => {
    const original = Object.assign(new Error("包含 SQL 与秘密连接串"), { code: "23505" });
    const mapped = mapPersistenceError(original, "创建任务");
    expect(mapped).toMatchObject({ code: "CONFLICT", message: "创建任务发生并发冲突" });
    expect("cause" in mapped).toBe(false);
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
});
