import { sha256Digest, tenantId } from "@cube-runtime/domain";
import type { RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import type { UncertainLifecycleEvent } from "@cube-runtime/sandbox";
import { createWorkspaceManifest } from "@cube-runtime/workspace";
import { describe, expect, it } from "vitest";
import {
  outboxPayloadDigest,
  rolloutProjectionDigest,
  runtimeMutationDigest,
  sandboxCleanupIdentityDigest,
  workspaceChangeDigest,
} from "./mutation-protocol.js";
import type { ExecutionScope, RuntimeEventV1, RuntimeMutation } from "./ports.js";
import { RunWorker, type RunWorkerOptions } from "./run-worker.js";
import {
  BlockingAgentSession,
  FakeArtifactPublication,
  FakeCancellationPort,
  FakeClock,
  FakeExecutionPersistence,
  FakeRecoveryMetrics,
  FakeRevisionVerifier,
  FakeSandboxRegistry,
  FakeSessionFactory,
  fakeRevision,
  fakeSeed,
  ScriptedAgentSession,
} from "./testing/fakes.js";

const successfulEvents: readonly RuntimeAgentEvent[] = [
  { type: "agent.started" },
  { type: "message.delta", delta: "完成" },
  { type: "message.completed", stopReason: "stop" },
  { type: "agent.settled" },
];

function harness(
  sessions: Array<ScriptedAgentSession | BlockingAgentSession>,
  seed = fakeSeed(),
  workerOptions: Partial<RunWorkerOptions> = {},
) {
  const persistence = new FakeExecutionPersistence();
  const scope = persistence.addSeed(seed);
  const revisions = new FakeRevisionVerifier();
  const sandboxes = new FakeSandboxRegistry();
  const factory = new FakeSessionFactory(sessions);
  const cancellation = new FakeCancellationPort();
  const shutdown = new AbortController();
  const artifacts = new FakeArtifactPublication();
  const clock = new FakeClock();
  const metrics = new FakeRecoveryMetrics();
  const worker = new RunWorker(
    {
      persistence,
      revisions,
      sandboxes,
      orphanSandboxes: sandboxes,
      sessions: factory,
      cancellation,
      shutdownSignal: shutdown.signal,
      artifacts,
      clock,
      metrics,
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
    artifacts,
    clock,
    metrics,
  };
}

describe("Run Worker 双栅栏与恢复状态机", () => {
  it("Artifact 修正轮次与反馈总预算不能配置为超过硬上限", () => {
    expect(() =>
      harness([], fakeSeed("artifact-round-limit"), { maxArtifactCorrectionRounds: 3 }),
    ).toThrow("maxArtifactCorrectionRounds 必须是 0 到 2 的安全整数");
    expect(() =>
      harness([], fakeSeed("artifact-budget-limit"), {
        artifactCorrectionPromptBudgetBytes: 8 * 1_024 + 1,
      }),
    ).toThrow("artifactCorrectionPromptBudgetBytes 必须是 1 到 8192 的安全整数");
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

  it("在创建 Session 前物化 Workspace；物化失败会走 cleanup，绝不启动模型", async () => {
    const h = harness(
      [new ScriptedAgentSession(successfulEvents)],
      fakeSeed("materialize-before-model"),
    );
    h.revisions.beforeMaterializeReturn = () => {
      expect(h.factory.createCount).toBe(0);
    };
    h.revisions.throwOnMaterialize = true;

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "WORKSPACE_CONFLICT",
    });

    expect(h.revisions.materializeCount).toBe(1);
    expect(h.factory.createCount).toBe(0);
    expect(h.sandboxes.settleCount).toBe(1);
  });

  it("Revision、Run succeeded、Attempt 终态和双栅栏释放在同一幂等事务完成", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.nextRevisionId = fakeRevision("revision-success");

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.revisions.materializeCount).toBe(1);

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
    expect(mutations.indexOf("attempt-1/sandbox/cleanup-intent")).toBeLessThan(
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
        payload: { registryId: "registry-test", providerSandboxId: "worker-fake" },
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
        candidateOperationKey: "attempt-1/workspace/publish/0",
        candidateOperationDigest: "0".repeat(64) as ReturnType<typeof sha256Digest>,
        manifest: createWorkspaceManifest(
          { tenantId: h.scope.tenantId, entries: [] },
          { maxFiles: 1, maxTotalBytes: 1 },
        ),
      }),
      currentHead: fakeRevision("revision-success"),
    });
  });

  it("重复投递不能重领 running Run，也不会创建第二个 Sandbox 或模型 Session", async () => {
    const blocked = new BlockingAgentSession();
    const h = harness([blocked]);
    const first = h.worker.execute(h.scope);
    await eventually(() => h.factory.createCount === 1);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "ignored",
      reason: "busy",
    });
    expect(h.sandboxes.acquireCount).toBe(1);
    expect(h.factory.createCount).toBe(1);

    h.cancellation.cancel(h.scope);
    await expect(first).resolves.toEqual({ outcome: "cancelled" });
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
      const h = harness([new ScriptedAgentSession(successfulEvents)]);
      h.sandboxes.beforeAcquireReturn = () => {
        if (lease === "run") h.persistence.expireRunLease(h.scope);
        else h.persistence.expireWorkspaceLease(h.scope);
      };

      await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });

      expect(h.sandboxes.acquireCount).toBe(1);
      expect(h.sandboxes.settleCount).toBe(1);
      expect(h.factory.createCount).toBe(0);
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
      const h = harness([new ScriptedAgentSession(successfulEvents)]);
      h.sandboxes.beforeAcquireReturn = () => {
        if (failure === "unavailable") h.persistence.unavailableNextMutation = true;
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
      expect(h.factory.createCount).toBe(0);
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
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
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
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.nextRevisionId = fakeRevision("revision-never-commit");
    h.revisions.beforeReturn = () => h.persistence.expireWorkspaceLease(h.scope);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });

    const record = h.persistence.record(h.scope);
    expect(h.revisions.verifyCount).toBe(1);
    expect(record.workspace.currentRevisionId).toBeUndefined();
    expect(record.run.status).toBe("running");
  });

  it("verify 调用前丢 Workspace lease，Verifier 完全不会被调用", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    h.persistence.afterMutation = (command) => {
      if (command.idempotencyKey.includes("/stage/model-settled")) {
        h.persistence.expireWorkspaceLease(h.scope);
      }
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });

    expect(h.revisions.verifyCount).toBe(0);
    expect(h.persistence.record(h.scope).workspace.currentRevisionId).toBeUndefined();
  });

  it("verify 完成后、Artifact 外部调用返回时丢 claim，Revision 仍未提交", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.nextRevisionId = fakeRevision("revision-after-verify");
    h.artifacts.beforeReturn = () => h.persistence.expireRunLease(h.scope);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });

    const record = h.persistence.record(h.scope);
    expect(h.artifacts.calls).toBe(1);
    expect(record.workspace.currentRevisionId).toBeUndefined();
    expect(record.run.status).toBe("running");
  });

  it("Revision+终态事务响应丢失时按幂等键读回，不重复提交 Revision", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
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
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
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
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
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
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
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

  it("cleanup started 已决定 close 后，completed receipt 伪造成 pause 必须失败关闭", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
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
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    h.sandboxes.nextAcquire = { outcome: "unknown", event: uncertain("create_response") };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "SANDBOX_UNKNOWN",
    });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("running");
    expect(record.attempt?.status).toBe("recovery_required");
    expect(record.attempt?.stage).toBe("claimed");
    expect(h.factory.createCount).toBe(0);
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
      const h = harness([new ScriptedAgentSession(successfulEvents)]);
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
      expect(mutations[0]).toBe("attempt-1/sandbox/acquire-unknown/request-test");
      expect(mutations.at(-1)).toBe(`attempt-1/final/${expectedRun}`);
      expect(h.factory.createCount).toBe(0);
    },
  );

  it("acquire UNKNOWN 没有 sandboxId/ref 时仍保留 requestId、TTL 与阶段", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
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
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    h.artifacts.beforeReturn = () => {
      h.persistence.unavailableNextMutation = true;
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "retryable",
      code: "PERSISTENCE_UNAVAILABLE",
    });

    expect(h.sandboxes.settleCount).toBe(0);
    expect(h.persistence.record(h.scope).run.status).toBe("running");
  });

  it("外部 settle 完成后 claim 丢失，旧 Worker 不写 completed 或 Run succeeded", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
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
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    h.sandboxes.beforeSettleReturn = () => h.cancellation.cancel(h.scope);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "cancelled" });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("cancelled");
    expect(record.attempt?.status).toBe("cancelled");
    expect(record.outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "completed" }),
    );
  });

  it("流式事件持久化不可用时立即 abort，保留 cleanup intent 并等待 Attempt 恢复", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = harness([session]);
    h.persistence.responseUnknownKeyIncludes = "/stage/model-execution-started";
    // 先让 checkpoint 以读回方式成功，再让第一个 agent event 失败。
    const originalRead = h.persistence.readMutation.bind(h.persistence);
    let checkpointRead = false;
    h.persistence.readMutation = async (input) => {
      const result = await originalRead(input);
      if (input.idempotencyKey.includes("model-execution-started")) {
        checkpointRead = true;
        h.persistence.unavailableNextMutation = true;
      }
      return result;
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "PERSISTENCE_UNAVAILABLE",
    });

    const record = h.persistence.record(h.scope);
    expect(checkpointRead).toBe(true);
    expect(session.abortCount).toBeGreaterThanOrEqual(1);
    expect(record.run.status).toBe("running");
    expect(record.workspace.currentRevisionId).toBeUndefined();
    expect(record.outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "pending" }),
    );
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
    expect(agentEvents).toHaveLength(1);
    expect(session.abortCompleted).toBe(true);
  });

  it("heartbeat Promise reject 被捕获并触发 stop/abort，不形成未处理拒绝", async () => {
    const session = new BlockingAgentSession();
    const h = harness([session]);
    const execution = h.worker.execute(h.scope);
    await eventually(() => h.factory.createCount === 1);
    h.persistence.rejectInspectNext = true;

    await expect(h.clock.tickHeartbeat()).resolves.toBeUndefined();
    await expect(execution).resolves.toEqual({
      outcome: "recovery_required",
      code: "PERSISTENCE_UNAVAILABLE",
    });
    expect(session.abortCount).toBeGreaterThan(0);
  });

  it("经过稳定净化的 Provider 失败属于模型业务失败，可安全收尾为 Domain failed", async () => {
    const h = harness([
      new ScriptedAgentSession([
        { type: "agent.started" },
        { type: "error", code: "PROVIDER", message: "上游私有请求和密钥信息" },
        { type: "agent.settled" },
      ]),
    ]);

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "failed" });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("failed");
    expect(record.attempt?.status).toBe("failed");
    expect(record.workspace.currentRevisionId).toBeUndefined();
    expect(JSON.stringify(record.events)).not.toContain("上游私有");
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

  it("model_execution_started 后崩溃不会自动重跑，恢复协调器强制 recovery_required", async () => {
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

    await expect(
      h.persistence.recoverExpiredAttempt({ scope: h.scope, decision: "safe_fail" }),
    ).resolves.toBe("recovered");
    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "ignored",
      reason: "recovery_required",
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

  it("Sandbox、Workspace 与 Artifact 异常分别映射稳定错误码", async () => {
    const acquire = harness([new ScriptedAgentSession(successfulEvents)]);
    acquire.sandboxes.beforeAcquireReturn = () => {
      throw new Error("私有 Sandbox 异常");
    };
    await expect(acquire.worker.execute(acquire.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "SANDBOX_FAILED",
    });

    const workspace = harness([new ScriptedAgentSession(successfulEvents)]);
    workspace.revisions.beforeReturn = () => {
      throw new Error("私有 Workspace 异常");
    };
    await expect(workspace.worker.execute(workspace.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "WORKSPACE_CONFLICT",
    });

    const artifactSession = new ScriptedAgentSession(successfulEvents);
    const artifact = harness([artifactSession]);
    artifact.artifacts.beforeReturn = () => {
      throw new Error("私有 Artifact 异常");
    };
    await expect(artifact.worker.execute(artifact.scope)).resolves.toEqual({
      outcome: "failed",
    });
    expect(artifact.artifacts.calls).toBe(3);
    expect(artifactSession.prompts).toHaveLength(3);
    expect(artifactSession.prompts[1]).toContain("Artifact 完成门未通过（修正轮次 1/2）");
  });

  it("完成门缺失时持久反馈并在同一 Session 修正，发布就绪后成功", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = harness([session]);
    h.artifacts.beforeReturn = () => {
      if (h.artifacts.calls === 1) throw new Error("required deliverable missing");
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.factory.createCount).toBe(1);
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain("publish_artifact");
    expect(h.persistence.record(h.scope).events).toContainEqual(
      expect.objectContaining({
        kind: "artifact_correction_requested",
        payload: expect.objectContaining({ round: 1, code: "ARTIFACT_NOT_READY" }),
      }),
    );
    expect(h.persistence.permits.map(({ permit }) => permit.effect)).toEqual([
      "model_start",
      "model_continue",
    ]);
  });

  it("修正反馈提交后取消优先，不能再启动模型", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = harness([session]);
    h.artifacts.beforeReturn = () => {
      throw new Error("missing");
    };
    h.persistence.afterMutation = (command) => {
      if (command.idempotencyKey.includes("/correction/1/feedback")) {
        h.cancellation.cancel(h.scope);
      }
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "cancelled" });
    expect(session.prompts).toHaveLength(1);
    expect(h.persistence.permits).toHaveLength(1);
  });

  it("修正反馈提交后租约丢失，不能再启动模型或伪造终态", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = harness([session]);
    h.artifacts.beforeReturn = () => {
      throw new Error("missing");
    };
    h.persistence.afterMutation = (command) => {
      if (command.idempotencyKey.includes("/correction/1/feedback")) {
        h.persistence.expireRunLease(h.scope);
      }
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "fence_lost" });
    expect(session.prompts).toHaveLength(1);
    expect(h.persistence.record(h.scope).run.status).toBe("running");
  });

  it("修正反馈事务响应未知时按 receipt 读回，不重复反馈或重复许可", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = harness([session]);
    h.persistence.responseUnknownKeyIncludes = "/correction/1/feedback";
    h.artifacts.beforeReturn = () => {
      if (h.artifacts.calls === 1) throw new Error("missing");
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(
      h.persistence
        .record(h.scope)
        .events.filter((event) => event.kind === "artifact_correction_requested"),
    ).toHaveLength(1);
    expect(h.persistence.permits).toHaveLength(2);
  });

  it("修正反馈总字节预算不足时稳定失败，不持久化半截反馈或启动下一轮", async () => {
    const session = new ScriptedAgentSession(successfulEvents);
    const h = harness([session], fakeSeed("artifact-budget"), {
      artifactCorrectionPromptBudgetBytes: 1,
    });
    h.artifacts.beforeReturn = () => {
      throw new Error("missing");
    };

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "failed" });
    expect(session.prompts).toHaveLength(1);
    expect(
      h.persistence
        .record(h.scope)
        .events.filter((event) => event.kind === "artifact_correction_requested"),
    ).toHaveLength(0);
    expect(h.persistence.permits).toHaveLength(1);
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
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
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
    const h = harness([blocked]);
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
