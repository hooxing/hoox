import {
  encodeControlledToolReceipt,
  type ToolObservationResult,
  type ToolObservationRolloutPort,
} from "@hoox/context-policy";
import {
  bindTrustedPiModelContextCapability,
  type RuntimeAgentEvent,
  type ToolCallingMode,
} from "@hoox/pi-adapter";
import type { AgentSessionFactoryPort } from "@hoox/run-contracts";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createDurableObservationRecorderFactory,
  PiWorkerSessionFactory,
} from "./pi-session-factory.js";
import { RunWorker } from "./run-worker.js";
import {
  FakeArtifactPublication,
  FakeCancellationPort,
  FakeClock,
  FakeExecutionPersistence,
  FakeRecoveryMetrics,
  FakeRevisionVerifier,
  FakeSandboxRegistry,
  fakeSeed,
} from "./testing/fakes.js";

type RecorderFactory = ConstructorParameters<typeof PiWorkerSessionFactory>[2];
type ToolCall = Parameters<ReturnType<RecorderFactory>["recordStarted"]>[0];

async function fixture(
  options: {
    constructorMode?: ToolCallingMode;
    withModel?: { toolCallingMode?: ToolCallingMode };
    code?: string;
    beforeStarted?: (call: ToolCall) => Promise<void>;
    startedOutcome?: (call: ToolCall) => ToolObservationResult["outcome"];
    resultOutcome?: (call: ToolCall) => ToolObservationResult["outcome"];
    rejectAuthorization?: boolean;
    unknownConsumption?: boolean;
    beforeToolConsumeReturn?: () => Promise<void>;
    updateScheduledTask?: ConstructorParameters<typeof PiWorkerSessionFactory>[13];
    nativeAutomation?: boolean;
  } = {},
) {
  const persistence = new FakeExecutionPersistence();
  const scope = persistence.addSeed(fakeSeed("pi-ptc-worker"));
  const sandboxes = new FakeSandboxRegistry();
  const operations: string[] = [];
  const events: RuntimeAgentEvent[] = [];
  const providerTools: string[][] = [];
  const providerResults: string[] = [];
  const results: ToolCall[] = [];
  const receipts: Array<ToolCall & { observation: string }> = [];
  const recordStarted = vi.fn(async (call: ToolCall): Promise<ToolObservationResult["outcome"]> => {
    operations.push(`record_started:${call.toolCallId}`);
    await options.beforeStarted?.(call);
    const outcome = options.startedOutcome?.(call) ?? "recorded";
    operations.push(
      `${outcome === "recorded" || outcome === "replayed" ? "durable" : outcome}:${call.toolCallId}`,
    );
    return outcome;
  });
  const issue = persistence.issueExternalEffectPermit.bind(persistence);
  vi.spyOn(persistence, "issueExternalEffectPermit").mockImplementation(async (input) => {
    if (input.effect === "tool_execution") {
      operations.push(`authorize:${input.call.callId}`);
      if (options.rejectAuthorization) persistence.rejectNextPermit = true;
    }
    return await issue(input);
  });
  const consume = persistence.consumeExternalEffectPermit.bind(persistence);
  vi.spyOn(persistence, "consumeExternalEffectPermit").mockImplementation(async (input) => {
    if (input.permit.effect === "tool_execution" && options.unknownConsumption)
      persistence.unavailableNextPermitConsume = true;
    const result = await consume(input);
    if (input.permit.effect === "tool_execution")
      operations.push(`${result.outcome}:${input.permit.callId}`);
    if (input.permit.effect === "tool_execution") await options.beforeToolConsumeReturn?.();
    return result;
  });
  const mutate = persistence.mutate.bind(persistence);
  vi.spyOn(persistence, "mutate").mockImplementation(async (input) => {
    const result = await mutate(input);
    if (result.outcome === "applied" || result.outcome === "already_applied") {
      for (const event of input.events) {
        if (event.kind === "agent_event" && event.payload.type === "tool.started")
          operations.push(`worker_durable_started:${event.payload.callId}`);
      }
    }
    return result;
  });
  const command = vi.fn(async (text: string) => {
    const call = persistence.permits.findLast(
      ({ permit, consumed }) => permit.effect === "tool_execution" && consumed,
    );
    operations.push(`effect:${call?.permit.callId ?? "missing-permit"}`);
    sandboxes.handle.files.set("/tmp/ptc-worker.txt", text);
    return { stdout: `${text}\n`, stderr: "", exitCode: 0 };
  });
  sandboxes.handle.command = command;
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  faux.setResponses([
    (context) => {
      providerTools.push((context.tools ?? []).map((tool) => tool.name));
      return options.nativeAutomation
        ? fauxAssistantMessage(
            fauxToolCall("automation_update", automationArguments, { id: "call-automation" }),
            { stopReason: "toolUse" },
          )
        : options.code === undefined
          ? fauxAssistantMessage("完成")
          : fauxAssistantMessage(
              fauxToolCall("run_code", { code: options.code }, { id: "call-ptc-program" }),
              { stopReason: "toolUse" },
            );
    },
    (context) => {
      providerTools.push((context.tools ?? []).map((tool) => tool.name));
      providerResults.push(
        ...context.messages
          .filter((message) => message.role === "toolResult")
          .map((message) => JSON.stringify(message)),
      );
      return fauxAssistantMessage("完成");
    },
  ]);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.provider.id, async () => ({
    type: "api_key",
    key: "test-only-key",
  }));
  const modelRuntime = createModels({ credentials });
  modelRuntime.setProvider(faux.provider);
  const model = faux.getModel();
  const createRecorder: RecorderFactory = (_input, outputs) => ({
    recordStarted,
    record: async (call) => {
      results.push(call);
      const outcome = options.resultOutcome?.(call) ?? "recorded";
      if (outcome !== "recorded" && outcome !== "replayed") {
        operations.push(`result_${outcome}:${call.toolCallId}`);
        return { outcome };
      }
      const observation = await outputs.readControlledReceipt(call);
      if (observation === undefined) return { outcome: "conflict" };
      receipts.push({ ...call, observation });
      operations.push(`result:${call.toolCallId}`);
      return { outcome, observation, isTruncated: false };
    },
  });
  let factory = new PiWorkerSessionFactory(
    model,
    modelRuntime,
    createRecorder,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.updateScheduledTask,
    undefined,
    options.constructorMode,
  );
  if (options.withModel !== undefined) {
    factory = factory.withModel({
      ...options.withModel,
      model,
      modelRuntime,
      modelContext: bindTrustedPiModelContextCapability(modelRuntime, model),
      modelWireTraces: undefined,
      prepareRuntimeCompaction: undefined,
    });
  }
  // 只旁路观测真实事件，保留 Pi 工厂和 RunWorker 的 durable 拒绝屏障及授权实现。
  const sessions: AgentSessionFactoryPort = {
    toolRejectionReceiptBarrier: factory.toolRejectionReceiptBarrier,
    create: async (input) => {
      const session = await factory.create(input);
      session.subscribe((event) => {
        events.push(event);
        if (event.type === "tool.started") operations.push(`started:${event.callId}`);
      });
      return session;
    },
  };
  const cancellation = new FakeCancellationPort();
  const worker = new RunWorker(
    {
      persistence,
      revisions: new FakeRevisionVerifier(),
      sandboxes,
      orphanSandboxes: sandboxes,
      sessions,
      cancellation,
      artifacts: new FakeArtifactPublication(),
      clock: new FakeClock(),
      metrics: new FakeRecoveryMetrics(),
    },
    { workerId: "pi-ptc-test-worker", runTimeoutMs: 60_000 },
  );
  return {
    worker,
    scope,
    persistence,
    sandboxes,
    faux,
    providerTools,
    providerResults,
    operations,
    events,
    recordStarted,
    results,
    receipts,
    command,
    cancellation,
  };
}

const automationArguments = {
  action: "create",
  name: "测试定时任务",
  instruction: "测试占位任务",
  first_run_at: "2099-01-01T09:00:00+08:00",
};
const automationProgram = `return await tools.automation_update(${JSON.stringify(automationArguments)});`;

const parentId = "call-ptc-program";
const firstCommand = 'return await tools.exec_command({ cmd: "echo ptc-first" });';
const catchAndContinue = `
  try { await tools.exec_command({ cmd: "echo ptc-first" }); } catch {}
  return await tools.exec_command({ cmd: "echo forbidden-second" });
`;

function startedCalls(test: Awaited<ReturnType<typeof fixture>>) {
  return test.recordStarted.mock.calls.map(([call]) => call);
}

function toolPermits(test: Awaited<ReturnType<typeof fixture>>) {
  return test.persistence.permits.filter(({ permit }) => permit.effect === "tool_execution");
}

describe("PiWorkerSessionFactory PTC 模式", () => {
  it.each(["native", "ptc"] as const)(
    "%s 定时任务授权等待中取消，授权收束后不开始 mutation",
    async (mode) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const mutation =
        vi.fn<NonNullable<ConstructorParameters<typeof PiWorkerSessionFactory>[13]>>();
      const test = await fixture({
        constructorMode: mode,
        ...(mode === "ptc" ? { code: automationProgram } : { nativeAutomation: true }),
        updateScheduledTask: mutation,
        beforeToolConsumeReturn: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const work = test.worker.execute(test.scope);
      await entered.promise;
      test.cancellation.cancel(test.scope);
      release.resolve();
      await work;
      expect(mutation).not.toHaveBeenCalled();
      expect(startedCalls(test).some((call) => call.toolName === "automation_update")).toBe(true);
    },
    30_000,
  );

  it("PTC 定时任务授权等待中触发程序期限，不开始 mutation", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalTimer = globalThis.setTimeout;
    const deadlines: Array<() => void> = [];
    const timers = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 30_000 && typeof callback === "function")
          deadlines.push(() => callback(...args));
        return originalTimer(callback, delay, ...args);
      });
    try {
      const mutation =
        vi.fn<NonNullable<ConstructorParameters<typeof PiWorkerSessionFactory>[13]>>();
      const test = await fixture({
        constructorMode: "ptc",
        code: automationProgram,
        updateScheduledTask: mutation,
        beforeToolConsumeReturn: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const work = test.worker.execute(test.scope);
      await entered.promise;
      expect(deadlines.length).toBeGreaterThanOrEqual(2);
      for (const expire of deadlines) expire();
      release.resolve();
      await work;
      expect(mutation).not.toHaveBeenCalled();
      expect(
        test.receipts
          .filter((call) => call.toolName === "automation_update")
          .map((call) => JSON.parse(call.observation).outcome),
      ).toEqual(["failed"]);
    } finally {
      timers.mockRestore();
      release.resolve();
    }
  }, 30_000);

  it.each([
    { name: "构造器省略模式", options: {}, ptc: false },
    { name: "构造器显式 native", options: { constructorMode: "native" as const }, ptc: false },
    { name: "构造器显式 PTC", options: { constructorMode: "ptc" as const }, ptc: true },
    { name: "withModel 省略模式继承 native", options: { withModel: {} }, ptc: false },
    {
      name: "withModel 省略模式继承 PTC",
      options: { constructorMode: "ptc" as const, withModel: {} },
      ptc: true,
    },
    {
      name: "withModel 将 native 切换为 PTC",
      options: { withModel: { toolCallingMode: "ptc" as const } },
      ptc: true,
    },
    {
      name: "withModel 将 PTC 切换为 native",
      options: {
        constructorMode: "ptc" as const,
        withModel: { toolCallingMode: "native" as const },
      },
      ptc: false,
    },
  ])("$name 时 Provider 获得对应模式的真实工具清单", async ({ options, ptc }) => {
    const test = await fixture(options);
    await expect(test.worker.execute(test.scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(test.providerTools).toHaveLength(1);
    if (ptc) expect(test.providerTools[0]).toEqual(["run_code"]);
    else {
      expect(test.providerTools[0]).toEqual(
        expect.arrayContaining(["exec_command", "read", "write"]),
      );
      expect(test.providerTools[0]).not.toContain("run_code");
    }
    expect(test.sandboxes.acquireCount).toBe(0);
  });

  it("父子 started 持久化完成前不执行，子工具依次经过 durable、一次性授权、副作用和结果", async () => {
    const parentGate = Promise.withResolvers<void>();
    const childGate = Promise.withResolvers<void>();
    const test = await fixture({
      constructorMode: "ptc",
      code: firstCommand,
      beforeStarted: (call) =>
        call.toolName === "run_code" ? parentGate.promise : childGate.promise,
    });
    const execution = test.worker.execute(test.scope);
    try {
      await vi.waitFor(() => expect(test.recordStarted).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      expect(startedCalls(test)).toEqual([{ toolCallId: parentId, toolName: "run_code" }]);
      expect(toolPermits(test)).toHaveLength(0);
      expect(test.operations.some((operation) => operation.startsWith("authorize:"))).toBe(false);
      expect(test.command).not.toHaveBeenCalled();
      expect(test.sandboxes.acquireCount).toBe(0);
      parentGate.resolve();
      await vi.waitFor(() => expect(test.recordStarted).toHaveBeenCalledTimes(2), {
        timeout: 5_000,
      });
      expect(test.operations).toContain(`durable:${parentId}`);
      expect(toolPermits(test)).toHaveLength(0);
      expect(test.operations.some((operation) => operation.startsWith("authorize:"))).toBe(false);
      expect(test.command).not.toHaveBeenCalled();
      expect(test.sandboxes.acquireCount).toBe(0);
    } finally {
      parentGate.resolve();
      childGate.resolve();
      await execution;
    }
    await expect(execution).resolves.toEqual({ outcome: "succeeded" });
    const child = startedCalls(test)[1];
    expect(child).toEqual({
      toolCallId: expect.stringMatching(/^ptc\./u),
      toolName: "exec_command",
      parentToolCallId: parentId,
    });
    if (child === undefined) throw new Error("测试缺少 PTC 子调用");
    expect(test.providerTools).toEqual([["run_code"], ["run_code"]]);
    expect(
      test.operations.filter(
        (operation) =>
          operation.endsWith(`:${child.toolCallId}`) &&
          !operation.startsWith("worker_durable_started:"),
      ),
    ).toEqual([
      `started:${child.toolCallId}`,
      `record_started:${child.toolCallId}`,
      `durable:${child.toolCallId}`,
      `authorize:${child.toolCallId}`,
      `consumed:${child.toolCallId}`,
      `effect:${child.toolCallId}`,
      `result:${child.toolCallId}`,
    ]);
    expect(test.operations).toContain(`worker_durable_started:${child.toolCallId}`);
    expect(test.operations.indexOf(`durable:${parentId}`)).toBeLessThan(
      test.operations.indexOf(`started:${child.toolCallId}`),
    );
    expect(test.operations.indexOf(`worker_durable_started:${child.toolCallId}`)).toBeLessThan(
      test.operations.indexOf(`authorize:${child.toolCallId}`),
    );
    expect(test.operations.indexOf(`result:${child.toolCallId}`)).toBeLessThan(
      test.operations.indexOf(`result:${parentId}`),
    );
    expect(test.results).toEqual([child, { toolCallId: parentId, toolName: "run_code" }]);
    expect(test.events).toContainEqual({
      type: "tool.started",
      callId: child.toolCallId,
      name: "exec_command",
      parentCallId: parentId,
    });
    expect(toolPermits(test)).toEqual([
      expect.objectContaining({
        consumed: true,
        permit: expect.objectContaining({ callId: child.toolCallId, toolName: "exec_command" }),
      }),
    ]);
    expect(test.command).toHaveBeenCalledTimes(1);
    expect(test.command.mock.calls[0]?.[0]).toContain("echo ptc-first");
    expect(test.sandboxes.handle.files.get("/tmp/ptc-worker.txt")).toContain("echo ptc-first");
    expect(test.providerResults[0]).toContain("ptc-first");
  }, 30_000);

  it.each(["run_code", "exec_command"])(
    "%s 的 started 持久化 UNKNOWN 时不授权、不执行也不继续 Provider",
    async (toolName) => {
      const test = await fixture({
        constructorMode: "ptc",
        code: catchAndContinue,
        startedOutcome: (call) => (call.toolName === toolName ? "unknown" : "recorded"),
      });
      await expect(test.worker.execute(test.scope)).resolves.toEqual({
        outcome: "recovery_required",
        code: "PERSISTENCE_UNAVAILABLE",
      });
      expect(toolPermits(test)).toHaveLength(0);
      expect(test.operations.some((operation) => operation.startsWith("authorize:"))).toBe(false);
      expect(test.command).not.toHaveBeenCalled();
      expect(test.sandboxes.acquireCount).toBe(0);
      expect(test.sandboxes.handle.files.size).toBe(0);
      expect(test.faux.state.callCount).toBe(1);
      expect(startedCalls(test).map((call) => call.toolName)).toEqual(
        toolName === "run_code" ? ["run_code"] : ["run_code", "exec_command"],
      );
    },
  );

  it.each([
    {
      name: "子工具许可被拒绝",
      options: { rejectAuthorization: true },
      outcome: { outcome: "fence_lost" },
    },
    {
      name: "子工具许可消费 UNKNOWN",
      options: { unknownConsumption: true },
      outcome: { outcome: "recovery_required", code: "PERSISTENCE_UNAVAILABLE" },
    },
  ])(
    "$name 时形成失败回执，guest catch 不能继续第二次副作用或 Provider",
    async ({ options, outcome }) => {
      const test = await fixture({ ...options, constructorMode: "ptc", code: catchAndContinue });
      await expect(test.worker.execute(test.scope)).resolves.toEqual(outcome);
      expect(startedCalls(test).map((call) => call.toolName)).toEqual(["run_code", "exec_command"]);
      expect(test.command).not.toHaveBeenCalled();
      expect(test.sandboxes.handle.files.size).toBe(0);
      expect(toolPermits(test).every(({ consumed }) => !consumed)).toBe(true);
      expect(test.receipts.find((call) => call.toolName === "exec_command")?.observation).toContain(
        '"outcome":"failed"',
      );
      expect(test.results.map((call) => call.toolName)).toEqual(["exec_command", "run_code"]);
      expect(test.faux.state.callCount).toBe(1);
    },
  );

  it.each(["exec_command", "run_code"])(
    "%s 结果持久化 UNKNOWN 时保留已发生副作用，不重放也不继续 Provider",
    async (toolName) => {
      const test = await fixture({
        constructorMode: "ptc",
        code: toolName === "run_code" ? firstCommand : catchAndContinue,
        resultOutcome: (call) => (call.toolName === toolName ? "unknown" : "recorded"),
      });
      await expect(test.worker.execute(test.scope)).resolves.toEqual({
        outcome: "recovery_required",
        code: "PERSISTENCE_UNAVAILABLE",
      });
      expect(test.command).toHaveBeenCalledTimes(1);
      expect(test.sandboxes.handle.files.get("/tmp/ptc-worker.txt")).toContain("echo ptc-first");
      expect(startedCalls(test).map((call) => call.toolName)).toEqual(["run_code", "exec_command"]);
      expect(toolPermits(test)).toHaveLength(1);
      expect(toolPermits(test)[0]?.consumed).toBe(true);
      expect(test.faux.state.callCount).toBe(1);
    },
  );

  it("生产 durable recorder 将子调用的 parentToolCallId 写入 tool_call 和 tool_result", async () => {
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(fakeSeed("pi-ptc-parent-binding"));
    const claimed = await persistence.claim({
      scope,
      workerId: "pi-ptc-parent-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("测试未取得 Attempt fence");
    const appendToolCall = vi
      .fn<ToolObservationRolloutPort["appendToolCall"]>()
      .mockResolvedValue({ outcome: "created" });
    const appendToolResult = vi
      .fn<ToolObservationRolloutPort["appendToolResult"]>()
      .mockResolvedValue({ outcome: "created" });
    const createRecorder = createDurableObservationRecorderFactory((input) => ({
      binding: {
        scope: input.scope,
        attemptId: input.attemptId,
        agentThreadId: "agent-ptc-parent",
      },
      traces: {
        persistTrace: async (trace) => ({
          outcome: "persisted" as const,
          referenceId: "trace-ptc-test",
          blob: {
            kind: "stable" as const,
            tenantId: trace.tenantId,
            purpose: "trace" as const,
            sha256: trace.sha256,
            size: trace.body.byteLength,
            incarnationId: "trace-ptc-incarnation",
            physicalObjectKey: "trace/ptc-test",
          },
        }),
      },
      rollout: { appendToolCall, appendToolResult },
      policy: { maxModelObservationBytes: 1024 },
    }));
    const recorder = createRecorder(
      { scope, attemptId: claimed.snapshot.attempt.attemptId, fence: claimed.fence } as Parameters<
        AgentSessionFactoryPort["create"]
      >[0],
      {
        readControlledReceipt: async (call) =>
          encodeControlledToolReceipt(call.toolName, "succeeded"),
      },
    );
    const parent = { toolCallId: parentId, toolName: "run_code" };
    const child = {
      toolCallId: "ptc-child-1",
      toolName: "exec_command",
      parentToolCallId: parentId,
    };
    await expect(recorder.recordStarted(parent)).resolves.toBe("recorded");
    await expect(recorder.recordStarted(child)).resolves.toBe("recorded");
    await expect(recorder.record(child)).resolves.toMatchObject({ outcome: "recorded" });
    await expect(recorder.record(parent)).resolves.toMatchObject({ outcome: "recorded" });

    expect(appendToolCall).toHaveBeenCalledTimes(2);
    expect(appendToolCall).toHaveBeenNthCalledWith(2, expect.objectContaining(child));
    expect(appendToolResult).toHaveBeenCalledTimes(2);
    expect(appendToolResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ toolCallId: child.toolCallId, parentToolCallId: parentId }),
    );
    expect(appendToolCall.mock.calls[0]?.[0]).not.toHaveProperty("parentToolCallId");
    expect(appendToolResult.mock.calls[1]?.[0]).not.toHaveProperty("parentToolCallId");
  });
});
