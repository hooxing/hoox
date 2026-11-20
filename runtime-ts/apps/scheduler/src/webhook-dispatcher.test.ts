import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { WebhookDispatcher } from "./webhook-dispatcher.js";

function fakePool(row: Record<string, unknown>) {
  const updates: unknown[][] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("WITH candidate")) return { rows: [{ ...row }], rowCount: 1 };
      return { rows: [], rowCount: null };
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (_sql: string, values: unknown[]) => {
      updates.push(values);
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as Pool;
  return { pool, updates };
}

const item = {
  tenant_id: "tenant_a",
  id: "delivery_a",
  webhook_id: "webhook_a",
  event_id: "evt_a",
  event_type: "run.succeeded",
  endpoint_url: "https://127.0.0.1/hook",
  secret_ciphertext: { version: 1, nonce: "n", ciphertext: "c", authTag: "t" },
  payload: { id: "evt_a", type: "run.succeeded", data: {} },
  attempts: 1,
  claim_token: "claim_a",
};

describe("Webhook Dispatcher", () => {
  it("拒绝私网目标并记录有界重试状态", async () => {
    const { pool, updates } = fakePool(item);
    const cipher = { decrypt: vi.fn(() => "secret") };
    const dispatcher = new WebhookDispatcher(pool, cipher as never, "scheduler_a");

    await expect(dispatcher.runOne()).resolves.toBe(true);

    expect(cipher.decrypt).not.toHaveBeenCalled();
    expect(updates[0]?.[3]).toBe("pending");
    expect(updates[0]?.[4]).toBe("delivery_failed");
    expect(updates[0]?.[5]).toBeGreaterThan(0);
  });

  it("重试上限后将投递标记为停用并保留原因", async () => {
    const { pool, updates } = fakePool({ ...item, attempts: 12 });
    const dispatcher = new WebhookDispatcher(pool, { decrypt: vi.fn() } as never, "scheduler_a");

    await expect(dispatcher.runOne()).resolves.toBe(true);

    expect(updates[0]?.[3]).toBe("disabled");
    expect(updates[0]?.[4]).toBe("delivery_failed");
    expect(updates[0]?.[5]).toBe(0);
  });
});
