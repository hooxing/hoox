import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function migration(version: string, direction: "up" | "down") {
  return readFile(new URL(`../migrations/${version}.${direction}.sql`, import.meta.url), "utf8");
}

describe("0018-0020 Thread 串行队列迁移契约", () => {
  it("0018 建立每 Thread 唯一 head、单 active Run 与完整 writer shape", async () => {
    const up = await migration("0018_thread_execution_heads", "up");
    expect(up).toContain("PRIMARY KEY (tenant_id, thread_id)");
    expect(up).toContain("thread_execution_heads_active_run_idx");
    expect(up).toContain("writer_epoch bigint NOT NULL DEFAULT 0");
    expect(up).toContain("context_through_sequence bigint");
    expect(up).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("0019 保证 receipt 正文不可缺失、FIFO 唯一且只有一个 active queue item", async () => {
    const up = await migration("0019_thread_follow_up_queue", "up");
    expect(up).toContain("UNIQUE (tenant_id, thread_id, client_request_id)");
    expect(up).toContain("octet_length(input_text) = body_size_bytes");
    expect(up).toContain("thread_follow_up_queue_one_active_idx");
    expect(up).toContain("WHERE state = 'active'");
    expect(up).toContain("ADD COLUMN context_through_sequence bigint");
    expect(up.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
  });

  it("0020 只保存 base/result 关系，并按 20→19→18 顺序可逆", async () => {
    const up = await migration("0020_run_workspace_results", "up");
    const down20 = await migration("0020_run_workspace_results", "down");
    const down19 = await migration("0019_thread_follow_up_queue", "down");
    const down18 = await migration("0018_thread_execution_heads", "down");
    expect(up).toContain("'committed', 'unchanged', 'failed_before_commit'");
    expect(up).toContain("run_execution_inputs_result_scope_unique");
    expect(up).toContain("FOREIGN KEY (tenant_id, workspace_id, result_revision_id)");
    expect(down20.indexOf("DROP TABLE run_workspace_results")).toBeLessThan(
      down20.indexOf("DROP CONSTRAINT run_execution_inputs_result_scope_unique"),
    );
    expect(down19.indexOf("DROP TABLE thread_follow_up_queue")).toBeLessThan(
      down19.indexOf("DROP TABLE thread_input_receipts"),
    );
    expect(down18).toContain("DROP TABLE thread_execution_heads");
  });

  it("0021 为 Thread Context Attempt 外键补齐完全匹配的唯一键", async () => {
    const up = await migration("0021_thread_context_stream", "up");
    expect(up).toContain("execution_attempts_context_scope_unique");
    expect(up).toContain("UNIQUE (tenant_id,attempt_id,run_id,thread_id)");
  });
});
