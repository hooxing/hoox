import { runId, tenantId, threadId, workspaceId, workspaceRevisionId } from "@cube-runtime/domain";
import type { RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import type { UncertainLifecycleEvent } from "@cube-runtime/sandbox";
import { describe, expect, it } from "vitest";
import type { RunScope, RunSnapshot } from "./ports.js";
import { RunWorker } from "./run-worker.js";
import {
  BlockingAgentSession,
  FakeArtifactPublication,
  FakeCancellationPort,
  FakeClock,
  FakeRevisionVerifier,
  FakeRunPersistence,
  FakeSandboxRegistry,
  FakeSessionFactory,
  FakeWorkspacePort,
  ScriptedAgentSession,
} from "./testing/fakes.js";

const scope: RunScope = {
  tenantId: tenantId("tenant-test"),
  threadId: threadId("thread-test"),
  runId: runId("run-test"),
  rootRunId: runId("run-test"),
};

const successEvents: readonly RuntimeAgentEvent[] = [
  { type: "agent.started" },
  { type: "message.delta", delta: "完成" },
  { type: "message.completed", stopReason: "stop" },
  { type: "agent.settled" },
];

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    ...scope,
    workspaceId: workspaceId("workspace-test"),
    status: "queued",
    input: "完成任务",
    stateVersion: 0,
    nextEventSequence: 0,
    ...overrides,
  };
}

function harness(sessions: ScriptedAgentSession[] | BlockingAgentSession[]) {
  const runs = new FakeRunPersistence(snapshot());
  const workspaces = new FakeWorkspacePort();
  const revisions = new FakeRevisionVerifier();
  const sandboxes = new FakeSandboxRegistry();
  const factory = new FakeSessionFactory(sessions);
  const cancellation = new FakeCancellationPort();
  const artifacts = new FakeArtifactPublication();
  const clock = new FakeClock();
  const worker = new RunWorker(
    { runs, workspaces, revisions, sandboxes, sessions: factory, cancellation, artifacts, clock },
    {
      workerId: "worker-test",
      claimLeaseMs: 30_000,
      workspaceLeaseMs: 30_000,
      heartbeatMs: 10_000,
      runTimeoutMs: 60_000,
    },
  );
  return {
    worker,
    runs,
    workspaces,
    revisions,
    sandboxes,
    factory,
    cancellation,
    artifacts,
    clock,
  };
}

describe("Run Worker 可靠性核心", () => {
  it("成功执行时按稳定序号持久化事件，仅提交一次已验证 Workspace，并经过 Artifact 完成门", async () => {
    const session = new ScriptedAgentSession(successEvents);
    const h = harness([session]);
    h.revisions.nextRevisionId = workspaceRevisionId("revision-success");

    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.runs.snapshot.status).toBe("succeeded");
    expect(h.runs.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(h.runs.events.map((event) => event.type)).toEqual([
      "agent.started",
      "message.delta",
      "message.completed",
      "agent.settled",
      "run.succeeded",
    ]);
    expect(new Set(h.runs.events.map((event) => event.idempotencyKey)).size).toBe(5);
    expect(h.workspaces.commitCount).toBe(1);
    expect(h.artifacts.calls).toBe(1);
    expect(h.sandboxes.settleCount).toBe(1);
  });

  it("重复投递只允许一个 Worker 获得 claim，不会创建第二个 Sandbox 或 Session", async () => {
    const blocked = new BlockingAgentSession();
    const h = harness([blocked]);

    const first = h.worker.execute(scope);
    await eventually(() => h.factory.createCount === 1);
    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "ignored", reason: "busy" });
    expect(h.sandboxes.acquireCount).toBe(1);
    expect(h.factory.createCount).toBe(1);

    h.cancellation.cancel(scope.runId);
    await expect(first).resolves.toEqual({ outcome: "cancelled" });
  });

  it("Workspace 租约在心跳中丢失时立即中止 Agent，旧 Worker 不提交事件、版本或终态", async () => {
    const blocked = new BlockingAgentSession();
    const h = harness([blocked]);
    const execution = h.worker.execute(scope);
    await eventually(() => h.factory.createCount === 1);

    h.workspaces.forceLeaseLost = true;
    await h.clock.tickHeartbeats();

    await expect(execution).resolves.toEqual({ outcome: "fence_lost" });
    expect(blocked.abortCount).toBe(1);
    expect(h.workspaces.commitCount).toBe(0);
    expect(h.runs.events).toEqual([]);
    expect(h.runs.snapshot.status).toBe("running");
  });

  it("Workspace 已校验提交后才到达的取消仍以 cancelled 完成，且不会重复提交版本", async () => {
    const h = harness([new ScriptedAgentSession(successEvents)]);
    h.revisions.nextRevisionId = workspaceRevisionId("revision-late-cancel");
    h.artifacts.onAssert = () => h.cancellation.cancel(scope.runId);

    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "cancelled" });

    expect(h.runs.snapshot.status).toBe("cancelled");
    expect(h.runs.events.at(-1)?.type).toBe("run.cancelled_after_checkpoint");
    expect(h.workspaces.commitCount).toBe(1);
    expect(h.artifacts.calls).toBe(1);
  });

  it("流式事件写入失败时中止执行，不伪造成功，也不推进 Workspace", async () => {
    const session = new ScriptedAgentSession(successEvents);
    const h = harness([session]);
    h.runs.failNextCommit = true;
    h.revisions.nextRevisionId = workspaceRevisionId("revision-must-not-commit");

    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "persistence_unavailable" });

    expect(session.abortCount).toBeGreaterThanOrEqual(1);
    expect(h.runs.snapshot.status).toBe("running");
    expect(h.runs.events).toEqual([]);
    expect(h.workspaces.commitCount).toBe(0);
    expect(h.artifacts.calls).toBe(0);
  });

  it("Sandbox 创建结果为 UNKNOWN 时失败并在同一提交写入恢复 Outbox", async () => {
    const h = harness([new ScriptedAgentSession(successEvents)]);
    h.sandboxes.nextAcquire = { outcome: "unknown", event: uncertainEvent("create_response") };

    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "failed" });

    expect(h.factory.createCount).toBe(0);
    expect(h.runs.snapshot.status).toBe("failed");
    expect(h.runs.events.at(-1)?.type).toBe("sandbox.lifecycle_unknown");
    expect(h.runs.outbox).toHaveLength(1);
    expect(h.runs.outbox[0]?.topic).toBe("sandbox.lifecycle.unknown");
  });

  it("Provider 失败事件优先于 Pi settle，Run 失败且不提交 Workspace", async () => {
    const h = harness([
      new ScriptedAgentSession([
        { type: "agent.started" },
        { type: "error", code: "PROVIDER", message: "上游失败" },
        { type: "agent.settled" },
      ]),
    ]);

    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "failed" });

    expect(h.runs.events.at(-1)?.type).toBe("agent.failed");
    expect(h.workspaces.commitCount).toBe(0);
    expect(h.artifacts.calls).toBe(0);
  });

  it("Pi Session 创建失败时仍关闭已取得的 Sandbox，再提交失败终态", async () => {
    const h = harness([new ScriptedAgentSession(successEvents)]);
    h.factory.failNextCreate = true;

    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "failed" });

    expect(h.sandboxes.acquireCount).toBe(1);
    expect(h.sandboxes.settleCount).toBe(1);
    expect(h.runs.snapshot.status).toBe("failed");
    expect(h.workspaces.commitCount).toBe(0);
  });

  it("waiting 提交检查点并释放 claim，追问恢复后复用 Sandbox 且调用 follow_up", async () => {
    const waiting = new ScriptedAgentSession([{ type: "agent.started" }], {
      kind: "waiting",
      question: "请补充范围",
    });
    const resumed = new ScriptedAgentSession(successEvents);
    const h = harness([waiting, resumed]);
    h.revisions.nextRevisionId = workspaceRevisionId("revision-waiting");

    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "waiting" });
    expect(h.runs.snapshot.status).toBe("waiting");
    expect(h.workspaces.commitCount).toBe(1);

    h.runs.resume("只处理 Markdown");
    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(resumed.turns).toEqual([{ mode: "follow_up", text: "只处理 Markdown" }]);
    expect(h.sandboxes.acquireCount).toBe(2);
    expect(h.workspaces.commitCount).toBe(1);
    expect(h.runs.snapshot.status).toBe("succeeded");
  });

  it("崩溃后保留已提交事件高水位，重入从下一序号继续且 Workspace 只提交一次", async () => {
    const h = harness([new ScriptedAgentSession(successEvents)]);
    const now = h.clock.now();
    const claim = await h.runs.claim({
      scope,
      workerId: "crashed-worker",
      now,
      leaseUntil: new Date(now.valueOf() + 30_000),
    });
    if (claim.outcome !== "claimed") throw new Error("测试前置 claim 失败");
    const partial = await h.runs.commit({
      scope,
      claimToken: claim.claim.token,
      claimEpoch: claim.claim.epoch,
      expectedStateVersion: claim.claim.snapshot.stateVersion,
      events: [
        {
          sequence: 0,
          idempotencyKey: `${scope.runId}/event/0`,
          type: "message.delta",
          occurredAt: now,
          payload: { type: "message.delta", delta: "已落盘" },
        },
      ],
      outbox: [],
    });
    expect(partial.outcome).toBe("committed");
    h.runs.markInterruptedAfterCrash();
    h.revisions.nextRevisionId = workspaceRevisionId("revision-after-crash");

    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });

    expect(h.runs.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(h.runs.events.map((event) => event.idempotencyKey)).size).toBe(6);
    expect(h.workspaces.commitCount).toBe(1);
  });

  it("执行超时会在安全点中止 Session 并以 failed 收敛", async () => {
    const blocked = new BlockingAgentSession();
    const h = harness([blocked]);
    const execution = h.worker.execute(scope);
    await eventually(() => h.factory.createCount === 1);

    h.clock.advance(60_000);

    await expect(execution).resolves.toEqual({ outcome: "failed" });
    expect(blocked.abortCount).toBe(1);
    expect(h.runs.events.at(-1)?.type).toBe("run.timed_out");
    expect(h.workspaces.commitCount).toBe(0);
  });

  it("Sandbox 收尾结果 UNKNOWN 会覆盖成功并进入恢复 Outbox", async () => {
    const h = harness([new ScriptedAgentSession(successEvents)]);
    h.sandboxes.nextSettlement = {
      outcome: "unknown",
      event: uncertainEvent("cleanup_after_create"),
    };

    await expect(h.worker.execute(scope)).resolves.toEqual({ outcome: "failed" });

    expect(h.runs.snapshot.status).toBe("failed");
    expect(h.runs.outbox).toHaveLength(1);
    expect(h.runs.events.at(-1)?.type).toBe("sandbox.lifecycle_unknown");
  });
});

function uncertainEvent(stage: UncertainLifecycleEvent["stage"]): UncertainLifecycleEvent {
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
