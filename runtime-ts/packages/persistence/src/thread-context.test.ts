import { readFile } from "node:fs/promises";
import { sha256Digest } from "@hoox/domain";
import { describe, expect, it } from "vitest";
import type { BlobStore } from "./blob-store.js";
import {
  projectAssistantHistoryMessage,
  readThreadContextBody,
  ThreadContextBodyPersistence,
} from "./thread-context.js";

describe("Thread Context body persistence", () => {
  it("小正文内联，大工具输出必须先形成 exact Stable Blob identity", async () => {
    const calls: Array<{ readonly body: Uint8Array; readonly sha256: string }> = [];
    const persistence = new ThreadContextBodyPersistence(
      {
        persistTrace: async (input) => {
          calls.push({ body: input.body, sha256: input.sha256 });
          return {
            outcome: "persisted",
            referenceId: "thread-context-ref",
            blob: {
              kind: "stable",
              tenantId: input.tenantId,
              purpose: "trace",
              sha256: input.sha256,
              size: input.body.byteLength,
              incarnationId: "11111111-1111-4111-8111-111111111111",
              physicalObjectKey: "stable/trace/body",
            },
          };
        },
      },
      256,
    );

    const small = await persistence.persist({
      tenantId: "tenant-a" as Parameters<typeof persistence.persist>[0]["tenantId"],
      idempotencyKey: "small",
      value: { text: "ok" },
    });
    expect(small.storage).toBe("inline");
    expect(calls).toHaveLength(0);

    const large = await persistence.persist({
      tenantId: "tenant-a" as Parameters<typeof persistence.persist>[0]["tenantId"],
      idempotencyKey: "large",
      value: { text: "x".repeat(2_000) },
    });
    const persistedCall = calls.at(0);
    if (persistedCall === undefined) throw new Error("预期大正文已写入 Trace Blob");
    expect(large).toEqual({
      storage: "blob",
      referenceId: "thread-context-ref",
      sha256: sha256Digest(persistedCall.sha256),
      size: persistedCall.body.byteLength,
      incarnationId: "11111111-1111-4111-8111-111111111111",
      physicalObjectKey: "stable/trace/body",
    });

    const blobs = {
      getBytes: async (_scope: unknown, blob: { readonly physicalObjectKey: string }) => {
        expect(blob.physicalObjectKey).toBe("stable/trace/body");
        return persistedCall.body;
      },
    } as unknown as BlobStore;
    await expect(readThreadContextBody("tenant-a", large, blobs)).resolves.toEqual({
      text: "x".repeat(2_000),
    });

    const corruptBlobs = {
      getBytes: async () => Buffer.from('{"text":"corrupt"}', "utf8"),
    } as unknown as BlobStore;
    await expect(readThreadContextBody("tenant-a", large, corruptBlobs)).rejects.toThrow(
      "Blob body 完整性校验失败",
    );
  });

  it("bigint 游标转成传输字符串后仍按数据库数值列排序", async () => {
    const expectations = [
      ["./thread-context.ts", "ORDER BY thread_context_entries.sequence"],
      ["./thread-context.ts", "ORDER BY thread_context_compaction_checkpoints.window_number"],
      ["./pg-thread-input.ts", "ORDER BY thread_input_receipt_events.event_sequence"],
      ["./pg-thread-run-queue.ts", "ORDER BY thread_input_receipts.input_sequence"],
      ["./pg-waiting-recovery.ts", "ORDER BY runtime_rollout_entries.sequence"],
      ["./thread-sandbox-session.ts", "ORDER BY thread_sandbox_sessions.generation"],
    ] as const;

    for (const [relativePath, qualifiedOrder] of expectations) {
      const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
      expect(source).toContain(qualifiedOrder);
    }
  });

  it("展示 phase 不进入 Active History 投影", () => {
    expect(
      projectAssistantHistoryMessage(
        7,
        {
          role: "assistant",
          text: "最终答复",
          content: [{ type: "text", text: "最终答复" }],
          api: "openai-completions",
          provider: "test",
          model: "test-model",
          stopReason: "stop",
          timestamp: 123,
          phase: "final_answer",
        },
        100,
      ),
    ).toEqual({
      sequence: 7,
      role: "assistant",
      content: [{ type: "text", text: "最终答复" }],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
      stopReason: "stop",
      timestamp: 123,
    });
  });
});
