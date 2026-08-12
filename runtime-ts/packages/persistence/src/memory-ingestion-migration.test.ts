import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function migration(direction: "up" | "down") {
  return readFile(
    new URL(`../migrations/0045_memory_ingestion_outbox.${direction}.sql`, import.meta.url),
    "utf8",
  );
}

describe("Mem0 异步记忆持久化契约", () => {
  it("Outbox 使用 Tenant RLS、Run 幂等、事件状态和 claim fencing", async () => {
    const up = await migration("up");
    expect(up).toContain("CREATE TABLE memory_ingestion_outbox");
    expect(up).toContain("PRIMARY KEY (tenant_id, run_id)");
    expect(up).toContain("UNIQUE (tenant_id, attempt_id)");
    expect(up).toContain("source_through_sequence");
    expect(up).toContain("provider_event_id uuid");
    expect(up).toContain("claim_generation");
    expect(up).toContain("claim_expires_at");
    expect(up).toContain("ENABLE ROW LEVEL SECURITY");
    expect(up).toContain("FORCE ROW LEVEL SECURITY");
    expect(up).not.toMatch(/CREATE (?:FUNCTION|TRIGGER|PROCEDURE)/u);
  });

  it("down 在任何记忆事实存在时拒绝破坏性回退", async () => {
    const down = await migration("down");
    expect(down).toContain("memory ingestion outbox down requires an empty table");
    expect(down.indexOf("RAISE EXCEPTION")).toBeLessThan(
      down.indexOf("DROP TABLE memory_ingestion_outbox"),
    );
  });

  it("Runtime ACL 只开放必要的读取、插入与状态推进列", async () => {
    const bootstrap = await readFile(new URL("./role-bootstrap.ts", import.meta.url), "utf8");
    expect(bootstrap).toContain('["memory_ingestion_outbox", new Set(["SELECT", "INSERT"])]');
    expect(bootstrap).toContain("hasMemoryIngestionState");
    expect(bootstrap).toContain("state,provider_event_id,claim_token,claim_generation,claimed_by");
    expect(bootstrap).not.toMatch(/GRANT (?:DELETE|TRUNCATE)[^;]*memory_ingestion_outbox/u);
  });
});
