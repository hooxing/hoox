import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (direction: "up" | "down") =>
  readFileSync(
    new URL(`../migrations/0047_sandbox_provider_identity.${direction}.sql`, import.meta.url),
    "utf8",
  );

describe("Sandbox Provider 身份迁移", () => {
  it("覆盖所有持久恢复边界并把唯一性与外键扩展到 provider_key", () => {
    const sql = migration("up");
    for (const table of [
      "sandbox_registry",
      "cleanup_outbox",
      "sandbox_lifecycle_unknown",
      "waiting_recovery_checkpoints",
      "thread_sandbox_sessions",
      "sandbox_lifecycle_effects",
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table}`);
    }
    expect(sql).toContain("CHECK (provider_key IN ('cube','e2b'))");
    expect(sql).toContain("UNIQUE (tenant_id,provider_key,provider_sandbox_id)");
    expect(sql).toContain(
      "FOREIGN KEY (tenant_id,attempt_id,registry_id,provider_key,provider_sandbox_id)",
    );
    expect(sql).toContain("UNIQUE (provider_key,provider_sandbox_id)");
  });

  it("存在非 Cube 事实时拒绝 down", () => {
    const sql = migration("down");
    expect(sql).toContain("provider_key <> 'cube'");
    expect(sql).toContain("非 Cube Sandbox Provider 已产生事实，拒绝破坏性回退");
  });
});
