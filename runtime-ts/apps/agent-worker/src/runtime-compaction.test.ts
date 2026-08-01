import { describe, expect, it, vi } from "vitest";
import type {
  ThreadContextCompactionCommitPort,
  ThreadContinuityMetricsPort,
} from "@cube-runtime/run-contracts";
import { sha256Digest } from "@cube-runtime/domain";
import {
  threadActiveHistoryDigest,
  type ThreadActiveHistoryV1,
  type TrustedPiModelContextCapability,
} from "@cube-runtime/pi-adapter";
import { RuntimeCompactionCoordinator } from "./runtime-compaction.js";

const model = {
  id: "test-model",
  provider: "test",
  api: "openai-completions",
  contextWindow: 10_000,
  maxTokens: 1_000,
} as never;
const modelContext = {
  model,
  descriptor: {
    modelId: "test-model",
    contextWindow: 10_000,
    maxOutputTokens: 1_000,
    compatibilityHash: sha256Digest("a".repeat(64)),
  },
  tokenizer: {
    identity: "test-byte-v1",
    countTokens: (text: string) => Buffer.byteLength(text, "utf8"),
  },
  tokenizerProbe: 1,
} as TrustedPiModelContextCapability;
const fence = {
  scope: {
    tenantId: "tenant" as never,
    threadId: "thread" as never,
    runId: "run" as never,
    rootRunId: "run" as never,
    workspaceId: "workspace" as never,
  },
  runClaim: { token: "claim", epoch: 1, expiresAt: "2026-07-31T00:00:00.000Z" as never },
  workspaceLease: {
    rootRunId: "run" as never,
    epoch: 1,
    expiresAt: "2026-07-31T00:00:00.000Z" as never,
  },
};

function active(
  messages: ThreadActiveHistoryV1["messages"],
  through: number,
): ThreadActiveHistoryV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    projectionSchemaVersion: 1 as const,
    throughSequence: through,
    messages,
  };
  return { ...unsigned, digest: threadActiveHistoryDigest(unsigned) };
}

describe("RuntimeCompactionCoordinator", () => {
  it("未达到压缩阈值时仍记录 Provider 可见 token 基线", async () => {
    const record = vi.fn<ThreadContinuityMetricsPort["record"]>(async () => undefined);
    const history = active([{ sequence: 1, role: "user", text: "短历史", timestamp: 1 }], 1);
    const coordinator = new RuntimeCompactionCoordinator(
      {
        enabled: true,
        path: "local",
        softLimitPercent: 80,
        targetPercent: 50,
        recentUserTokens: 1,
        maxOutputTokens: 100,
        timeoutMs: 1_000,
      },
      model,
      {} as never,
      modelContext,
      { commit: vi.fn() },
      undefined,
      { record },
    );

    await expect(
      coordinator.prepare({
        fence,
        attemptId: "attempt-visible",
        compatibilityDigest: "a".repeat(64),
        history,
      }),
    ).resolves.toBe(history);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        observationId: "attempt-visible:context-visible:1",
        metricName: "context_visible_tokens",
        unit: "tokens",
      }),
    );
  });

  it("连续三次 checkpoint 都基于前一 replacement，并在 DB receipt 后推进在线 cursor", async () => {
    const commits: Parameters<ThreadContextCompactionCommitPort["commit"]>[0][] = [];
    const checkpoints: ThreadContextCompactionCommitPort = {
      commit: vi.fn(async (input) => {
        commits.push(input);
        return {
          outcome: "applied" as const,
          checkpointId: input.checkpointId,
          windowNumber: commits.length,
          checkpointFactSequence: input.replacement.throughSequence + 1,
        };
      }),
    };
    const coordinator = new RuntimeCompactionCoordinator(
      {
        enabled: true,
        path: "remote",
        softLimitPercent: 20,
        targetPercent: 10,
        recentUserTokens: 1,
        maxOutputTokens: 100,
        timeoutMs: 1_000,
      },
      model,
      {} as never,
      modelContext,
      checkpoints,
      { compact: vi.fn(async () => "短摘要") },
    );
    let history = active(
      [
        { sequence: 1, role: "user", text: "旧目标", timestamp: 1 },
        {
          sequence: 2,
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(2_500) }],
          api: "openai-completions",
          provider: "test",
          model: "test-model",
          stopReason: "stop",
          timestamp: 2,
        },
        { sequence: 3, role: "user", text: "用户原文-1", timestamp: 3 },
      ],
      3,
    );
    for (let window = 1; window <= 3; window += 1) {
      history = await coordinator.prepare({
        fence,
        attemptId: "attempt-1",
        compatibilityDigest: "b".repeat(64),
        history,
      });
      const latestCommit = commits.at(-1);
      if (latestCommit === undefined) throw new Error("预期 checkpoint commit");
      expect(history.throughSequence).toBe(latestCommit.replacement.throughSequence + 1);
      expect(history.messages[0]?.role).toBe("compactionHandoff");
      if (window < 3) {
        const next = history.throughSequence;
        history = active(
          [
            ...history.messages,
            {
              sequence: next + 1,
              role: "assistant",
              content: [{ type: "text", text: "y".repeat(2_500) }],
              api: "openai-completions",
              provider: "test",
              model: "test-model",
              stopReason: "stop",
              timestamp: next + 1,
            },
            {
              sequence: next + 2,
              role: "user",
              text: `用户原文-${window + 1}`,
              timestamp: next + 2,
            },
          ],
          next + 2,
        );
      }
    }
    expect(commits).toHaveLength(3);
    expect(commits.map((item) => item.replacement.messages[0]?.role)).toEqual([
      "compactionHandoff",
      "compactionHandoff",
      "compactionHandoff",
    ]);
    const persistedLatest = commits.at(-1)?.replacement;
    if (persistedLatest === undefined) throw new Error("最新 replacement 缺失");
    const restartedUnsigned = {
      schemaVersion: 1 as const,
      projectionSchemaVersion: 1 as const,
      throughSequence: history.throughSequence,
      messages: persistedLatest.messages,
    };
    expect(threadActiveHistoryDigest(restartedUnsigned)).toBe(history.digest);
  });

  it("local compactor 的 Provider 请求固定 tools=[] 且禁用 retry", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "start" };
        yield { type: "done" };
      },
      result: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "本地交接摘要" }],
      }),
    };
    const streamCall = vi.fn((_model: unknown, _context: unknown, _options: unknown) => stream);
    const coordinator = new RuntimeCompactionCoordinator(
      {
        enabled: true,
        path: "local",
        softLimitPercent: 20,
        targetPercent: 10,
        recentUserTokens: 1,
        maxOutputTokens: 100,
        timeoutMs: 1_000,
      },
      model,
      { stream: streamCall } as never,
      modelContext,
      {
        commit: vi.fn(async (input) => ({
          outcome: "applied" as const,
          checkpointId: input.checkpointId,
          windowNumber: 1,
          checkpointFactSequence: input.replacement.throughSequence + 1,
        })),
      },
    );
    const old = active(
      [
        { sequence: 1, role: "user", text: "旧", timestamp: 1 },
        {
          sequence: 2,
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(2_500) }],
          api: "openai-completions",
          provider: "test",
          model: "test-model",
          stopReason: "stop",
          timestamp: 2,
        },
        { sequence: 3, role: "user", text: "最近原文", timestamp: 3 },
      ],
      3,
    );
    await coordinator.prepare({
      fence,
      attemptId: "attempt-local",
      compatibilityDigest: "c".repeat(64),
      history: old,
    });
    expect(streamCall).toHaveBeenCalledOnce();
    expect(streamCall.mock.calls[0]?.[1]).toMatchObject({
      tools: [],
      systemPrompt: expect.stringContaining("低信任历史数据"),
    });
    expect(streamCall.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 100, maxRetries: 0 });
  });

  it("首轮前 checkpoint 越过 claim 已追加 tail 时不把当前 user 重复安装进 Session", async () => {
    const coordinator = new RuntimeCompactionCoordinator(
      {
        enabled: true,
        path: "remote",
        softLimitPercent: 20,
        targetPercent: 10,
        recentUserTokens: 1,
        maxOutputTokens: 100,
        timeoutMs: 1_000,
      },
      model,
      {} as never,
      modelContext,
      {
        commit: vi.fn(async (input) => ({
          outcome: "applied" as const,
          checkpointId: input.checkpointId,
          windowNumber: 1,
          // 中间两个 sequence 是 claim 已写入的 run_started + 当前 user_message。
          checkpointFactSequence: input.replacement.throughSequence + 3,
        })),
      },
      { compact: vi.fn(async () => "首轮前摘要") },
    );
    const predecessor = active(
      [
        { sequence: 1, role: "user", text: "旧 Run", timestamp: 1 },
        {
          sequence: 2,
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(2_500) }],
          api: "openai-completions",
          provider: "test",
          model: "test-model",
          stopReason: "stop",
          timestamp: 2,
        },
        { sequence: 3, role: "user", text: "上一条真实 user", timestamp: 3 },
      ],
      3,
    );
    const installed = await coordinator.prepare({
      fence,
      attemptId: "attempt-initial",
      compatibilityDigest: "d".repeat(64),
      history: predecessor,
    });
    expect(installed.throughSequence).toBe(3);
    expect(installed.messages.at(-1)).toMatchObject({
      role: "user",
      text: "上一条真实 user",
    });
    expect(JSON.stringify(installed.messages)).not.toContain("当前 Run user");
  });

  it("compactor 或 checkpoint 提交失败时返回完全相同的旧 history", async () => {
    const old = active(
      [
        { sequence: 1, role: "user", text: "旧", timestamp: 1 },
        {
          sequence: 2,
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(2_500) }],
          api: "openai-completions",
          provider: "test",
          model: "test-model",
          stopReason: "stop",
          timestamp: 2,
        },
        { sequence: 3, role: "user", text: "保留", timestamp: 3 },
      ],
      3,
    );
    const coordinator = new RuntimeCompactionCoordinator(
      {
        enabled: true,
        path: "remote",
        softLimitPercent: 20,
        targetPercent: 10,
        recentUserTokens: 1,
        maxOutputTokens: 100,
        timeoutMs: 1_000,
      },
      model,
      {} as never,
      modelContext,
      { commit: vi.fn(async () => ({ outcome: "conflict" as const })) },
      { compact: vi.fn(async () => "摘要") },
    );
    expect(
      await coordinator.prepare({
        fence,
        attemptId: "attempt-1",
        compatibilityDigest: "b".repeat(64),
        history: old,
      }),
    ).toBe(old);
  });
});
