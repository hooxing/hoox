import { tenantId } from "@cube-runtime/domain";
import type { RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import type { UncertainLifecycleEvent } from "@cube-runtime/sandbox";
import { describe, expect, it } from "vitest";
import type { ExecutionScope, RuntimeEventV1 } from "./ports.js";
import { RunWorker } from "./run-worker.js";
import {
  BlockingAgentSession,
  FakeArtifactPublication,
  FakeCancellationPort,
  FakeClock,
  FakeExecutionPersistence,
  FakeRevisionVerifier,
  FakeSandboxRegistry,
  FakeSessionFactory,
  ScriptedAgentSession,
  fakeRevision,
  fakeSeed,
} from "./testing/fakes.js";

const successfulEvents: readonly RuntimeAgentEvent[] = [
  { type: "agent.started" },
  { type: "message.delta", delta: "完成" },
  { type: "message.completed", stopReason: "stop" },
  { type: "agent.settled" },
];

function harness(sessions: Array<ScriptedAgentSession | BlockingAgentSession>) {
  const persistence = new FakeExecutionPersistence();
  const scope = persistence.addSeed(fakeSeed());
  const revisions = new FakeRevisionVerifier();
  const sandboxes = new FakeSandboxRegistry();
  const factory = new FakeSessionFactory(sessions);
  const cancellation = new FakeCancellationPort();
  const artifacts = new FakeArtifactPublication();
  const clock = new FakeClock();
  const worker = new RunWorker(
    { persistence, revisions, sandboxes, sessions: factory, cancellation, artifacts, clock },
    { workerId: "worker-test", leaseDurationMs: 30_000, heartbeatMs: 10_000, runTimeoutMs: 60_000 },
  );
  return {
    worker,
    persistence,
    scope,
    revisions,
    sandboxes,
    factory,
    cancellation,
    artifacts,
    clock,
  };
}

describe("Run Worker 双栅栏与恢复状态机", () => {
  it("Revision、Run succeeded、Attempt 终态和双栅栏释放在同一幂等事务完成", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    h.revisions.nextRevisionId = fakeRevision("revision-success");

    await expect(h.worker.execute(h.scope)).resolves.toEqual({ outcome: "succeeded" });

    const currentScope = h.persistence.scopeForRun(h.scope.runId);
    const record = h.persistence.record(currentScope);
    expect(record.run.status).toBe("succeeded");
    expect(record.workspace.currentRevisionId).toBe(fakeRevision("revision-success"));
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
    },
  );

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

  it("settle 抛异常时保留 pending cleanup Outbox，Attempt 进入 recovery_required，Run 不伪失败", async () => {
    const h = harness([new ScriptedAgentSession(successfulEvents)]);
    h.sandboxes.throwOnSettle = true;

    await expect(h.worker.execute(h.scope)).resolves.toEqual({
      outcome: "recovery_required",
      code: "INTERNAL",
    });

    const record = h.persistence.record(h.scope);
    expect(record.run.status).toBe("running");
    expect(record.attempt?.status).toBe("recovery_required");
    expect(record.outbox).toContainEqual(
      expect.objectContaining({ kind: "sandbox_cleanup", state: "pending" }),
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
    expect(h.factory.createCount).toBe(0);
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
      schemaVersion: 1 as const,
      checkpointId: "checkpoint-waiting",
      turns: [
        { role: "user" as const, text: "生成报告" },
        { role: "assistant" as const, text: "请补充范围" },
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
      occurredAt: claimed.databaseNow,
      payload: { status: "running", stage: "model_execution_started" },
    };
    await h.persistence.mutate({
      idempotencyKey: `${claimed.snapshot.attempt.attemptId}/stage/model-execution-started`,
      fence: claimed.fence,
      expectedAttemptVersion: 0,
      nextAttemptStatus: "running",
      nextStage: "model_execution_started",
      events: [event],
      outbox: [],
    });
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
