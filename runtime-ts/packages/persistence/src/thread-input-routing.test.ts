import { describe, expect, it } from "vitest";
import { decideThreadInputRoute } from "./pg-thread-input.js";

const active = {
  activeRunId: "run-1",
  activeTurnId: "turn-1",
  activeRunStatus: "running",
  activeAttemptStatus: "running",
  activeAttemptStage: "model_execution_started",
} as const;

describe("阶段 3 统一输入路由", () => {
  it("auto 只 steer 可采样 regular active Run，waiting/终结阶段转 follow-up", () => {
    expect(decideThreadInputRoute({ mode: "auto", fallbackToFollowUp: false, ...active })).toEqual({
      action: "steer",
    });
    expect(
      decideThreadInputRoute({
        mode: "auto",
        fallbackToFollowUp: false,
        ...active,
        activeRunStatus: "waiting",
        activeAttemptStatus: "waiting",
        activeAttemptStage: "finished",
      }),
    ).toEqual({ action: "queue" });
    expect(
      decideThreadInputRoute({
        mode: "auto",
        fallbackToFollowUp: false,
        ...active,
        activeAttemptStage: "finalizing",
      }),
    ).toEqual({ action: "queue" });
  });

  it("显式 steer 必须匹配 expected Run/Turn，只有显式 fallback 才排队", () => {
    expect(
      decideThreadInputRoute({
        mode: "steer",
        expectedRunId: "run-old",
        expectedTurnId: "turn-1",
        fallbackToFollowUp: false,
        ...active,
      }),
    ).toEqual({ action: "reject", rejectionCode: "expected_run_mismatch" });
    expect(
      decideThreadInputRoute({
        mode: "steer",
        expectedRunId: "run-1",
        expectedTurnId: "turn-old",
        fallbackToFollowUp: false,
        ...active,
      }),
    ).toEqual({ action: "reject", rejectionCode: "expected_turn_mismatch" });
    expect(
      decideThreadInputRoute({
        mode: "steer",
        expectedRunId: "run-old",
        expectedTurnId: "turn-1",
        fallbackToFollowUp: true,
        ...active,
      }),
    ).toEqual({ action: "queue" });
  });

  it("follow_up 不受 active 状态影响并始终创建独立 FIFO 项", () => {
    expect(
      decideThreadInputRoute({ mode: "follow_up", fallbackToFollowUp: false, ...active }),
    ).toEqual({ action: "queue" });
  });
});
