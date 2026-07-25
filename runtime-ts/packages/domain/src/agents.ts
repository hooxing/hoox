import { domainInvariant } from "./errors.js";
import type { Run } from "./execution.js";
import type { AgentThreadId, IsoTimestamp, RunId, TenantId } from "./ids.js";

export type AgentThreadKind = "root" | "subagent";
export type AgentThreadStatus = "active" | "waiting" | "completed" | "failed" | "cancelled";

export interface AgentThread {
  readonly id: AgentThreadId;
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly kind: AgentThreadKind;
  readonly parentId?: AgentThreadId;
  readonly status: AgentThreadStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface AgentTree {
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly rootId: AgentThreadId;
  readonly agents: readonly AgentThread[];
}

export function createAgentTree(input: {
  readonly run: Run;
  readonly rootId: AgentThreadId;
  readonly now: IsoTimestamp;
}): AgentTree {
  const root = Object.freeze<AgentThread>({
    id: input.rootId,
    tenantId: input.run.tenantId,
    runId: input.run.id,
    kind: "root",
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
  });
  return Object.freeze({
    runId: input.run.id,
    tenantId: input.run.tenantId,
    rootId: root.id,
    agents: Object.freeze([root]),
  });
}

export function spawnAgentThread(input: {
  readonly tree: AgentTree;
  readonly parentId: AgentThreadId;
  readonly id: AgentThreadId;
  readonly now: IsoTimestamp;
}): AgentTree {
  domainInvariant(
    !input.tree.agents.some((agent) => agent.id === input.id),
    "INVALID_ARGUMENT",
    "Agent Thread ID 已存在",
  );
  const parent = input.tree.agents.find((agent) => agent.id === input.parentId);
  domainInvariant(parent !== undefined, "INVALID_ARGUMENT", "父 Agent Thread 不存在");
  domainInvariant(
    parent.status === "active",
    "INVALID_STATE_TRANSITION",
    "只有活跃 Agent Thread 可以创建子 Agent",
  );
  const agent = Object.freeze<AgentThread>({
    id: input.id,
    tenantId: input.tree.tenantId,
    runId: input.tree.runId,
    kind: "subagent",
    parentId: parent.id,
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
  });
  return Object.freeze({ ...input.tree, agents: Object.freeze([...input.tree.agents, agent]) });
}

export function transitionAgentThread(input: {
  readonly tree: AgentTree;
  readonly id: AgentThreadId;
  readonly target: AgentThreadStatus;
  readonly now: IsoTimestamp;
}): AgentTree {
  const current = input.tree.agents.find((agent) => agent.id === input.id);
  domainInvariant(current !== undefined, "INVALID_ARGUMENT", "Agent Thread 不存在");
  const transitions: Readonly<Record<AgentThreadStatus, readonly AgentThreadStatus[]>> = {
    active: ["waiting", "completed", "failed", "cancelled"],
    waiting: ["active", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  };
  domainInvariant(
    transitions[current.status].includes(input.target),
    "INVALID_STATE_TRANSITION",
    "Agent Thread 状态转换不被允许",
  );
  if (current.kind === "root" && input.target === "completed") {
    const unfinishedSubagent = input.tree.agents.some(
      (agent) => agent.kind === "subagent" && ["active", "waiting"].includes(agent.status),
    );
    domainInvariant(
      !unfinishedSubagent,
      "INVALID_STATE_TRANSITION",
      "仍有未结束的子 Agent，根 Agent 不能完成",
    );
  }
  const agents = input.tree.agents.map((agent) =>
    agent.id === current.id
      ? Object.freeze({ ...agent, status: input.target, updatedAt: input.now })
      : agent,
  );
  return Object.freeze({ ...input.tree, agents: Object.freeze(agents) });
}
