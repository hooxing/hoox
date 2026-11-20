import type { RunPhaseTimingDiagnosticsPort } from "./run-phase-diagnostics.js";
import {
  type RunPersonalizationSnapshot,
  resourceId,
  resourceVersionId,
  runId,
  sha256Digest,
  type TenantId,
  tenantId,
  type UserId,
} from "@hoox/domain";
import type { MemoryRetriever } from "@hoox/memory";
import type { RuntimeAgentEvent } from "@hoox/pi-adapter";
import type { UncertainLifecycleEvent } from "@hoox/sandbox";
import { FakeSandboxHandle } from "@hoox/sandbox/testing";
import {
  createWorkspaceManifest,
  WorkspaceApplicationError,
  WorkspaceDependencyError,
} from "@hoox/workspace";
import { describe, expect, it, vi } from "vitest";
import {
  outboxPayloadDigest,
  rolloutProjectionDigest,
  runtimeMutationDigest,
  sandboxCleanupIdentityDigest,
  workspaceChangeDigest,
} from "./mutation-protocol.js";
import type {
  AgentControlPersistencePort,
  ExecutionScope,
  RuntimeEventV1,
  RuntimeMutation,
  SandboxSessionRef,
  ThreadContinuityMetricsPort,
} from "./ports.js";
import type { RunEventDiagnosticsPort } from "./run-event-diagnostics.js";
import type { RunStartupTimingDiagnosticsPort } from "./run-startup-diagnostics.js";
import { fakeAgentSnapshot } from "./testing/agent-snapshot.js";
import { RunWorker, type RunWorkerOptions } from "./run-worker.js";
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
  FakeThreadSandboxLifecycle,
  fakeRevision,
  fakeSeed,
  ScriptedAgentSession,
} from "./testing/fakes.js";
import { WorkspaceMaterializationStageError } from "./workspace-runtime.js";

const successfulEvents: readonly RuntimeAgentEvent[] = [
  { type: "agent.started" },
  { type: "message.delta", delta: "完成" },
  { type: "message.completed", stopReason: "stop" },
  { type: "agent.settled" },
];

function fakeAgentControlPersistence(): AgentControlPersistencePort {
  let sequence = 0;
  return {
    initializeRoot: async () => ({ outcome: "ready", conversations: [] }),
    spawn: async (input) => ({ outcome: "created", snapshot: input.snapshot }),
    queueFollowUp: async () => "created",
    startTurn: async () => "started",
    settleTurn: async () => "settled",
    appendMailbox: async () => ({ outcome: "created", sequence: ++sequence }),
    recordCommand: async () => "recorded",
  };
}

function harness(
  sessions: Array<ScriptedAgentSession | BlockingAgentSession>,
  seed = fakeSeed(),
  workerOptions: Partial<RunWorkerOptions> = {},
  runEventDiagnostics?: RunEventDiagnosticsPort,
  prepareSandboxBeforeInput:
    | boolean
    | ((ensure: () => Promise<SandboxSessionRef>) => Promise<void>) = false,
  memoryRetriever?: MemoryRetriever,
  personalizations?: Readonly<{
    resolveForRun(input: {
      readonly scope: { readonly tenantId: TenantId; readonly userId: UserId };
    }): Promise<RunPersonalizationSnapshot>;
  }>,
  startupTimingDiagnostics?: RunStartupTimingDiagnosticsPort,
  phaseTimingDiagnostics?: RunPhaseTimingDiagnosticsPort,
) {
  const persistence = new FakeExecutionPersistence();
  const scope = persistence.addSeed(seed);
  const revisions = new FakeRevisionVerifier();
  const sandboxes = new FakeSandboxRegistry();
  const factory = new FakeSessionFactory(sessions, prepareSandboxBeforeInput);
  const cancellation = new FakeCancellationPort();
  const shutdown = new AbortController();
  const clock = new FakeClock();
  const metrics = new FakeRecoveryMetrics();
  const continuityMetrics = {
    record: vi.fn<ThreadContinuityMetricsPort["record"]>(async () => undefined),
  };
  const threadContextBodies = new FakeThreadContextBodies();
  const threadSandboxes = new FakeThreadSandboxLifecycle();
  const agentControl = fakeAgentControlPersistence();
  const worker = new RunWorker(
    {
      persistence,
      revisions,
      sandboxes,
      orphanSandboxes: sandboxes,
      sessions: factory,
      cancellation,
      shutdownSignal: shutdown.signal,
      clock,
      metrics,
      continuityMetrics,
      ...(runEventDiagnostics === undefined ? {} : { runEventDiagnostics }),
      ...(startupTimingDiagnostics === undefined ? {} : { startupTimingDiagnostics }),
      ...(phaseTimingDiagnostics === undefined ? {} : { phaseTimingDiagnostics }),
      ...(workerOptions.threadContextWriteEnabled === true ? { threadContextBodies } : {}),
      ...(workerOptions.threadSandboxSessionReuseEnabled === true ? { threadSandboxes } : {}),
      ...(workerOptions.subagentsEnabled === true ? { agentControl } : {}),
      ...(memoryRetriever === undefined ? {} : { memoryRetriever }),
      ...(personalizations === undefined ? {} : { personalizations }),
    },
    {
      workerId: "worker-test",
      leaseDurationMs: 30_000,
      heartbeatMs: 10_000,
      runTimeoutMs: 60_000,
      ...workerOptions,
    },
  );
  return {
    worker,
    persistence,
    scope,
    revisions,
    sandboxes,
    factory,
    cancellation,
    shutdown,
    clock,
    metrics,
    continuityMetrics,
    threadContextBodies,
    threadSandboxes,
    agentControl,
    runEventDiagnostics,
  };
}

function sandboxHarness(
  sessions: Array<ScriptedAgentSession | BlockingAgentSession>,
  seed = fakeSeed(),
  workerOptions: Partial<RunWorkerOptions> = {},
  runEventDiagnostics?: RunEventDiagnosticsPort,
) {
  return harness(sessions, seed, workerOptions, runEventDiagnostics, true);
}

describe("Run Worker 双栅栏与恢复状态机", () => {
  it("纯文本回答不 acquire、materialize、verify 或 settle Sandbox", async () => {
    const seed = fakeSeed("no-sandbox");
    const h = harness([new ScriptedAgentSession(successfulEvents)], seed);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.factory.initialInputTexts).toEqual([seed.input]);
    expect(h.sandboxes.acquireCount).toBe(0);
    expect(h.sandboxes.settleCount).toBe(0);
    expect(h.revisions.materializeCount).toBe(0);
    expect(h.revisions.verifyCount).toBe(0);
    expect(h.persistence.record(h.scope).outbox).not.toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup" }),
    );
  });

  it("阶段诊断覆盖排队、沙箱、工作区和持久化，且诊断失败不改变任务完成", async () => {
    const records: Parameters<RunPhaseTimingDiagnosticsPort["persist"]>[0][] = [];
    const h = harness(
      [new ScriptedAgentSession(successfulEvents)],
      fakeSeed("phase-timing"),
      {},
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      {
        persist: async (record) => {
          records.push(record);
          if (record.phase === "runtime_persist") throw new Error("diagnostic unavailable");
        },
      },
    );
    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(records.map((record) => record.phase)).toEqual(
      expect.arrayContaining([
        "run_queue_wait",
        "sandbox_acquire",
        "workspace_materialize",
        "workspace_verify",
        "sandbox_settle",
        "runtime_persist",
      ]),
    );
    expect(
      records.every((record) => record.context.runId === h.scope.runId && record.durationMs >= 0),
    ).toBe(true);
    expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index + 1));
  });

  it("在首个模型请求前发布细分启动耗时且不包含后续阶段", async () => {
    const persist = vi.fn<RunStartupTimingDiagnosticsPort["persist"]>(async () => undefined);
    const h = harness(
      [new ScriptedAgentSession(successfulEvents)],
      fakeSeed("startup-timing"),
      {},
      undefined,
      false,
      undefined,
      undefined,
      { persist },
    );

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(persist).toHaveBeenCalledOnce();
    const snapshot = persist.mock.calls[0]?.[0];
    expect(snapshot?.context).toMatchObject({
      runId: h.scope.runId,
      threadId: h.scope.threadId,
    });
    expect(snapshot?.spans.map((span) => span.phase)).toEqual([
      "run_claim",
      "pre_session_stop_point",
      "memory_retrieve",
      "agent_session_create",
      "post_session_stop_point",
      "model_checkpoint",
      "prepare_input",
      "model_authorization",
    ]);
    expect(snapshot?.spans.every((span) => span.durationMs >= 0)).toBe(true);
  });

  it("长期记忆检索结果只注入当前 user message，失败时降级为原消息", async () => {
    const seed = fakeSeed("memory-retrieval");
    const retriever = {
      retrieve: vi.fn(async () => [{ id: "memory-a", text: "用户偏好简短回答", score: 0.9 }]),
    } satisfies MemoryRetriever;
    const h = harness(
      [new ScriptedAgentSession(successfulEvents)],
      seed,
      {},
      undefined,
      false,
      retriever,
    );

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(retriever.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: seed.run.tenantId,
        userId: seed.memorySubjectUserId,
        query: seed.input,
      }),
    );
    expect(h.factory.initialInputTexts[0]).toContain("低信任派生数据");
    expect(h.factory.initialInputTexts[0]).toContain("用户偏好简短回答");
    expect(h.factory.initialInputTexts[0]).toContain(seed.input);

    const unavailable = {
      retrieve: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    } satisfies MemoryRetriever;
    const fallback = harness(
      [new ScriptedAgentSession(successfulEvents)],
      fakeSeed("memory-fallback"),
      {},
      undefined,
      false,
      unavailable,
    );
    await expect(fallback.worker.execute(fallback.scope)).resolves.toEqual({
      outcome: "succeeded",
    });
    expect(fallback.factory.initialInputTexts).toEqual(["执行任务"]);
  });

  it("领取 Run 后按实际发起用户读取一次个性化，并把同一快照交给 Session", async () => {
    const seed = { ...fakeSeed("personalization"), requestedByUserId: "user-task-initiator" };
    const snapshot: RunPersonalizationSnapshot = Object.freeze({
      team: Object.freeze({ content: "团队默认使用 TypeScript", version: 4 }),
      user: Object.freeze({ content: "回答保持简洁", version: 7 }),
    });
    const personalizations = {
      resolveForRun: vi.fn(async () => snapshot),
    };
    const h = harness(
      [new ScriptedAgentSession(successfulEvents)],
      seed,
      {},
      undefined,
      false,
      undefined,
      personalizations,
    );

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(personalizations.resolveForRun).toHaveBeenCalledWith({
      scope: { tenantId: seed.run.tenantId, userId: "user-task-initiator" },
    });
    expect(h.factory.personalizationSnapshots).toEqual([snapshot]);
  });

  it("root 与 SubAgent 的独立 Session 复用同一个已物化 Sandbox", async () => {
    const root = new BlockingAgentSession();
    const child = new ScriptedAgentSession([
      { type: "agent.started" },
      { type: "message.completed", stopReason: "stop" },
      {
        type: "turn.completed",
        assistant: {
          content: [{ type: "text", text: "子任务完成" }],
          api: "test",
          provider: "test",
          model: "test",
          stopReason: "stop",
          timestamp: 1,
        },
        toolResults: [],
      },
      { type: "agent.settled" },
    ]);
    const h = sandboxHarness([root, child], fakeSeed("subagent-shared-sandbox"), {
      subagentsEnabled: true,
    });
    const execution = h.worker.execute(h.scope);
    await vi.waitFor(() => expect(root.prompts).toHaveLength(1));
    const control = h.factory.agentControls[0];
    if (control === undefined) throw new Error("测试缺少 root AgentControl");

    const spawned = await control.spawn({
      callId: "call_spawn_shared_sandbox",
      task: "读取共享工作区",
      tools: ["read"],
      forkTurns: "none",
    });
    const delivered = await control.wait({ afterSequence: 0, timeoutMs: 1_000 });
    expect(delivered.updates[0]).toMatchObject({
      senderPath: spawned.path,
      kind: "final_answer",
      payload: "子任务完成",
    });

    root.emit({ type: "message.completed", stopReason: "stop" });
    root.complete();
    await expect(execution).resolves.toEqual({ outcome: "succeeded" });
    expect(h.factory.agentIdentities[0]).toBeUndefined();
    expect(h.factory.agentIdentities[1]).toMatchObject({ agentKind: "subagent" });
    expect(h.factory.agentSnapshots).toHaveLength(2);
    expect(h.factory.agentSnapshots[1]).toBe(h.factory.agentSnapshots[0]);
    expect(h.factory.preparedSandboxes).toHaveLength(2);
    expect(h.factory.preparedSandboxes[0]).toBe(h.factory.preparedSandboxes[1]);
    expect(h.sandboxes.acquireCount).toBe(1);
    expect(h.revisions.materializeCount).toBe(1);
  });

  it("SubAgent 工具 started 与 Attempt invocation 原子提交并保留完整生命周期", async () => {
    const root = new BlockingAgentSession();
    const child = new BlockingAgentSession();
    const h = sandboxHarness([root, child], fakeSeed("subagent-tool-lifecycle"), {
      subagentsEnabled: true,
    });
    const execution = h.worker.execute(h.scope);
    await vi.waitFor(() => expect(root.prompts).toHaveLength(1));
    const control = h.factory.agentControls[0];
    if (control === undefined) throw new Error("测试缺少 root AgentControl");

    const spawned = await control.spawn({
      callId: "call_spawn_tool_lifecycle",
      task: "执行受控命令",
      tools: ["exec_command"],
      forkTurns: "none",
    });
    await vi.waitFor(() => expect(child.prompts).toHaveLength(1));
    const runtimeCallIds = [
      `${spawned.agentThreadId}:turn-test:child-command-1`,
      `${spawned.agentThreadId}:turn-test:child-command-2`,
    ];
    child.emit({ type: "message.completed", stopReason: "toolUse" });
    child.emit({
      type: "tool.started",
      callId: runtimeCallIds[0] ?? "missing-call-1",
      name: "exec_command",
    });
    root.emit({ type: "thinking.started" });
    child.emit({
      type: "tool.started",
      callId: runtimeCallIds[1] ?? "missing-call-2",
      name: "exec_command",
    });
    const authorizations = await Promise.all(
      runtimeCallIds.map(async (runtimeCallId, index) =>
        h.factory.toolAuthorizers[1]?.({
          callId: runtimeCallId,
          toolName: "exec_command",
          argsDigest: sha256Digest(`${index + 1}`.repeat(64)),
        }),
      ),
    );
    expect(authorizations.map((authorization) => authorization?.permit)).toEqual(
      runtimeCallIds.map((runtimeCallId) =>
        expect.objectContaining({
          effect: "tool_execution",
          callId: runtimeCallId,
          toolName: "exec_command",
        }),
      ),
    );
    for (const runtimeCallId of runtimeCallIds) {
      child.emit({
        type: "tool.completed",
        callId: runtimeCallId,
        name: "exec_command",
        isError: false,
      });
    }
    child.emit({ type: "message.completed", stopReason: "stop" });
    child.emit({
      type: "turn.completed",
      assistant: {
        content: [{ type: "text", text: "命令执行完成" }],
        api: "test",
        provider: "test",
        model: "test",
        stopReason: "stop",
        timestamp: 1,
      },
      toolResults: [
        {
          toolCallId: runtimeCallIds[0] ?? "missing-call-1",
          toolName: "exec_command",
          text: "ok-1",
          isError: false,
          timestamp: 1,
        },
        {
          toolCallId: runtimeCallIds[1] ?? "missing-call-2",
          toolName: "exec_command",
          text: "ok-2",
          isError: false,
          timestamp: 1,
        },
      ],
    });
    child.emit({ type: "agent.settled" });
    child.complete();

    const delivered = await control.wait({ afterSequence: 0, timeoutMs: 1_000 });
    expect(delivered.updates[0]).toMatchObject({ kind: "final_answer", payload: "命令执行完成" });
    root.emit({ type: "thinking.completed" });
    root.emit({ type: "message.completed", stopReason: "stop" });
    root.complete();
    await expect(execution).resolves.toEqual({ outcome: "succeeded" });

    const toolEvents = h.persistence
      .record(h.scope)
      .events.filter(
        (event) =>
          event.kind === "agent_event" &&
          (event.payload.type === "tool.started" || event.payload.type === "tool.completed"),
      );
    expect(toolEvents).toEqual(
      [
        ...runtimeCallIds.map((runtimeCallId) => ({ type: "tool.started", runtimeCallId })),
        ...runtimeCallIds.map((runtimeCallId) => ({ type: "tool.completed", runtimeCallId })),
      ].map(({ type, runtimeCallId }) =>
        expect.objectContaining({
          payload: expect.objectContaining({ type, callId: runtimeCallId }),
        }),
      ),
    );
  });

  it("在 todo_write started 持久化后写入完整 Todo 快照，不影响其他工具授权", async () => {
    const session = new BlockingAgentSession();
    const h = harness([session], fakeSeed("todo-write"));
    const execution = h.worker.execute(h.scope);
    await vi.waitFor(() => expect(session.prompts).toHaveLength(1));

    session.emit({ type: "tool.started", callId: "call-todo", name: "todo_write" });
    const snapshot = await h.factory.todoWriters[0]?.({
      callId: "call-todo",
      command: {
        todos: [
          { id: "confirm", content: "确认目标", status: "pending" },
          { id: "deliver", content: "完成交付", status: "pending" },
        ],
      },
    });
    session.emit({
      type: "tool.completed",
      callId: "call-todo",
      name: "todo_write",
      isError: false,
    });
    session.emit({ type: "message.completed", stopReason: "stop" });
    session.complete();

    await expect(execution).resolves.toEqual({ outcome: "succeeded" });
    expect(snapshot).toMatchObject({ schemaVersion: 1, version: 1 });
    const todoEvent = h.persistence
      .record(h.scope)
      .events.find(
        (event) => event.kind === "agent_event" && event.payload.type === "todo.updated",
      );
    expect(todoEvent).toMatchObject({
      payload: {
        type: "todo.updated",
        snapshot: {
          version: 1,
          todos: [
            { id: "confirm", status: "pending" },
            { id: "deliver", status: "pending" },
          ],
        },
      },
    });
    expect(h.factory.toolAuthorizers).toHaveLength(1);
  });

  it("模型确认上下文过大时终止 Run 并释放队列，不进入人工恢复", async () => {
    const session = new ScriptedAgentSession([], {
      kind: "context_too_large",
      action: "rebuild_context",
    });
    const h = harness([session], fakeSeed("context-too-large"));

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "failed" });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("failed");
    expect(record.attempt?.status).toBe("failed");
    expect(record.attempt?.stage).toBe("finished");
    expect(record.fence).toBeUndefined();
  });

  it("并发启动信号共享完整 acquire 与 materialize，不能提前取得未就绪 Sandbox", async () => {
    let markMaterializeStarted: () => void = () => undefined;
    const materializeStarted = new Promise<void>((resolve) => {
      markMaterializeStarted = resolve;
    });
    let releaseMaterialize: () => void = () => undefined;
    const materializeRelease = new Promise<void>((resolve) => {
      releaseMaterialize = resolve;
    });
    let materializeFinished = false;
    let secondResolvedBeforeMaterialize = false;
    const prepareConcurrently = async (ensure: () => Promise<SandboxSessionRef>) => {
      const first = ensure();
      await materializeStarted;
      const second = ensure().then((ready) => {
        if (!materializeFinished) secondResolvedBeforeMaterialize = true;
        return ready;
      });
      await Promise.resolve();
      releaseMaterialize();
      const [firstReady, secondReady] = await Promise.all([first, second]);
      expect(secondReady).toBe(firstReady);
    };
    const h = harness(
      [new ScriptedAgentSession(successfulEvents)],
      fakeSeed("sandbox-single-flight"),
      {},
      undefined,
      prepareConcurrently,
    );
    h.revisions.beforeMaterializeReturn = async () => {
      markMaterializeStarted();
      await materializeRelease;
      materializeFinished = true;
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(secondResolvedBeforeMaterialize).toBe(false);
    expect(h.sandboxes.acquireCount).toBe(1);
    expect(h.revisions.materializeCount).toBe(1);
  });

  it("durable mutation 成功后 best-effort 镜像 Run 事件，镜像失败不改变 Run 结果", async () => {
    const persist = vi.fn<RunEventDiagnosticsPort["persist"]>(async () => {
      throw new Error("测试磁盘只读");
    });
    const h = harness([new ScriptedAgentSession(successfulEvents)], fakeSeed(), {}, { persist });

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(persist).toHaveBeenCalled();
    expect(
      persist.mock.calls.some(
        ([record]) =>
          record.context.runId === h.scope.runId &&
          record.context.attemptId.startsWith("attempt-") &&
          record.event.kind === "agent_event" &&
          record.event.payload.type === "message.delta",
      ),
    ).toBe(true);
  });

  it("紧急撤销在安全点令 Run 失败，不启动 Session 或 Sandbox", async () => {
    const h = harness([], fakeSeed("agent-revoked"));
    h.persistence.agentRevisionRevoked = true;
    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "failed" });
    expect(h.factory.createCount).toBe(0);
    expect(h.persistence.record(h.scope).events).toContainEqual(
      expect.objectContaining({
        kind: "attempt_state_changed",
        payload: expect.objectContaining({ code: "AGENT_REVISION_REVOKED" }),
      }),
    );
  });

  it("模型在途时由续租发现撤销，先失败关闭再交给 Sandbox 清理消费者", async () => {
    const session = new BlockingAgentSession();
    const h = sandboxHarness([session], fakeSeed("agent-revoked-during-model"));
    const execution = h.worker.execute(h.scope);
    await eventually(() => session.prompts.length === 1);
    h.persistence.agentRevisionRevoked = true;
    await h.clock.tickHeartbeat();
    await expect(execution).resolves.toEqual({ outcome: "failed" });
    expect(session.abortCount).toBe(1);
    expect(h.sandboxes.settleCount).toBe(0);
    expect(h.persistence.record(h.scope).outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "started" }),
    );
  });

  it.each(["AGENT_SNAPSHOT_INVALID", "AGENT_REVISION_REVOKED"] as const)(
    "领取读取到 %s 时失败关闭",
    async (agent) => {
      const h = harness([], { ...fakeSeed("agent-blocked"), agent });
      await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "failed" });
      expect(h.factory.createCount).toBe(0);
      expect(h.persistence.record(h.scope).events).toContainEqual(
        expect.objectContaining({
          kind: "attempt_state_changed",
          payload: expect.objectContaining({ code: agent }),
        }),
      );
    },
  );

  it("快照要求未接入的固定 Provider 时不回退到平台模型", async () => {
    const h = harness([], {
      ...fakeSeed("agent-model-unavailable"),
      agent: fakeAgentSnapshot({
        model: {
          mode: "pinned",
          providerKey: "model-provider-test",
          providerRevision: 3,
          modelId: "model-test",
        },
      }),
    });
    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "failed" });
    expect(h.factory.createCount).toBe(0);
    expect(h.persistence.record(h.scope).events).toContainEqual(
      expect.objectContaining({
        kind: "attempt_state_changed",
        payload: expect.objectContaining({ code: "AGENT_CONFIGURATION_UNSUPPORTED" }),
      }),
    );
  });

  it("快照关闭长期记忆时不读平台记忆", async () => {
    const seed = {
      ...fakeSeed("agent-memory-disabled"),
      agent: fakeAgentSnapshot({ memory: { mode: "configured", longTermEnabled: false } }),
    };
    const memoryRetriever = { retrieve: vi.fn(async () => []) };
    const h = harness(
      [new ScriptedAgentSession(successfulEvents)],
      seed,
      {},
      undefined,
      false,
      memoryRetriever,
    );
    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(memoryRetriever.retrieve).not.toHaveBeenCalled();
  });

  it("默认记忆模式跟随平台并允许平台检索", async () => {
    const memoryRetriever = { retrieve: vi.fn(async () => []) };
    const h = harness(
      [new ScriptedAgentSession(successfulEvents)],
      {
        ...fakeSeed("agent-memory-platform-default"),
        agent: fakeAgentSnapshot({ memory: { mode: "platform_default" } }),
      },
      {},
      undefined,
      false,
      memoryRetriever,
    );
    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(memoryRetriever.retrieve).toHaveBeenCalledTimes(1);
  });

  it("Agent 的 kill 策略不允许成功 Run 暂停或交接 Thread Sandbox", async () => {
    const h = sandboxHarness(
      [new ScriptedAgentSession(successfulEvents)],
      {
        ...fakeSeed("agent-sandbox-kill"),
        agent: fakeAgentSnapshot({ sandboxIdleAction: "kill" }),
      },
      { threadSandboxSessionReuseEnabled: true },
    );
    h.persistence.threadSandboxHandoffRunId = runId("agent-kill-follow-up");
    h.threadSandboxes.queuedFollowUp = true;
    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(h.revisions.verifyCount).toBe(1);
    expect(h.threadSandboxes.terminalReceipts).toEqual([
      expect.objectContaining({ effectKind: "terminate" }),
    ]);
  });

  it("阶段 5 成功终态先提交 pause intent，再执行 lifecycle effect，且不走 success-close", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)], fakeSeed(), {
      threadSandboxSessionReuseEnabled: true,
    });

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.threadSandboxes.acquireCount).toBe(1);
    expect(h.threadSandboxes.resourceFilesystemRequirements).toEqual([true]);
    expect(h.threadSandboxes.attestCount).toBe(1);
    expect(h.threadSandboxes.terminalEffectCount).toBe(1);
    expect(h.threadSandboxes.terminateCount).toBe(0);
    expect(h.sandboxes.acquireCount).toBe(0);
    expect(h.sandboxes.settleCount).toBe(0);
    const terminal = h.persistence.mutationCommands.find((mutation) =>
      mutation.idempotencyKey.endsWith("/final/succeeded"),
    );
    expect(terminal?.threadSandboxTerminal).toMatchObject({
      schemaVersion: 1,
      sessionId: h.threadSandboxes.lease.sessionId,
      generation: 1,
    });
  });

  it("Thread Sandbox 将暂停时生成一次 Workspace 快照", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)], fakeSeed(), {
      threadSandboxSessionReuseEnabled: true,
    });

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.threadSandboxes.queuedFollowUpChecks).toBe(1);
    expect(h.revisions.verifyCount).toBe(1);
    expect(
      h.persistence.mutationCommands.some((mutation) =>
        mutation.idempotencyKey.endsWith("/stage/workspace-verified"),
      ),
    ).toBe(true);
  });

  it("已有排队 follow-up 时推迟快照，Sandbox 连同文件交接给下一个 Run", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)], fakeSeed(), {
      threadSandboxSessionReuseEnabled: true,
    });
    h.threadSandboxes.queuedFollowUp = true;

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.revisions.verifyCount).toBe(0);
    expect(
      h.persistence.mutationCommands.some((mutation) =>
        mutation.idempotencyKey.endsWith("/stage/workspace-verified"),
      ),
    ).toBe(false);
    const terminal = h.persistence.mutationCommands.find((mutation) =>
      mutation.idempotencyKey.endsWith("/final/succeeded"),
    );
    expect(terminal?.workspaceChange).toBeUndefined();
    expect(terminal?.threadSandboxTerminal).toMatchObject({
      sessionId: h.threadSandboxes.lease.sessionId,
    });
  });

  it("follow-up 查询失败时照常快照，不因性能提示丢失 Workspace", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)], fakeSeed(), {
      threadSandboxSessionReuseEnabled: true,
    });
    h.threadSandboxes.queuedFollowUp = "unavailable";

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.revisions.verifyCount).toBe(1);
  });

  it("主模型命中输出上限后只续跑一次，并以独立 model_continue 许可完成任务", async () => {
    const lengthEvents: readonly RuntimeAgentEvent[] = [
      { type: "agent.started" },
      { type: "thinking.delta", delta: "尚未完成" },
      { type: "message.completed", stopReason: "length" },
      { type: "agent.settled" },
    ];
    const session = new ScriptedAgentSession(lengthEvents, { kind: "completed" }, [
      { events: successfulEvents },
    ]);
    const h = sandboxHarness([session], fakeSeed(), {
      threadSandboxSessionReuseEnabled: true,
    });

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain("上一轮因模型输出长度上限中止");
    expect(h.persistence.permits.map(({ permit }) => permit.effect)).toEqual([
      "model_start",
      "model_continue",
    ]);
    expect(h.persistence.permits[1]?.permit.callId).toBe("attempt-1/model/output-limit/1");
    expect(h.threadSandboxes.terminalEffectCount).toBe(1);
    expect(h.threadSandboxes.terminateCount).toBe(0);
    expect(h.sandboxes.settleCount).toBe(0);
  });

  it("主模型连续两次命中输出上限时失败但暂停 Thread Sandbox，保留未提交工作", async () => {
    const lengthEvents: readonly RuntimeAgentEvent[] = [
      { type: "agent.started" },
      { type: "thinking.delta", delta: "输出仍未完成" },
      { type: "message.completed", stopReason: "length" },
      { type: "agent.settled" },
    ];
    const session = new ScriptedAgentSession(lengthEvents, { kind: "completed" }, [
      { events: lengthEvents },
    ]);
    const h = sandboxHarness([session], fakeSeed(), {
      threadSandboxSessionReuseEnabled: true,
    });

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "failed" });

    expect(session.prompts).toHaveLength(2);
    expect(h.persistence.record(h.scope).run.status).toBe("failed");
    expect(h.threadSandboxes.terminalEffectCount).toBe(1);
    expect(h.threadSandboxes.terminateCount).toBe(0);
    expect(h.sandboxes.settleCount).toBe(0);
    const terminal = h.persistence.mutationCommands.find((mutation) =>
      mutation.idempotencyKey.endsWith("/final/failed"),
    );
    expect(terminal?.threadSandboxTerminal).toMatchObject({
      sessionId: h.threadSandboxes.lease.sessionId,
      generation: h.threadSandboxes.lease.generation,
    });
  });

  it("Workspace 物化期间 heartbeat 同时续租 Thread Sandbox，避免首个工具因租约过期中断", async () => {
    let markMaterializeStarted: () => void = () => undefined;
    const materializeStarted = new Promise<void>((resolve) => {
      markMaterializeStarted = resolve;
    });
    let releaseMaterialize: () => void = () => undefined;
    const materializeRelease = new Promise<void>((resolve) => {
      releaseMaterialize = resolve;
    });
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)], fakeSeed(), {
      threadSandboxSessionReuseEnabled: true,
    });
    h.revisions.beforeMaterializeReturn = async () => {
      markMaterializeStarted();
      await materializeRelease;
    };

    const execution = h.worker.execute(h.scope);
    await materializeStarted;
    await h.clock.tickHeartbeat();
    releaseMaterialize();

    await expect(execution).resolves.toEqual({ outcome: "succeeded" });
    expect(h.threadSandboxes.renewCount).toBe(1);
    expect(h.threadSandboxes.attestCount).toBe(1);
  });

  it("阶段 5 pause 结果未知不回滚已经提交的 Run/Workspace/Context 终态", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)], fakeSeed(), {
      threadSandboxSessionReuseEnabled: true,
    });
    h.threadSandboxes.nextTerminalEffect = "unknown";

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(h.persistence.record(h.scope).run.status).toBe("succeeded");
    expect(h.threadSandboxes.terminalEffectCount).toBe(1);
  });

  it("阶段 5 running handoff 通过 revision attestation 时跳过物化且不 pause", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)], fakeSeed(), {
      threadSandboxSessionReuseEnabled: true,
    });
    h.threadSandboxes.nextAcquire = {
      outcome: "ready",
      session: {
        registryId: "thread-registry-reused",
        providerKey: "cube" as const,
        providerSandboxId: h.threadSandboxes.handle.id,
        mode: "connected",
        sandbox: h.threadSandboxes.handle,
      },
      lease: h.threadSandboxes.lease,
      resourceFilesystemMounted: true,
      requiresMaterialization: false,
      source: "running_handoff",
    };
    h.persistence.threadSandboxHandoffRunId = runId("run-next");

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(h.revisions.materializeCount).toBe(0);
    expect(h.threadSandboxes.attestCount).toBe(0);
    expect(h.threadSandboxes.terminalEffectCount).toBe(0);
    expect(h.threadSandboxes.terminateCount).toBe(0);
  });

  it("复用 Thread Sandbox 前验证历史、当前任务目录与本轮直接附件路径", async () => {
    const attachment = {
      resourceId: resourceId("resource-resume-probe"),
      versionId: resourceVersionId("version-resume-probe"),
    };
    const attachmentPath = "/resources/resource-resume-probe/version-resume-probe/数据(简洁).csv";
    const seed = {
      ...fakeSeed("resourcefs-resume-probe"),
      input: `转换文件\n\n# 用户在本轮提供的文件\n- ${JSON.stringify({ 文件名: "数据（简洁）.csv", 文件地址: attachmentPath })}`,
      attachments: [attachment],
    };
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)], seed, {
      threadSandboxSessionReuseEnabled: true,
      historyFilesystemEnabled: true,
    });
    h.threadSandboxes.nextAcquire = {
      outcome: "ready",
      session: {
        registryId: "thread-registry-reused-probe",
        providerKey: "cube" as const,
        providerSandboxId: h.threadSandboxes.handle.id,
        mode: "connected",
        sandbox: h.threadSandboxes.handle,
      },
      lease: h.threadSandboxes.lease,
      resourceFilesystemMounted: true,
      requiresMaterialization: false,
      source: "paused_resumed",
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.threadSandboxes.handle.commands).toHaveLength(2);
    expect(h.threadSandboxes.handle.commands[0]).toContain("[ -d '/resources/history' ]");
    expect(h.threadSandboxes.handle.commands[0]).toContain(
      `/resources/.thread-files/${h.scope.threadId}/files`,
    );
    expect(h.threadSandboxes.handle.commands[0]).toContain(attachmentPath);
    expect(h.revisions.materializeCount).toBe(0);
    expect(h.threadSandboxes.terminateCount).toBe(0);
  });

  it("复用挂载缺失时退役旧 generation 并仅冷恢复一次", async () => {
    const h = sandboxHarness(
      [new ScriptedAgentSession(successfulEvents)],
      fakeSeed("resourcefs-resume-rebuild"),
      {
        threadSandboxSessionReuseEnabled: true,
        historyFilesystemEnabled: true,
      },
    );
    const stale = {
      outcome: "ready" as const,
      session: {
        registryId: "thread-registry-stale",
        providerKey: "cube" as const,
        providerSandboxId: h.threadSandboxes.handle.id,
        mode: "connected" as const,
        sandbox: h.threadSandboxes.handle,
      },
      lease: h.threadSandboxes.lease,
      resourceFilesystemMounted: true,
      requiresMaterialization: false,
      source: "paused_resumed" as const,
    };
    const recoveredHandle = new FakeSandboxHandle("thread-worker-recovered");
    const recoveredLease = {
      ...h.threadSandboxes.lease,
      sessionId: "thread-session-recovered",
      generation: 2,
      leaseId: "sandbox-lease-recovered",
      leaseToken: "sandbox-token-recovered",
      leaseEpoch: 1,
    };
    const cold = {
      outcome: "ready" as const,
      session: {
        registryId: "thread-registry-recovered",
        providerKey: "cube" as const,
        providerSandboxId: recoveredHandle.id,
        mode: "created" as const,
        sandbox: recoveredHandle,
      },
      lease: recoveredLease,
      resourceFilesystemMounted: true,
      requiresMaterialization: true,
      source: "cold_created" as const,
    };
    const acquire = vi
      .spyOn(h.threadSandboxes, "acquire")
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(cold);
    vi.spyOn(h.threadSandboxes.handle, "command").mockResolvedValueOnce({
      stdout: "",
      stderr: "history root missing",
      exitCode: 71,
    });

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(h.threadSandboxes.terminateCount).toBe(1);
    expect(h.revisions.materializeCount).toBe(1);
    expect(h.threadSandboxes.attestCount).toBe(1);
    expect(recoveredHandle.commands).toHaveLength(2);
    expect(recoveredHandle.commands[0]).toContain("[ -d '/resources/history' ]");
    expect(recoveredHandle.commands[1]).toContain("ensure_link /history");
  });

  it("复用自检的非缺失错误失败关闭且不误判为可冷恢复", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = sandboxHarness([session], fakeSeed("resourcefs-resume-probe-error"), {
      threadSandboxSessionReuseEnabled: true,
      historyFilesystemEnabled: true,
    });
    h.threadSandboxes.nextAcquire = {
      outcome: "ready",
      session: {
        registryId: "thread-registry-probe-error",
        providerKey: "cube" as const,
        providerSandboxId: h.threadSandboxes.handle.id,
        mode: "connected",
        sandbox: h.threadSandboxes.handle,
      },
      lease: h.threadSandboxes.lease,
      resourceFilesystemMounted: true,
      requiresMaterialization: false,
      source: "running_handoff",
    };
    vi.spyOn(h.threadSandboxes.handle, "command").mockResolvedValueOnce({
      stdout: "",
      stderr: "unexpected entrypoint state",
      exitCode: 73,
    });

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "SANDBOX_FAILED",
    });

    expect(h.threadSandboxes.acquireCount).toBe(1);
    expect(h.threadSandboxes.terminateCount).toBe(1);
    expect(session.prompts).toEqual([]);
  });

  it("旧 generation 的 heartbeat renew 迟到失败不能误伤冷恢复后的新 lease", async () => {
    const h = sandboxHarness(
      [new ScriptedAgentSession(successfulEvents)],
      fakeSeed("resourcefs-resume-stale-renew"),
      {
        threadSandboxSessionReuseEnabled: true,
        historyFilesystemEnabled: true,
      },
    );
    const recoveredHandle = new FakeSandboxHandle("thread-worker-stale-renew-recovered");
    const recoveredLease = {
      ...h.threadSandboxes.lease,
      sessionId: "thread-session-stale-renew-recovered",
      generation: 2,
      leaseId: "sandbox-lease-stale-renew-recovered",
      leaseToken: "sandbox-token-stale-renew-recovered",
    };
    const acquire = vi
      .spyOn(h.threadSandboxes, "acquire")
      .mockResolvedValueOnce({
        outcome: "ready",
        session: {
          registryId: "thread-registry-stale-renew",
          providerKey: "cube" as const,
          providerSandboxId: h.threadSandboxes.handle.id,
          mode: "connected",
          sandbox: h.threadSandboxes.handle,
        },
        lease: h.threadSandboxes.lease,
        resourceFilesystemMounted: true,
        requiresMaterialization: false,
        source: "paused_resumed",
      })
      .mockResolvedValueOnce({
        outcome: "ready",
        session: {
          registryId: "thread-registry-stale-renew-recovered",
          providerKey: "cube" as const,
          providerSandboxId: recoveredHandle.id,
          mode: "created",
          sandbox: recoveredHandle,
        },
        lease: recoveredLease,
        resourceFilesystemMounted: true,
        requiresMaterialization: true,
        source: "cold_created",
      });
    let markProbeStarted: () => void = () => undefined;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    let releaseProbe: () => void = () => undefined;
    const probeRelease = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    vi.spyOn(h.threadSandboxes.handle, "command").mockImplementationOnce(async () => {
      markProbeStarted();
      await probeRelease;
      return { stdout: "", stderr: "history root missing", exitCode: 71 };
    });
    let markRenewStarted: () => void = () => undefined;
    const renewStarted = new Promise<void>((resolve) => {
      markRenewStarted = resolve;
    });
    let releaseRenew: () => void = () => undefined;
    const renewRelease = new Promise<void>((resolve) => {
      releaseRenew = resolve;
    });
    const renew = vi
      .spyOn(h.threadSandboxes, "renew")
      .mockImplementationOnce(async (input) => {
        expect(input.lease).toBe(h.threadSandboxes.lease);
        markRenewStarted();
        await renewRelease;
        return "lease_lost";
      })
      .mockResolvedValue("renewed");

    const execution = h.worker.execute(h.scope);
    await probeStarted;
    const heartbeat = h.clock.tickHeartbeat();
    await renewStarted;
    releaseProbe();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(recoveredHandle.commands).toHaveLength(1));
    releaseRenew();
    await heartbeat;

    await expect(execution).resolves.toEqual({ outcome: "succeeded" });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(h.threadSandboxes.terminateCount).toBe(1);
  });

  it("冷恢复窗口内新 generation 的 renew 失败仍然立即失败关闭", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = sandboxHarness([session], fakeSeed("resourcefs-resume-new-renew-failed"), {
      threadSandboxSessionReuseEnabled: true,
      historyFilesystemEnabled: true,
    });
    const recoveredHandle = new FakeSandboxHandle("thread-worker-new-renew-failed");
    const recoveredLease = {
      ...h.threadSandboxes.lease,
      sessionId: "thread-session-new-renew-failed",
      generation: 2,
      leaseId: "sandbox-lease-new-renew-failed",
      leaseToken: "sandbox-token-new-renew-failed",
    };
    vi.spyOn(h.threadSandboxes, "acquire")
      .mockResolvedValueOnce({
        outcome: "ready",
        session: {
          registryId: "thread-registry-new-renew-stale",
          providerKey: "cube" as const,
          providerSandboxId: h.threadSandboxes.handle.id,
          mode: "connected",
          sandbox: h.threadSandboxes.handle,
        },
        lease: h.threadSandboxes.lease,
        resourceFilesystemMounted: true,
        requiresMaterialization: false,
        source: "running_handoff",
      })
      .mockResolvedValueOnce({
        outcome: "ready",
        session: {
          registryId: "thread-registry-new-renew-failed",
          providerKey: "cube" as const,
          providerSandboxId: recoveredHandle.id,
          mode: "created",
          sandbox: recoveredHandle,
        },
        lease: recoveredLease,
        resourceFilesystemMounted: true,
        requiresMaterialization: true,
        source: "cold_created",
      });
    vi.spyOn(h.threadSandboxes.handle, "command").mockResolvedValueOnce({
      stdout: "",
      stderr: "history root missing",
      exitCode: 71,
    });
    let markRecoveredProbeStarted: () => void = () => undefined;
    const recoveredProbeStarted = new Promise<void>((resolve) => {
      markRecoveredProbeStarted = resolve;
    });
    let releaseRecoveredProbe: () => void = () => undefined;
    const recoveredProbeRelease = new Promise<void>((resolve) => {
      releaseRecoveredProbe = resolve;
    });
    vi.spyOn(recoveredHandle, "command").mockImplementationOnce(async () => {
      markRecoveredProbeStarted();
      await recoveredProbeRelease;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const renew = vi.spyOn(h.threadSandboxes, "renew").mockImplementationOnce(async (input) => {
      expect(input.lease).toBe(recoveredLease);
      return "lease_lost";
    });

    const execution = h.worker.execute(h.scope);
    await recoveredProbeStarted;
    await h.clock.tickHeartbeat();
    releaseRecoveredProbe();

    await expect(execution).resolves.toEqual({ outcome: "fence_lost" });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(h.threadSandboxes.terminateCount).toBe(2);
    expect(session.prompts).toEqual([]);
  });

  it("冷恢复后数据面仍缺失时失败关闭且不创建第三个 generation", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = sandboxHarness([session], fakeSeed("resourcefs-resume-rebuild-failed"), {
      threadSandboxSessionReuseEnabled: true,
      historyFilesystemEnabled: true,
    });
    const recoveredHandle = new FakeSandboxHandle("thread-worker-recovered-missing");
    const acquire = vi
      .spyOn(h.threadSandboxes, "acquire")
      .mockResolvedValueOnce({
        outcome: "ready",
        session: {
          registryId: "thread-registry-stale-missing",
          providerKey: "cube" as const,
          providerSandboxId: h.threadSandboxes.handle.id,
          mode: "connected",
          sandbox: h.threadSandboxes.handle,
        },
        lease: h.threadSandboxes.lease,
        resourceFilesystemMounted: true,
        requiresMaterialization: false,
        source: "running_handoff",
      })
      .mockResolvedValueOnce({
        outcome: "ready",
        session: {
          registryId: "thread-registry-recovered-missing",
          providerKey: "cube" as const,
          providerSandboxId: recoveredHandle.id,
          mode: "created",
          sandbox: recoveredHandle,
        },
        lease: {
          ...h.threadSandboxes.lease,
          sessionId: "thread-session-recovered-missing",
          generation: 2,
          leaseId: "sandbox-lease-recovered-missing",
          leaseToken: "sandbox-token-recovered-missing",
        },
        resourceFilesystemMounted: true,
        requiresMaterialization: true,
        source: "cold_created",
      });
    vi.spyOn(h.threadSandboxes.handle, "command").mockResolvedValueOnce({
      stdout: "",
      stderr: "history root missing",
      exitCode: 71,
    });
    vi.spyOn(recoveredHandle, "command").mockResolvedValueOnce({
      stdout: "",
      stderr: "history root still missing",
      exitCode: 71,
    });
    const terminate = vi.spyOn(h.threadSandboxes, "terminate");

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "SANDBOX_FAILED",
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(h.threadSandboxes.terminateCount).toBe(2);
    expect(terminate.mock.calls[1]?.[0]).toMatchObject({
      session: { providerSandboxId: recoveredHandle.id },
      lease: { sessionId: "thread-session-recovered-missing", generation: 2 },
    });
    expect(h.revisions.materializeCount).toBe(0);
    expect(session.prompts).toEqual([]);
  });

  it("阶段 3 在完整 turn 后按序消费同一安全点的多条 steer，并合并注入活跃 Session", async () => {
    const completedTurn: RuntimeAgentEvent = {
      type: "turn.completed",
      assistant: {
        content: [{ type: "text", text: "第一轮完成" }],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        stopReason: "stop",
        timestamp: 1,
      },
      toolResults: [],
    };
    const session = new ScriptedAgentSession([
      { type: "agent.started" },
      { type: "message.completed", stopReason: "stop" },
      completedTurn,
      { type: "agent.settled" },
    ]);
    const execution = harness([session], fakeSeed("durable-steer"), {
      threadContextWriteEnabled: true,
      threadInputRoutingV2Enabled: true,
    });
    execution.persistence.pendingThreadSteers.push(
      {
        scope: execution.scope,
        receiptId: "input-steer-1",
        targetTurnId: "turn-1",
        inputText: "不要改后端，只调整配色",
        bodyDigest: sha256Digest("a".repeat(64)),
      },
      {
        scope: execution.scope,
        receiptId: "input-steer-2",
        targetTurnId: "turn-1",
        inputText: "保留现有字体",
        bodyDigest: sha256Digest("b".repeat(64)),
      },
    );

    await expect(execution.worker.execute(execution.scope)).resolves.toEqual({
      outcome: "succeeded",
    });
    expect(session.prompts).toEqual(["执行任务"]);
    expect(session.steers).toEqual(["不要改后端，只调整配色", "保留现有字体"]);
    expect(execution.persistence.pendingThreadSteers).toHaveLength(0);
    expect(
      execution.persistence.durableOperations.some((item) =>
        item.includes("permit:consume:attempt-1/model/steer/input-steer-1"),
      ),
    ).toBe(false);
  });

  it("阶段 3 在 Provider stream 与完整 tool call/result 收敛前不读取或消费 steer", async () => {
    const session = new BlockingAgentSession();
    const execution = harness([session], fakeSeed("durable-steer-safe-point"), {
      threadContextWriteEnabled: true,
      threadInputRoutingV2Enabled: true,
    });
    execution.persistence.pendingThreadSteers.push({
      scope: execution.scope,
      receiptId: "input-steer-safe-point",
      targetTurnId: "turn-1",
      inputText: "工具完成后再采用这条输入",
      bodyDigest: sha256Digest("b".repeat(64)),
    });

    const running = execution.worker.execute(execution.scope);
    await eventually(() => session.prompts.length === 1);
    session.emit({ type: "agent.started" });
    session.emit({ type: "message.delta", delta: "仍在流式输出" });
    await eventually(() =>
      execution.persistence
        .record(execution.scope)
        .events.some(
          (event) => event.kind === "agent_event" && event.payload.type === "message.delta",
        ),
    );
    expect(execution.persistence.durableOperations).not.toContain("steer:read");
    expect(execution.persistence.pendingThreadSteers).toHaveLength(1);

    session.emit({ type: "message.completed", stopReason: "stop" });
    session.emit({
      type: "turn.completed",
      assistant: {
        content: [
          {
            type: "toolCall",
            id: "tool-safe-point",
            name: "sandbox_write_file",
            arguments: { path: "theme.css" },
          },
          { type: "text", text: "工具结果已经配对" },
        ],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        stopReason: "stop",
        timestamp: 1,
      },
      toolResults: [
        {
          toolCallId: "tool-safe-point",
          toolName: "sandbox_write_file",
          text: "ok",
          isError: false,
          timestamp: 2,
        },
      ],
    });
    await eventually(() => session.steers.length === 1);
    const contextAppendIndex = execution.persistence.durableOperations.findIndex((item) =>
      item.includes("/context/turn/0"),
    );
    const steerReadIndex = execution.persistence.durableOperations.indexOf("steer:read");
    expect(contextAppendIndex).toBeGreaterThanOrEqual(0);
    expect(contextAppendIndex).toBeLessThan(steerReadIndex);
    expect(session.prompts).toEqual(["执行任务"]);
    expect(session.steers).toEqual(["工具完成后再采用这条输入"]);

    // 模拟 Pi 在原 prompt 中消费 steer 后完成下一轮，而不是由 Worker 另开 prompt。
    session.emit({ type: "message.completed", stopReason: "stop" });
    session.emit({
      type: "turn.completed",
      assistant: {
        content: [{ type: "text", text: "已采用新输入" }],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        stopReason: "stop",
        timestamp: 3,
      },
      toolResults: [],
    });
    session.emit({ type: "agent.settled" });
    session.complete();
    await expect(running).resolves.toEqual({ outcome: "succeeded" });
    expect(execution.persistence.pendingThreadSteers).toHaveLength(0);
  });

  it("阶段 2 只在完整 turn 后双写 assistant，并在 terminal 同事务追加 Workspace/Run 事实", async () => {
    const turn: RuntimeAgentEvent = {
      type: "turn.completed",
      assistant: {
        content: [
          {
            type: "thinking",
            thinking: "先核验文档依赖，再生成文件",
            thinkingSignature: "reasoning_content",
          },
          { type: "text", text: "跨 Run 可恢复回答" },
        ],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        stopReason: "stop",
        timestamp: 1,
      },
      toolResults: [],
    };
    const execution = harness(
      [
        new ScriptedAgentSession([
          { type: "agent.started" },
          { type: "message.completed", stopReason: "stop" },
          turn,
          { type: "agent.settled" },
        ]),
      ],
      fakeSeed("thread-context-write"),
      { threadContextWriteEnabled: true },
    );
    const commands: RuntimeMutation[] = [];
    execution.persistence.afterMutation = (command) => commands.push(command);
    await expect(execution.worker.execute(execution.scope)).resolves.toEqual({
      outcome: "succeeded",
    });
    const contextCommands = commands.filter((command) => command.threadContextAppend !== undefined);
    expect(contextCommands).toHaveLength(2);
    expect(contextCommands[0]?.threadContextAppend?.entries.map((entry) => entry.kind)).toEqual([
      "assistant_message",
    ]);
    expect(contextCommands[1]?.threadContextAppend?.entries.map((entry) => entry.kind)).toEqual([
      "workspace_unchanged",
      "run_terminal",
    ]);
    expect(execution.threadContextBodies.values).toContainEqual(
      expect.objectContaining({
        text: "跨 Run 可恢复回答",
        content: [
          {
            type: "thinking",
            thinking: "先核验文档依赖，再生成文件",
            thinkingSignature: "reasoning_content",
          },
          { type: "text", text: "跨 Run 可恢复回答" },
        ],
      }),
    );
  });

  it("最终答复阶段在安全点开始，跨 length 续写后才提交", async () => {
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
    const partialTurn: RuntimeAgentEvent = {
      type: "turn.completed",
      assistant: {
        content: [{ type: "text", text: "最终答复的前半段" }],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        stopReason: "length",
        timestamp: 3,
      },
      toolResults: [],
    };
    const completedTurn: RuntimeAgentEvent = {
      type: "turn.completed",
      assistant: {
        content: [{ type: "text", text: "，以及后半段。" }],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        stopReason: "stop",
        timestamp: 4,
      },
      toolResults: [],
    };
    const session = new ScriptedAgentSession(
      [
        { type: "agent.started" },
        {
          type: "tool.started",
          callId: "call-final",
          name: "collapse_process_for_final_answer",
        },
        {
          type: "tool.completed",
          callId: "call-final",
          name: "collapse_process_for_final_answer",
          isError: false,
        },
        { type: "message.completed", stopReason: "toolUse" },
        markerTurn,
        { type: "message.delta", delta: "最终答复的前半段" },
        { type: "message.completed", stopReason: "length" },
        partialTurn,
        { type: "agent.settled" },
      ],
      { kind: "completed" },
      [
        {
          events: [
            { type: "agent.started" },
            { type: "message.delta", delta: "，以及后半段。" },
            { type: "message.completed", stopReason: "stop" },
            completedTurn,
            { type: "agent.settled" },
          ],
        },
      ],
    );
    const execution = harness([session], fakeSeed("final-answer-length"), {
      threadContextWriteEnabled: true,
    });

    await expect(execution.worker.execute(execution.scope)).resolves.toEqual({
      outcome: "succeeded",
    });

    expect(session.prompts).toHaveLength(2);
    const phaseEvents = execution.persistence
      .record(execution.scope)
      .events.filter(
        (event) =>
          event.kind === "agent_event" &&
          (event.payload.type === "finalization.started" ||
            event.payload.type === "final_answer.committed"),
      )
      .map((event) => (event.kind === "agent_event" ? event.payload : undefined));
    expect(phaseEvents).toEqual([
      { type: "finalization.started", callId: "call-final" },
      { type: "final_answer.committed", callId: "call-final" },
    ]);
    expect(
      execution.threadContextBodies.values.filter((body) => body.role === "assistant"),
    ).toEqual([
      expect.objectContaining({ phase: "commentary", stopReason: "toolUse" }),
      expect.objectContaining({ phase: "final_answer", text: "最终答复的前半段" }),
      expect.objectContaining({ phase: "final_answer", text: "，以及后半段。" }),
    ]);
  });

  it("阶段标志后重新调用工具会取消折叠，后续普通回复不冒充最终答复", async () => {
    const session = new ScriptedAgentSession([
      { type: "agent.started" },
      { type: "message.completed", stopReason: "toolUse" },
      {
        type: "turn.completed",
        assistant: {
          content: [
            {
              type: "toolCall",
              id: "call-final-cancel",
              name: "collapse_process_for_final_answer",
              arguments: {},
            },
          ],
          api: "test",
          provider: "test",
          model: "test",
          stopReason: "toolUse",
          timestamp: 1,
        },
        toolResults: [
          {
            toolCallId: "call-final-cancel",
            toolName: "collapse_process_for_final_answer",
            text: "ready",
            isError: false,
            timestamp: 2,
          },
        ],
      },
      { type: "message.completed", stopReason: "toolUse" },
      {
        type: "turn.completed",
        assistant: {
          content: [
            { type: "toolCall", id: "call-read-more", name: "read", arguments: { path: "a" } },
          ],
          api: "test",
          provider: "test",
          model: "test",
          stopReason: "toolUse",
          timestamp: 3,
        },
        toolResults: [
          {
            toolCallId: "call-read-more",
            toolName: "read",
            text: "ok",
            isError: false,
            timestamp: 4,
          },
        ],
      },
      { type: "message.delta", delta: "补充检查后完成。" },
      { type: "message.completed", stopReason: "stop" },
      {
        type: "turn.completed",
        assistant: {
          content: [{ type: "text", text: "补充检查后完成。" }],
          api: "test",
          provider: "test",
          model: "test",
          stopReason: "stop",
          timestamp: 5,
        },
        toolResults: [],
      },
      { type: "agent.settled" },
    ]);
    const execution = harness([session], fakeSeed("final-answer-cancel"), {
      threadContextWriteEnabled: true,
    });

    await expect(execution.worker.execute(execution.scope)).resolves.toEqual({
      outcome: "succeeded",
    });
    expect(
      execution.persistence
        .record(execution.scope)
        .events.find(
          (event) =>
            event.kind === "agent_event" && event.payload.type === "finalization.cancelled",
        ),
    ).toMatchObject({
      payload: {
        type: "finalization.cancelled",
        callId: "call-final-cancel",
        reason: "tool_use",
      },
    });
    expect(execution.threadContextBodies.values).toContainEqual(
      expect.objectContaining({ text: "补充检查后完成。" }),
    );
    expect(
      execution.threadContextBodies.values.find((body) => body.text === "补充检查后完成。"),
    ).not.toHaveProperty("phase");
  });

  it("turn 安全点先排空思考与消息公开事件，再提交 Thread Context", async () => {
    const turn: RuntimeAgentEvent = {
      type: "turn.completed",
      assistant: {
        content: [
          { type: "thinking", thinking: "先检查输入" },
          { type: "text", text: "检查完成" },
        ],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        stopReason: "stop",
        timestamp: 1,
      },
      toolResults: [],
    };
    const execution = harness(
      [
        new ScriptedAgentSession([
          { type: "agent.started" },
          { type: "thinking.started" },
          { type: "thinking.delta", delta: "先检查输入" },
          { type: "thinking.completed" },
          { type: "message.completed", stopReason: "stop" },
          turn,
          { type: "agent.settled" },
        ]),
      ],
      fakeSeed("thread-context-event-order"),
      { threadContextWriteEnabled: true },
    );

    await expect(execution.worker.execute(execution.scope)).resolves.toEqual({
      outcome: "succeeded",
    });

    const events = execution.persistence
      .record(execution.scope)
      .events.filter((event) => event.kind === "agent_event");
    const contextIndex = execution.persistence.durableOperations.findIndex((operation) =>
      operation.includes("/context/turn/0"),
    );
    expect(contextIndex).toBeGreaterThanOrEqual(0);
    for (const type of [
      "thinking.started",
      "thinking.delta",
      "thinking.completed",
      "message.completed",
    ]) {
      const event = events.find((candidate) => candidate.payload.type === type);
      if (event === undefined) throw new Error(`缺少测试事件：${type}`);
      const eventIndex = execution.persistence.durableOperations.indexOf(
        `mutate:attempt-1/event/${event.sequence}`,
      );
      expect(eventIndex).toBeGreaterThanOrEqual(0);
      expect(eventIndex).toBeLessThan(contextIndex);
    }
  });

  it("初始 Projection 按 UTF-8 字节拒绝 emoji 超限，不能先启动 Sandbox 或 Session", async () => {
    const seed = fakeSeed("emoji-projection");
    const oversized = "😀".repeat(5_000);
    const h = harness([new ScriptedAgentSession(successfulEvents)], {
      ...seed,
      rolloutProjection: {
        schemaVersion: 2,
        checkpointId: "emoji-byte-boundary",
        // JS code unit 小于旧 16,000 限制，但 UTF-8 字节为 20,000，必须统一拒绝。
        items: [{ kind: "turn", role: "user", text: oversized }],
      },
    });
    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "EVENT_REJECTED",
    });
    expect(h.sandboxes.acquireCount).toBe(0);
    expect(h.factory.createCount).toBe(0);
  });

  it("Session 报告 Tool Observation 未收敛时，不能进入 Run succeeded", async () => {
    const session = new ScriptedAgentSession([{ type: "agent.started" }], {
      kind: "recovery_required",
      code: "PERSISTENCE_UNAVAILABLE",
    });
    const h = harness([session], fakeSeed("tool-observation-recovery"));

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "PERSISTENCE_UNAVAILABLE",
    });
    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("running");
    expect(record.attempt).toMatchObject({ status: "recovery_required" });
    expect(record.mutations.has("attempt-1/final/succeeded")).toBe(false);
  });

  it("Session 创建后仅在文件信号到达时物化 Workspace；失败会 cleanup 且不启动模型", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = sandboxHarness([session], fakeSeed("materialize-before-model"));
    h.revisions.beforeMaterializeReturn = () => {
      expect(h.factory.createCount).toBe(1);
      throw new WorkspaceMaterializationStageError("baseline_snapshot");
    };

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(h.worker.execute(h.scope)).resolves.toEqual({
        outcome: "recovery_required",
        code: "WORKSPACE_CONFLICT",
      });
      // 仅输出固定分类，不把 Sandbox、路径、对象键或原始异常带进日志。
      expect(warning).toHaveBeenCalledWith(
        "WORKSPACE_MATERIALIZE_FAILED category=stage_baseline_snapshot",
      );
    } finally {
      warning.mockRestore();
    }

    expect(h.revisions.materializeCount).toBe(1);
    expect(h.factory.createCount).toBe(1);
    expect(session.prompts).toHaveLength(0);
    expect(h.sandboxes.settleCount).toBe(1);
    expect(h.continuityMetrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metricName: "workspace_materialize_latency_ms",
        outcome: "failed",
      }),
    );
  });

  it("Revision、Run succeeded、Attempt 终态和双栅栏释放在同一幂等事务完成", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.nextRevisionId = fakeRevision("revision-success");

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.revisions.materializeCount).toBe(1);
    expect(h.continuityMetrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metricName: "workspace_materialize_latency_ms",
        outcome: "ready",
      }),
    );

    const currentScope = h.persistence.scopeForRun(h.scope.runId);
    const record = h.persistence.record(currentScope);
    expect(record.run.status).toBe("succeeded");
    expect(record.workspace.currentRevisionId).toBe(fakeRevision("revision-success"));
    expect(currentScope).toEqual(h.scope);
    expect(record.attempt).toMatchObject({ status: "succeeded", stage: "finished" });
    expect(record.fence).toBeUndefined();
    expect(record.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: record.events.length }, (_, index) => index),
    );
    expect(record.outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "completed" }),
    );
    const mutations = [...record.mutations.keys()];
    expect(mutations.indexOf("attempt-1/sandbox/cleanup-intent")).toBeGreaterThan(
      mutations.indexOf("attempt-1/stage/model-execution-started"),
    );
    const intent = record.mutations.get("attempt-1/sandbox/cleanup-intent");
    const intentReceipt = intent?.receipt.outbox[0];
    expect(intentReceipt).toMatchObject({
      kind: "sandbox_cleanup",
      state: "pending",
      armed: true,
      identity: { registryId: "registry-test", providerSandboxId: "worker-fake" },
    });
    expect(intentReceipt === undefined ? true : "disposition" in intentReceipt).toBe(false);
    expect(intentReceipt?.payloadDigest).toBe(
      outboxPayloadDigest(
        {
          schemaVersion: 1,
          kind: "sandbox_cleanup",
          idempotencyKey: "attempt-1/sandbox/registry-test/cleanup",
          state: "pending",
          armed: true,
          payload: {
            registryId: "registry-test",
            providerKey: "cube" as const,
            providerSandboxId: "worker-fake",
          },
        },
        intentReceipt?.kind === "sandbox_cleanup" ? intentReceipt.armedAt : undefined,
      ),
    );
    expect(
      intentReceipt?.kind === "sandbox_cleanup" ? intentReceipt.identityDigest : undefined,
    ).toBe(
      sandboxCleanupIdentityDigest({
        schemaVersion: 1,
        kind: "sandbox_cleanup",
        idempotencyKey: "attempt-1/sandbox/registry-test/cleanup",
        state: "pending",
        armed: true,
        payload: {
          registryId: "registry-test",
          providerKey: "cube",
          providerSandboxId: "worker-fake",
        },
      }),
    );
    const final = record.mutations.get("attempt-1/final/succeeded");
    expect(final?.receipt.workspace).toEqual({
      changeDigest: workspaceChangeDigest({
        tenantId: h.scope.tenantId,
        threadId: h.scope.threadId,
        workspaceId: h.scope.workspaceId,
        rootRunId: h.scope.rootRunId,
        revisionId: fakeRevision("revision-success"),
        candidateOperationKey: "attempt-1:workspace:publish:0",
        candidateOperationDigest: "0".repeat(64) as ReturnType<typeof sha256Digest>,
        manifest: createWorkspaceManifest(
          { tenantId: h.scope.tenantId, entries: [] },
          { maxFiles: 1, maxTotalBytes: 1 },
        ),
      }),
      currentHead: fakeRevision("revision-success"),
    });
  });

  it("重复投递不能重领 running Run，也不会提前创建 Sandbox 或第二个模型 Session", async () => {
    const blocked = new BlockingAgentSession();
    const h = harness([blocked]);
    const first = h.worker.execute(h.scope);
    await eventually(() => h.factory.createCount === 1);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "ignored",
      reason: "busy",
    });
    expect(h.sandboxes.acquireCount).toBe(0);
    expect(h.factory.createCount).toBe(1);

    h.cancellation.cancel(h.scope);
    await expect(first).resolves.toEqual({ outcome: "cancelled" });
  });

  it("API 已提交 cancelled 后，原 Worker 仍原子关闭 Attempt 并释放栅栏", async () => {
    const blocked = new BlockingAgentSession();
    const h = harness([blocked]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.createCount === 1);

    h.persistence.cancelRunExternally(h.scope);
    h.cancellation.cancel(h.scope);

    await expect(execution).resolves.toEqual({ outcome: "cancelled" });
    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("cancelled");
    expect(record.attempt).toMatchObject({ status: "cancelled", stage: "finished" });
    expect(record.workspace.writerLease).toBeUndefined();
    expect(record.events).toContainEqual(
      expect.objectContaining({
        kind: "agent_event",
        payload: expect.objectContaining({ type: "runtime.notice", code: "CANCELLED" }),
      }),
    );
  });

  it("运行中取消不等待普通 Sandbox settle，原子转交持久清理消费者", async () => {
    const blocked = new BlockingAgentSession();
    const h = sandboxHarness([blocked]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.createCount === 1);

    h.persistence.cancelRunExternally(h.scope);
    h.cancellation.cancel(h.scope);

    await expect(execution).resolves.toEqual({ outcome: "cancelled" });
    const record = h.persistence.record(h.scope);
    expect(h.sandboxes.settleCount).toBe(0);
    expect(record.attempt).toMatchObject({ status: "cancelled", stage: "finished" });
    expect(record.outbox).toContainEqual(
      expect.objectContaining({
        kind: "sandbox_cleanup",
        state: "started",
        payload: expect.objectContaining({ disposition: "close" }),
      }),
    );
  });

  it("进程停机中止在途 Session，但只提交恢复事实而不伪造用户 cancelled", async () => {
    const blocked = new BlockingAgentSession();
    const h = harness([blocked], fakeSeed("worker-shutdown"));
    const commands: RuntimeMutation[] = [];
    h.persistence.afterMutation = (command) => commands.push(command);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.createCount === 1);

    h.shutdown.abort("test_worker_shutdown");

    await expect(execution).resolves.toEqual({
      outcome: "recovery_required",
      code: "WORKER_SHUTDOWN",
    });
    const record = h.persistence.record(h.scope);
    expect(blocked.abortCount).toBeGreaterThanOrEqual(1);
    expect(record.run.status).toBe("running");
    expect(record.attempt).toMatchObject({ status: "recovery_required" });
    expect(commands.some((command) => command.nextRunStatus === "cancelled")).toBe(false);
    expect(record.mutations.has("attempt-1/final/cancelled")).toBe(false);
  });

  it.each(["run", "workspace"] as const)(
    "%s lease 到期都会使旧 Worker 丢失写权限，不写 Revision 或业务终态",
    async (lease) => {
      const blocked = new BlockingAgentSession();
      const h = harness([blocked]);
      const execution = h.worker.execute(h.scope);
      await eventually(() => h.factory.createCount === 1);
      if (lease === "run") h.persistence.expireRunLease(h.scope);
      else h.persistence.expireWorkspaceLease(h.scope);

      await h.clock.tickHeartbeat();
      await expect(execution).resolves.toEqual({ outcome: "fence_lost" });

      const record = h.persistence.record(h.scope);
      expect(record.run.status).toBe("running");
      expect(record.workspace.currentRevisionId).toBeUndefined();
      expect(blocked.abortCount).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(["run", "workspace"] as const)(
    "Sandbox create 期间 %s lease 丢失，返回后只清理 Sandbox，绝不启动模型",
    async (lease) => {
      const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
      h.sandboxes.beforeAcquireReturn = () => {
        if (lease === "run") h.persistence.expireRunLease(h.scope);
        else h.persistence.expireWorkspaceLease(h.scope);
      };

      await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });

      expect(h.sandboxes.acquireCount).toBe(1);
      expect(h.sandboxes.settleCount).toBe(1);
      expect(h.factory.createCount).toBe(1);
      expect(h.persistence.record(h.scope).run.status).toBe("running");
      expect(h.sandboxes.cleanupIntentIds).toEqual(["registry:registry-test:orphan-cleanup"]);
      expect(h.metrics.orphanCleanups).toEqual([
        expect.objectContaining({ reason: "fence_lost", cleanupOutcome: "settled" }),
      ]);
    },
  );

  it.each([
    { failure: "unavailable" as const, expected: "unavailable" as const },
    { failure: "response_unknown" as const, expected: "response_unknown" as const },
    { failure: "fence_lost" as const, expected: "fence_lost" as const },
  ])(
    "Sandbox 已登记但 cleanup intent 返回 $failure 时，使用 registry 事实独立清理",
    async ({ failure, expected }) => {
      const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
      h.sandboxes.beforeAcquireReturn = () => {
        if (failure === "unavailable") h.persistence.unavailableMutationAttempts = 4;
        if (failure === "response_unknown") {
          h.persistence.responseUnknownWithoutCommitKeyIncludes = "/sandbox/cleanup-intent";
        }
        if (failure === "fence_lost") {
          h.persistence.fenceLostMutationKeyIncludes = "/sandbox/cleanup-intent";
        }
      };

      const result = await h.worker.execute(h.scope);

      expect(result).toEqual(
        failure === "fence_lost"
          ? { outcome: "fence_lost" }
          : { outcome: "retryable", code: "PERSISTENCE_UNAVAILABLE" },
      );
      expect(h.factory.createCount).toBe(1);
      expect(h.sandboxes.cleanupIntentIds).toEqual(["registry:registry-test:orphan-cleanup"]);
      expect(h.metrics.orphanCleanups).toEqual([
        expect.objectContaining({
          registryId: "registry-test",
          reason: expected,
          cleanupOutcome: "settled",
        }),
      ]);
      expect(h.persistence.record(h.scope).outbox).toHaveLength(0);
    },
  );

  it("cleanup intent 幂等摘要冲突映射稳定错误码，同时仍清理已登记 Sandbox", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.sandboxes.beforeAcquireReturn = () => {
      h.persistence.idempotencyConflictKeyIncludes = "/sandbox/cleanup-intent";
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(h.sandboxes.cleanupIntentIds).toEqual(["registry:registry-test:orphan-cleanup"]);
    expect(h.metrics.orphanCleanups).toEqual([
      expect.objectContaining({ reason: "idempotency_conflict", cleanupOutcome: "settled" }),
    ]);
  });

  it("Workspace verify 返回前丢租约，不执行 prepare/Revision 提交", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.nextRevisionId = fakeRevision("revision-never-commit");
    h.revisions.beforeReturn = () => h.persistence.expireWorkspaceLease(h.scope);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });

    const record = h.persistence.record(h.scope);
    expect(h.revisions.verifyCount).toBe(1);
    expect(record.workspace.currentRevisionId).toBeUndefined();
    expect(record.run.status).toBe("running");
  });

  it("verify 调用前丢 Workspace lease，Verifier 完全不会被调用", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.persistence.afterMutation = (command) => {
      if (command.idempotencyKey.includes("/stage/model-settled")) {
        h.persistence.expireWorkspaceLease(h.scope);
      }
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });

    expect(h.revisions.verifyCount).toBe(0);
    expect(h.persistence.record(h.scope).workspace.currentRevisionId).toBeUndefined();
  });

  it("verify 完成后丢 claim 时不提交 Revision 或成功终态", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.nextRevisionId = fakeRevision("revision-after-verify");
    h.persistence.afterMutation = (command) => {
      if (command.idempotencyKey.includes("/stage/workspace-verified")) {
        h.persistence.expireRunLease(h.scope);
      }
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });

    const record = h.persistence.record(h.scope);
    expect(record.workspace.currentRevisionId).toBeUndefined();
    expect(record.run.status).toBe("running");
    expect(record.attempt?.status).not.toBe("succeeded");
  });

  it("Revision+终态事务响应丢失时按幂等键读回，不重复提交 Revision", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.nextRevisionId = fakeRevision("revision-response-lost");
    h.persistence.responseUnknownKeyIncludes = "/final/succeeded";

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    const scope = h.persistence.scopeForRun(h.scope.runId);
    const record = h.persistence.record(scope);
    expect(record.workspace.currentRevisionNumber).toBe(1);
    expect(record.run.status).toBe("succeeded");
    expect(
      [...record.mutations.keys()].filter((key) => key.includes("/final/succeeded")),
    ).toHaveLength(1);
  });

  it("Revision 推进后仍只允许原始完整 scope 精确 readback，不接受伪造 baseRevision", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.nextRevisionId = fakeRevision("revision-scope-immutable");
    h.persistence.responseUnknownKeyIncludes = "/final/succeeded";

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    const original = await h.persistence.readMutation({
      scope: h.scope,
      idempotencyKey: "attempt-1/final/succeeded",
    });
    const forged = await h.persistence.readMutation({
      scope: { ...h.scope, baseRevisionId: fakeRevision("revision-scope-immutable") },
      idempotencyKey: "attempt-1/final/succeeded",
    });
    expect(original.outcome).toBe("applied");
    expect(forged.outcome).toBe("scope_mismatch");
  });

  it("model_execution_started 提交后再次丢租约，模型许可和 prompt 都不会发生", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = harness([session]);
    h.persistence.afterMutation = (command) => {
      if (command.idempotencyKey.includes("model-execution-started")) {
        h.persistence.expireRunLease(h.scope);
      }
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });

    expect(session.prompts).toEqual([]);
    expect(h.persistence.permits.some(({ permit }) => permit.effect === "model_start")).toBe(false);
  });

  it("model_execution_started 提交后仅在数据库取消，模型许可拒绝并收敛为 cancelled", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = harness([session]);
    h.persistence.afterMutation = (command) => {
      if (command.idempotencyKey.includes("model-execution-started")) {
        h.persistence.cancelRunExternally(h.scope);
      }
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "cancelled" });

    expect(session.prompts).toEqual([]);
    expect(h.persistence.permits.some(({ permit }) => permit.effect === "model_start")).toBe(false);
    expect(h.persistence.record(h.scope).attempt).toMatchObject({ status: "cancelled" });
  });

  it("每次工具执行都重新领取 DB 许可，许可拒绝时中止 Session 且工具调用方失败", async () => {
    const session = new BlockingAgentSession();
    const h = harness([session]);
    const execution = h.worker.execute(h.scope);
    await eventually(
      () => h.factory.toolAuthorizers.length === 1 && h.persistence.permits.length === 1,
    );
    expect(h.persistence.permits).toHaveLength(1);
    expect(h.persistence.permits[0]).toMatchObject({
      permit: { effect: "model_start" },
      consumed: true,
    });

    h.persistence.rejectNextPermit = true;
    session.emit({
      type: "tool.started",
      callId: "tool-call-test",
      name: "sandbox_write_file",
    });
    await expect(
      h.factory.toolAuthorizers[0]?.({
        callId: "tool-call-test",
        toolName: "sandbox_write_file",
        argsDigest: sha256Digest("a".repeat(64)),
      }),
    ).rejects.toThrow("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    await expect(execution).resolves.toEqual({ outcome: "fence_lost" });
    expect(session.abortCount).toBeGreaterThan(0);
  });

  it("tool.started 与后续事件、许可共用单 lane，issue/consume 之间不会插入 mutation", async () => {
    const session = new BlockingAgentSession();
    const h = harness([session]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.toolAuthorizers.length === 1);
    const call = {
      callId: "tool-call-lane",
      toolName: "sandbox_write_file",
      argsDigest: sha256Digest("c".repeat(64)),
    };
    session.emit({ type: "tool.started", callId: call.callId, name: call.toolName });
    h.persistence.beforePermitIssueReturn = (input) => {
      if (input.call.callId === call.callId) {
        session.emit({ type: "message.delta", delta: "许可间事件" });
      }
    };

    await expect(h.factory.toolAuthorizers[0]?.(call)).resolves.toMatchObject({
      permit: { callId: call.callId, attemptVersion: expect.any(Number) },
    });
    await eventually(() =>
      h.persistence
        .record(h.scope)
        .events.some(
          (event) => event.kind === "agent_event" && event.payload.type === "message.delta",
        ),
    );
    const operations = h.persistence.durableOperations;
    const startedEvent = h.persistence
      .record(h.scope)
      .events.find(
        (event) => event.kind === "agent_event" && event.payload.type === "tool.started",
      );
    const deltaEvent = h.persistence
      .record(h.scope)
      .events.find(
        (event) => event.kind === "agent_event" && event.payload.type === "message.delta",
      );
    if (startedEvent === undefined || deltaEvent === undefined) throw new Error("测试事件不存在");
    const startedIndex = operations.indexOf(`mutate:attempt-1/event/${startedEvent.sequence}`);
    const issueIndex = operations.indexOf(`permit:issue:${call.callId}`);
    const consumeIndex = operations.indexOf(`permit:consume:${call.callId}`);
    const deltaIndex = operations.indexOf(`mutate:attempt-1/event/${deltaEvent.sequence}`);
    expect(startedIndex).toBeLessThan(issueIndex);
    expect(issueIndex).toBeLessThan(consumeIndex);
    expect(consumeIndex).toBeLessThan(deltaIndex);

    h.cancellation.cancel(h.scope);
    await expect(execution).resolves.toEqual({ outcome: "cancelled" });
  });

  it("工具许可消费不可用时中止执行并把普通 Sandbox 原子转交清理消费者", async () => {
    const session = new BlockingAgentSession();
    const h = sandboxHarness([session]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.toolAuthorizers.length === 1);
    const call = {
      callId: "tool-call-consume-unavailable",
      toolName: "sandbox_write_file",
      argsDigest: sha256Digest("9".repeat(64)),
    };
    session.emit({ type: "tool.started", callId: call.callId, name: call.toolName });
    h.persistence.unavailableNextPermitConsume = true;

    await expect(h.factory.toolAuthorizers[0]?.(call)).rejects.toThrow(
      "EXTERNAL_EFFECT_NOT_AUTHORIZED",
    );
    await expect(execution).resolves.toEqual({
      outcome: "recovery_required",
      code: "PERSISTENCE_UNAVAILABLE",
    });

    const record = h.persistence.record(h.scope);
    expect(h.sandboxes.settleCount).toBe(0);
    expect(record.attempt).toMatchObject({ status: "recovery_required" });
    expect(record.outbox).toContainEqual(
      expect.objectContaining({
        kind: "sandbox_cleanup",
        state: "started",
        payload: expect.objectContaining({ disposition: "close" }),
      }),
    );
  });

  it.each([
    { replayName: "sandbox_write_file", label: "同名" },
    { replayName: "sandbox_read_file", label: "异名" },
  ])(
    "Attempt 内 $label 重放 tool.started callId 时永久拒绝且不签发许可",
    async ({ replayName }) => {
      const session = new BlockingAgentSession();
      const h = harness([session]);
      const execution = h.worker.execute(h.scope);
      await eventually(() => h.factory.toolAuthorizers.length === 1);
      const callId = "tool-call-replayed-start";
      session.emit({ type: "tool.started", callId, name: "sandbox_write_file" });
      await eventually(() => {
        const mutation = [...h.persistence.record(h.scope).mutations.values()].find(
          (candidate) => candidate.receipt.effectInvocation?.callId === callId,
        );
        return mutation?.receipt.effectInvocation?.toolName === "sandbox_write_file";
      });

      session.emit({ type: "tool.started", callId, name: replayName });
      await expect(
        h.factory.toolAuthorizers[0]?.({
          callId,
          toolName: "sandbox_write_file",
          argsDigest: sha256Digest("1".repeat(64)),
        }),
      ).rejects.toThrow("EXTERNAL_EFFECT_NOT_AUTHORIZED");
      await expect(execution).resolves.toEqual({
        outcome: "recovery_required",
        code: "PROTOCOL",
      });
      expect(
        h.persistence.durableOperations.filter((item) => item === `permit:issue:${callId}`),
      ).toHaveLength(0);
    },
  );

  it.each([
    { replayDigest: "2", label: "相同参数" },
    { replayDigest: "3", label: "不同参数" },
  ])("同一 callId 已请求授权后以$label重放也永久拒绝", async ({ replayDigest }) => {
    const session = new BlockingAgentSession();
    const h = harness([session]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.toolAuthorizers.length === 1);
    const call = {
      callId: "tool-call-replayed-args",
      toolName: "sandbox_write_file",
      argsDigest: sha256Digest("2".repeat(64)),
    };
    session.emit({ type: "tool.started", callId: call.callId, name: call.toolName });

    await expect(h.factory.toolAuthorizers[0]?.(call)).resolves.toMatchObject({
      permit: { callId: call.callId },
    });
    await expect(
      h.factory.toolAuthorizers[0]?.({
        ...call,
        argsDigest: sha256Digest(replayDigest.repeat(64)),
      }),
    ).rejects.toThrow("EXTERNAL_EFFECT_NOT_AUTHORIZED");
    await expect(execution).resolves.toEqual({
      outcome: "recovery_required",
      code: "PROTOCOL",
    });
    expect(
      h.persistence.durableOperations.filter((item) => item === `permit:issue:${call.callId}`),
    ).toHaveLength(1);
    expect(
      h.persistence.durableOperations.filter((item) => item === `permit:consume:${call.callId}`),
    ).toHaveLength(1);
  });

  it("取消在已排队 tool.started 后优先阻止许可，不签发也不消费", async () => {
    const session = new BlockingAgentSession();
    const h = harness([session]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.toolAuthorizers.length === 1);
    const call = {
      callId: "tool-call-cancel-priority",
      toolName: "sandbox_write_file",
      argsDigest: sha256Digest("d".repeat(64)),
    };
    session.emit({ type: "tool.started", callId: call.callId, name: call.toolName });
    h.cancellation.cancel(h.scope);

    await expect(h.factory.toolAuthorizers[0]?.(call)).rejects.toThrow(
      "EXTERNAL_EFFECT_NOT_AUTHORIZED",
    );
    await expect(execution).resolves.toEqual({ outcome: "cancelled" });
    expect(
      h.persistence.durableOperations.some((item) => item === `permit:issue:${call.callId}`),
    ).toBe(false);
    expect(
      h.persistence.durableOperations.some((item) => item === `permit:consume:${call.callId}`),
    ).toBe(false);
  });

  it("issue 返回前发生取消时，同一 lane 在 consume 前重新检查并拒绝", async () => {
    const session = new BlockingAgentSession();
    const h = harness([session]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.toolAuthorizers.length === 1);
    const call = {
      callId: "tool-call-cancel-after-issue",
      toolName: "sandbox_write_file",
      argsDigest: sha256Digest("f".repeat(64)),
    };
    session.emit({ type: "tool.started", callId: call.callId, name: call.toolName });
    h.persistence.beforePermitIssueReturn = (input) => {
      if (input.call.callId === call.callId) h.cancellation.cancel(h.scope);
    };

    await expect(h.factory.toolAuthorizers[0]?.(call)).rejects.toThrow(
      "EXTERNAL_EFFECT_NOT_AUTHORIZED",
    );
    await expect(execution).resolves.toEqual({ outcome: "cancelled" });
    expect(h.persistence.durableOperations).toContain(`permit:issue:${call.callId}`);
    expect(h.persistence.durableOperations).not.toContain(`permit:consume:${call.callId}`);
  });

  it("lease 检查先入 lane 时优先于后续工具许可，旧 Worker 不消费许可", async () => {
    const session = new BlockingAgentSession();
    const h = harness([session]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.toolAuthorizers.length === 1);
    const call = {
      callId: "tool-call-lease-priority",
      toolName: "sandbox_write_file",
      argsDigest: sha256Digest("e".repeat(64)),
    };
    session.emit({ type: "tool.started", callId: call.callId, name: call.toolName });
    await eventually(() =>
      h.persistence
        .record(h.scope)
        .events.some(
          (event) => event.kind === "agent_event" && event.payload.type === "tool.started",
        ),
    );
    h.persistence.forceFenceLost = true;
    const heartbeat = h.clock.tickHeartbeat();

    await expect(h.factory.toolAuthorizers[0]?.(call)).rejects.toThrow(
      "EXTERNAL_EFFECT_NOT_AUTHORIZED",
    );
    await heartbeat;
    await expect(execution).resolves.toEqual({ outcome: "fence_lost" });
    expect(
      h.persistence.durableOperations.some((item) => item === `permit:consume:${call.callId}`),
    ).toBe(false);
  });

  it("settle 抛异常时保留 started cleanup checkpoint，禁止回退 pending", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.sandboxes.throwOnSettle = true;

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "SANDBOX_FAILED",
    });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("running");
    expect(record.attempt).toMatchObject({ status: "recovery_required", stage: "finalizing" });
    expect(record.outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "started" }),
    );
    expect(JSON.stringify(record.outbox)).not.toContain("上游私有");
  });

  it("settle 返回 UNKNOWN 时持久化 unknown cleanup 与告警，不自动再次 settle", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.sandboxes.nextSettlement = { outcome: "unknown", event: uncertain("cleanup_after_create") };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "SANDBOX_UNKNOWN",
    });

    const record = h.persistence.record(h.scope);
    expect(h.sandboxes.settleCount).toBe(1);
    expect(record.run.status).toBe("running");
    expect(record.outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "unknown" }),
    );
  });

  it("业务失败后的 cleanup UNKNOWN 保留原始错误码并持久化补偿事实", async () => {
    const h = sandboxHarness([
      new ScriptedAgentSession([
        { type: "agent.started" },
        { type: "error", code: "PROVIDER", message: "模型服务暂时不可用" },
        { type: "agent.settled" },
      ]),
    ]);
    h.sandboxes.nextSettlement = { outcome: "unknown", event: uncertain("cleanup_after_create") };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "PROVIDER",
    });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("running");
    expect(record.outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "unknown" }),
    );
    expect(record.events).toContainEqual(
      expect.objectContaining({
        kind: "agent_event",
        payload: expect.objectContaining({ type: "runtime.notice", code: "PROVIDER" }),
      }),
    );
  });

  it("cleanup started 已决定 close 后，completed receipt 伪造成 pause 必须失败关闭", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.persistence.rewriteNextCleanupReceiptDisposition = {
      state: "completed",
      disposition: "pause",
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "IDEMPOTENCY_CONFLICT",
    });

    expect(h.sandboxes.settleCount).toBe(1);
    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("running");
    expect(record.outbox).toContainEqual(
      expect.objectContaining({
        kind: "sandbox_cleanup",
        state: "completed",
        payload: expect.objectContaining({ disposition: "close" }),
      }),
    );
  });

  it("Sandbox acquire UNKNOWN 只进入 Attempt recovery_required，不伪造 Run failed", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.sandboxes.nextAcquire = { outcome: "unknown", event: uncertain("create_response") };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "SANDBOX_UNKNOWN",
    });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("running");
    expect(record.attempt?.status).toBe("recovery_required");
    expect(record.attempt?.stage).toBe("model_execution_started");
    expect(h.factory.createCount).toBe(1);
    expect(record.outbox).toContainEqual(
      expect.objectContaining({
        kind: "sandbox_lifecycle_unknown",
        state: "unknown",
        payload: expect.objectContaining({
          requestId: "request-test",
          sandboxId: "sandbox-test",
          actualTtlSeconds: 120,
          stage: "create_response",
        }),
      }),
    );
    expect(record.outbox.some((item) => item.kind === "sandbox_cleanup")).toBe(false);
  });

  it.each([
    {
      race: "cancel" as const,
      expectedResult: { outcome: "cancelled" } as const,
      expectedRun: "cancelled" as const,
    },
    {
      race: "timeout" as const,
      expectedResult: { outcome: "failed" } as const,
      expectedRun: "failed" as const,
    },
  ])(
    "acquire UNKNOWN 返回前发生 $race 时，先持久化恢复事实再写业务终态",
    async ({ race, expectedResult, expectedRun }) => {
      const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
      h.sandboxes.nextAcquire = { outcome: "unknown", event: uncertain("create_response") };
      h.sandboxes.beforeAcquireReturn = () => {
        if (race === "cancel") h.cancellation.cancel(h.scope);
        else h.clock.fireTimeout();
      };

      await expect(h.worker.execute(h.scope)).resolves.toEqual(expectedResult);

      const record = h.persistence.record(h.scope);
      expect(record.run.status).toBe(expectedRun);
      expect(record.outbox).toContainEqual(
        expect.objectContaining({
          kind: "sandbox_lifecycle_unknown",
          payload: expect.objectContaining({
            requestId: "request-test",
            sandboxId: "sandbox-test",
            actualTtlSeconds: 120,
            stage: "create_response",
          }),
        }),
      );
      const mutations = [...record.mutations.keys()];
      expect(mutations[0]).toBe("attempt-1/stage/model-execution-started");
      expect(mutations[1]).toBe("attempt-1/sandbox/acquire-unknown/request-test");
      expect(mutations.at(-1)).toBe(`attempt-1/final/${expectedRun}`);
      expect(h.factory.createCount).toBe(1);
    },
  );

  it("acquire UNKNOWN 没有 sandboxId/ref 时仍保留 requestId、TTL 与阶段", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    const { sandboxId: _sandboxId, ...eventWithoutSandboxId } = uncertain("create_response");
    h.sandboxes.nextAcquire = { outcome: "unknown", event: eventWithoutSandboxId };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "SANDBOX_UNKNOWN",
    });

    const unknownFact = h.persistence
      .record(h.scope)
      .outbox.find((item) => item.kind === "sandbox_lifecycle_unknown");
    expect(unknownFact).toMatchObject({
      payload: {
        requestId: "request-test",
        actualTtlSeconds: 120,
        stage: "create_response",
      },
    });
    expect(
      unknownFact?.kind === "sandbox_lifecycle_unknown" && "sandboxId" in unknownFact.payload,
    ).toBe(false);
  });

  it("settle 调用前 started 事务失败，不调用外部 settle，也不写业务终态", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.persistence.afterMutation = (command) => {
      if (command.idempotencyKey.includes("/stage/workspace-verified")) {
        h.persistence.unavailableMutationAttempts = 4;
      }
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "retryable",
      code: "PERSISTENCE_UNAVAILABLE",
    });

    expect(h.sandboxes.settleCount).toBe(0);
    expect(h.persistence.record(h.scope).run.status).toBe("running");
  });

  it("外部 settle 完成后 claim 丢失，旧 Worker 不写 completed 或 Run succeeded", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.sandboxes.beforeSettleReturn = () => h.persistence.expireRunLease(h.scope);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });

    const record = h.persistence.record(h.scope);
    expect(h.sandboxes.settleCount).toBe(1);
    expect(record.run.status).toBe("running");
    expect(record.outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "started" }),
    );
  });

  it("settle 返回后、终态事务前观察到取消时，cancelled 优先于 succeeded", async () => {
    const h = sandboxHarness(
      [new ScriptedAgentSession(successfulEvents)],
      fakeSeed("cancelled-context"),
      {
        threadContextWriteEnabled: true,
      },
    );
    const commands: RuntimeMutation[] = [];
    h.persistence.afterMutation = (command) => commands.push(command);
    h.sandboxes.beforeSettleReturn = () => h.cancellation.cancel(h.scope);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "cancelled" });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("cancelled");
    expect(record.attempt?.status).toBe("cancelled");
    expect(record.outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "completed" }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        threadContextAppend: expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              kind: "run_terminal",
              body: expect.objectContaining({
                value: expect.objectContaining({ status: "cancelled", code: "CANCELLED" }),
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("流式事件持久化单次不可用时重放同一幂等 mutation 并继续完成", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = sandboxHarness([session]);
    h.persistence.responseUnknownKeyIncludes = "/sandbox/cleanup-intent";
    // 先让按需 cleanup intent 以读回方式成功，再让第一个 agent event 失败。
    const originalRead = h.persistence.readMutation.bind(h.persistence);
    let checkpointRead = false;
    h.persistence.readMutation = async (input) => {
      const result = await originalRead(input);
      if (input.idempotencyKey.includes("sandbox/cleanup-intent")) {
        checkpointRead = true;
        h.persistence.unavailableNextMutation = true;
      }
      return result;
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    const record = h.persistence.record(h.scope);
    expect(checkpointRead).toBe(true);
    expect(session.abortCount).toBe(0);
    expect(record.run.status).toBe("succeeded");
    const firstEventKey = h.persistence.durableOperations.find((operation) =>
      operation.startsWith("mutate:attempt-1/event/"),
    );
    if (firstEventKey === undefined) throw new Error("首个流式事件 mutation 不存在");
    expect(
      h.persistence.durableOperations.filter((operation) => operation === firstEventKey),
    ).toHaveLength(2);
  });

  it("流式事件持久化连续三次不可用时等待映射恢复并继续完成", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = sandboxHarness([session]);
    h.persistence.responseUnknownKeyIncludes = "/sandbox/cleanup-intent";
    const originalRead = h.persistence.readMutation.bind(h.persistence);
    let checkpointRead = false;
    h.persistence.readMutation = async (input) => {
      const result = await originalRead(input);
      if (input.idempotencyKey.includes("sandbox/cleanup-intent")) {
        checkpointRead = true;
        h.persistence.unavailableMutationAttempts = 3;
      }
      return result;
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    const record = h.persistence.record(h.scope);
    expect(checkpointRead).toBe(true);
    expect(session.abortCount).toBe(0);
    expect(record.run.status).toBe("succeeded");
    const firstEventKey = h.persistence.durableOperations.find((operation) =>
      operation.startsWith("mutate:attempt-1/event/"),
    );
    if (firstEventKey === undefined) throw new Error("首个流式事件 mutation 不存在");
    expect(
      h.persistence.durableOperations.filter((operation) => operation === firstEventKey),
    ).toHaveLength(4);
  });

  it("流式事件持久化持续不可用时中止，并推进 cleanup intent 等待 Scheduler", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = sandboxHarness([session]);
    h.persistence.responseUnknownKeyIncludes = "/sandbox/cleanup-intent";
    const originalRead = h.persistence.readMutation.bind(h.persistence);
    h.persistence.readMutation = async (input) => {
      const result = await originalRead(input);
      if (input.idempotencyKey.includes("sandbox/cleanup-intent")) {
        h.persistence.unavailableMutationAttempts = 4;
      }
      return result;
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "PERSISTENCE_UNAVAILABLE",
    });

    const record = h.persistence.record(h.scope);
    expect(session.abortCount).toBeGreaterThanOrEqual(1);
    expect(record.run.status).toBe("running");
    expect(record.workspace.currentRevisionId).toBeUndefined();
    expect(record.outbox).toContainEqual(
      expect.objectContaining({
        kind: "sandbox_cleanup",
        state: "started",
        payload: expect.objectContaining({ disposition: "close" }),
      }),
    );
  });

  it("COMMIT 响应未知且首次读回不可用时继续幂等读回并完成 Run", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    h.persistence.responseUnknownNextMutation = true;
    const originalRead = h.persistence.readMutation.bind(h.persistence);
    let readCount = 0;
    h.persistence.readMutation = async (input) => {
      readCount += 1;
      if (readCount === 1) return { outcome: "unavailable" };
      return originalRead(input);
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(readCount).toBe(2);
    expect(h.persistence.record(h.scope).run.status).toBe("succeeded");
  });

  it("超大 adapter event 被版本协议拒绝后立即 abort，Attempt recovery_required", async () => {
    const huge = "x".repeat(70 * 1024);
    const session = new ScriptedAgentSession([
      { type: "agent.started" },
      { type: "message.delta", delta: huge },
    ]);
    const h = harness([session]);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "EVENT_REJECTED",
    });

    expect(session.abortCount).toBeGreaterThanOrEqual(1);
    expect(h.persistence.record(h.scope).run.status).toBe("running");
  });

  it("事件拒绝原子关闭入口，排队事件只 drain，并在 Sandbox 清理前 await abort", async () => {
    const session = new ScriptedAgentSession([
      { type: "agent.started" },
      { type: "message.delta", delta: "x".repeat(70 * 1024) },
      { type: "message.completed", stopReason: "stop" },
      { type: "agent.settled" },
    ]);
    session.beforeAbortReturn = async () => {
      await Promise.resolve();
    };
    const h = harness([session]);
    h.sandboxes.beforeSettleReturn = () => {
      expect(session.abortCompleted).toBe(true);
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "EVENT_REJECTED",
    });

    const agentEvents = h.persistence
      .record(h.scope)
      .events.filter((event) => event.kind === "agent_event");
    expect(agentEvents).toHaveLength(2);
    expect(agentEvents).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "runtime.notice",
          code: "EVENT_REJECTED",
          source: "terminal_fallback",
        }),
      }),
    );
    expect(
      agentEvents.some(
        (event) => event.kind === "agent_event" && event.payload.type === "message.completed",
      ),
    ).toBe(false);
    expect(session.abortCompleted).toBe(true);
  });

  it("heartbeat 单次 Promise reject 会有界重试且不覆盖 Provider 失败", async () => {
    const session = new BlockingAgentSession();
    const h = harness([session]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.createCount === 1);
    h.persistence.rejectInspectNext = true;

    await expect(h.clock.tickHeartbeat()).resolves.toBeUndefined();
    expect(session.abortCount).toBe(0);
    session.emit({ type: "error", code: "PROVIDER", message: "模型服务暂时不可用" });
    session.emit({ type: "agent.settled" });
    session.complete();
    await expect(execution).resolves.toEqual({ outcome: "failed" });
    expect(h.persistence.record(h.scope).events).toContainEqual(
      expect.objectContaining({
        kind: "agent_event",
        payload: expect.objectContaining({ type: "runtime.notice", code: "PROVIDER" }),
      }),
    );
  });

  it("heartbeat 持续不可用超过重试上限后才 stop/abort", async () => {
    const session = new BlockingAgentSession();
    const h = harness([session]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.createCount === 1);
    h.persistence.forceInspectUnavailable = true;

    await expect(h.clock.tickHeartbeat()).resolves.toBeUndefined();
    await expect(execution).resolves.toEqual({
      outcome: "recovery_required",
      code: "PERSISTENCE_UNAVAILABLE",
    });
    expect(session.abortCount).toBeGreaterThan(0);
  });

  it("经过稳定净化的 Provider 失败属于模型业务失败，可安全收尾为 Domain failed", async () => {
    const h = harness(
      [
        new ScriptedAgentSession([
          { type: "agent.started" },
          { type: "error", code: "PROVIDER", message: "上游私有请求和密钥信息" },
          { type: "agent.settled" },
        ]),
      ],
      fakeSeed("failed-context"),
      { threadContextWriteEnabled: true },
    );
    const commands: RuntimeMutation[] = [];
    h.persistence.afterMutation = (command) => commands.push(command);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "failed" });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("failed");
    expect(record.attempt?.status).toBe("failed");
    expect(record.workspace.currentRevisionId).toBeUndefined();
    expect(JSON.stringify(record.events)).not.toContain("上游私有");
    expect(record.events).toContainEqual(
      expect.objectContaining({
        kind: "agent_event",
        payload: expect.objectContaining({
          type: "runtime.notice",
          code: "PROVIDER",
          message: "模型服务调用失败，本次任务未能完成，请稍后重试。",
        }),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        threadContextAppend: expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              kind: "run_terminal",
              body: expect.objectContaining({
                value: expect.objectContaining({ status: "failed", code: "PROVIDER" }),
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("waiting 原子提交 checkpoint 与 RolloutProjection，回答后新 Session 用 prompt 启动模型", async () => {
    const projection = {
      schemaVersion: 2 as const,
      checkpointId: "checkpoint-waiting",
      items: [
        { kind: "turn" as const, role: "user" as const, text: "生成报告" },
        { kind: "turn" as const, role: "assistant" as const, text: "请补充范围" },
      ],
    };
    const waiting = new ScriptedAgentSession([{ type: "agent.started" }], {
      kind: "waiting",
      question: "请补充范围",
      rolloutProjection: projection,
    });
    const resumed = new ScriptedAgentSession(successfulEvents);
    const h = harness([waiting, resumed]);
    h.revisions.nextRevisionId = fakeRevision("revision-waiting");

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "waiting" });
    const resumedScope = h.persistence.scopeForRun(h.scope.runId);
    h.persistence.setAnswer(resumedScope, "只处理 Markdown");
    await expect(h.worker.execute(resumedScope)).resolves.toEqual({ outcome: "succeeded" });

    expect(resumed.prompts).toEqual(["只处理 Markdown"]);
    expect(h.factory.projections[1]).toEqual(projection);
    expect(h.persistence.record(resumedScope).run.status).toBe("succeeded");
  });

  it("model_execution_started 后租约过期由 Worker 入口自动收敛且不会重跑模型", async () => {
    const h = harness([]);
    const claimed = await h.persistence.claim({
      scope: h.scope,
      workerId: "crashed-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("测试 claim 失败");
    const event: RuntimeEventV1 = {
      schemaVersion: 1,
      kind: "attempt_state_changed",
      sequence: 0,
      payload: { status: "running", stage: "model_execution_started" },
    };
    await h.persistence.mutate(
      signedMutation({
        idempotencyKey: `${claimed.snapshot.attempt.attemptId}/stage/model-execution-started`,
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        nextAttemptStatus: "running",
        nextStage: "model_execution_started",
        events: [event],
        outbox: [],
      }),
    );
    h.persistence.advanceDatabase(31_000);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "INTERNAL",
    });
    // Dispatch ack 结果未知时再次进入同一路径必须幂等收敛，不能重新武装模型。
    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "INTERNAL",
    });
    const record = h.persistence.record(h.scope);
    expect(record.attempt?.status).toBe("recovery_required");
    expect(record.run.status).toBe("running");
    expect(h.factory.createCount).toBe(0);
  });

  it("inspect/renew 只延长过期时间，不更换 claim、Workspace lease 或运行态", async () => {
    const h = harness([]);
    const claimed = await h.persistence.claim({
      scope: h.scope,
      workerId: "renew-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("测试 claim 失败");

    const first = await h.persistence.inspectAndRenew({
      fence: claimed.fence,
      leaseDurationMs: 30_000,
    });
    if (first.outcome !== "active") throw new Error("第一次续租失败");
    const second = await h.persistence.inspectAndRenew({
      fence: first.fence,
      leaseDurationMs: 30_000,
    });
    if (second.outcome !== "active") throw new Error("第二次续租失败");

    expect(second.run.status).toBe("running");
    expect(second.fence.runClaim).toMatchObject({
      token: claimed.fence.runClaim.token,
      epoch: claimed.fence.runClaim.epoch,
    });
    expect(second.fence.workspaceLease).toMatchObject({
      rootRunId: claimed.fence.workspaceLease.rootRunId,
      epoch: claimed.fence.workspaceLease.epoch,
    });
    expect(Date.parse(first.fence.runClaim.expiresAt)).toBeGreaterThan(
      Date.parse(claimed.fence.runClaim.expiresAt),
    );
    expect(Date.parse(second.fence.runClaim.expiresAt)).toBeGreaterThan(
      Date.parse(first.fence.runClaim.expiresAt),
    );
    expect(second.workspace.writerLease).toEqual(second.fence.workspaceLease);
  });

  it("副作用许可绑定调用内容且只能消费一次，Attempt 版本推进后旧许可失效", async () => {
    const h = harness([]);
    const claimed = await h.persistence.claim({
      scope: h.scope,
      workerId: "permit-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("测试 claim 失败");
    const call = {
      callId: "call-1",
      toolName: "sandbox_write_file",
      argsDigest: sha256Digest("b".repeat(64)),
    };
    const registerInvocation = async (
      invocation: typeof call,
      expectedAttemptVersion: number,
      sequence: number,
    ) =>
      await h.persistence.mutate(
        signedMutation({
          idempotencyKey: `register-${invocation.callId}`,
          fence: claimed.fence,
          expectedAttemptVersion,
          events: [
            {
              schemaVersion: 1,
              kind: "agent_event",
              sequence,
              payload: {
                type: "tool.started",
                callId: invocation.callId,
                name: invocation.toolName,
              },
            },
          ],
          outbox: [],
          effectInvocation: { callId: invocation.callId, toolName: invocation.toolName },
        }),
      );
    await expect(registerInvocation(call, 0, 0)).resolves.toMatchObject({ outcome: "applied" });
    const issued = await h.persistence.issueExternalEffectPermit({
      fence: claimed.fence,
      expectedAttemptVersion: 1,
      effect: "tool_execution",
      call,
      permitDurationMs: 1_000,
    });
    if (issued.outcome !== "authorized") throw new Error("测试许可签发失败");
    expect(issued.permit).toMatchObject({
      scope: h.scope,
      attemptVersion: 1,
      effect: "tool_execution",
      ...call,
    });
    await expect(
      h.persistence.consumeExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        permit: issued.permit,
      }),
    ).resolves.toMatchObject({ outcome: "consumed" });
    await expect(
      h.persistence.consumeExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        permit: issued.permit,
      }),
    ).resolves.toEqual({ outcome: "already_consumed" });

    const staleCall = { ...call, callId: "call-stale" };
    await expect(registerInvocation(staleCall, 1, 1)).resolves.toMatchObject({
      outcome: "applied",
    });
    const stale = await h.persistence.issueExternalEffectPermit({
      fence: claimed.fence,
      expectedAttemptVersion: 2,
      effect: "tool_execution",
      call: staleCall,
      permitDurationMs: 1_000,
    });
    if (stale.outcome !== "authorized") throw new Error("测试旧许可签发失败");
    await h.persistence.mutate(
      signedMutation({
        idempotencyKey: "advance-attempt-version",
        fence: claimed.fence,
        expectedAttemptVersion: 2,
        events: [],
        outbox: [],
      }),
    );
    await expect(
      h.persistence.consumeExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 2,
        permit: stale.permit,
      }),
    ).resolves.toEqual({ outcome: "conflict" });

    const expiringCall = { ...call, callId: "call-expiring" };
    await expect(registerInvocation(expiringCall, 3, 2)).resolves.toMatchObject({
      outcome: "applied",
    });
    const expiring = await h.persistence.issueExternalEffectPermit({
      fence: claimed.fence,
      expectedAttemptVersion: 4,
      effect: "tool_execution",
      call: expiringCall,
      permitDurationMs: 1_000,
    });
    if (expiring.outcome !== "authorized") throw new Error("测试过期许可签发失败");
    expect(Date.parse(expiring.permit.expiresAt)).toBeGreaterThan(
      Date.parse(expiring.permit.issuedAt),
    );
    h.persistence.advanceDatabase(1_001);
    await expect(
      h.persistence.consumeExternalEffectPermit({
        fence: claimed.fence,
        expectedAttemptVersion: 4,
        permit: expiring.permit,
      }),
    ).resolves.toEqual({ outcome: "expired" });
  });

  it.each(["sandbox_write_file", "sandbox_read_file"])(
    "持久层对 Attempt+callId 永久唯一，重放为 %s 也返回幂等冲突",
    async (replayedToolName) => {
      const h = harness([]);
      const claimed = await h.persistence.claim({
        scope: h.scope,
        workerId: "invocation-worker",
        leaseDurationMs: 30_000,
      });
      if (claimed.outcome !== "claimed") throw new Error("测试 claim 失败");
      const firstCommand = signedMutation({
        idempotencyKey: "invocation-first",
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        effectInvocation: { callId: "permanent-call", toolName: "sandbox_write_file" },
        events: [
          {
            schemaVersion: 1,
            kind: "agent_event",
            sequence: 0,
            payload: {
              type: "tool.started",
              callId: "permanent-call",
              name: "sandbox_write_file",
            },
          },
        ],
        outbox: [],
      });
      const first = await h.persistence.mutate(firstCommand);
      expect(first).toMatchObject({
        outcome: "applied",
        receipt: {
          effectInvocation: { callId: "permanent-call", toolName: "sandbox_write_file" },
        },
      });
      await expect(h.persistence.mutate(firstCommand)).resolves.toEqual({
        outcome: "idempotency_conflict",
      });

      await expect(
        h.persistence.mutate(
          signedMutation({
            idempotencyKey: `invocation-replay-${replayedToolName}`,
            fence: claimed.fence,
            expectedAttemptVersion: 1,
            effectInvocation: { callId: "permanent-call", toolName: replayedToolName },
            events: [
              {
                schemaVersion: 1,
                kind: "agent_event",
                sequence: 1,
                payload: {
                  type: "tool.started",
                  callId: "permanent-call",
                  name: replayedToolName,
                },
              },
            ],
            outbox: [],
          }),
        ),
      ).resolves.toEqual({ outcome: "idempotency_conflict" });
      expect(h.persistence.record(h.scope).events).toHaveLength(1);
    },
  );

  it("mutation receipt 固定命令摘要与推进量，同一幂等键不同摘要稳定冲突", async () => {
    const h = harness([]);
    const claimed = await h.persistence.claim({
      scope: h.scope,
      workerId: "receipt-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("测试 claim 失败");
    const command = signedMutation({
      idempotencyKey: "receipt-key",
      fence: claimed.fence,
      expectedAttemptVersion: 0,
      events: [],
      outbox: [],
    });
    const first = await h.persistence.mutate(command);
    if (first.outcome !== "applied") throw new Error("首次 mutation 失败");
    expect(first.receipt).toEqual({
      schemaVersion: 1,
      idempotencyKey: "receipt-key",
      commandDigest: command.commandDigest,
      previousAttemptVersion: 0,
      attemptVersion: 1,
      eventSequenceStart: 0,
      eventSequenceEnd: 0,
      outbox: [],
    });
    await expect(h.persistence.mutate(command)).resolves.toMatchObject({
      outcome: "already_applied",
      receipt: first.receipt,
    });
    await expect(
      h.persistence.mutate(
        signedMutation({
          idempotencyKey: command.idempotencyKey,
          fence: command.fence,
          expectedAttemptVersion: command.expectedAttemptVersion,
          events: command.events,
          outbox: command.outbox,
          nextStage: "workspace_verified",
        }),
      ),
    ).resolves.toEqual({ outcome: "idempotency_conflict" });
  });

  it("RolloutProjection 使用独立版本 CAS，并在 receipt 中返回版本与摘要", async () => {
    const h = harness([]);
    const claimed = await h.persistence.claim({
      scope: h.scope,
      workerId: "projection-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("测试 claim 失败");
    const projection = {
      schemaVersion: 2 as const,
      checkpointId: "projection-receipt",
      items: [{ kind: "turn" as const, role: "user" as const, text: "继续" }],
    };
    const applied = await h.persistence.mutate(
      signedMutation({
        idempotencyKey: "projection-first",
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        expectedProjectionVersion: 0,
        events: [],
        outbox: [],
        rolloutProjection: projection,
      }),
    );
    if (applied.outcome !== "applied") throw new Error("投影 mutation 失败");
    expect(applied.receipt.projection).toMatchObject({
      previousVersion: 0,
      version: 1,
      digest: rolloutProjectionDigest(projection),
    });
    expect(applied.attempt.projectionVersion).toBe(1);
    await expect(
      h.persistence.mutate(
        signedMutation({
          idempotencyKey: "projection-stale",
          fence: claimed.fence,
          expectedAttemptVersion: 1,
          expectedProjectionVersion: 0,
          events: [],
          outbox: [],
          rolloutProjection: { ...projection, checkpointId: "projection-stale" },
        }),
      ),
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("heartbeat 非重入，stop 会等待唯一在途续租结束", async () => {
    const blocked = new BlockingAgentSession();
    const h = harness([blocked]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.createCount === 1);
    const originalInspect = h.persistence.inspectAndRenew.bind(h.persistence);
    let releaseInspect: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (releaseInspect = resolve));
    let concurrent = 0;
    let maximumConcurrent = 0;
    h.persistence.inspectAndRenew = async (input) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await gate;
      try {
        return await originalInspect(input);
      } finally {
        concurrent -= 1;
      }
    };

    const firstTick = h.clock.tickHeartbeat();
    await eventually(() => concurrent === 1);
    const secondTick = h.clock.tickHeartbeat();
    await Promise.resolve();
    expect(maximumConcurrent).toBe(1);
    h.cancellation.cancel(h.scope);
    releaseInspect?.();
    await Promise.all([firstTick, secondTick]);
    await expect(execution).resolves.toEqual({ outcome: "cancelled" });
    expect(maximumConcurrent).toBe(1);
  });

  it("Sandbox 与 Workspace 异常分别映射稳定错误码", async () => {
    const acquire = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    acquire.sandboxes.nextAcquire = { outcome: "failed", code: "SANDBOX_FAILED" };
    await expect(acquire.worker.execute(acquire.scope)).resolves.toEqual({
      outcome: "failed",
    });
    expect(acquire.persistence.record(acquire.scope).run.status).toBe("failed");
    expect(acquire.persistence.record(acquire.scope).attempt?.status).toBe("failed");
    expect(acquire.persistence.record(acquire.scope).fence).toBeUndefined();

    const workspace = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    workspace.revisions.beforeReturn = () => {
      throw new Error("私有 Workspace 异常");
    };
    await expect(workspace.worker.execute(workspace.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "WORKSPACE_CONFLICT",
    });
  });

  it("Thread Sandbox 的确定性创建失败终止 Run，后续任务不再排队", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)], fakeSeed(), {
      threadSandboxSessionReuseEnabled: true,
    });
    h.threadSandboxes.nextAcquire = { outcome: "failed", code: "SANDBOX_FAILED" };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "failed" });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("failed");
    expect(record.attempt?.status).toBe("failed");
    expect(record.attempt?.stage).toBe("finished");
    expect(record.fence).toBeUndefined();
    expect(record.outbox.some((item) => item.kind === "sandbox_lifecycle_unknown")).toBe(false);
  });

  it("Workspace verify 日志只接受固定 diagnostic，伪造值不会离开边界", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.beforeReturn = () => {
      throw new WorkspaceApplicationError(
        "DEPENDENCY_FAILED",
        "内部错误",
        "credential_like_diagnostic" as never,
      );
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(h.worker.execute(h.scope)).resolves.toEqual({
        outcome: "recovery_required",
        code: "WORKSPACE_CONFLICT",
      });
      expect(warning).toHaveBeenCalledWith(
        "WORKSPACE_VERIFY_FAILED category=application_dependency_failed",
      );
      expect(warning.mock.calls.flat().join(" ")).not.toContain("credential_like_diagnostic");
    } finally {
      warning.mockRestore();
    }
  });

  it("Workspace 日志对伪造 code、result 与 diagnostic 一律输出 unclassified", async () => {
    const canary = "credential-canary\nforged-category";
    const application = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    application.revisions.beforeReturn = () => {
      throw new WorkspaceApplicationError(canary as never, "内部错误", canary as never);
    };
    const dependency = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    dependency.revisions.beforeReturn = () => {
      throw new WorkspaceDependencyError(canary as never, "内部依赖错误");
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const target of [application, dependency]) {
        await expect(target.worker.execute(target.scope)).resolves.toEqual({
          outcome: "recovery_required",
          code: "WORKSPACE_CONFLICT",
        });
      }
      expect(warning).toHaveBeenCalledWith("WORKSPACE_VERIFY_FAILED category=unclassified");
      expect(warning.mock.calls.flat().join(" ")).not.toContain(canary);
    } finally {
      warning.mockRestore();
    }
  });

  it("模型完成后 Run 与 Attempt 均进入成功终态", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = harness([session]);
    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.factory.createCount).toBe(1);
    expect(session.prompts).toHaveLength(1);
    expect(h.persistence.permits).toHaveLength(1);
    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("succeeded");
    expect(record.attempt).toMatchObject({ status: "succeeded" });
    expect(record.mutations.has("attempt-1/final/succeeded")).toBe(true);
  });

  it("跨 Tenant scope 被拒绝且不泄漏或改写原记录", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    const attacker: ExecutionScope = { ...h.scope, tenantId: tenantId("tenant-attacker") };

    await expect(h.worker.execute(attacker)).resolves.toEqual({
      outcome: "ignored",
      reason: "scope_mismatch",
    });

    expect(h.persistence.record(h.scope).run.status).toBe("queued");
    expect(h.sandboxes.acquireCount).toBe(0);
  });

  it("DB 在同一事务时钟内生成事件与 Revision 时间，Worker command 不携带时间", async () => {
    const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.nextRevisionId = fakeRevision("revision-db-clock");
    const commands: unknown[] = [];
    h.persistence.afterMutation = (command) => commands.push(command);
    h.persistence.advanceDatabase(1_234);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(JSON.stringify(commands)).not.toContain("occurredAt");
    expect(JSON.stringify(commands)).not.toContain("createdAt");
    const record = h.persistence.record(h.scope);
    expect(new Set(record.events.map((event) => event.occurredAt))).toEqual(
      new Set(["2026-07-26T00:00:01.234Z"]),
    );
    expect(h.persistence.revisionCreatedAt).toEqual(["2026-07-26T00:00:01.234Z"]);
  });

  it("cleanup armed 永久不可逆，pending 不含处置，started 一次决定后不可更换", async () => {
    const h = harness([]);
    const claimed = await h.persistence.claim({
      scope: h.scope,
      workerId: "outbox-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("测试 claim 失败");
    const base = {
      schemaVersion: 1 as const,
      kind: "sandbox_cleanup" as const,
      idempotencyKey: "cleanup-monotonic",
      armed: true as const,
      payload: {
        registryId: "registry-test",
        providerKey: "cube" as const,
        providerSandboxId: "sandbox-test",
      },
    };
    const pending = await h.persistence.mutate(
      signedMutation({
        idempotencyKey: "mutation-pending",
        fence: claimed.fence,
        expectedAttemptVersion: 0,
        events: [],
        outbox: [{ ...base, state: "pending" }],
      }),
    );
    expect(pending.outcome).toBe("applied");
    await expect(
      h.persistence.mutate(
        signedMutation({
          idempotencyKey: "mutation-unarmed",
          fence: claimed.fence,
          expectedAttemptVersion: 1,
          events: [],
          outbox: [{ ...base, state: "pending", armed: false as true }],
        }),
      ),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      h.persistence.mutate(
        signedMutation({
          idempotencyKey: "mutation-forged-armed-at",
          fence: claimed.fence,
          expectedAttemptVersion: 1,
          events: [],
          outbox: [
            {
              ...base,
              state: "pending",
              armedAt: "2020-01-01T00:00:00.000Z",
            } as never,
          ],
        }),
      ),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      h.persistence.mutate(
        signedMutation({
          idempotencyKey: "mutation-pending-with-disposition",
          fence: claimed.fence,
          expectedAttemptVersion: 1,
          events: [],
          outbox: [
            {
              ...base,
              state: "pending",
              payload: { ...base.payload, disposition: "close" },
            } as never,
          ],
        }),
      ),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      h.persistence.mutate(
        signedMutation({
          idempotencyKey: "mutation-changed-identity",
          fence: claimed.fence,
          expectedAttemptVersion: 1,
          events: [],
          outbox: [
            {
              ...base,
              state: "started",
              payload: {
                ...base.payload,
                providerSandboxId: "sandbox-forged",
                disposition: "close",
              },
            },
          ],
        }),
      ),
    ).resolves.toEqual({ outcome: "conflict" });
    h.persistence.advanceDatabase(1_000);
    const started = await h.persistence.mutate(
      signedMutation({
        idempotencyKey: "mutation-started",
        fence: claimed.fence,
        expectedAttemptVersion: 1,
        events: [],
        outbox: [{ ...base, state: "started", payload: { ...base.payload, disposition: "close" } }],
      }),
    );
    expect(started.outcome).toBe("applied");
    if (pending.outcome !== "applied" || started.outcome !== "applied") {
      throw new Error("cleanup 测试 mutation 失败");
    }
    expect(started.receipt.outbox[0]).toMatchObject({
      armed: true,
      armedAt:
        pending.receipt.outbox[0]?.kind === "sandbox_cleanup"
          ? pending.receipt.outbox[0].armedAt
          : undefined,
      disposition: "close",
    });
    const startedReceipt = started.receipt.outbox[0];
    if (startedReceipt?.kind !== "sandbox_cleanup") throw new Error("started receipt 缺失");
    expect(startedReceipt.payloadDigest).toBe(
      outboxPayloadDigest(
        {
          ...base,
          state: "started",
          payload: { ...base.payload, disposition: "close" },
        },
        startedReceipt.armedAt,
      ),
    );
    await expect(
      h.persistence.mutate(
        signedMutation({
          idempotencyKey: "mutation-change-disposition",
          fence: claimed.fence,
          expectedAttemptVersion: 2,
          events: [],
          outbox: [
            { ...base, state: "started", payload: { ...base.payload, disposition: "pause" } },
          ],
        }),
      ),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      h.persistence.mutate(
        signedMutation({
          idempotencyKey: "mutation-disarm-started",
          fence: claimed.fence,
          expectedAttemptVersion: 2,
          events: [],
          outbox: [
            {
              ...base,
              armed: false as true,
              state: "started",
              payload: { ...base.payload, disposition: "close" },
            },
          ],
        }),
      ),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      h.persistence.mutate(
        signedMutation({
          idempotencyKey: "mutation-regression",
          fence: claimed.fence,
          expectedAttemptVersion: 2,
          events: [],
          outbox: [{ ...base, state: "pending" }],
        }),
      ),
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("超时在安全点清理 Sandbox 后只使用 Domain failed 终态", async () => {
    const blocked = new BlockingAgentSession();
    const h = sandboxHarness([blocked]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.createCount === 1);
    h.clock.fireTimeout();

    await expect(execution).resolves.toEqual({ outcome: "failed" });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("failed");
    expect(record.attempt?.status).toBe("failed");
    expect(record.outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "completed" }),
    );
  });
});

function uncertain(stage: UncertainLifecycleEvent["stage"]): UncertainLifecycleEvent {
  return {
    providerKey: "cube",
    kind: "sandbox_create_outcome_unknown",
    stage,
    requestId: "request-test",
    sandboxId: "sandbox-test",
    actualTtlSeconds: 120,
    occurredAt: "2026-07-26T00:00:00.000Z",
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("等待测试条件超时");
}

function signedMutation(
  input: Omit<RuntimeMutation, "schemaVersion" | "commandDigest">,
): RuntimeMutation {
  const unsigned = { ...input, schemaVersion: 1 as const };
  return { ...unsigned, commandDigest: runtimeMutationDigest(unsigned) };
}

it("personal Tenant 在模型执行前获得固定历史目录入口", async () => {
  const h = sandboxHarness(
    [new ScriptedAgentSession(successfulEvents)],
    fakeSeed("personal-history-entrypoints"),
    { historyFilesystemEnabled: true },
  );

  await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

  expect(h.sandboxes.handle.commands).toHaveLength(1);
  expect(h.sandboxes.handle.commands[0]).toContain("ensure_link /history");
  expect(h.sandboxes.handle.commands[0]).toContain("prepare_thread_entrypoint");
  expect(h.sandboxes.handle.commands[0]).not.toContain('[ -d "$thread_target" ]');
  expect(h.sandboxes.handle.commands[0]).not.toContain('install -d -m 0555 "$link"');
  expect(h.sandboxes.handle.commands[0]).toContain('ln -s "$thread_target" "$link"');
  expect(h.sandboxes.handle.commands[0]).toContain(
    `/resources/.thread-files/${h.scope.threadId}/files`,
  );
});

it("team Tenant 与个人空间一样获得当前 Tenant 的历史目录入口", async () => {
  const seed = {
    ...fakeSeed("team-history-entrypoints"),
    tenantKind: "team" as const,
  };
  const h = sandboxHarness([new ScriptedAgentSession(successfulEvents)], seed, {
    historyFilesystemEnabled: true,
  });

  await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

  expect(h.sandboxes.handle.commands).toHaveLength(1);
  expect(h.sandboxes.handle.commands[0]).toContain("ensure_link /history");
  expect(h.sandboxes.handle.commands[0]).toContain(
    `/resources/.thread-files/${h.scope.threadId}/files`,
  );
});

it("personal 历史固定入口准备失败时不启动模型并失败关闭", async () => {
  const session = new ScriptedAgentSession(successfulEvents);
  const h = sandboxHarness([session], fakeSeed("personal-history-entrypoints-failure"), {
    historyFilesystemEnabled: true,
  });
  vi.spyOn(h.sandboxes.handle, "command").mockResolvedValue({
    stdout: "",
    stderr: "history root missing",
    exitCode: 71,
  });

  await expect(h.worker.execute(h.scope)).resolves.toEqual({
    outcome: "recovery_required",
    code: "SANDBOX_FAILED",
  });

  expect(session.prompts).toEqual([]);
});
