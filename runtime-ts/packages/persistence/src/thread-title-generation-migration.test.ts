import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pendingHistoryDirectoryName } from "./pg-thread-title-generation.js";

async function migration(direction: "up" | "down") {
  return readFile(
    new URL(`../migrations/0035_thread_title_generation.${direction}.sql`, import.meta.url),
    "utf8",
  );
}

describe("低成本 Thread 标题持久化契约", () => {
  it("Outbox 使用 Tenant RLS、单 Thread 幂等与 claim fencing", async () => {
    const up = await migration("up");
    expect(up).toContain("CREATE TABLE thread_title_generation_outbox");
    expect(up).toContain("PRIMARY KEY (tenant_id, thread_id)");
    expect(up).toContain("source_receipt_id");
    expect(up).toContain("claim_generation");
    expect(up).toContain("claim_expires_at");
    expect(up).toContain("ENABLE ROW LEVEL SECURITY");
    expect(up).toContain("FORCE ROW LEVEL SECURITY");
    expect(up).toContain("naming_state IN ('pending', 'ready', 'fallback')");
  });

  it("down 拒绝在 pending 目录仍存在时破坏标题就绪协议", async () => {
    const down = await migration("down");
    expect(down).toContain("requires no pending history directories");
    expect(down.indexOf("RAISE EXCEPTION")).toBeLessThan(
      down.indexOf("DROP TABLE IF EXISTS thread_title_generation_outbox"),
    );
  });

  it("pending 目录使用内部稳定 Thread 身份且不会进入语义时间目录格式", () => {
    expect(pendingHistoryDirectoryName("thread_abc-123")).toBe("pending-thread_abc-123");
    expect(() => pendingHistoryDirectoryName("x".repeat(256))).toThrow("pending 历史目录");
  });

  it("Runtime 最小 ACL 允许 Outbox 状态推进和 pending 目录最终命名", async () => {
    const bootstrap = await readFile(new URL("./role-bootstrap.ts", import.meta.url), "utf8");
    expect(bootstrap).toContain("thread_title_generation_outbox");
    expect(bootstrap).toContain("directory_name,naming_state,first_file_at");
    expect(bootstrap).toContain("claim_token,claim_generation,claimed_by,claim_expires_at");
    expect(bootstrap.match(/"thread_title_generation_outbox"/gu)).toHaveLength(3);
    expect(bootstrap.match(/"directory_name"/gu)).toHaveLength(1);
  });
});
