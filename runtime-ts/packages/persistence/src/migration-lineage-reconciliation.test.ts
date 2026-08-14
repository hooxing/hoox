import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadMigrations, reconcileKnownMigrationLineages } from "./migrations.js";

const legacyMemoryRecord = Object.freeze({
  version: 43,
  name: "memory_ingestion_outbox",
  checksum: "175f914a06d706fe40fa9ef838235bf348513a4ebd65fdcdb7e39371064688c5",
});

describe("已发布迁移谱系兼容", () => {
  it("把已知 0043 Mem0 历史记录原子换号到当前 0045", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({ rowCount: 1 }));
    await reconcileKnownMigrationLineages(
      { query } as unknown as Pick<PoolClient, "query">,
      [legacyMemoryRecord],
      await loadMigrations(),
    );
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([
      43,
      "memory_ingestion_outbox",
      legacyMemoryRecord.checksum,
      45,
      "memory_ingestion_outbox",
      "8623caa030ded4431fac618166d9502d2df7c60b39aba422cebc14f55d57cbf5",
    ]);
  });

  it("未知 checksum 不修复，保留后续严格校验失败语义", async () => {
    const query = vi.fn();
    await reconcileKnownMigrationLineages(
      { query } as unknown as Pick<PoolClient, "query">,
      [{ ...legacyMemoryRecord, checksum: "0".repeat(64) }],
      await loadMigrations(),
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("目标版本已占用时拒绝改写历史", async () => {
    await expect(
      reconcileKnownMigrationLineages(
        { query: vi.fn() } as unknown as Pick<PoolClient, "query">,
        [legacyMemoryRecord, { version: 45, name: "unexpected", checksum: "1".repeat(64) }],
        await loadMigrations(),
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_MISMATCH" });
  });
});
