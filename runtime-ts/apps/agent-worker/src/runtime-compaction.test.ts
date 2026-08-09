import { sha256Digest } from "@cube-runtime/domain";
import {
  type ThreadActiveHistoryV1,
  type TrustedPiModelContextCapability,
  threadActiveHistoryDigest,
} from "@cube-runtime/pi-adapter";
import type {
  ThreadContextCompactionCommitPort,
  ThreadContinuityMetricsPort,
} from "@cube-runtime/run-contracts";
import { describe, expect, it, vi } from "vitest";
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

  it("首轮输入会占用目标余量，并在旧历史单独未达阈值时提前压缩", async () => {
    const commit = vi.fn(async (input) => ({
      outcome: "applied" as const,
      checkpointId: input.checkpointId,
      windowNumber: 1,
      checkpointFactSequence: input.replacement.throughSequence + 1,
    }));
    const compact = vi.fn(async () => "短摘要");
    const coordinator = new RuntimeCompactionCoordinator(
      {
        enabled: true,
        path: "remote",
        softLimitPercent: 20,
        targetPercent: 19,
        recentUserTokens: 1,
        maxOutputTokens: 100,
        timeoutMs: 1_000,
      },
      model,
      {} as never,
      modelContext,
      { commit },
      { compact },
    );
    const old = active(
      [
        { sequence: 1, role: "user", text: "单用户目标", timestamp: 1 },
        {
          sequence: 2,
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(1_100) }],
          api: "openai-completions",
          provider: "test",
          model: "test-model",
          stopReason: "stop",
          timestamp: 2,
        },
      ],
      2,
    );
    const withoutIncoming = await coordinator.prepare({
      fence,
      attemptId: "attempt-without-incoming",
      compatibilityDigest: "b".repeat(64),
      history: old,
    });
    expect(withoutIncoming).toBe(old);
    expect(compact).not.toHaveBeenCalled();

    const prepared = await coordinator.prepare({
      fence,
      attemptId: "attempt-with-incoming",
      compatibilityDigest: "b".repeat(64),
      history: old,
      additionalVisibleTokens: 1_000,
    });
    expect(compact).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(prepared.messages.map((message) => message.role)).toEqual(["user", "compactionHandoff"]);
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

  it("local compactor 忽略 thinking 并接受同一终态中的最终正文", async () => {
    const commit = vi.fn(async (input) => ({
      outcome: "applied" as const,
      checkpointId: input.checkpointId,
      windowNumber: 1,
      checkpointFactSequence: input.replacement.throughSequence + 1,
    }));
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "done" };
      },
      result: async () => ({
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "内部推理不进入摘要" },
          { type: "text", text: "可用交接摘要" },
        ],
      }),
    };
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
      { stream: vi.fn(() => stream) } as never,
      modelContext,
      { commit },
    );
    const old = active(
      [
        { sequence: 1, role: "user", text: "目标", timestamp: 1 },
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
      ],
      2,
    );

    const prepared = await coordinator.prepare({
      fence,
      attemptId: "attempt-thinking",
      compatibilityDigest: "e".repeat(64),
      history: old,
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(prepared.messages.at(-1)).toMatchObject({
      role: "compactionHandoff",
      text: "可用交接摘要",
    });
  });

  it("local compactor 达到长度上限时用精简提示重试", async () => {
    const results = [
      {
        stopReason: "length",
        content: [{ type: "text", text: "第一次截断摘要" }],
      },
      {
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "忽略" },
          { type: "text", text: "第二次完整摘要" },
        ],
      },
    ];
    const streamCall = vi.fn((_model: unknown, _context: unknown, _options: unknown) => {
      const result = results.shift();
      if (result === undefined) throw new Error("unexpected extra compaction call");
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done" };
        },
        result: async () => result,
      };
    });
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
        { sequence: 1, role: "user", text: "目标", timestamp: 1 },
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
      ],
      2,
    );

    const prepared = await coordinator.prepare({
      fence,
      attemptId: "attempt-length-retry",
      compatibilityDigest: "f".repeat(64),
      history: old,
    });

    expect(streamCall).toHaveBeenCalledTimes(2);
    expect(streamCall.mock.calls[1]?.[1]).toMatchObject({
      systemPrompt: expect.stringContaining("立即输出更短的最终交接摘要"),
    });
    expect(prepared.messages.at(-1)).toMatchObject({
      role: "compactionHandoff",
      text: "第二次完整摘要",
    });
  });

  it("两次都达到长度上限时使用最长的可用正文", async () => {
    const results = [
      { stopReason: "length", content: [{ type: "text", text: "较完整的截断摘要" }] },
      { stopReason: "length", content: [{ type: "text", text: "短摘要" }] },
    ];
    const streamCall = vi.fn((_model: unknown, _context: unknown, _options: unknown) => {
      const result = results.shift();
      if (result === undefined) throw new Error("unexpected extra compaction call");
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done" };
        },
        result: async () => result,
      };
    });
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
        { sequence: 1, role: "user", text: "目标", timestamp: 1 },
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
      ],
      2,
    );

    const prepared = await coordinator.prepare({
      fence,
      attemptId: "attempt-length-fallback",
      compatibilityDigest: "1".repeat(64),
      history: old,
    });

    expect(prepared.messages.at(-1)).toMatchObject({
      role: "compactionHandoff",
      text: "较完整的截断摘要",
    });
  });

  it("尚未撞硬窗口时 compactor 失败仍保留旧 history", async () => {
    const old = active(
      [
        { sequence: 1, role: "user", text: "目标", timestamp: 1 },
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
      ],
      2,
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
      { commit: vi.fn() },
      { compact: vi.fn(async () => Promise.reject(new Error("provider failed"))) },
    );

    await expect(
      coordinator.prepare({
        fence,
        attemptId: "attempt-soft-failure",
        compatibilityDigest: "3".repeat(64),
        history: old,
      }),
    ).resolves.toBe(old);
  });

  it("投影已撞硬窗口时不再静默吞掉 compactor 失败", async () => {
    const old = active(
      [
        { sequence: 1, role: "user", text: "目标", timestamp: 1 },
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
      ],
      2,
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
      { commit: vi.fn() },
      { compact: vi.fn(async () => Promise.reject(new Error("provider failed"))) },
    );

    await expect(
      coordinator.prepare({
        fence,
        attemptId: "attempt-hard-window",
        compatibilityDigest: "2".repeat(64),
        history: old,
        availableHistoryTokens: 2_000,
      }),
    ).rejects.toThrow("硬窗口准入前生成失败");
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

  it("checkpoint 提交冲突时返回完全相同的旧 history", async () => {
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
