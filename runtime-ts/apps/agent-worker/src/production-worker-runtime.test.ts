import type { PgClaimedRunDispatch } from "@cube-runtime/persistence";
import { describe, expect, it } from "vitest";
import { AgentWorkerPollingLoop } from "./production-worker-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function claim(): PgClaimedRunDispatch {
  return {
    outboxId: "outbox-worker-loop",
    generation: 1,
    claimToken: "dispatch-claim-worker-loop",
    scope: {
      tenantId: "tenant-worker-loop",
      threadId: "thread-worker-loop",
      runId: "run-worker-loop",
      rootRunId: "run-worker-loop",
      workspaceId: "workspace-worker-loop",
    },
  };
}

describe("Agent Worker production polling loop", () => {
  it("领取 durable dispatch 后执行 RunWorker 并以同一 dispatch fence 确认终态", async () => {
    const acknowledged = deferred<void>();
    const expected = claim();
    let claimed = false;
    const acknowledgements: unknown[] = [];
    const loop = new AgentWorkerPollingLoop(
      {
        claim: async () => {
          if (claimed) return [];
          claimed = true;
          return [expected];
        },
        acknowledge: async (input) => {
          acknowledgements.push(input);
          acknowledged.resolve(undefined);
        },
      },
      { execute: async () => ({ outcome: "succeeded" }) },
      {
        tenantId: expected.scope.tenantId,
        workerId: "worker-loop",
        pollIntervalMs: 10,
        dispatchLeaseMs: 30_000,
      },
    );
    loop.start();
    await acknowledged.promise;
    await loop.close();
    expect(acknowledgements).toEqual([{ claim: expected, outcome: "terminal" }]);
  });

  it("stopAccepting 停止新领取并等待在途 RunWorker 与 ack 完成", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const closed = deferred<void>();
    let claimCount = 0;
    let ackCount = 0;
    const loop = new AgentWorkerPollingLoop(
      {
        claim: async () => {
          claimCount += 1;
          return claimCount === 1 ? [claim()] : [];
        },
        acknowledge: async () => {
          ackCount += 1;
        },
      },
      {
        execute: async () => {
          started.resolve();
          await finish.promise;
          return { outcome: "succeeded" };
        },
      },
      {
        tenantId: "tenant-worker-loop",
        workerId: "worker-loop",
        pollIntervalMs: 10,
        dispatchLeaseMs: 30_000,
      },
    );
    loop.start();
    await started.promise;
    let didClose = false;
    void loop.close().then(() => {
      didClose = true;
      closed.resolve();
    });
    await Promise.resolve();
    expect(didClose).toBe(false);
    finish.resolve();
    await closed.promise;
    expect(claimCount).toBe(1);
    expect(ackCount).toBe(1);
  });
});
