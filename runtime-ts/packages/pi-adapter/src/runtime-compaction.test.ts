import { describe, expect, it } from "vitest";
import {
  buildRuntimeCompactionReplacement,
  decideRuntimeCompaction,
  providerVisibleThreadHistoryTokens,
  serializeRuntimeCompactionSource,
} from "./runtime-compaction.js";
import { threadActiveHistoryDigest, type ThreadActiveHistoryV1 } from "./thread-history.js";

const tokenizer = {
  identity: "test-byte-v1",
  countTokens: (text: string) => Buffer.byteLength(text, "utf8"),
};

function history(messages: ThreadActiveHistoryV1["messages"]): ThreadActiveHistoryV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    projectionSchemaVersion: 1 as const,
    throughSequence: messages.at(-1)?.sequence ?? 0,
    messages,
  };
  return { ...unsigned, digest: threadActiveHistoryDigest(unsigned) };
}

describe("Runtime compaction 纯策略", () => {
  it("审计专用 workspace_unchanged 不参与 Provider token 或压缩输入", () => {
    const visible = {
      sequence: 1,
      role: "user" as const,
      text: "真实用户输入",
      timestamp: 1,
    };
    const auditOnly = {
      sequence: 2,
      role: "runtimeNotice" as const,
      code: "workspace_unchanged" as const,
      text: "上一运行未产生 Workspace revision。",
      timestamp: 2,
    };
    expect(providerVisibleThreadHistoryTokens([visible, auditOnly], tokenizer)).toBe(
      providerVisibleThreadHistoryTokens([visible], tokenizer),
    );
    const serialized = serializeRuntimeCompactionSource({
      sourceFromSequence: 1,
      sourceThroughSequence: 2,
      prefix: [visible, auditOnly],
      retainedSuffix: [],
    });
    expect(serialized).toContain("真实用户输入");
    expect(serialized).not.toContain("workspace_unchanged");
    expect(serialized).not.toContain("Workspace revision");
  });

  it("从真实 user 边界保留完整尾部，不切断 tool call/result provenance", () => {
    const source = history([
      { sequence: 1, role: "user", text: "旧目标".repeat(200), timestamp: 1 },
      {
        sequence: 2,
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }],
        api: "openai-completions",
        provider: "test",
        model: "m",
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        sequence: 4,
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        text: "事实",
        isError: false,
        timestamp: 3,
      },
      { sequence: 5, role: "user", text: "最近用户原文", timestamp: 4 },
    ]);
    const decision = decideRuntimeCompaction(
      source,
      { schemaVersion: 1, softLimitTokens: 10, targetTokens: 9, recentUserTokens: 1 },
      tokenizer,
    );
    expect(decision.outcome).toBe("compact");
    if (decision.outcome !== "compact") return;
    expect(decision.source.prefix.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(decision.source.retainedSuffix).toEqual([
      { sequence: 5, role: "user", text: "最近用户原文", timestamp: 4 },
    ]);
  });

  it("replacement 保留真实 user 原文并以独立低信任 handoff kind 替换前缀", () => {
    const source = history([
      { sequence: 1, role: "user", text: "旧".repeat(100), timestamp: 1 },
      {
        sequence: 2,
        role: "assistant",
        content: [{ type: "text", text: "旧答复" }],
        api: "openai-completions",
        provider: "test",
        model: "m",
        stopReason: "stop",
        timestamp: 2,
      },
      { sequence: 3, role: "user", text: "逐字保留🙂", timestamp: 3 },
    ]);
    const buildPolicy = {
      schemaVersion: 1 as const,
      softLimitTokens: 3_000,
      targetTokens: 2_000,
      recentUserTokens: 1,
    };
    const decision = decideRuntimeCompaction(
      source,
      { ...buildPolicy, softLimitTokens: 10, targetTokens: 9 },
      tokenizer,
    );
    expect(decision.outcome).toBe("compact");
    if (decision.outcome !== "compact") return;
    const built = buildRuntimeCompactionReplacement({
      previousHistory: source,
      source: decision.source,
      checkpointId: "checkpoint-1",
      summary: "旧事实摘要",
      timestamp: 9,
      policy: buildPolicy,
      tokenizer,
    });
    expect(built.outcome).toBe("ready");
    if (built.outcome !== "ready") return;
    expect(built.history.messages[0]).toMatchObject({
      role: "compactionHandoff",
      sourceFromSequence: 1,
      sourceThroughSequence: 2,
    });
    expect(built.history.messages[1]).toMatchObject({ role: "user", text: "逐字保留🙂" });
    expect(providerVisibleThreadHistoryTokens(built.history.messages, tokenizer)).toBe(
      built.tokensAfter,
    );
  });
});
