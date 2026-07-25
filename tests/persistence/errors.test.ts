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
});
