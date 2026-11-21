import { sha256Digest } from "@hoox/domain";
import type { RuntimeAgentEvent } from "@hoox/pi-adapter";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentControlPersistencePort,
  AgentSessionFactoryPort,
  RuntimeMutation,
  WorkerAgentSessionPort,
} from "./ports.js";
import { RunWorker } from "./run-worker.js";
import {
  BlockingAgentSession,
  FakeCancellationPort,
  FakeClock,
  FakeExecutionPersistence,
  FakeRecoveryMetrics,
  FakeRevisionVerifier,
  FakeSandboxRegistry,
  FakeSessionFactory,
  FakeThreadContextBodies,
  fakeSeed,
  ScriptedAgentSession,
} from "./testing/fakes.js";

type SessionInput = Parameters<AgentSessionFactoryPort["create"]>[0];
const unknownOutcome = {
  kind: "recovery_required",
  code: "EXTERNAL_TOOL_RESULT_UNKNOWN",
} as const;
const unknownResult = {
  outcome: "recovery_required",
  code: "EXTERNAL_TOOL_RESULT_UNKNOWN",
} as const;
const toolCall = {
  callId: "call-after-unknown",
  toolName: "http__recovery_regression",
  argsDigest: sha256Digest("a".repeat(64)),
};

async function within<Value>(promise: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("交错屏障等待超时")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function harness(sessions: WorkerAgentSessionPort[], threadContextWriteEnabled = false) {
  const persistence = new FakeExecutionPersistence();
  const scope = persistence.addSeed(fakeSeed("external-tool-recovery-interleaving"));
  const sandboxes = new FakeSandboxRegistry();
  const factory = new FakeSessionFactory(sessions);
  const inputs: SessionInput[] = [];
  const create = factory.create.bind(factory);
  vi.spyOn(factory, "create").mockImplementation(async (input) => {
    inputs.push(input);
    return create(input);
  });
  let mailboxSequence = 0;
  const agentControl: AgentControlPersistencePort = {
    initializeRoot: async () => ({ outcome: "ready", conversations: [] }),
    spawn: async (input) => ({ outcome: "created", snapshot: input.snapshot }),
    queueFollowUp: async () => "created",
    startTurn: async () => "started",
    settleTurn: async () => "settled",
    appendMailbox: async () => ({ outcome: "created", sequence: ++mailboxSequence }),
    recordCommand: async () => "recorded",
  };
  const worker = new RunWorker(
    {
      persistence,
      sessions: factory,
      revisions: new FakeRevisionVerifier(),
      sandboxes,
      orphanSandboxes: sandboxes,
      cancellation: new FakeCancellationPort(),
      clock: new FakeClock(),
      metrics: new FakeRecoveryMetrics(),
      agentControl,
      ...(threadContextWriteEnabled ? { threadContextBodies: new FakeThreadContextBodies() } : {}),
    },
    {
      workerId: "worker-unknown-interleaving",
      leaseDurationMs: 30_000,
      heartbeatMs: 10_000,
      runTimeoutMs: 60_000,
      subagentsEnabled: true,
      threadContextWriteEnabled,
    },
  );
  return { worker, persistence, scope, inputs };
}

function concurrentHarness(threadContextWriteEnabled = false) {
  const root = new BlockingAgentSession();
  const child = new ScriptedAgentSession([]);
  const execution = harness([root, child], threadContextWriteEnabled);
  const rootStarted = Promise.withResolvers<void>();
  const childStarted = Promise.withResolvers<void>();
  const triggerUnknown = Promise.withResolvers<boolean>();
  const unknownQueued = Promise.withResolvers<void>();
  const unknownReturned = Promise.withResolvers<boolean>();
  void unknownReturned.promise.catch(() => undefined);
  const runRoot = root.runPrompt.bind(root);
  vi.spyOn(root, "runPrompt").mockImplementation((input) => {
    const result = runRoot(input);
    rootStarted.resolve();
    return result;
  });
  vi.spyOn(child, "runPrompt").mockImplementation(async () => {
    childStarted.resolve();
    if (!(await triggerUnknown.promise)) return { kind: "completed" };
    try {
      const callback = execution.inputs[1]?.onExternalToolResultUnknown;
      if (callback === undefined) throw new Error("子 Session 未装配 UNKNOWN 回调");
      const recovery = callback();
      unknownQueued.resolve();
      await recovery;
      unknownReturned.resolve(child.abortCompleted);
      return unknownOutcome;
    } catch (error) {
      unknownReturned.reject(error);
      throw error;
    }
  });
  const start = async () => {
    await within(rootStarted.promise);
    const control = execution.inputs[0]?.agentControl;
    if (control === undefined) throw new Error("根 Session 未装配子代理控制器");
    await control.spawn({
      callId: "spawn-unknown",
      task: "核验外部结果",
      tools: [],
      forkTurns: "none",
    });
    await within(childStarted.promise);
    root.emit({ type: "tool.started", callId: toolCall.callId, name: toolCall.toolName });
  };
  return {
    ...execution,
    root,
    child,
    start,
    triggerUnknown,
    unknownQueued,
    unknownReturned,
  };
}

function expectDurableUnknown(execution: ReturnType<typeof harness>): void {
  const record = execution.persistence.record(execution.scope);
  expect(record.attempt?.status).toBe("recovery_required");
  expect(
    record.events.filter(
      (event) =>
        event.kind === "attempt_state_changed" &&
        ["recovery_required", "failed", "cancelled"].includes(event.payload.status),
    ),
  ).toEqual([
    expect.objectContaining({
      kind: "attempt_state_changed",
      payload: expect.objectContaining({
        status: "recovery_required",
        code: "EXTERNAL_TOOL_RESULT_UNKNOWN",
      }),
    }),
  ]);
}

async function expectAuthorizationClosed(execution: ReturnType<typeof harness>): Promise<void> {
  const permitsBefore = execution.persistence.permits.length;
  const authorize = execution.inputs[0]?.authorizeToolEffect;
  if (authorize === undefined) throw new Error("根 Session 未装配副作用授权器");
  await expect(authorize(toolCall)).rejects.toThrow("EXTERNAL_EFFECT_NOT_AUTHORIZED");
  expect(execution.persistence.permits).toHaveLength(permitsBefore);
}

describe("外部工具 UNKNOWN 的根恢复交错", () => {
  it("流式持久化失败正等待子 Session abort 时，UNKNOWN 回调仍完成并持久化根恢复", async () => {
    const execution = concurrentHarness();
    const abortEntered = Promise.withResolvers<void>();
    const releaseAbort = Promise.withResolvers<void>();
    execution.child.beforeAbortReturn = async () => {
      abortEntered.resolve();
      execution.triggerUnknown.resolve(true);
      await Promise.race([execution.unknownReturned.promise, releaseAbort.promise]);
    };
    const mutate = execution.persistence.mutate.bind(execution.persistence);
    vi.spyOn(execution.persistence, "mutate").mockImplementation(async (command) => {
      if (
        command.events.some(
          (event) => event.kind === "agent_event" && event.payload.type === "message.delta",
        )
      )
        return { outcome: "protocol_invalid" };
      return mutate(command);
    });
    const running = execution.worker.execute(execution.scope);
    try {
      await execution.start();
      execution.root.emit({ type: "message.delta", delta: "触发流式持久化失败" });
      await within(abortEntered.promise);
      expect(await within(execution.unknownReturned.promise)).toBe(false);
      expectDurableUnknown(execution);
      await expectAuthorizationClosed(execution);
      await expect(within(running)).resolves.toEqual(unknownResult);
      expectDurableUnknown(execution);
    } finally {
      releaseAbort.resolve();
      execution.triggerUnknown.resolve(false);
      execution.root.complete();
      await within(running).catch(() => undefined);
    }
  });

  it("在途终答安全点提交后，UNKNOWN 使用最新序号且安全点返回不覆盖根恢复", async () => {
    const execution = concurrentHarness(true);
    const safePointEntered = Promise.withResolvers<RuntimeMutation>();
    const releaseSafePoint = Promise.withResolvers<void>();
    const mutate = execution.persistence.mutate.bind(execution.persistence);
    vi.spyOn(execution.persistence, "mutate").mockImplementation(async (command) => {
      if (
        command.threadContextAppend !== undefined &&
        command.events.some(
          (event) => event.kind === "agent_event" && event.payload.type === "finalization.started",
        )
      ) {
        safePointEntered.resolve(command);
        await releaseSafePoint.promise;
      }
      return mutate(command);
    });
    const running = execution.worker.execute(execution.scope);
    try {
      await execution.start();
      const markerTurn: RuntimeAgentEvent = {
        type: "turn.completed",
        assistant: {
          content: [
            {
              type: "toolCall",
              id: "call-final",
              name: "collapse_process_for_final_answer",
              arguments: {},
            },
          ],
          api: "openai-completions",
          provider: "test",
          model: "test-model",
          stopReason: "toolUse",
          timestamp: 1,
        },
        toolResults: [
          {
            toolCallId: "call-final",
            toolName: "collapse_process_for_final_answer",
            text: '{"status":"ready"}',
            isError: false,
            timestamp: 2,
          },
        ],
      };
      execution.root.emit(markerTurn);
      const predecessor = await within(safePointEntered.promise);
      execution.triggerUnknown.resolve(true);
      await within(execution.unknownQueued.promise);
      expect(execution.persistence.record(execution.scope).attempt?.status).toBe("running");
      execution.root.emit({ type: "message.delta", delta: "UNKNOWN 后不得持久化" });
      await expectAuthorizationClosed(execution);
      releaseSafePoint.resolve();
      await within(execution.unknownReturned.promise);
      await expect(within(running)).resolves.toEqual(unknownResult);
      expectDurableUnknown(execution);
      const recovery = execution.persistence.mutationCommands.find((command) =>
        command.idempotencyKey.endsWith("/recovery/EXTERNAL_TOOL_RESULT_UNKNOWN"),
      );
      expect(recovery?.expectedAttemptVersion).toBe(predecessor.expectedAttemptVersion + 1);
      const sequence = predecessor.events[0]?.sequence;
      expect(sequence).toBeTypeOf("number");
      expect(recovery?.events.map((event) => event.sequence)).toEqual([
        Number(sequence) + 1,
        Number(sequence) + 2,
      ]);
      const events = execution.persistence.record(execution.scope).events;
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "agent_event",
          payload: { type: "finalization.started", callId: "call-final" },
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          kind: "agent_event",
          payload: { type: "message.delta", delta: "UNKNOWN 后不得持久化" },
        }),
      );
      await expectAuthorizationClosed(execution);
    } finally {
      releaseSafePoint.resolve();
      execution.triggerUnknown.resolve(false);
      execution.root.complete();
      await within(running).catch(() => undefined);
    }
  });

  it("根 Session 仅返回 UNKNOWN outcome 时，已生效的撤销不覆盖根恢复事实", async () => {
    const root = new ScriptedAgentSession([], unknownOutcome);
    const execution = harness([root]);
    const runPrompt = root.runPrompt.bind(root);
    vi.spyOn(root, "runPrompt").mockImplementation(async (input, authorization) => {
      execution.persistence.agentRevisionRevoked = true;
      return runPrompt(input, authorization);
    });
    await expect(within(execution.worker.execute(execution.scope))).resolves.toEqual(unknownResult);
    expect(execution.persistence.agentRevisionRevoked).toBe(true);
    expectDurableUnknown(execution);
    await expectAuthorizationClosed(execution);
  });
});
