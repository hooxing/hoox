import type { Pool } from "pg";
import { listRunTrajectoryCleanupTenants } from "@hoox/persistence";

export interface RunTrajectoryRetentionStore {
  cleanupExpired(tenantId: string, limit?: number): Promise<number>;
}

export async function runRunTrajectoryRetentionPass(
  coordinator: Pool,
  store: RunTrajectoryRetentionStore,
  onFailure: () => void = () => undefined,
): Promise<number> {
  const tenants = await listRunTrajectoryCleanupTenants(coordinator);
  let removed = 0;
  for (const tenantId of tenants) {
    try {
      for (let batch = 0; batch < 100; batch += 1) {
        const count = await store.cleanupExpired(tenantId, 100);
        removed += count;
        if (count < 100) break;
      }
    } catch {
      onFailure();
    }
  }
  return removed;
}
