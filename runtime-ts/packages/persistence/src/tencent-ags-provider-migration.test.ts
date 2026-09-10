import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrations } from "./migrations.js";

const tables = [
  "sandbox_registry",
  "cleanup_outbox",
  "sandbox_lifecycle_unknown",
  "waiting_recovery_checkpoints",
  "thread_sandbox_sessions",
  "sandbox_lifecycle_effects",
];
const source = (direction: string) =>
  readFileSync(
    new URL(`../migrations/0063_tencent_ags_provider.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("AGS Provider 持久化迁移", () => {
  it("已执行迁移在不同平台保持相同原始字节校验和", async () => {
    const migration = (await loadMigrations()).find((entry) => entry.version === 63);
    expect(migration?.checksum).toBe(
      "685f7c1fd5159f135489d985c477fa2d714e2a14c5076672917bf0c73b4f3a06",
    );
  });

  it("只扩展受限 key，不重写已有 Provider 身份和外键", () => {
    const sql = source("up");
    for (const table of tables) expect(sql).toContain(`ALTER TABLE ${table}`);
    expect(sql.match(/CHECK \(provider_key IN \('cube','e2b','tencent-ags'\)\)/gu)).toHaveLength(6);
    expect(sql).not.toMatch(/UPDATE|DROP TABLE|FOREIGN KEY/u);
  });
  it("任一边界存在 AGS 事实时必须在缩减约束前拒绝回退", () => {
    const sql = source("down");
    for (const table of tables)
      expect(sql).toContain(`EXISTS (SELECT 1 FROM ${table} WHERE provider_key = 'tencent-ags')`);
    expect(sql.indexOf("RAISE EXCEPTION")).toBeLessThan(sql.indexOf("ALTER TABLE"));
  });
});
