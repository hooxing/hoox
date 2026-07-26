import { describe, expect, it } from "vitest";
import { RunDispatchScheduler, type ClaimedRunDispatch } from "./run-dispatch.js";

function claim(): ClaimedRunDispatch {
  return {
    outboxId: "outbox-1",
    generation: 3,
    claimToken: "claim-token-1",
    scope: {
      tenantId: "tenant-a",
      runId: "run-a",
      threadId: "thread-a",
      workspaceId: "workspace-a",
      rootRunId: "run-a",
    },
  };
}

describe("Run Dispatch Scheduler", () => {
  it("先短事务领取，再在事务外执行并用双栅栏确认", async () => {
    let transactionOpen = false;
    const acknowledgements: unknown[] = [];
    const scheduler = new RunDispatchScheduler(
      {
        claim: async () => {
          transactionOpen = true;
          const result = [claim()];
          transactionOpen = false;
          return result;
        },
        acknowledge: async (input) => {
          acknowledgements.push(input);
        },
      },
      {
        execute: async () => {
          expect(transactionOpen).toBe(false);
          return { kind: "success" };
        },
      },
    );
    await expect(
      scheduler.tick({
        tenantId: "tenant-a",
        dispatcherId: "scheduler-a",
        limit: 10,
        leaseMilliseconds: 30_000,
      }),
    ).resolves.toBe(1);
    expect(acknowledgements).toEqual([{ claim: claim(), outcome: "dispatched" }]);
  });

  it("busy、waiting、异常均安全 defer，terminal 不会再次投递", async () => {
    const results = [
      { kind: "busy" as const, retryAfterMilliseconds: 1000 },
      { kind: "waiting" as const, retryAfterMilliseconds: 2000 },
      { kind: "terminal" as const },
      { kind: "retryable" as const, retryAfterMilliseconds: 3000 },
    ];
    const calls: unknown[] = [];
    const scheduler = new RunDispatchScheduler(
      {
        claim: async () => results.map((_, index) => ({ ...claim(), outboxId: `outbox-${index}` })),
        acknowledge: async (input) => {
          calls.push(input);
        },
      },
      { execute: async () => results.shift() ?? { kind: "terminal" } },
    );
    await scheduler.tick({
      tenantId: "tenant-a",
      dispatcherId: "scheduler-a",
      limit: 10,
      leaseMilliseconds: 30_000,
    });
    expect(calls.map((value) => (value as { outcome: string }).outcome)).toEqual([
      "defer",
      "waiting",
      "terminal",
      "defer",
    ]);
  });
});
