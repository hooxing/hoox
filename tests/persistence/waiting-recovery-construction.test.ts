import { describe, expect, it } from "vitest";
import * as recoveryModule from "../../runtime-ts/packages/persistence/src/pg-waiting-recovery.js";
import type { Pool } from "../../runtime-ts/packages/persistence/src/postgres.js";

const unusedPool = Object.freeze({}) as Pool;
const unusedAdapter = {
  async execute(): Promise<{ outcome: "unknown" }> {
    return { outcome: "unknown" };
  },
};
const unusedVerifier = {
  verify(): boolean {
    return false;
  },
};

describe("waiting recovery 受信构造边界", () => {
  it("不导出实现类，且运行时不能替换私有执行路径", () => {
    const store = recoveryModule.createTestingPgWaitingRecoveryStore(
      unusedPool,
      unusedAdapter,
      unusedVerifier,
    );
    expect("PgWaitingRecoveryStore" in recoveryModule).toBe(false);
    expect("completeEffect" in store).toBe(false);
    expect(Reflect.get(store, "constructor")).toBeUndefined();
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.isFrozen(Object.getPrototypeOf(store))).toBe(true);
    expect(Reflect.set(store, "execute", async () => ({ outcome: "completed" }))).toBe(false);
  });

  it("testing factory 在 production 环境拒绝构造", () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() =>
        recoveryModule.createTestingPgWaitingRecoveryStore(
          unusedPool,
          { ...unusedAdapter },
          { ...unusedVerifier },
        ),
      ).toThrow("生产路径禁止");
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
