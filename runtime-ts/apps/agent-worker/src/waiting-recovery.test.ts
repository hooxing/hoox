import {
  isoTimestamp,
  runId,
  tenantId,
  threadId,
  workspaceId,
  workspaceRevisionId,
} from "@cube-runtime/domain";
import { describe, expect, it } from "vitest";
import {
  coordinateWaitingRecovery,
  decideWaitingRecovery,
  type WaitingRecoveryCheckpoint,
  type WaitingRecoveryObservation,
  type WaitingRecoveryStorePort,
} from "./waiting-recovery.js";

const revisionOne = workspaceRevisionId("revision-1");
const scope = {
  tenantId: tenantId("tenant-1"),
  threadId: threadId("thread-1"),
  runId: runId("run-1"),
  rootRunId: runId("run-1"),
  workspaceId: workspaceId("workspace-1"),
  baseRevisionId: workspaceRevisionId("base-1"),
};

function checkpoint(
  patch: Partial<NonNullable<WaitingRecoveryCheckpoint["sandbox"]>> = {},
): WaitingRecoveryCheckpoint {
  return {
    checkpointId: "checkpoint-waiting-1",
    scope,
    workspaceHeadAtWait: revisionOne,
    sandbox: {
      registryId: "registry-1",
      providerSandboxId: "cube-1",
      tenantId: scope.tenantId,
      threadId: scope.threadId,
      workspaceId: scope.workspaceId,
      baseRevisionId: scope.baseRevisionId,
      generation: 3,
      expectedGeneration: 3,
      pausedAt: isoTimestamp("2026-07-28T00:00:00.000Z"),
      expiresAt: isoTimestamp("2026-07-28T00:10:00.000Z"),
      lifecycle: "paused",
      ...patch,
    },
  };
}

function observation(patch: Partial<WaitingRecoveryObservation> = {}): WaitingRecoveryObservation {
  return {
    now: isoTimestamp("2026-07-28T00:09:59.999Z"),
    currentWorkspaceHead: revisionOne,
    canReplanWorkspaceChange: false,
    ...patch,
  };
}

describe("waiting + Sandbox 恢复决策", () => {
  it("十分钟 TTL 内且 generation、scope、baseRevision 全匹配才复用", () => {
    expect(decideWaitingRecovery(checkpoint(), observation())).toEqual({
      outcome: "resume",
      workspace: "unchanged",
      sandbox: { kind: "sandbox_reused", registryId: "registry-1", generation: 3 },
    });
  });

  it("TTL 到期边界是开区间并确定重建", () => {
    expect(
      decideWaitingRecovery(
        checkpoint(),
        observation({ now: isoTimestamp("2026-07-28T00:10:00.000Z") }),
      ),
    ).toMatchObject({ sandbox: { kind: "sandbox_rebuilt", reason: "ttl_expired" } });
  });

  it("generation 漂移时重建，不连接旧实例", () => {
    expect(decideWaitingRecovery(checkpoint({ generation: 4 }), observation())).toMatchObject({
      sandbox: { kind: "sandbox_rebuilt", reason: "generation_mismatch" },
    });
  });

  it("baseRevision 漂移时明确重建", () => {
    expect(
      decideWaitingRecovery(
        checkpoint({ baseRevisionId: workspaceRevisionId("base-other") }),
        observation(),
      ),
    ).toMatchObject({
      sandbox: { kind: "sandbox_rebuilt", reason: "base_revision_mismatch" },
    });
  });

  it("用户并发修改 Workspace 时要求重算计划或返回结构化冲突", () => {
    const changed = workspaceRevisionId("revision-user-change");
    expect(
      decideWaitingRecovery(checkpoint(), observation({ currentWorkspaceHead: changed })),
    ).toEqual({ outcome: "workspace_conflict", expectedHead: revisionOne, actualHead: changed });
    expect(
      decideWaitingRecovery(
        checkpoint(),
        observation({ currentWorkspaceHead: changed, canReplanWorkspaceChange: true }),
      ),
    ).toMatchObject({ outcome: "resume", workspace: "replan" });
  });

  it.each(["pause", "connect", "create", "materialize"] as const)(
    "%s 副作用 UNKNOWN 时不要求自动重试",
    (effect) => {
      expect(
        decideWaitingRecovery(checkpoint({ lifecycle: `${effect}_unknown` }), observation()),
      ).toEqual({ outcome: "external_effect_unknown", effect, requestAutomaticRetry: false });
    },
  );

  it("服务重启后相同持久输入仍产生相同决定", () => {
    const stored = JSON.parse(JSON.stringify(checkpoint())) as WaitingRecoveryCheckpoint;
    const first = decideWaitingRecovery(checkpoint(), observation());
    const restarted = decideWaitingRecovery(stored, observation());
    expect(restarted).toEqual(first);
  });

  it("跨租户、跨 Thread 与跨 Workspace 候选均不能复用", () => {
    for (const mismatch of [
      { tenantId: "tenant-other" },
      { threadId: "thread-other" },
      { workspaceId: "workspace-other" },
    ]) {
      expect(decideWaitingRecovery(checkpoint(mismatch), observation())).toMatchObject({
        sandbox: { kind: "sandbox_rebuilt", reason: "scope_mismatch" },
      });
    }
  });

  it("并发双恢复只有 PG CAS 胜者能提交 sandbox_reused 事实", async () => {
    let held = false;
    let resolved = false;
    const facts: string[] = [];
    const store: WaitingRecoveryStorePort = {
      async claim() {
        if (resolved) return { outcome: "resolved" };
        if (held) return { outcome: "busy" };
        held = true;
        return {
          outcome: "claimed",
          claim: { checkpoint: checkpoint(), claimToken: "claim-1" },
        };
      },
      async resolve(input) {
        if (resolved) return "already_resolved";
        resolved = true;
        if (input.sandboxFact) facts.push(input.sandboxFact.kind);
        return "resolved";
      },
    };
    const recover = (workerId: string) =>
      coordinateWaitingRecovery({
        store,
        scope,
        checkpointId: "checkpoint-waiting-1",
        workerId,
        observation: observation(),
      });
    const results = await Promise.all([recover("worker-1"), recover("worker-2")]);
    expect(results.map((item) => item.outcome).sort()).toEqual(["busy", "decided"]);
    expect(facts).toEqual(["sandbox_reused"]);
  });

  it("超过十分钟的 warm window 在可信边界直接拒绝", () => {
    expect(() =>
      decideWaitingRecovery(
        checkpoint({ expiresAt: isoTimestamp("2026-07-28T00:10:00.001Z") }),
        observation(),
      ),
    ).toThrow("最多十分钟");
  });
});
