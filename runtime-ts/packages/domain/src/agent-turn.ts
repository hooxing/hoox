import { sealEntity, type Entity } from "./entity.js";
import { domainInvariant } from "./errors.js";
import type { AgentThread } from "./agents.js";
import type { AgentThreadId, IsoTimestamp } from "./ids.js";

export type AgentTurnStatus = "queued" | "running" | "completed" | "interrupted" | "failed";
export type AgentTurnTrigger = "spawn" | "follow_up";

interface AgentTurnData {
  readonly id: string;
  readonly agentThreadId: AgentThreadId;
  readonly ordinal: number;
  readonly trigger: AgentTurnTrigger;
  readonly status: AgentTurnStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type AgentTurn = Entity<"AgentTurn", AgentTurnData>;

export function queueAgentTurn(input: {
  readonly thread: AgentThread;
  readonly id: string;
  readonly ordinal: number;
  readonly trigger: AgentTurnTrigger;
  readonly now: IsoTimestamp;
}): AgentTurn {
  domainInvariant(
    input.thread.kind === "subagent",
    "INVALID_ARGUMENT",
    "只有子 Agent 可排队内部 Turn",
  );
  domainInvariant(
    input.thread.status === "active" || input.thread.status === "waiting",
    "INVALID_STATE_TRANSITION",
    "已结束的 Agent Thread 不能启动新 Turn",
  );
  domainInvariant(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(input.id),
    "INVALID_ARGUMENT",
    "Agent Turn ID 无效",
  );
  domainInvariant(
    Number.isSafeInteger(input.ordinal) && input.ordinal > 0,
    "INVALID_ARGUMENT",
    "Agent Turn 序号无效",
  );
  return sealEntity("AgentTurn", {
    id: input.id,
    agentThreadId: input.thread.id,
    ordinal: input.ordinal,
    trigger: input.trigger,
    status: "queued" as const,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function transitionAgentTurn(input: {
  readonly turn: AgentTurn;
  readonly target: AgentTurnStatus;
  readonly now: IsoTimestamp;
}): AgentTurn {
  const transitions: Readonly<Record<AgentTurnStatus, readonly AgentTurnStatus[]>> = {
    queued: ["running", "interrupted", "failed"],
    running: ["completed", "interrupted", "failed"],
    completed: [],
    interrupted: [],
    failed: [],
  };
  domainInvariant(
    transitions[input.turn.status].includes(input.target),
    "INVALID_STATE_TRANSITION",
    "Agent Turn 状态转换不被允许",
  );
  return sealEntity("AgentTurn", {
    ...input.turn,
    status: input.target,
    updatedAt: input.now,
  });
}
