import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runRunTrajectoryRetentionPass } from "./run-trajectory-retention.js";

describe("run trajectory retention coordinator", () => {
  it("restart 后重新枚举所有租户，失败租户留待下次重试", async () => {
    const coordinator = {
      query: vi.fn(async () => ({
        rows: [{ tenant_id: "tenant_a" }, { tenant_id: "tenant_b" }],
      })),
    } as unknown as Pool;
    const firstStore = {
      cleanupExpired: vi.fn(async (tenantId: string) => {
        if (tenantId === "tenant_b") throw new Error("blob delete failed");
        return 1;
      }),
    };
    const onFailure = vi.fn();
    await expect(runRunTrajectoryRetentionPass(coordinator, firstStore, onFailure)).resolves.toBe(
      1,
    );
    expect(onFailure).toHaveBeenCalledTimes(1);

    const restartedStore = { cleanupExpired: vi.fn(async () => 1) };
    await expect(runRunTrajectoryRetentionPass(coordinator, restartedStore)).resolves.toBe(2);
    expect(restartedStore.cleanupExpired).toHaveBeenCalledWith("tenant_a", 100);
    expect(restartedStore.cleanupExpired).toHaveBeenCalledWith("tenant_b", 100);
    expect(coordinator.query).toHaveBeenCalledTimes(2);
  });
});
